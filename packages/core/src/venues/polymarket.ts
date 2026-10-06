import type { NormalizedMarket } from "../types"

// Subset of a Gamma API market (GET /markets?include_tag=true).
export type GammaMarket = {
  id: string
  question: string
  outcomes?: string
  outcomePrices?: string
  bestBid?: number
  bestAsk?: number
  liquidityNum?: number
  volume24hr?: number
  endDate?: string
  tags?: { slug?: string }[]
}

// Non-political categories are checked in this order.
const CATEGORIES = ["politics", "sports", "crypto", "economy", "tech", "culture", "science", "weather"]
const CATEGORY_ALIASES: Record<string, string> = {
  elections: "politics",
  "global-elections": "politics",
  midterms: "politics",
  trump: "politics",
  congress: "politics",
  senate: "politics",
  "white-house": "politics",
  esports: "sports",
  finance: "economy",
  fed: "economy",
  ai: "tech",
}

// Gamma has many election and politics tags (world-elections,
// us-presidential-election, geopolitics, ...). These tags and known political
// aliases take precedence so mixed tags cannot bypass a politics deny.
const isPoliticalTag = (tag: string) =>
  tag.includes("election") || tag.includes("politic") || CATEGORY_ALIASES[tag] === "politics"

export const categorize = (tags: string[]): string => {
  if (tags.some(isPoliticalTag)) return "politics"
  for (const category of CATEGORIES) {
    if (tags.includes(category)) return category
  }
  for (const tag of tags) {
    const alias = CATEGORY_ALIASES[tag]
    if (alias) return alias
  }
  return "other"
}

const parseList = (raw: string | undefined): string[] => {
  if (!raw) return []
  try {
    const value = JSON.parse(raw)
    return Array.isArray(value) ? value.map(String) : []
  } catch {
    return []
  }
}

// Returns null for markets the loop can't trade (non-binary, no prices).
export const normalizeGammaMarket = (m: GammaMarket): NormalizedMarket | null => {
  const outcomes = parseList(m.outcomes)
  const prices = parseList(m.outcomePrices).map(Number)
  if (outcomes.length !== 2 || prices.length !== 2 || !Number.isFinite(prices[0])) return null

  const tags = (m.tags ?? []).map((t) => t.slug ?? "").filter((s) => s.length > 0)
  return {
    venue: "polymarket",
    marketId: String(m.id),
    question: m.question,
    category: categorize(tags),
    tags,
    outcomes,
    yesPrice: prices[0],
    bestBid: m.bestBid ?? 0,
    bestAsk: m.bestAsk ?? 0,
    liquidity: m.liquidityNum ?? 0,
    volume24h: m.volume24hr ?? 0,
    endDate: m.endDate ?? "",
  }
}

export const normalizeGammaMarkets = (raw: GammaMarket[]): NormalizedMarket[] =>
  raw.map(normalizeGammaMarket).filter((m): m is NormalizedMarket => m !== null)
