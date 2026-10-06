import { describe, expect, test } from "bun:test"
import { categorize, normalizeGammaMarket, normalizeGammaMarkets } from "../src"

const gamma = {
  id: "601819",
  question: "Will Lula win the 2026 Brazilian presidential election?",
  outcomes: '["Yes", "No"]',
  outcomePrices: '["0.425", "0.575"]',
  bestBid: 0.42,
  bestAsk: 0.43,
  liquidityNum: 250000,
  volume24hr: 90000,
  endDate: "2026-10-04T12:00:00Z",
  tags: [{ slug: "macro-election-2" }, { slug: "politics" }, { slug: "brazil" }],
}

describe("polymarket normalize", () => {
  test("maps a binary gamma market", () => {
    expect(normalizeGammaMarket(gamma)).toEqual({
      venue: "polymarket",
      marketId: "601819",
      question: gamma.question,
      category: "politics",
      tags: ["macro-election-2", "politics", "brazil"],
      outcomes: ["Yes", "No"],
      yesPrice: 0.425,
      bestBid: 0.42,
      bestAsk: 0.43,
      liquidity: 250000,
      volume24h: 90000,
      endDate: "2026-10-04T12:00:00Z",
    })
  })

  test("drops markets it cannot trade", () => {
    expect(normalizeGammaMarket({ ...gamma, outcomes: '["A","B","C"]' })).toBeNull()
    expect(normalizeGammaMarket({ ...gamma, outcomePrices: undefined })).toBeNull()
    expect(normalizeGammaMarkets([gamma, { ...gamma, outcomePrices: "garbage" }])).toHaveLength(1)
  })

  test("categorize prefers known categories, then aliases for non-political tags", () => {
    expect(categorize(["esports", "valorant", "sports"])).toBe("sports")
    expect(categorize(["recurring", "fed", "fomc"])).toBe("economy")
    expect(categorize(["global-elections"])).toBe("politics")
    expect(categorize(["weird"])).toBe("other")
  })

  test("categorize maps any election or politics tag to politics", () => {
    expect(categorize(["world-elections", "brazil"])).toBe("politics")
    expect(categorize(["us-presidential-election"])).toBe("politics")
    expect(categorize(["geopolitics"])).toBe("politics")
    expect(categorize(["midterms", "indiana"])).toBe("politics")
  })

  test("political tags and aliases take precedence regardless of tag order", () => {
    const politicalTags = [
      "politics", "elections", "global-elections", "midterms", "trump",
      "congress", "senate", "white-house", "world-elections",
      "us-presidential-election", "geopolitics",
    ]
    for (const politicalTag of politicalTags) {
      for (const otherTag of ["sports", "esports"]) {
        expect(categorize([otherTag, politicalTag])).toBe("politics")
        expect(categorize([politicalTag, otherTag])).toBe("politics")
      }
    }
  })
})
