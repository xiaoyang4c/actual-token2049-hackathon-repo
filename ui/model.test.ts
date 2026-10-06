import { describe, expect, test } from "bun:test"
import { FIXTURE } from "./fixture.js"
import { formatMoney, formatPnl } from "./format.js"
import { buildView, executionOf, fillMode } from "./model.js"
import { deskTitle, renderDesk } from "./render.js"

const policy = FIXTURE.state.policy
const flatBook = {
  cash: 1000,
  equity: 1000,
  startOfDayEquity: 1000,
  highWaterMark: 1000,
  dailyPnl: 0,
  positions: [],
}

const htmlOf = (state: unknown, audit: unknown, source: "live" | "fixture" | "stale" = "live") =>
  renderDesk(buildView(state, audit, { source, updatedAt: "2026-10-03T12:00:00.000Z" }))

describe("fill mode", () => {
  test("reads the leading PAPER or LIVE tag from audit details", () => {
    expect(fillMode({ type: "fill_filled", detail: "[PAPER] yes 20 @ 0.42 on m1 (edge)" })).toBe("paper")
    expect(fillMode({ type: "fill_rejected", detail: "[LIVE] no 5 @ 0.20 on m2 (reason)" })).toBe("live")
    expect(fillMode({ type: "note", detail: "mention [LIVE] later" })).toBeNull()
  })

  test("reads a mode field only on fill events", () => {
    expect(fillMode({ type: "fill_filled", detail: "yes 1 @ 0.4 on m", mode: "live" })).toBe("live")
    expect(fillMode({ type: "policy_blocked", detail: "blocked", mode: "live" })).toBeNull()
  })

  test("counts paper, live, mixed, and empty logs", () => {
    expect(executionOf([]).kind).toBe("none")
    expect(executionOf([{ events: [{ type: "fill_filled", detail: "[PAPER] yes 1 @ 0.4 on m" }] }]).kind).toBe("paper")
    expect(executionOf([{ events: [{ type: "fill_filled", detail: "[LIVE] yes 1 @ 0.4 on m" }] }]).kind).toBe("live")
    expect(executionOf(FIXTURE.audit)).toEqual({ kind: "mixed", paper: 2, live: 1, unmarked: 0 })
  })
})

describe("desk html", () => {
  test("renders the initial control-api book with no controls", () => {
    const html = htmlOf({ policy, portfolio: flatBook }, [])
    expect(html).toContain('data-source="live"')
    expect(html).toContain('data-mode="none"')
    expect(html).toContain(">Policy<")
    expect(html).toContain(">Portfolio<")
    expect(html).toContain(">Audit<")
    expect(html).toContain(">Cash<")
    expect(html).toContain(">Equity<")
    expect(html).toContain(">Daily PnL<")
    expect(html).toContain("$1,000.00")
    expect(html).toContain("$25.00")
    expect(html).toContain("$100.00")
    expect(html).toContain("20%")
    expect(html).toContain("Polymarket")
    expect(html).toContain("Kalshi")
    expect(html).toContain("politics")
    expect(html).toContain("No open positions.")
    expect(html).toContain("No cycles recorded.")
    expect(html).toContain(">NO FILLS<")
    expect(html).toContain(">Connected<")
    expect(html).toContain(">PAPER<")
    expect(html).toContain(">LIVE<")
    expect(html).not.toContain("<button")
    expect(html).not.toContain("<form")
    expect(html).not.toContain("<input")
    expect(html).not.toContain("<textarea")
    expect(html).not.toContain("<select")
    expect(html).not.toContain("onclick=")
    expect(html).not.toContain("Kill switch is on")
    expect(deskTitle(buildView({ policy, portfolio: flatBook }, [], { source: "live" }))).toBe("Operator · NO FILLS")
  })

  test("shows cash, equity, daily PnL, positions, and paper versus live fills", () => {
    const html = htmlOf(FIXTURE.state, FIXTURE.audit, "fixture")
    expect(html).toContain('data-source="fixture"')
    expect(html).toContain('data-mode="mixed"')
    expect(html).toContain("Fixture data")
    expect(html).toContain("not the running agent")
    expect(html).toContain("$960.00")
    expect(html).toContain("$975.50")
    expect(html).toContain("−$24.50")
    expect(html).toContain("sample-fed-cut")
    expect(html).toContain("sample-cpi")
    expect(html).toContain("badge-paper")
    expect(html).toContain("badge-live")
    expect(html).toContain("sample-live-market")
    expect(html).toContain("category_denied: politics")
    expect(html).not.toContain("<button")
    expect(deskTitle(buildView(FIXTURE.state, FIXTURE.audit, { source: "fixture" }))).toBe("Fixture · Operator · MIXED")
  })

  test("escapes audit details", () => {
    const html = htmlOf(
      { policy, portfolio: flatBook },
      [{ cycleId: "c", events: [{ type: "note", detail: `<img src=x onerror="alert(1)">` }] }],
    )
    expect(html).not.toContain("<img")
    expect(html).toContain("&lt;img")
  })

  test("marks a kill switch without offering a control", () => {
    const html = htmlOf({ policy: { ...policy, kill_switch: true }, portfolio: flatBook }, [])
    expect(html).toContain("Kill switch is on")
    expect(html).toContain(">On<")
    expect(html).not.toContain("<button")
  })

  test("paper-only and live-only banners stay distinct", () => {
    const paper = htmlOf(
      { policy, portfolio: flatBook },
      [{ events: [{ type: "fill_filled", detail: "[PAPER] yes 1 @ 0.40 on m" }] }],
    )
    const live = htmlOf(
      { policy, portfolio: flatBook },
      [{ events: [{ type: "fill_filled", detail: "[LIVE] yes 1 @ 0.40 on m" }] }],
    )
    expect(paper).toContain('data-mode="paper"')
    expect(paper).toContain("Nothing was sent to a venue")
    expect(paper).toContain("fill-paper")
    expect(paper).not.toContain("fill-live")
    expect(live).toContain('data-mode="live"')
    expect(live).toContain("orders that were sent to a venue")
    expect(live).toContain("fill-live")
    expect(live).not.toContain("fill-paper")
  })

  test("keeps the last book labeled when the source is stale", () => {
    const html = htmlOf({ policy, portfolio: flatBook }, [], "stale")
    expect(html).toContain("Showing the last response")
    expect(html).toContain('data-source="stale"')
    expect(html).not.toContain("Fixture data")
  })
})

describe("money", () => {
  test("formats cash and pnl", () => {
    expect(formatMoney(1000)).toBe("$1,000.00")
    expect(formatMoney(-24.5)).toBe("−$24.50")
    expect(formatPnl(3)).toBe("+$3.00")
    expect(formatPnl(0)).toBe("$0.00")
    expect(formatMoney("nope")).toBe("—")
  })
})
