import { describe, expect, test } from "bun:test"
import { categorizeKalshi, normalizeKalshiEvents, normalizeKalshiMarket, type KalshiEvent, type KalshiMarket } from "../src"

const event: KalshiEvent = { event_ticker: "KXFED-26OCT", category: "Economics", title: "Fed funds rate after Oct 2026 meeting?" }

const market: KalshiMarket = {
  ticker: "KXFED-26OCT-T4.00",
  title: "Will the upper bound of the federal funds rate be above 4.00% following the Oct 28, 2026 meeting?",
  market_type: "binary",
  status: "active",
  yes_bid_dollars: "0.1800",
  yes_ask_dollars: "0.2200",
  last_price_dollars: "0.2000",
  volume_24h_fp: "1500.00",
  open_interest_fp: "76327.94",
  close_time: "2026-10-28T17:55:00Z",
}

describe("kalshi normalize", () => {
  test("maps a binary market with its event's category", () => {
    expect(normalizeKalshiMarket(event, market)).toEqual({
      venue: "kalshi",
      marketId: "KXFED-26OCT-T4.00",
      question: market.title,
      category: "economy",
      tags: ["Economics"],
      outcomes: ["Yes", "No"],
      yesPrice: 0.2,
      bestBid: 0.18,
      bestAsk: 0.22,
      liquidity: 76327.94,
      volume24h: 1500,
      endDate: "2026-10-28T17:55:00Z",
    })
  })

  test("uses the mid when there is no last trade", () => {
    expect(normalizeKalshiMarket(event, { ...market, last_price_dollars: "0.0000" })?.yesPrice).toBeCloseTo(0.2)
  })

  test("drops markets it cannot trade", () => {
    expect(normalizeKalshiMarket(event, { ...market, market_type: "scalar" })).toBeNull()
    expect(normalizeKalshiMarket(event, { ...market, status: "closed" })).toBeNull()
    expect(normalizeKalshiMarket(event, { ...market, yes_ask_dollars: "0.0000" })).toBeNull()
  })

  test("flattens events and maps categories", () => {
    const markets = normalizeKalshiEvents({
      events: [
        { ...event, markets: [market, { ...market, ticker: "X", status: "closed" }] },
        { event_ticker: "E2", category: "Elections", title: "t", markets: [{ ...market, ticker: "Y" }] },
      ],
    })
    expect(markets.map((m) => [m.marketId, m.category])).toEqual([
      ["KXFED-26OCT-T4.00", "economy"],
      ["Y", "politics"],
    ])
    expect(categorizeKalshi("Something New")).toBe("other")
  })
})
