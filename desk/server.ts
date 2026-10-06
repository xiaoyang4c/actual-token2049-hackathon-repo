// Agent Desk: a local operator frontend for the Token2049 agent runtime.
//
//   bun run server.ts        then open http://localhost:8800
//
// The backend lives untouched in the repo root. This process:
//   1. starts `bun run services` there if the services are not already up,
//   2. proxies the browser to the control API, payment service and market feed,
//   3. runs agent cycles itself, step for step like cre/agent-loop/workflow.ts,
//      because the real CRE simulator needs the Chainlink CLI and a cre login.

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  checkHalt, edgeVsSignal, eligibleEdgeMarkets, gateIntents,
  normalizeGammaMarkets, normalizeKalshiEvents,
  type EdgeParams, type GammaMarket, type KalshiEventsResponse, type NormalizedMarket,
  type Policy, type Portfolio, type Signal, type Venue,
} from "../packages/core/src"

const PORT = Number(process.env.DESK_PORT ?? 8800)
const REPO = join(import.meta.dir, "..")
const SETTINGS_FILE = join(import.meta.dir, ".desk-settings.json")
const BUN = process.execPath

const baseConfig = JSON.parse(readFileSync(join(REPO, "cre/agent-loop/config.local.json"), "utf8"))
const URLS = {
  control: baseConfig.controlApiUrl as string,
  cardano: baseConfig.cardanoAgentUrl as string,
  score: baseConfig.scoreUrl as string,
  feed: "http://localhost:8790",
  venues: baseConfig.venueUrls as Record<Venue, string>,
}

// ─── Settings the operator can change from the desk ──────────
type Settings = { strategy: EdgeParams; maxDataPaymentLovelace: number }
const defaults: Settings = { strategy: { ...baseConfig.strategy }, maxDataPaymentLovelace: baseConfig.maxDataPaymentLovelace }
let settings: Settings = defaults
try {
  if (existsSync(SETTINGS_FILE)) settings = { ...defaults, ...JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) }
} catch { settings = defaults }

const parseSettings = (body: any): Settings => {
  const s = body?.strategy ?? {}
  const num = (v: unknown, min: number, max: number, label: string) => {
    const n = Number(v)
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label} must be between ${min} and ${max}`)
    return n
  }
  const strategy: EdgeParams = {
    minEdge: num(s.minEdge, 0, 1, "Minimum edge"),
    minConfidence: num(s.minConfidence, 0, 1, "Minimum confidence"),
    stake: num(s.stake, 0.01, 1e6, "Stake"),
    maxIntents: Math.round(num(s.maxIntents, 0, 100, "Orders per cycle")),
    minLiquidity: num(s.minLiquidity, 0, 1e12, "Minimum liquidity"),
    minPrice: num(s.minPrice, 0, 1, "Lowest price"),
    maxPrice: num(s.maxPrice, 0, 1, "Highest price"),
  }
  if (strategy.minPrice > strategy.maxPrice) throw new Error("Lowest price must not exceed highest price")
  const cap = Math.round(num(body?.maxDataPaymentLovelace, 0, 1e15, "Data payment cap"))
  return { strategy, maxDataPaymentLovelace: cap }
}

// ─── Backend process ─────────────────────────────────────────
let child: ReturnType<typeof Bun.spawn> | null = null
const logs: string[] = []
// The desk's own health checks and polling reads would flood the log panel.
const HEALTH_LINE = /GET \/agent\/state -> 200|GET \/wallet -> 200|POST \/score -> 400|GET \/markets\/(status|polymarket|kalshi) -> 200|GET \/(audit|receipts|agent\/days|positions\/history) -> 200/
const pushLog = (line: string) => {
  for (const l of line.split("\n")) if (l.trim() && !HEALTH_LINE.test(l)) logs.push(l)
  while (logs.length > 200) logs.shift()
}
const pipe = async (stream: ReadableStream<Uint8Array> | null) => {
  if (!stream) return
  const decoder = new TextDecoder()
  for await (const chunk of stream) pushLog(decoder.decode(chunk))
}

const ping = async (url: string, init?: RequestInit) => {
  try {
    await fetch(url, { ...init, signal: AbortSignal.timeout(800) })
    return true
  } catch { return false }
}

const serviceHealth = async () => {
  const [control, cardano, score, feed] = await Promise.all([
    ping(`${URLS.control}/agent/state`),
    ping(`${URLS.cardano}/wallet`),
    ping(URLS.score, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }),
    ping(`${URLS.feed}/markets/status`),
  ])
  return { control, cardano, score, feed }
}

const startBackend = async () => {
  const h = await serviceHealth()
  if (Object.values(h).every(Boolean)) return "already running"
  if (child) return "starting"
  pushLog("[desk] starting backend: bun run services")
  // The repo's npm scripts call `bun` by name, so put this Bun on the PATH.
  const env = { ...process.env, PATH: `${dirname(BUN)}:${process.env.PATH ?? ""}` }
  child = Bun.spawn([BUN, "run", "services"], { cwd: REPO, stdout: "pipe", stderr: "pipe", env })
  pipe(child.stdout as ReadableStream<Uint8Array>)
  pipe(child.stderr as ReadableStream<Uint8Array>)
  child.exited.then((code) => {
    pushLog(`[desk] backend exited with code ${code}`)
    child = null
  })
  return "started"
}

const stopBackend = () => {
  if (!child) return "not managed by the desk"
  child.kill()
  return "stopping"
}

const shutdown = () => {
  child?.kill()
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

// ─── Cycle runner (mirrors cre/agent-loop/workflow.ts) ───────
type AuditEvent = { type: string; detail: string }
type CycleResult = { cycleId: string; startedAt: string; finishedAt: string; summary: string; events: AuditEvent[] }

const getJson = async <T>(url: string): Promise<T> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`)
  return res.json() as Promise<T>
}
const postJson = async <T>(url: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  })
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T }
}

const readMarkets = async (policy: Policy, record?: (t: string, d: string) => void) => {
  const markets: NormalizedMarket[] = []
  const readers: [Venue, (raw: unknown) => NormalizedMarket[]][] = [
    ["polymarket", (raw) => normalizeGammaMarkets(raw as GammaMarket[])],
    ["kalshi", (raw) => normalizeKalshiEvents(raw as KalshiEventsResponse)],
  ]
  for (const [venue, normalize] of readers) {
    const url = URLS.venues[venue]
    if (!url || !policy.venues_enabled.includes(venue)) continue
    try {
      const read = normalize(await getJson(url))
      markets.push(...read)
      record?.("markets", `${venue}: ${read.length} binary markets`)
    } catch (err) {
      record?.("venue_error", `${venue}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return markets
}

let cycleRunning = false
const history: CycleResult[] = []

const runCycle = async (): Promise<CycleResult> => {
  if (cycleRunning) throw Object.assign(new Error("A cycle is already running"), { status: 409 })
  cycleRunning = true
  const startedAt = new Date().toISOString()
  const cycleId = `cycle-${startedAt}`
  const events: AuditEvent[] = []
  const record = (type: string, detail: string) => events.push({ type, detail })
  const { strategy, maxDataPaymentLovelace } = settings

  const run = async (): Promise<string> => {
    record("cycle_start", cycleId)
    const { policy, portfolio } = await getJson<{ policy: Policy; portfolio: Portfolio }>(`${URLS.control}/agent/state`)
    record("state", `cash ${portfolio.cash.toFixed(2)}, equity ${portfolio.equity.toFixed(2)}, positions ${portfolio.positions.length}`)

    const halt = checkHalt(policy, portfolio)
    if (halt.halted) {
      record("halted", halt.reasons.join("; "))
      return "halted: no data purchased, no orders placed"
    }

    const markets = await readMarkets(policy, record)
    if (markets.length === 0) return "no markets"
    const eligible = eligibleEdgeMarkets(markets, policy, portfolio, strategy)
    record("eligible_markets", `${eligible.length} of ${markets.length} markets can pass strategy and policy`)
    if (eligible.length === 0) return "no eligible markets: no data purchased, no orders placed"

    const scoreBody = { markets: eligible.map((m) => ({ venue: m.venue, marketId: m.marketId, yesPrice: m.yesPrice })) }
    const quote = await postJson<{ signals?: Signal[]; accepts?: any[] }>(URLS.score, scoreBody)
    let signals: Signal[] = []
    if (quote.status === 200) {
      signals = quote.body.signals ?? []
    } else {
      const req = quote.body.accepts?.[0]
      if (quote.status !== 402 || !req) throw new Error(`score quote failed: ${quote.status}`)
      const amount = typeof req.maxAmountRequired === "string" && /^\d+$/.test(req.maxAmountRequired) ? Number(req.maxAmountRequired) : NaN
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        record("payment_refused", "invalid payment amount: expected positive integer lovelace")
        return "invalid data payment: no orders placed"
      }
      record("x402_quote", `${amount} ${req.asset} on ${req.network} to ${req.payTo} for ${req.resource}`)
      if (amount > maxDataPaymentLovelace) {
        record("payment_refused", `${amount} > cap ${maxDataPaymentLovelace}`)
        return "data too expensive: no orders placed"
      }
      const pay = await postJson<any>(`${URLS.cardano}/pay`, { idempotencyKey: `${cycleId}:score`, requirement: req })
      if (pay.status !== 200) throw new Error(`payment failed: ${pay.status} ${pay.body?.error ?? ""}`)
      record("cardano_payment", `receipt ${pay.body.receipt.receiptId}, tx ${String(pay.body.receipt.txHash).slice(0, 16)}… (escrowed)`)
      const paid = await postJson<{ signals: Signal[] }>(URLS.score, scoreBody, { "X-PAYMENT": pay.body.xPayment })
      if (paid.status !== 200) throw new Error(`paid score request failed: ${paid.status}`)
      signals = paid.body.signals
    }
    record("signals", `${signals.length} fair-value scores received`)

    const intents = edgeVsSignal.evaluate({ markets: eligible, signals, portfolio }, { ...strategy, maxIntents: eligible.length })
    const decisions = gateIntents(intents, eligible, policy, portfolio, strategy.maxIntents)
    for (const d of decisions) {
      const m = markets.find((x) => x.venue === d.intent.venue && x.marketId === d.intent.marketId)
      const what = `${d.intent.side} ${d.intent.size} @ ${d.intent.limit} "${m?.question ?? d.intent.marketId}" [${m?.category ?? "?"}]`
      record(d.approved ? "policy_approved" : "policy_blocked", d.approved ? what : `${what} -> ${d.reasons.join(", ")}`)
    }
    const approved = decisions.filter((d) => d.approved)
    if (approved.length === 0) return `${intents.length} proposed, 0 approved`

    const orders = approved.map((d, i) => ({ idempotencyKey: `${cycleId}:order:${i}`, intent: d.intent }))
    const res = await postJson<{ fills: any[] }>(`${URLS.control}/orders`, { cycleId, orders })
    if (res.status !== 200) throw new Error(`orders failed: ${res.status}`)
    for (const f of res.body.fills) {
      record(`fill_${f.status}`, `[${String(f.mode).toUpperCase()}] ${f.side} ${f.size} @ ${f.price} on ${f.marketId} (${f.reason})`)
    }
    const filled = res.body.fills.filter((f) => f.status === "filled")
    const modes = [...new Set(filled.map((f) => f.mode))].sort()
    const execution = modes.length === 0 ? "no fills" : modes.length === 1 ? modes[0] : `mixed: ${modes.join("/")}`
    return `${intents.length} proposed, ${approved.length} approved, ${filled.length} filled (${execution})`
  }

  let summary: string
  try {
    summary = await run()
  } catch (err) {
    record("cycle_error", err instanceof Error ? err.message : String(err))
    summary = "cycle failed"
  }
  record("cycle_end", summary)
  await postJson(`${URLS.control}/audit`, { cycleId, events }).catch(() => {})
  cycleRunning = false
  const result = { cycleId, startedAt, finishedAt: new Date().toISOString(), summary, events }
  history.unshift(result)
  history.length = Math.min(history.length, 30)
  return result
}

// ─── Auto-run ────────────────────────────────────────────────
const auto = { enabled: false, seconds: 60, nextAt: 0 }
let autoTimer: ReturnType<typeof setTimeout> | null = null
const scheduleAuto = () => {
  if (autoTimer) clearTimeout(autoTimer)
  autoTimer = null
  if (!auto.enabled) { auto.nextAt = 0; return }
  auto.nextAt = Date.now() + auto.seconds * 1000
  autoTimer = setTimeout(async () => {
    if (!cycleRunning) await runCycle().catch((e) => pushLog(`[desk] auto cycle failed: ${e.message}`))
    scheduleAuto()
  }, auto.seconds * 1000)
}

// ─── HTTP ────────────────────────────────────────────────────
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } })

const forward = async (target: string, req: Request) => {
  try {
    const init: RequestInit = { method: req.method, headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000) }
    if (req.method === "POST") init.body = await req.text()
    const res = await fetch(target, init)
    return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store" } })
  } catch (err) {
    return json({ error: "backend unreachable", detail: String(err) }, 502)
  }
}

const PROXY: Record<string, string> = {
  "GET /api/audit": `${URLS.control}/audit`,
  "GET /api/days": `${URLS.control}/agent/days`,
  "GET /api/history": `${URLS.control}/positions/history`,
  "POST /api/policy": `${URLS.control}/agent/policy`,
  "POST /api/shock": `${URLS.control}/agent/debug/shock`,
  "POST /api/reset": `${URLS.control}/agent/debug/reset`,
  "POST /api/close": `${URLS.control}/positions/close`,
  "POST /api/resolve": `${URLS.control}/markets/resolve`,
  "GET /api/receipts": `${URLS.cardano}/receipts`,
  "GET /api/wallet": `${URLS.cardano}/wallet`,
  "GET /api/feed": `${URLS.feed}/markets/status`,
}

// v1 (web/) is served at /, v2 (web-v2/) at /v2. Each builds to its own dist.
const DIST = join(import.meta.dir, "web", "dist")
const DIST_V2 = join(import.meta.dir, "web-v2", "dist")
const staticFile = (pathname: string) => {
  const v2 = pathname === "/v2" || pathname.startsWith("/v2/")
  const path = v2 ? pathname.slice(3) || "/" : pathname
  const rel = path === "/" ? "index.html" : path.slice(1)
  if (rel.includes("..")) return null
  const file = Bun.file(join(v2 ? DIST_V2 : DIST, rel))
  return file.size > 0 ? file : null
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url)
    const key = `${req.method} ${url.pathname}`
    try {
      if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
        const file = staticFile(url.pathname)
        if (file) {
          const cache = /^\/(v2\/)?assets\//.test(url.pathname) ? "public, max-age=31536000, immutable" : "no-store"
          return new Response(file, { headers: { "cache-control": cache } })
        }
      }
      if (PROXY[key]) return forward(PROXY[key], req)

      switch (key) {
        case "GET /api/status":
          return json({
            services: await serviceHealth(), managed: Boolean(child), logs: logs.slice(-60),
            auto: { ...auto, running: cycleRunning }, settings, defaults, cycles: history.slice(0, 10),
          })
        case "POST /api/backend/start": return json({ result: await startBackend() })
        case "POST /api/backend/stop": return json({ result: stopBackend() })
        case "GET /api/state": {
          const res = await fetch(`${URLS.control}/agent/state`, { signal: AbortSignal.timeout(3000) })
          const state = await res.json()
          if (!res.ok) return json(state, res.status)
          return json({ ...state, halt: checkHalt(state.policy, state.portfolio) })
        }
        case "GET /api/markets": {
          const state = await getJson<{ policy: Policy; portfolio: Portfolio }>(`${URLS.control}/agent/state`)
          const all = await readMarkets({ ...state.policy, venues_enabled: ["polymarket", "kalshi"] })
          const eligible = new Set(eligibleEdgeMarkets(all, state.policy, state.portfolio, settings.strategy).map((m) => `${m.venue}:${m.marketId}`))
          const held = new Set(state.portfolio.positions.map((p) => `${p.venue}:${p.marketId}`))
          const p = state.policy
          return json(all.map((m) => {
            const blocked: string[] = []
            if (!p.venues_enabled.includes(m.venue)) blocked.push("venue off")
            if (p.category_deny.includes(m.category)) blocked.push(`${m.category} denied`)
            else if (p.category_allow.length && !p.category_allow.includes(m.category)) blocked.push(`${m.category} not allowed`)
            return { ...m, eligible: eligible.has(`${m.venue}:${m.marketId}`), held: held.has(`${m.venue}:${m.marketId}`), blocked }
          }))
        }
        case "POST /api/cycle": return json(await runCycle())
        case "POST /api/auto": {
          const body = await req.json() as { enabled?: boolean; seconds?: number }
          const seconds = Number(body.seconds ?? auto.seconds)
          if (!Number.isFinite(seconds) || seconds < 10 || seconds > 3600) return json({ error: "Interval must be 10 to 3600 seconds" }, 400)
          auto.enabled = Boolean(body.enabled)
          auto.seconds = Math.round(seconds)
          scheduleAuto()
          return json({ auto })
        }
        case "POST /api/settings": {
          const body = await req.json()
          settings = body?.reset ? defaults : parseSettings(body)
          writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))
          return json({ settings })
        }
      }
      return json({ error: "not found" }, 404)
    } catch (err: any) {
      return json({ error: err?.message ?? String(err) }, err?.status ?? 502)
    }
  },
})

console.log(`Agent Desk     http://localhost:${PORT}`)
console.log(`Backend repo   ${REPO}`)
startBackend().then((r) => console.log(`Backend        ${r}`))
