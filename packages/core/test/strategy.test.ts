import { describe, expect, test } from "bun:test"
import { edgeVsSignal, eligibleEdgeMarkets, type Signal } from "../src"
import { market, policy, portfolio } from "./fixtures"

const p = edgeVsSignal.defaults

describe("edgeVsSignal", () => {
  test("buys yes when fair is above the ask", () => {
    const intents = edgeVsSignal.evaluate(
      { markets: [market()], signals: [{ venue: "polymarket" as const, marketId: "m1", fairYes: 0.6, confidence: 0.8 }], portfolio: portfolio() },
      p,
    )
    expect(intents).toHaveLength(1)
    expect(intents[0]).toMatchObject({ side: "yes", limit: 0.51, size: Math.floor(20 / 0.51) })
  })

  test("buys no when fair is below the bid", () => {
    const [intent] = edgeVsSignal.evaluate(
      { markets: [market()], signals: [{ venue: "polymarket" as const, marketId: "m1", fairYes: 0.4, confidence: 0.8 }], portfolio: portfolio() },
      p,
    )
    expect(intent).toMatchObject({ side: "no", limit: 0.51 })
  })

  test("skips small edges, low confidence, thin books and held markets", () => {
    const run = (fairYes: number, confidence: number, over = {}, held = false) =>
      edgeVsSignal.evaluate(
        {
          markets: [market(over)],
          signals: [{ venue: "polymarket" as const, marketId: "m1", fairYes, confidence }],
          portfolio: portfolio({
            positions: held ? [{ venue: "polymarket", marketId: "m1", side: "yes", size: 1, avgPrice: 0.5 }] : [],
          }),
        },
        p,
      )
    expect(run(0.53, 0.8)).toEqual([])
    expect(run(0.7, 0.3)).toEqual([])
    expect(run(0.7, 0.8, { liquidity: 10 })).toEqual([])
    expect(run(0.7, 0.8, {}, true)).toEqual([])
  })

  test("ranks by edge and caps the count", () => {
    const markets = [market({ marketId: "a" }), market({ marketId: "b" }), market({ marketId: "c" })]
    const signals = [
      { venue: "polymarket" as const, marketId: "a", fairYes: 0.6, confidence: 1 },
      { venue: "polymarket" as const, marketId: "b", fairYes: 0.8, confidence: 1 },
      { venue: "polymarket" as const, marketId: "c", fairYes: 0.7, confidence: 1 },
    ]
    const intents = edgeVsSignal.evaluate({ markets, signals, portfolio: portfolio() }, { ...p, maxIntents: 2 })
    expect(intents.map((i) => i.marketId)).toEqual(["b", "c"])
  })

  test("matches signals by venue and market ID", () => {
    const markets = [market(), market({ venue: "kalshi" })]
    const signals: Signal[] = [{ venue: "polymarket", marketId: "m1", fairYes: 0.8, confidence: 1 }]
    expect(edgeVsSignal.evaluate({ markets, signals, portfolio: portfolio() }, p).map((i) => i.venue)).toEqual(["polymarket"])
    signals.push({ venue: "kalshi", marketId: "m1", fairYes: 0.2, confidence: 1 })
    const intents = edgeVsSignal.evaluate({ markets, signals, portfolio: portfolio() }, p)
    expect(intents.map((i) => [i.venue, i.side])).toEqual([["polymarket", "yes"], ["kalshi", "no"]])
  })

  test("an unqualified legacy signal cannot match a market", () => {
    const intents = edgeVsSignal.evaluate({
      markets: [market()], portfolio: portfolio(),
      signals: JSON.parse('[ {"marketId": "m1", "fairYes": 0.8, "confidence": 1} ]') as Signal[],
    }, p)
    expect(intents).toEqual([])
  })
})

describe("eligibleEdgeMarkets", () => {
  test("filters policy, held positions, liquidity, prices, size, and available funds before scoring", () => {
    const cases = [
      { markets: [market({ category: "politics" })], policy: policy() },
      { markets: [market({ venue: "kalshi" })], policy: policy() },
      { markets: [market()], policy: policy({ category_allow: ["sports"] }) },
      { markets: [market({ liquidity: 1 })], policy: policy() },
      { markets: [market({ yesPrice: 1.1 })], policy: policy() },
      { markets: [market({ bestBid: 0.99, bestAsk: 0.99 })], policy: policy() },
      { markets: [market()], policy: policy({ max_bet: 19 }) },
      { markets: [market()], policy: policy(), portfolio: portfolio({ cash: 19 }) },
      { markets: [market()], policy: policy(), portfolio: portfolio({ positions: [{ venue: "polymarket", marketId: "m1", side: "yes", size: 1, avgPrice: 0.5 }] }) },
    ]
    for (const c of cases) expect(eligibleEdgeMarkets(c.markets, c.policy, c.portfolio ?? portfolio(), p)).toEqual([])
    expect(eligibleEdgeMarkets([market()], policy(), portfolio(), { ...p, stake: 0 })).toEqual([])
    expect(eligibleEdgeMarkets([market()], policy(), portfolio(), { ...p, maxIntents: 0 })).toEqual([])
  })

  test("keeps a market when one side passes policy using the actual rounded order cost", () => {
    const m = market({ bestBid: 0.79, bestAsk: 0.81 })
    expect(eligibleEdgeMarkets([m], policy({ max_bet: 19.5 }), portfolio({ cash: 19.5 }), p)).toEqual([m])
    expect(eligibleEdgeMarkets([m], policy({ max_bet: 19 }), portfolio(), p)).toEqual([])
  })
})
