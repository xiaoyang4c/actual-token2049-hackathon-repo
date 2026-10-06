import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { executionOf } from "../ui/model.js"
import { start } from "./control-api"

type StoredAudit = { cycleId: string; receivedAt: string; events: unknown[] }

const withServer = async (run: (origin: string, auditFile: string) => Promise<void>) => {
  const directory = mkdtempSync(join(tmpdir(), "control-api-audit-"))
  const auditFile = join(directory, "audit.jsonl")
  const server = start(0, { auditFile, databasePath: join(directory, "agent.sqlite") })
  try {
    await run(`http://127.0.0.1:${server.port}`, auditFile)
  } finally {
    await server.stop(true)
    rmSync(directory, { recursive: true, force: true })
  }
}

const postAudit = (origin: string, body: unknown) =>
  fetch(`${origin}/audit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

const storedCycles = async (origin: string, cycleId: string): Promise<StoredAudit[]> => {
  const response = await fetch(`${origin}/audit`)
  const audit = await response.json() as StoredAudit[]
  return audit.filter((entry) => entry.cycleId === cycleId)
}

describe("control API audit", () => {
  test("recovers from a failed append and stores the retried cycle once", async () => {
    await withServer(async (origin, auditFile) => {
      const body = { cycleId: `audit-write-retry-${crypto.randomUUID()}`, events: [{ type: "cycle_end", detail: "done" }] }
      // A directory at the file path makes the first append fail.
      mkdirSync(auditFile)
      const failed = await postAudit(origin, body)
      expect(failed.status).toBe(500)
      await failed.text()
      expect(await storedCycles(origin, body.cycleId)).toEqual([])

      rmSync(auditFile, { recursive: true })
      const retried = await postAudit(origin, body)
      expect(retried.status).toBe(200)
      expect(await retried.json()).toEqual({ ok: true, events: 1 })
      const entries = await storedCycles(origin, body.cycleId)
      expect(entries).toHaveLength(1)
      expect(entries[0].events).toEqual(body.events)

      const duplicate = await postAudit(origin, body)
      expect(duplicate.status).toBe(200)
      expect(await duplicate.json()).toEqual({ ok: true, events: 1, duplicate: true })
      expect(await storedCycles(origin, body.cycleId)).toEqual(entries)
      const lines = readFileSync(auditFile, "utf8").trim().split("\n")
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0])).toEqual(entries[0])
    })
  })

  test("preserves direct and nested fill modes in memory, on disk, and in the UI", async () => {
    await withServer(async (origin, auditFile) => {
      const events = [
        { type: "fill_filled", detail: "yes 1 @ 0.4 on m1", mode: "live" },
        { type: "fill_filled", detail: "yes 2 @ 0.5 on m2", fill: { mode: "paper" } },
        { type: "fill_rejected", detail: "[PAPER] yes 1 @ 0.4 on m3 (insufficient_cash)" },
        { type: "cycle_end", detail: "done" },
      ]
      const body = { cycleId: `audit-fill-modes-${crypto.randomUUID()}`, events }
      const response = await postAudit(origin, body)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true, events: 4 })
      const entries = await storedCycles(origin, body.cycleId)
      expect(entries).toHaveLength(1)
      expect(entries[0].events).toEqual(events)
      const persisted = JSON.parse(readFileSync(auditFile, "utf8")) as StoredAudit
      expect(persisted).toEqual(entries[0])
      expect(executionOf(entries)).toEqual({ kind: "mixed", paper: 2, live: 1, unmarked: 0 })
      expect(executionOf([persisted])).toEqual(executionOf(entries))
    })
  })

  test("rejects invalid mode metadata before storing any events", async () => {
    await withServer(async (origin, auditFile) => {
      const invalidMetadata = [
        { mode: "unknown" },
        { mode: null },
        { fill: { mode: "unknown" } },
        { fill: { mode: 1 } },
        { fill: null },
      ]
      for (const [index, metadata] of invalidMetadata.entries()) {
        const body = {
          cycleId: `audit-invalid-mode-${index}-${crypto.randomUUID()}`,
          events: [
            { type: "cycle_start", detail: "started" },
            { type: "fill_filled", detail: "yes 1 @ 0.4 on m1", ...metadata },
          ],
        }
        const response = await postAudit(origin, body)
        expect(response.status).toBe(400)
        await response.text()
        expect(await storedCycles(origin, body.cycleId)).toEqual([])
      }
      expect(existsSync(auditFile)).toBe(false)
    })
  })
})
