// Control API: durable policy and paper book, plus the JSONL audit log.
import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { AgentRequestError, createAgentRuntime, type AgentRuntimeOptions } from "./agent-runtime"
import kalshiFixture from "./fixtures/kalshi-events.json"
import polymarketFixture from "./fixtures/polymarket-markets.json"
import { json, readJson, serve, type Handler } from "./lib/http"
import { reliabilityRoutes } from "./reliability/index"

const AUDIT_FILE = new URL("./.data/audit.jsonl", import.meta.url)
type AuditMode = "paper" | "live"
type AuditEvent = { type: string; detail: string; mode?: AuditMode; fill?: { mode?: AuditMode } }
type AuditRequest = { cycleId: string; events: AuditEvent[] }
type AuditEntry = AuditRequest & { receivedAt: string }

const isAuditMode = (value: unknown): value is AuditMode => value === "paper" || value === "live"

const isAuditFill = (value: unknown): value is NonNullable<AuditEvent["fill"]> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  ((value as { mode?: unknown }).mode === undefined || isAuditMode((value as { mode?: unknown }).mode))

const isAuditEvent = (value: unknown): value is AuditEvent =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as AuditEvent).type === "string" &&
  typeof (value as AuditEvent).detail === "string" &&
  ((value as AuditEvent).mode === undefined || isAuditMode((value as AuditEvent).mode)) &&
  ((value as AuditEvent).fill === undefined || isAuditFill((value as AuditEvent).fill))

const copyAuditEvent = ({ type, detail, mode, fill }: AuditEvent): AuditEvent => {
  const event: AuditEvent = { type, detail }
  if (mode !== undefined) event.mode = mode
  if (fill?.mode !== undefined) event.fill = { mode: fill.mode }
  return event
}

const isAuditRequest = (value: unknown): value is AuditRequest =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as AuditRequest).cycleId === "string" &&
  (value as AuditRequest).cycleId.length > 0 &&
  Array.isArray((value as AuditRequest).events) &&
  (value as AuditRequest).events.every(isAuditEvent)

function loadAudit(file: string | URL): AuditEntry[] {
  if (!existsSync(file)) return []
  const contents = readFileSync(file)
  const completeBytes = contents.lastIndexOf(10) + 1
  const parseEntry = (line: string): AuditEntry => {
    const value: unknown = JSON.parse(line)
    if (!isAuditRequest(value) || typeof (value as AuditEntry).receivedAt !== "string") {
      throw new Error("invalid stored audit entry")
    }
    return value as AuditEntry
  }
  // Validate completed records before repairing an interrupted final append.
  const entries = contents.subarray(0, completeBytes).toString("utf8")
    .split("\n").filter((line) => line.trim()).map(parseEntry)
  const tail = contents.subarray(completeBytes)
  if (!tail.toString("utf8").trim()) return entries
  let lastEntry: AuditEntry
  try {
    lastEntry = parseEntry(tail.toString("utf8"))
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    const path = typeof file === "string" ? file : fileURLToPath(file)
    const recoveryFile = `${path}.incomplete-${randomUUID()}`
    writeFileSync(recoveryFile, tail, { flag: "wx" })
    truncateSync(file, completeBytes)
    console.warn(`[control-api] recovered incomplete audit append; saved fragment to ${recoveryFile}`)
    return entries
  }
  // Preserve a complete record without a terminator and separate the next append.
  appendFileSync(file, "\n")
  entries.push(lastEntry)
  return entries
}

export interface ControlOptions extends AgentRuntimeOptions {
  auditFile?: string | URL
}

export function start(port: number, options: ControlOptions = {}) {
  const auditFile = options.auditFile ?? AUDIT_FILE
  mkdirSync(dirname(typeof auditFile === "string" ? auditFile : fileURLToPath(auditFile)), { recursive: true })
  const audit = loadAudit(auditFile)
  const runtime = createAgentRuntime(options)
  const handle = (handler: Handler): Handler => async (request, url) => {
    try {
      return await handler(request, url)
    } catch (error) {
      if (error instanceof AgentRequestError) return json({ error: error.message }, error.status)
      if (error instanceof SyntaxError) return json({ error: "invalid JSON" }, 400)
      throw error
    }
  }
  try {
    const server = serve("control-api", port, {
      "GET /agent/state": handle(() => json(runtime.state())),

      "POST /agent/marks": handle(async (req) => json({ portfolio: runtime.updateQuotes(await readJson<unknown>(req)) })),
      "POST /positions/close": handle(async (req) => json(runtime.closePosition(await readJson<unknown>(req)))),
      "POST /markets/resolve": handle(async (req) => json(runtime.resolveMarket(await readJson<unknown>(req)))),
      "GET /positions/history": () => json(runtime.history()),
      "GET /agent/days": handle(() => json(runtime.days())),

      "POST /agent/policy": handle(async (req) => json({ policy: runtime.updatePolicy(await readJson<unknown>(req)) })),

      "POST /agent/debug/shock": handle(async (req) => json({ portfolio: runtime.shock(await readJson<unknown>(req)) })),

      "POST /agent/debug/reset": () => json({ portfolio: runtime.reset() }),

      // The order result and book update commit together before the response.
      "POST /orders": handle(async (req) => json(runtime.submitOrders(await readJson<unknown>(req)))),

      // Checks the body before it stores anything. One entry per cycle, so a
      // repeated POST from several CRE nodes is logged once.
      "POST /audit": handle(async (req) => {
        const body = await readJson<unknown>(req)
        if (!isAuditRequest(body)) {
          return json({ error: "body must be { cycleId: string, events: { type: string, detail: string }[] }; optional mode and fill.mode must be paper or live" }, 400)
        }
        if (audit.some((e) => e.cycleId === body.cycleId)) {
          return json({ ok: true, events: body.events.length, duplicate: true })
        }
        const entry: AuditEntry = {
          receivedAt: new Date().toISOString(),
          cycleId: body.cycleId,
          events: body.events.map(copyAuditEvent),
        }
        appendFileSync(auditFile, JSON.stringify(entry) + "\n")
        audit.push(entry)
        return json({ ok: true, events: entry.events.length })
      }),

      "GET /audit": () => json(audit),

      // Offline stand-ins for the venue read APIs.
      "GET /fixtures/polymarket/markets": () => json(polymarketFixture),
      "GET /fixtures/kalshi/events": () => json(kalshiFixture),

      // Reliability marketplace reads (plumbing for the UI lane). Each
      // lane registers its own routes through services/reliability. The
      // trading routes above stay unchanged.
      ...Object.fromEntries(
        reliabilityRoutes.map((route) => [`${route.method} ${route.path}`, route.handler]),
      ),
    })
    return {
      port: server.port!,
      stop(force = false) {
        const stopped = server.stop(force)
        if (stopped instanceof Promise) return stopped.finally(() => runtime.close())
        runtime.close()
      },
    }
  } catch (error) {
    runtime.close()
    throw error
  }
}
