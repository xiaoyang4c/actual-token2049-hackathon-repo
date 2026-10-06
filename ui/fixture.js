// Saved sample used only when GET /agent/state or GET /audit cannot be read.
// The page labels this data as a fixture so it cannot be mistaken for the agent.

export const FIXTURE = {
  state: {
    policy: {
      max_bet: 25,
      max_daily_loss: 100,
      category_allow: [],
      category_deny: ["politics"],
      venues_enabled: ["polymarket", "kalshi"],
      stop_loss_pct: 0.2,
      kill_switch: false,
    },
    portfolio: {
      cash: 960,
      equity: 975.5,
      startOfDayEquity: 1000,
      highWaterMark: 1000,
      dailyPnl: -24.5,
      positions: [
        { venue: "polymarket", marketId: "sample-fed-cut", side: "yes", size: 20, avgPrice: 0.42 },
        { venue: "kalshi", marketId: "sample-cpi", side: "no", size: 15, avgPrice: 0.31 },
      ],
    },
  },
  audit: [
    {
      receivedAt: "2026-10-03T12:00:00.000Z",
      cycleId: "cycle-sample-paper",
      events: [
        { type: "cycle_start", detail: "cycle-sample-paper" },
        { type: "state", detail: "cash 1000.00, equity 1000.00, positions 0" },
        {
          type: "policy_blocked",
          detail: 'yes 40 @ 0.50 "Sample election market" [politics] -> category_denied: politics',
        },
        { type: "fill_filled", detail: "[PAPER] yes 20 @ 0.42 on sample-fed-cut (edge 0.08)" },
        { type: "fill_rejected", detail: "[PAPER] no 80 @ 0.40 on sample-cpi (insufficient_cash)" },
        { type: "cycle_end", detail: "2 proposed, 1 approved, 1 filled (paper)" },
      ],
    },
    {
      receivedAt: "2026-10-03T12:05:00.000Z",
      cycleId: "cycle-sample-live",
      events: [
        { type: "cycle_start", detail: "cycle-sample-live" },
        { type: "fill_filled", detail: "[LIVE] yes 10 @ 0.55 on sample-live-market (sample live fill)" },
        { type: "cycle_end", detail: "1 proposed, 1 approved, 1 filled (live)" },
      ],
    },
  ],
}
