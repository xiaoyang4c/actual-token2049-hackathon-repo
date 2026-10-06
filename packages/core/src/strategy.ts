import { gateIntents } from "./policy"
import type { Intent, NormalizedMarket, Policy, Portfolio, Side, Signal } from "./types"

export type StrategyInput = {
  markets: NormalizedMarket[]
  signals: Signal[]
  portfolio: Portfolio
}

// A strategy pack only proposes. The policy gate decides what executes.
export type StrategyPack<P> = {
  id: string
  description: string
  defaults: P
  evaluate: (input: StrategyInput, params: P) => Intent[]
}

export type EdgeParams = {
  // Minimum (fair - ask) to propose a buy.
  minEdge: number
  minConfidence: number
  // Dollars to spend per order.
  stake: number
  maxIntents: number
  minLiquidity: number
  // Skip prices outside [minPrice, maxPrice].
  minPrice: number
  maxPrice: number
}

const round3 = (x: number) => Math.round(x * 1000) / 1000

type Candidate = { market: NormalizedMarket; side: Side; ask: number; edge: number }

const bestSide = (market: NormalizedMarket, fairYes: number): Candidate => {
  const yesAsk = market.bestAsk
  const noAsk = 1 - market.bestBid
  const yesEdge = fairYes - yesAsk
  const noEdge = 1 - fairYes - noAsk
  return yesEdge >= noEdge
    ? { market, side: "yes", ask: yesAsk, edge: yesEdge }
    : { market, side: "no", ask: noAsk, edge: noEdge }
}

const isAvailableMarket = (market: NormalizedMarket, held: Set<string>, p: EdgeParams) =>
  !held.has(`${market.venue}:${market.marketId}`) &&
  Number.isFinite(market.yesPrice) && market.yesPrice >= 0 && market.yesPrice <= 1 &&
  Number.isFinite(market.liquidity) && market.liquidity >= p.minLiquidity &&
  Number.isFinite(market.bestBid) && market.bestBid > 0 && market.bestBid < 1 &&
  Number.isFinite(market.bestAsk) && market.bestAsk > 0 && market.bestAsk < 1

const candidateIntent = (c: Candidate, p: EdgeParams): Intent | null => {
  if (c.ask < p.minPrice || c.ask > p.maxPrice) return null
  const limit = round3(c.ask)
  if (limit <= 0 || limit >= 1) return null
  const size = Math.floor(p.stake / limit)
  if (!Number.isSafeInteger(size) || size <= 0) return null
  return {
    venue: c.market.venue,
    marketId: c.market.marketId,
    side: c.side,
    size,
    limit,
    reason: `edge ${c.edge.toFixed(3)} on ${c.side} (${c.market.category})`,
  }
}

// Before buying signals, keep markets where at least one side could pass
// strategy constraints and policy with the current portfolio.
export const eligibleEdgeMarkets = (
  markets: NormalizedMarket[], policy: Policy, portfolio: Portfolio, p: EdgeParams,
): NormalizedMarket[] => {
  if (!Number.isSafeInteger(p.maxIntents) || p.maxIntents <= 0) return []
  const held = new Set(portfolio.positions.map((pos) => `${pos.venue}:${pos.marketId}`))
  return markets.filter((market) => {
    if (!isAvailableMarket(market, held, p)) return false
    const sides: Candidate[] = [
      { market, side: "yes", ask: market.bestAsk, edge: 0 },
      { market, side: "no", ask: 1 - market.bestBid, edge: 0 },
    ]
    return sides.some((side) => {
      const intent = candidateIntent(side, p)
      return intent !== null && gateIntents([intent], [market], policy, portfolio)[0].approved
    })
  })
}

// Buys whichever side a paid signal says is underpriced by at least minEdge.
export const edgeVsSignal: StrategyPack<EdgeParams> = {
  id: "edge-vs-signal",
  description: "Buy the side a paid fair-value signal says is mispriced, sized by a fixed stake.",
  defaults: {
    minEdge: 0.04,
    minConfidence: 0.5,
    stake: 20,
    maxIntents: 5,
    minLiquidity: 1000,
    minPrice: 0.05,
    maxPrice: 0.95,
  },
  evaluate: ({ markets, signals, portfolio }, p) => {
    const held = new Set(portfolio.positions.map((pos) => `${pos.venue}:${pos.marketId}`))

    const candidates: { intent: Intent; edge: number }[] = []
    for (const market of markets) {
      if (!isAvailableMarket(market, held, p)) continue
      const signal = signals.find((s) => s.venue === market.venue && s.marketId === market.marketId)
      if (!signal || !Number.isFinite(signal.fairYes) || signal.fairYes < 0 || signal.fairYes > 1 ||
        !Number.isFinite(signal.confidence) || signal.confidence < p.minConfidence) continue

      const c = bestSide(market, signal.fairYes)
      if (c.edge < p.minEdge) continue
      const intent = candidateIntent(c, p)
      if (intent) candidates.push({ intent, edge: c.edge })
    }

    return candidates
      .sort((a, b) => b.edge - a.edge)
      .slice(0, p.maxIntents)
      .map((c) => c.intent)
  },
}
