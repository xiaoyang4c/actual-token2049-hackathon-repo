import type { NormalizedMarket, Policy, Portfolio } from "../src"

export const market = (over: Partial<NormalizedMarket> = {}): NormalizedMarket => ({
  venue: "polymarket",
  marketId: "m1",
  question: "Will it happen?",
  category: "economy",
  tags: ["economy"],
  outcomes: ["Yes", "No"],
  yesPrice: 0.5,
  bestBid: 0.49,
  bestAsk: 0.51,
  liquidity: 50_000,
  volume24h: 10_000,
  endDate: "2026-12-31T00:00:00Z",
  ...over,
})

export const policy = (over: Partial<Policy> = {}): Policy => ({
  max_bet: 25,
  max_daily_loss: 100,
  category_allow: [],
  category_deny: ["politics"],
  venues_enabled: ["polymarket"],
  stop_loss_pct: 0.2,
  kill_switch: false,
  ...over,
})

export const portfolio = (over: Partial<Portfolio> = {}): Portfolio => ({
  cash: 1000,
  equity: 1000,
  startOfDayEquity: 1000,
  highWaterMark: 1000,
  dailyPnl: 0,
  positions: [],
  ...over,
})
