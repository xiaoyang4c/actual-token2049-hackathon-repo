import { describe, expect, test } from "bun:test"
import type { ScoreRequest, Signal } from "../packages/core/src"
import { start as startWallet, type PaymentRequirement } from "./cardano-agent"
import { start as startProvider } from "./score-provider"
import {loadPaymentConfig} from './cardano-agents-ts/config'

const withServices = async (run: (providerUrl: string, walletUrl: string) => Promise<void>) => {
  const config = {...loadPaymentConfig({}), databasePath: ':memory:'}
  const wallet = startWallet(0, {config})
  let provider: ReturnType<typeof startProvider> | undefined
  try {
    const walletUrl = `http://127.0.0.1:${wallet.port}`
    provider = startProvider(0, walletUrl, config)
    await run(`http://127.0.0.1:${provider.port}`, walletUrl)
  } finally {
    await provider?.stop(true)
    await wallet.stop(true)
  }
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })

const request: ScoreRequest = { markets: [
  { venue: "polymarket", marketId: "same-id", yesPrice: 0.5 },
  { venue: "kalshi", marketId: "same-id", yesPrice: 0.5 },
] }

describe("score provider HTTP integration", () => {
  test("paid scores preserve venue identity, persist delivery, and repeat without another payment", async () => {
    await withServices(async (providerUrl, walletUrl) => {
      const walletBefore = await (await fetch(`${walletUrl}/wallet`)).json() as { balanceLovelace: number }
      const quote = await post(`${providerUrl}/score`, request)
      expect(quote.status).toBe(402)
      const { accepts } = await quote.json() as { accepts: PaymentRequirement[] }
      const payment = await post(`${walletUrl}/pay`, { idempotencyKey: crypto.randomUUID(), requirement: accepts[0] })
      expect(payment.status).toBe(200)
      const { receipt, xPayment } = await payment.json() as { receipt: { receiptId: string; amount: number }; xPayment: string }

      const response = await post(`${providerUrl}/score`, request, { "X-PAYMENT": xPayment })
      expect(response.status).toBe(200)
      const { signals } = await response.json() as { signals: Signal[] }
      expect(signals.map((s) => [s.venue, s.marketId])).toEqual([["polymarket", "same-id"], ["kalshi", "same-id"]])
      // Identical IDs at different venues also get independent deterministic scores.
      expect([signals[0].fairYes, signals[0].confidence]).not.toEqual([signals[1].fairYes, signals[1].confidence])
      const retried = await post(`${providerUrl}/score`, request, { "X-PAYMENT": xPayment })
      expect(retried.status).toBe(200)
      expect(await retried.json()).toEqual({ signals })
      const walletAfter = await (await fetch(`${walletUrl}/wallet`)).json() as { balanceLovelace: number }
      expect(walletAfter.balanceLovelace).toBe(walletBefore.balanceLovelace - receipt.amount)
      const receipts = await (await fetch(`${walletUrl}/receipts`)).json() as { receiptId: string; status: string }[]
      expect(receipts.find((r) => r.receiptId === receipt.receiptId)?.status).toBe("delivered")
    })
  })

  test("rejects missing or invalid venue identity and invalid prices", async () => {
    await withServices(async (providerUrl) => {
      for (const market of [
        { marketId: "same-id", yesPrice: 0.5 },
        { venue: "unknown", marketId: "same-id", yesPrice: 0.5 },
        { venue: "polymarket", marketId: "", yesPrice: 0.5 },
        { venue: "polymarket", marketId: "same-id", yesPrice: null },
        { venue: "polymarket", marketId: "same-id", yesPrice: 1.1 },
      ]) {
        const response = await post(`${providerUrl}/score`, { markets: [market] })
        expect(response.status).toBe(400)
        await response.text()
      }
    })
  })

  test("a paid request still requires a valid payment proof", async () => {
    await withServices(async (providerUrl) => {
      const response = await post(`${providerUrl}/score`, request, { "X-PAYMENT": "invalid-proof" })
      expect(response.status).toBe(402)
      expect(await response.json()).not.toHaveProperty("signals")
    })
  })
})
