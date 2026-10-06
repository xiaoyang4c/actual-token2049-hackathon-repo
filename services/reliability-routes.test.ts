/**
 * @fileoverview Tests for the reliability read endpoints and seed helper.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentStore } from "../packages/db/src/index"
import { start } from "./control-api"
import { seedReliabilityStore } from "./reliability/seed"

const withServer = async (run: (origin: string) => Promise<void>) => {
  const directory = mkdtempSync(join(tmpdir(), "reliability-api-"))
  const server = start(0, { auditFile: join(directory, "audit.jsonl"), databasePath: join(directory, "agent.sqlite") })
  try {
    await run(`http://127.0.0.1:${server.port}`)
  } finally {
    await server.stop(true)
    rmSync(directory, { recursive: true, force: true })
  }
}

describe("reliability read endpoints", () => {
  test("serves entities, scores, listings, transactions, and receipts", async () => {
    await withServer(async (origin) => {
      const entities = await (await fetch(`${origin}/reliability/entities`)).json() as { id: string }[]
      expect(entities.map((entity) => entity.id)).toEqual([
        "entity-new",
        "entity-established",
        "entity-farm-a",
        "entity-farm-b",
      ])
      expect((await (await fetch(`${origin}/reliability/entities?id=entity-new`)).json() as { kycStatus: string }).kycStatus).toBe("pending")
      expect(await (await fetch(`${origin}/reliability/entities?id=nope`)).status).toBe(404)

      const scores = await (await fetch(`${origin}/reliability/scores`)).json() as
        { entityId: string; role: string; value: number; lowerBound: number; confidence: number }[]
      expect(scores.length).toBeGreaterThan(0)
      for (const score of scores) {
        expect(score.lowerBound).toBeLessThanOrEqual(score.value)
        expect(["buyer", "seller"]).toContain(score.role)
      }
      const filtered = await (await fetch(`${origin}/reliability/scores?entityId=entity-new`)).json() as unknown[]
      expect(filtered.length).toBeGreaterThan(0)

      const listings = await (await fetch(`${origin}/reliability/listings`)).json() as
        { id: string; transactionType: string; minBuyerReliability?: number; minSellerReliability?: number }[]
      expect(listings).toHaveLength(2)
      expect(new Set(listings.map((listing) => listing.transactionType))).toEqual(new Set(["service", "invoice"]))

      const transactions = await (await fetch(`${origin}/reliability/transactions`)).json() as
        { id: string; type: string; termsHash?: string; versions: unknown[] }[]
      expect(transactions.length).toBeGreaterThan(2)
      const invoice = transactions.find((transaction) => transaction.id === "tx-invoice-1")
      expect(invoice?.termsHash).toMatch(/^[a-f0-9]{64}$/)
      expect(invoice?.versions).toHaveLength(2)

      const receipt = await (await fetch(`${origin}/reliability/receipts?transactionId=tx-invoice-1`)).json() as
        { transaction: { id: string }; outcome: { state: string }; events: unknown[]; termsDecision?: { buyerFeeBps: number; sellerFeeBps: number } }
      expect(receipt.transaction.id).toBe("tx-invoice-1")
      expect(receipt.outcome.state).toBe("successful")
      expect(receipt.events).toHaveLength(2)
      expect(receipt.termsDecision?.buyerFeeBps).toBeGreaterThan(0)
      expect(receipt.termsDecision?.sellerFeeBps).toBeGreaterThan(0)
      expect(await (await fetch(`${origin}/reliability/receipts`)).status).toBe(400)
      expect(await (await fetch(`${origin}/reliability/receipts?transactionId=nope`)).status).toBe(404)
    })
  })

  test("seeds the store from the same fixtures", () => {
    const store = AgentStore.open()
    try {
      seedReliabilityStore(store)
      expect(store.listEntities()).toHaveLength(4)
      expect(store.listTransactions()).toHaveLength(store.listTransactions().length)
      expect(store.getOutcome("tx-service-1")?.verificationMethod).toBe("lifecycle")
      expect(store.getOutcome("tx-invoice-1")?.verificationMethod).toBe("payment-settlement")
      expect(store.listReliabilityStates()).toHaveLength(6)
      seedReliabilityStore(store)
      expect(store.listEntities()).toHaveLength(4)
    } finally {
      store.close()
    }
  })
})
