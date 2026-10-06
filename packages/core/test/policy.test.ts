import { describe, expect, test } from "bun:test"
import { checkHalt, gateIntents, normalizeGammaMarket, type Intent, type Policy, type Portfolio } from "../src"
import { market, policy, portfolio } from "./fixtures"

const intent = (over: Partial<Intent> = {}): Intent => ({
  venue: "polymarket",
  marketId: "m1",
  side: "yes",
  size: 20,
  limit: 0.5,
  reason: "test",
  ...over,
})

const invalidNumbers: [string, unknown][] = [
  ["NaN", NaN],
  ["Infinity", Infinity],
  ["-Infinity", -Infinity],
  ["numeric string", "20"],
  ["null", null],
  ["undefined", undefined],
  ["bigint", 20n],
  ["symbol", Symbol("number")],
]

describe("checkHalt", () => {
  test("not halted by default", () => {
    expect(checkHalt(policy(), portfolio()).halted).toBe(false)
  })

  test("kill switch halts", () => {
    expect(checkHalt(policy({ kill_switch: true }), portfolio()).reasons).toEqual(["kill_switch_on"])
  })

  test("daily loss limit halts", () => {
    const halt = checkHalt(policy({ max_daily_loss: 50 }), portfolio({ dailyPnl: -50 }))
    expect(halt.halted).toBe(true)
    expect(halt.reasons[0]).toStartWith("daily_loss_limit_hit")
  })

  test("stop loss halts at the drawdown floor", () => {
    const halt = checkHalt(policy({ stop_loss_pct: 0.2 }), portfolio({ equity: 800, highWaterMark: 1000 }))
    expect(halt.reasons.some((r) => r.startsWith("stop_loss_triggered"))).toBe(true)
    expect(checkHalt(policy(), portfolio({ equity: 801 })).halted).toBe(false)
  })

  for (const field of ["max_bet", "max_daily_loss", "stop_loss_pct"] as const) {
    test.each(invalidNumbers)(`halts for ${field} set to %s`, (label, value) => {
      const halt = checkHalt(policy({ [field]: value } as Partial<Policy>), portfolio())
      expect(halt.halted).toBe(true)
      expect(halt.reasons).toContain(`invalid_policy: ${field}`)
    })
  }

  test.each([
    ["max_bet", -1],
    ["max_daily_loss", -1],
    ["stop_loss_pct", -0.01],
    ["stop_loss_pct", 1.01],
  ] as const)("halts for out-of-range %s (%s)", (field, value) => {
    expect(checkHalt(policy({ [field]: value }), portfolio()).reasons).toContain(`invalid_policy: ${field}`)
  })

  for (const field of ["cash", "equity", "startOfDayEquity", "highWaterMark", "dailyPnl"] as const) {
    test.each(invalidNumbers)(`halts for ${field} set to %s`, (label, value) => {
      const halt = checkHalt(policy(), portfolio({ [field]: value } as Partial<Portfolio>))
      expect(halt.halted).toBe(true)
      expect(halt.reasons).toContain(`invalid_portfolio: ${field}`)
    })
  }

  test.each([
    [-50.01, true],
    [-50, true],
    [-49.99, false],
  ] as const)("daily loss boundary at pnl %s", (dailyPnl, halted) => {
    expect(checkHalt(policy({ max_daily_loss: 50 }), portfolio({ dailyPnl })).halted).toBe(halted)
  })

  test.each([
    [799.99, true],
    [800, true],
    [800.01, false],
  ] as const)("drawdown boundary at equity %s", (equity, halted) => {
    expect(checkHalt(policy(), portfolio({ equity })).halted).toBe(halted)
  })

  test("accepts zero policy limits and stop-loss endpoints", () => {
    const state = portfolio({ equity: 1001, dailyPnl: 1 })
    expect(checkHalt(policy({ max_bet: 0, max_daily_loss: 0, stop_loss_pct: 0 }), state).halted).toBe(false)
    expect(checkHalt(policy({ stop_loss_pct: 1 }), portfolio()).halted).toBe(false)
  })
})

describe("gateIntents", () => {
  test.each(["polymarket", "kalshi"] as const)("approves both sides on enabled venue %s", (venue) => {
    for (const side of ["yes", "no"] as const) {
      const [decision] = gateIntents(
        [intent({ venue, side })],
        [market({ venue })],
        policy({ venues_enabled: [venue] }),
        portfolio(),
      )
      expect(decision.approved).toBe(true)
      expect(decision.reasons).toEqual([])
    }
  })

  test("blocks a denied category", () => {
    const [d] = gateIntents([intent()], [market({ category: "politics" })], policy(), portfolio())
    expect(d.approved).toBe(false)
    expect(d.reasons).toEqual(["category_denied: politics"])
  })

  test("blocks normalized markets with mixed political and non-political tags", () => {
    for (const tags of [["sports", "world-elections"], ["crypto", "trump"], ["esports", "geopolitics"]]) {
      const normalized = normalizeGammaMarket({
        id: "m1",
        question: "Political market with mixed tags",
        outcomes: '["Yes", "No"]',
        outcomePrices: '["0.5", "0.5"]',
        tags: tags.map((slug) => ({ slug })),
      })
      if (normalized === null) throw new Error("expected a binary market")
      const [decision] = gateIntents([intent()], [normalized], policy(), portfolio())
      expect(decision.approved).toBe(false)
      expect(decision.reasons).toEqual(["category_denied: politics"])
    }
  })

  test("enforces the allowlist when set", () => {
    const [d] = gateIntents([intent()], [market({ category: "sports" })], policy({ category_allow: ["economy"] }), portfolio())
    expect(d.reasons).toEqual(["category_not_allowed: sports"])
  })

  test("rejects over max_bet and disabled venues", () => {
    const [d] = gateIntents(
      [intent({ venue: "kalshi", size: 100 })],
      [market({ venue: "kalshi" })],
      policy(),
      portfolio(),
    )
    expect(d.reasons).toContain("venue_disabled: kalshi")
    expect(d.reasons).toContain("max_bet_exceeded: 50.00 > 25")
  })

  test("counts cash committed earlier in the same cycle", () => {
    const decisions = gateIntents(
      [intent(), intent({ marketId: "m2" })],
      [market(), market({ marketId: "m2" })],
      policy(),
      portfolio({ cash: 15 }),
    )
    expect(decisions.map((d) => d.approved)).toEqual([true, false])
    expect(decisions[1].reasons[0]).toStartWith("insufficient_cash")
  })

  test("rejected proposals do not consume the approved order limit", () => {
    const decisions = gateIntents(
      [intent({ size: 100 }), intent(), intent({ size: 5 }), intent()],
      [market()], policy(), portfolio({ cash: 20 }), 2,
    )
    expect(decisions.map((d) => d.approved)).toEqual([false, true, true, false])
    expect(decisions[0].reasons).toContain("max_bet_exceeded: 50.00 > 25")
    expect(decisions[3].reasons).toContain("intent_limit_reached")
  })

  test.each([
    ...invalidNumbers.filter(([, value]) => value !== undefined),
    ["negative", -1],
    ["fractional", 0.5],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ] as [string, unknown][])("rejects invalid approved order limit: %s", (label, value) => {
    const decisions = gateIntents([intent(), intent()], [market()], policy(), portfolio(), value as number)
    expect(decisions.map((decision) => decision.approved)).toEqual([false, false])
    expect(decisions.every((decision) => decision.reasons.includes("invalid_intent_limit"))).toBe(true)
  })

  test("a zero approved order limit rejects all intents", () => {
    const [decision] = gateIntents([intent()], [market()], policy(), portfolio(), 0)
    expect(decision.approved).toBe(false)
    expect(decision.reasons).toEqual(["intent_limit_reached"])
  })

  test("malformed intents do not consume the approved order limit", () => {
    const decisions = gateIntents(
      [null as unknown as Intent, intent({ size: NaN }), intent(), intent()],
      [market()], policy(), portfolio(), 1,
    )
    expect(decisions.map((decision) => decision.approved)).toEqual([false, false, true, false])
    expect(decisions[3].reasons).toEqual(["intent_limit_reached"])
  })

  test("kill switch rejects everything", () => {
    const [d] = gateIntents([intent()], [market()], policy({ kill_switch: true }), portfolio())
    expect(d.approved).toBe(false)
    expect(d.reasons).toEqual(["kill_switch_on"])
  })

  test("unknown market is rejected", () => {
    const [d] = gateIntents([intent({ marketId: "nope" })], [market()], policy(), portfolio())
    expect(d.reasons).toEqual(["unknown_market"])
  })

  for (const field of ["size", "limit"] as const) {
    test.each(invalidNumbers)(`rejects ${field} set to %s`, (label, value) => {
      const malformed = intent({ [field]: value } as Partial<Intent>)
      const [decision] = gateIntents([malformed], [market()], policy(), portfolio())
      expect(decision.approved).toBe(false)
      expect(decision.reasons).toContain("invalid_order")
      expect(decision.intent).toBe(malformed)
    })
  }

  test.each([
    ["size", -1],
    ["size", 0],
    ["limit", -0.01],
    ["limit", 0],
    ["limit", 1],
    ["limit", 1.01],
  ] as const)("rejects out-of-range %s (%s)", (field, value) => {
    const [decision] = gateIntents([intent({ [field]: value })], [market()], policy(), portfolio())
    expect(decision.approved).toBe(false)
    expect(decision.reasons).toContain("invalid_order")
  })

  const malformedIntents: [string, unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["primitive", 1],
    ["array", []],
    ["empty object", {}],
    ["unsupported venue", { ...intent(), venue: "other" }],
    ["unsupported side", { ...intent(), side: "buy" }],
    ["missing side", { ...intent(), side: undefined }],
    ["missing market ID", { ...intent(), marketId: undefined }],
    ["empty market ID", intent({ marketId: "" })],
    ["blank market ID", intent({ marketId: " \t" })],
    ["numeric market ID", { ...intent(), marketId: 1 }],
    ["missing reason", { ...intent(), reason: undefined }],
    ["numeric reason", { ...intent(), reason: 1 }],
  ]

  test.each(malformedIntents)("rejects malformed intent: %s", (label, value) => {
    const [decision] = gateIntents([value as Intent], [market()], policy(), portfolio())
    expect(decision.approved).toBe(false)
    expect(decision.reasons).toContain("invalid_order")
    expect(decision.intent).toBe(value as Intent)
  })

  test("rejects a cost that underflows to zero", () => {
    const [decision] = gateIntents([intent({ size: Number.MIN_VALUE })], [market()], policy(), portfolio())
    expect(decision.approved).toBe(false)
    expect(decision.reasons).toContain("invalid_order")
  })

  test("accepts fractional sizes and limits just inside zero and one", () => {
    for (const limit of [Number.MIN_VALUE, 1 - Number.EPSILON]) {
      const [decision] = gateIntents([intent({ size: 1, limit })], [market()], policy(), portfolio())
      expect(decision.approved).toBe(true)
    }
    const [decision] = gateIntents([intent({ size: 0.5 })], [market()], policy(), portfolio())
    expect(decision.approved).toBe(true)
  })

  test("accepts cost exactly at max_bet and available cash", () => {
    const [decision] = gateIntents([intent({ size: 50 })], [market()], policy(), portfolio({ cash: 25 }))
    expect(decision.approved).toBe(true)
    expect(decision.reasons).toEqual([])
  })

  test("rejects cost just above max_bet or available cash", () => {
    const [overBet] = gateIntents([intent({ size: 50.02 })], [market()], policy(), portfolio())
    expect(overBet.approved).toBe(false)
    expect(overBet.reasons.some((reason) => reason.startsWith("max_bet_exceeded"))).toBe(true)
    const [overCash] = gateIntents([intent()], [market()], policy(), portfolio({ cash: 9.99 }))
    expect(overCash.approved).toBe(false)
    expect(overCash.reasons.some((reason) => reason.startsWith("insufficient_cash"))).toBe(true)
  })

  test("rejected intents preserve cash for later valid intents", () => {
    const decisions = gateIntents(
      [intent({ size: NaN }), intent({ size: 50.02 }), intent(), intent()],
      [market()],
      policy(),
      portfolio({ cash: 10 }),
    )
    expect(decisions.map((decision) => decision.approved)).toEqual([false, false, true, false])
    expect(decisions[3].reasons).toContain("insufficient_cash: 10.00 > 0.00")
  })

  test("invalid policy or portfolio state rejects every intent", () => {
    for (const [settings, state] of [
      [policy({ max_bet: NaN }), portfolio()],
      [policy({ max_daily_loss: Infinity }), portfolio()],
      [policy({ stop_loss_pct: NaN }), portfolio()],
      [policy(), portfolio({ dailyPnl: NaN })],
      [policy(), portfolio({ cash: NaN })],
      [policy(), portfolio({ highWaterMark: NaN })],
    ] as const) {
      const decisions = gateIntents([intent(), intent()], [market()], settings, state)
      expect(decisions.every((decision) => !decision.approved)).toBe(true)
      expect(decisions.every((decision) => decision.reasons.some((reason) => reason.startsWith("invalid_")))).toBe(true)
    }
  })
})
