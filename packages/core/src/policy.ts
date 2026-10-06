import type { Halt, Intent, NormalizedMarket, Policy, PolicyDecision, Portfolio } from "./types"

const invalidStateReasons = (policy: Policy, portfolio: Portfolio): string[] => {
  const reasons: string[] = []
  if (!Number.isFinite(policy.max_bet) || policy.max_bet < 0) reasons.push("invalid_policy: max_bet")
  if (!Number.isFinite(policy.max_daily_loss) || policy.max_daily_loss < 0) {
    reasons.push("invalid_policy: max_daily_loss")
  }
  if (!Number.isFinite(policy.stop_loss_pct) || policy.stop_loss_pct < 0 || policy.stop_loss_pct > 1) {
    reasons.push("invalid_policy: stop_loss_pct")
  }
  for (const field of ["cash", "equity", "startOfDayEquity", "highWaterMark", "dailyPnl"] as const) {
    if (!Number.isFinite(portfolio[field])) reasons.push(`invalid_portfolio: ${field}`)
  }
  return reasons
}

// Agent-wide stops. Invalid numeric state halts before loss comparisons.
// When halted, the loop places no orders and buys no data.
export const checkHalt = (policy: Policy, portfolio: Portfolio): Halt => {
  const reasons: string[] = []
  if (policy.kill_switch) reasons.push("kill_switch_on")
  const invalidReasons = invalidStateReasons(policy, portfolio)
  if (invalidReasons.length > 0) return { halted: true, reasons: [...reasons, ...invalidReasons] }

  if (portfolio.dailyPnl <= -policy.max_daily_loss) {
    reasons.push(`daily_loss_limit_hit: pnl ${portfolio.dailyPnl.toFixed(2)} <= -${policy.max_daily_loss}`)
  }
  const floor = portfolio.highWaterMark * (1 - policy.stop_loss_pct)
  if (portfolio.equity <= floor) {
    reasons.push(`stop_loss_triggered: equity ${portfolio.equity.toFixed(2)} <= ${floor.toFixed(2)}`)
  }
  return { halted: reasons.length > 0, reasons }
}

const categoryReasons = (policy: Policy, category: string): string[] => {
  if (policy.category_deny.includes(category)) return [`category_denied: ${category}`]
  if (policy.category_allow.length > 0 && !policy.category_allow.includes(category)) {
    return [`category_not_allowed: ${category}`]
  }
  return []
}

const isValidIntent = (value: unknown): value is Intent => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const intent = value as Record<string, unknown>
  return (
    (intent.venue === "polymarket" || intent.venue === "kalshi") &&
    typeof intent.marketId === "string" && intent.marketId.trim().length > 0 &&
    (intent.side === "yes" || intent.side === "no") &&
    typeof intent.size === "number" && Number.isFinite(intent.size) && intent.size > 0 &&
    typeof intent.limit === "number" && Number.isFinite(intent.limit) && intent.limit > 0 && intent.limit < 1 &&
    typeof intent.reason === "string"
  )
}

// Checks every proposed intent in order. Cash already committed to earlier
// approved intents in the same cycle counts against later ones.
// Only approved intents count toward the optional execution limit.
// Malformed intents are rejected before lookup or arithmetic, without spending cash.
export const gateIntents = (
  intents: Intent[],
  markets: NormalizedMarket[],
  policy: Policy,
  portfolio: Portfolio,
  maxApproved = intents.length,
): PolicyDecision[] => {
  const halt = checkHalt(policy, portfolio)
  const invalidMaxApproved = !Number.isSafeInteger(maxApproved) || maxApproved < 0
  let cash = portfolio.cash
  let approvedCount = 0

  return intents.map((intent) => {
    const reasons = [...halt.reasons]
    if (invalidMaxApproved) reasons.push("invalid_intent_limit")
    if (!isValidIntent(intent)) return { intent, approved: false, reasons: [...reasons, "invalid_order"] }

    const cost = intent.size * intent.limit
    if (!Number.isFinite(cost) || cost <= 0) {
      return { intent, approved: false, reasons: [...reasons, "invalid_order"] }
    }
    const market = markets.find((m) => m.venue === intent.venue && m.marketId === intent.marketId)

    if (!policy.venues_enabled.includes(intent.venue)) reasons.push(`venue_disabled: ${intent.venue}`)
    if (!market) {
      reasons.push("unknown_market")
    } else {
      reasons.push(...categoryReasons(policy, market.category))
    }
    if (Number.isFinite(policy.max_bet) && cost > policy.max_bet) {
      reasons.push(`max_bet_exceeded: ${cost.toFixed(2)} > ${policy.max_bet}`)
    }
    if (Number.isFinite(cash) && cost > cash) {
      reasons.push(`insufficient_cash: ${cost.toFixed(2)} > ${cash.toFixed(2)}`)
    }
    if (!invalidMaxApproved && approvedCount >= maxApproved) reasons.push("intent_limit_reached")

    const approved = reasons.length === 0
    if (approved) {
      cash -= cost
      approvedCount += 1
    }
    return { intent, approved, reasons }
  })
}
