// Parses GET /agent/state and GET /audit into the read-only desk view.

import { formatMoney, formatPct, formatPnl, formatPrice, formatSize, venueLabel } from "./format.js"

const SOURCES = new Set(["live", "fixture", "stale"])
const MODES = new Set(["paper", "live", "mixed", "none"])

const normalizeMode = (value) => {
  if (typeof value !== "string") return null
  const mode = value.trim().toLowerCase()
  return mode === "paper" || mode === "live" ? mode : null
}

// Workflow audit lines look like: [PAPER] yes 20 @ 0.42 on <market> (reason)
export function fillMode(event) {
  if (!event || typeof event !== "object") return null
  const detail = typeof event.detail === "string" ? event.detail : ""
  const tagged = detail.match(/^\s*\[(paper|live)\]/i)
  if (tagged) return tagged[1].toLowerCase()
  const type = typeof event.type === "string" ? event.type : ""
  if (!type.startsWith("fill")) return null
  return normalizeMode(event.mode) ?? normalizeMode(event.fill?.mode)
}

const isFillType = (event) => typeof event?.type === "string" && event.type.startsWith("fill")

export function allEvents(audit) {
  if (!Array.isArray(audit)) return []
  const events = []
  for (const entry of audit) {
    if (!entry || typeof entry !== "object") continue
    if (Array.isArray(entry.events)) {
      for (const event of entry.events) {
        if (event && typeof event === "object") events.push(event)
      }
    } else if (entry.type || entry.detail || entry.mode) {
      events.push(entry)
    }
  }
  return events
}

export function executionOf(audit) {
  let paper = 0
  let live = 0
  let unmarked = 0
  for (const event of allEvents(audit)) {
    const mode = fillMode(event)
    if (mode === "paper") paper += 1
    else if (mode === "live") live += 1
    else if (isFillType(event)) unmarked += 1
  }
  const kind = paper && live ? "mixed" : live ? "live" : paper ? "paper" : "none"
  return { kind, paper, live, unmarked }
}

const finite = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const asStrings = (value) => (Array.isArray(value) ? value.map((item) => String(item)) : [])

const presentPolicy = (policy) => {
  const p = policy && typeof policy === "object" ? policy : {}
  return {
    maxBet: formatMoney(p.max_bet),
    maxDailyLoss: formatMoney(p.max_daily_loss),
    maxDailyLossValue: finite(p.max_daily_loss),
    stopLoss: formatPct(p.stop_loss_pct),
    killSwitch: p.kill_switch === true,
    venues: asStrings(p.venues_enabled),
    allow: asStrings(p.category_allow),
    deny: asStrings(p.category_deny),
  }
}

const presentPosition = (position) => {
  const size = finite(position?.size)
  const avg = finite(position?.avgPrice)
  return {
    venue: venueLabel(position?.venue),
    marketId: String(position?.marketId ?? "—"),
    side: position?.side === "yes" || position?.side === "no" ? position.side : String(position?.side ?? "—"),
    size: formatSize(position?.size),
    avgPrice: formatPrice(position?.avgPrice),
    cost: size !== null && avg !== null ? formatMoney(size * avg) : "—",
  }
}

const presentPortfolio = (portfolio) => {
  const p = portfolio && typeof portfolio === "object" ? portfolio : {}
  const daily = finite(p.dailyPnl)
  return {
    cash: formatMoney(p.cash),
    equity: formatMoney(p.equity),
    dailyPnl: formatPnl(p.dailyPnl),
    dailyPnlValue: daily,
    pnlClass: daily === null ? "flat" : daily > 0 ? "up" : daily < 0 ? "down" : "flat",
    startOfDay: formatMoney(p.startOfDayEquity),
    highWater: formatMoney(p.highWaterMark),
    positions: Array.isArray(p.positions) ? p.positions.map(presentPosition) : [],
  }
}

const stampOf = (value) => {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return { text: "—", iso: "" }
  const text = new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
  return { text, iso: value }
}

const presentEvent = (event) => {
  const type = typeof event?.type === "string" && event.type ? event.type : "event"
  const detail = typeof event?.detail === "string" ? event.detail : ""
  const mode = fillMode(event)
  const shown = mode ? detail.replace(/^\s*\[(paper|live)\]\s*/i, "") : detail
  let status = null
  if (type === "fill_filled") status = "filled"
  else if (type === "fill_rejected") status = "rejected"
  return { type, detail: shown, mode, status, isFill: mode !== null || type.startsWith("fill") }
}

const presentCycles = (audit) => {
  if (!Array.isArray(audit)) return []
  const cycles = []
  audit.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return
    if (Array.isArray(entry.events)) {
      cycles.push({
        cycleId: String(entry.cycleId ?? `cycle-${index + 1}`),
        received: stampOf(entry.receivedAt),
        events: entry.events.filter((event) => event && typeof event === "object").map(presentEvent),
      })
      return
    }
    if (entry.type || entry.detail) {
      cycles.push({
        cycleId: String(entry.cycleId ?? `event-${index + 1}`),
        received: stampOf(entry.receivedAt),
        events: [presentEvent(entry)],
      })
    }
  })
  return cycles.reverse()
}

const shortError = (error) => {
  const text = String(error ?? "").replace(/\s+/g, " ").trim()
  if (!text) return ""
  return text.length > 180 ? text.slice(0, 177) + "…" : text
}

export function buildView(state, audit, meta = {}) {
  const source = SOURCES.has(meta.source) ? meta.source : "fixture"
  const execution = executionOf(audit)
  const mode = MODES.has(execution.kind) ? execution.kind : "none"
  return {
    source,
    error: shortError(meta.error),
    updatedAt: stampOf(meta.updatedAt),
    execution,
    mode,
    policy: presentPolicy(state?.policy),
    portfolio: presentPortfolio(state?.portfolio),
    cycles: presentCycles(audit),
  }
}
