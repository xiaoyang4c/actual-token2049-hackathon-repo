// Shared types for the agent loop. Kept free of null/undefined fields so the
// values pass cleanly through CRE consensus aggregation.

export type Venue = "polymarket" | "kalshi"

export type NormalizedMarket = {
  venue: Venue
  marketId: string
  question: string
  // Policy category mapped from the venue metadata, or "other".
  category: string
  tags: string[]
  // Binary markets only. outcomes[0] is the "yes" side.
  outcomes: string[]
  yesPrice: number
  bestBid: number
  bestAsk: number
  liquidity: number
  volume24h: number
  endDate: string
}

export type Side = "yes" | "no"

export type Intent = {
  venue: Venue
  marketId: string
  side: Side
  // Number of shares (contracts).
  size: number
  // Max price per share, 0..1.
  limit: number
  reason: string
}

export type Policy = {
  max_bet: number
  max_daily_loss: number
  category_allow: string[]
  category_deny: string[]
  venues_enabled: Venue[]
  stop_loss_pct: number
  kill_switch: boolean
}

export type Position = {
  venue: Venue
  marketId: string
  side: Side
  size: number
  avgPrice: number
}

export type Portfolio = {
  cash: number
  equity: number
  startOfDayEquity: number
  // Equity the stop-loss is measured from.
  highWaterMark: number
  dailyPnl: number
  positions: Position[]
}

export type Signal = {
  venue: Venue
  marketId: string
  // Provider's estimate of P(outcomes[0]).
  fairYes: number
  confidence: number
}

// Venue and market ID together identify a market in the scoring protocol.
export type ScoreMarket = Pick<NormalizedMarket, "venue" | "marketId" | "yesPrice">
export type ScoreRequest = { markets: ScoreMarket[] }

export type PolicyDecision = {
  intent: Intent
  approved: boolean
  reasons: string[]
}

export type Halt = {
  halted: boolean
  reasons: string[]
}
