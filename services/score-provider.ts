// Local paid-score demo. Confirm payment, prepare scores, and commit delivery.
import { createHash } from "node:crypto"
import type { ScoreMarket, ScoreRequest, Signal } from "../packages/core/src"
import type { PaymentRequirement } from "./cardano-agent"
import {loadPaymentConfig, type PaymentConfig} from './cardano-agents-ts/config'
import {scoreInputHash} from './cardano-agents-ts/types'
import { json, readJson, serve } from "./lib/http"

const PRICE_LOVELACE = 1_000_000
const MAX_MARKETS = 50

const isScoreMarket = (value: unknown): value is ScoreMarket => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const market = value as Partial<ScoreMarket>
  return (market.venue === "polymarket" || market.venue === "kalshi") &&
    typeof market.marketId === "string" && market.marketId.length > 0 &&
    typeof market.yesPrice === "number" && Number.isFinite(market.yesPrice) && market.yesPrice >= 0 && market.yesPrice <= 1
}

const isScoreRequest = (value: unknown): value is ScoreRequest =>
  typeof value === "object" && value !== null &&
  Array.isArray((value as ScoreRequest).markets) && (value as ScoreRequest).markets.every(isScoreMarket)

// Deterministic per market so simulation runs are reproducible.
const score = ({ venue, marketId, yesPrice }: ScoreMarket): Signal => {
  const h = createHash("sha256").update(`${venue}:${marketId}`).digest()
  const offset = ((h[0] / 255) * 2 - 1) * 0.12
  const fairYes = Math.min(0.99, Math.max(0.01, yesPrice + offset))
  return {
    venue,
    marketId,
    fairYes: Math.round(fairYes * 1000) / 1000,
    confidence: Math.round((0.6 + (h[1] / 255) * 0.3) * 100) / 100,
  }
}

export const scoreMarkets = (request: ScoreRequest) => ({signals: request.markets.slice(0, MAX_MARKETS).map(score)})

export const start = (port: number, cardanoAgentUrl: string, config: PaymentConfig = loadPaymentConfig()) => {
  const baseRequirement: Omit<PaymentRequirement, 'resource'> = {
    scheme: "exact",
    network: "cardano-preprod",
    maxAmountRequired: String(PRICE_LOVELACE),
    asset: "lovelace",
    payTo: config.scorePayTo,
    description: `Fair-value scores for up to ${MAX_MARKETS} binary markets`,
    maxTimeoutSeconds: 60,
  }

  return serve("score-provider", port, {
    "POST /score": async (req) => {
      const body = await readJson<unknown>(req)
      if (!isScoreRequest(body)) return json({ error: "markets require venue, marketId, and a finite yesPrice in [0, 1]" }, 400)
      if (body.markets.length > MAX_MARKETS) return json({error: `at most ${MAX_MARKETS} markets are supported`}, 400)
      const resource = new URL('/score', req.url).href
      const inputHash = scoreInputHash(body)
      const requirement: PaymentRequirement = {...baseRequirement, resource, inputHash}
      const xPayment = req.headers.get("x-payment")
      if (!xPayment) {
        return json({ x402Version: 1, error: "X-PAYMENT header is required", accepts: [requirement] }, 402)
      }

      const verification = {xPayment, resource, amount: PRICE_LOVELACE, payTo: config.scorePayTo, inputHash}
      const verify = await fetch(`${cardanoAgentUrl}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(verification),
      })
      const result = (await verify.json()) as {
        valid: boolean; reason?: string; txHash?: string; simulated?: boolean;
        response?: {signals: Signal[]};
      }
      if (!verify.ok || !result.valid) {
        return json({ x402Version: 1, error: result.reason, accepts: [requirement] }, verify.status >= 500 ? 503 : 402)
      }

      let response = result.response
      if (!response) {
        const delivery = await fetch(`${cardanoAgentUrl}/deliver`, {
          method: 'POST', headers: {'content-type': 'application/json'},
          body: JSON.stringify({...verification, response: scoreMarkets(body)}),
        })
        if (!delivery.ok) return json({error: 'score delivery was not committed; retry the same payment'}, delivery.status)
        response = (await delivery.json() as {response: {signals: Signal[]}}).response
      }
      const paymentResponse = Buffer.from(JSON.stringify({
        success: true, txHash: result.txHash, network: requirement.network, simulated: result.simulated,
      })).toString("base64")
      return json(response, 200, { "x-payment-response": paymentResponse })
    },
  })
}
