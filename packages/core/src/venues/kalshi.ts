import type { NormalizedMarket } from "../types"

// Subset of GET /trade-api/v2/events?with_nested_markets=true.
export type KalshiMarket = {
  ticker: string
  title: string
  yes_sub_title?: string
  market_type?: string
  status?: string
  yes_bid_dollars?: string
  yes_ask_dollars?: string
  last_price_dollars?: string
  volume_24h_fp?: string
  open_interest_fp?: string
  close_time?: string
}

export type KalshiEvent = {
  event_ticker: string
  category: string
  title: string
  markets?: KalshiMarket[]
}

export type KalshiEventsResponse = { events: KalshiEvent[] }

// Kalshi's event categories, mapped onto the shared category names the policy uses.
const CATEGORY_MAP: Record<string, string> = {
  Politics: "politics",
  Elections: "politics",
  World: "politics",
  Sports: "sports",
  Economics: "economy",
  Financials: "economy",
  Crypto: "crypto",
  "Science and Technology": "tech",
  Companies: "tech",
  "Climate and Weather": "weather",
  Entertainment: "culture",
  Social: "culture",
  Health: "science",
}

export const categorizeKalshi = (category: string): string => CATEGORY_MAP[category] ?? "other"

const num = (raw: string | undefined): number => {
  const n = Number(raw)
  return Number.isFinite(n) ? n : 0
}

// Returns null for markets the loop can't trade (non-binary, inactive, no quotes).
export const normalizeKalshiMarket = (event: KalshiEvent, m: KalshiMarket): NormalizedMarket | null => {
  if (m.market_type !== "binary" || m.status !== "active") return null
  const bestBid = num(m.yes_bid_dollars)
  const bestAsk = num(m.yes_ask_dollars)
  if (bestAsk <= 0) return null

  const last = num(m.last_price_dollars)
  return {
    venue: "kalshi",
    marketId: m.ticker,
    question: m.title,
    category: categorizeKalshi(event.category),
    tags: [event.category],
    outcomes: ["Yes", "No"],
    yesPrice: last > 0 ? last : (bestBid + bestAsk) / 2,
    bestBid,
    bestAsk,
    // Open interest in contracts, each worth $1 at settlement.
    liquidity: num(m.open_interest_fp),
    volume24h: num(m.volume_24h_fp),
    endDate: m.close_time ?? "",
  }
}

export const normalizeKalshiEvents = (res: KalshiEventsResponse): NormalizedMarket[] =>
  res.events.flatMap((event) =>
    (event.markets ?? [])
      .map((m) => normalizeKalshiMarket(event, m))
      .filter((m): m is NormalizedMarket => m !== null),
  )
