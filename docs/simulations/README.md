# CRE simulation logs

These logs are the full output of `cre workflow simulate` for the agent loop.
Each log shows one cycle. The runs used the `local-settings` target, so the
workflow read markets from the background market feed.

All fills are paper fills. The Cardano payments are simulated. No transaction
went to a chain.

| Log | Setup | Result |
|---|---|---|
| [`2026-10-03-normal-cycle.log`](2026-10-03-normal-cycle.log) | Clean book, default policy | The agent paid for scores, blocked 2 politics markets, and made 3 paper fills. |
| [`2026-10-03-kill-switch.log`](2026-10-03-kill-switch.log) | `kill_switch` on | The agent stopped before it bought data or sent orders. |
| [`2026-10-03-stop-loss.log`](2026-10-03-stop-loss.log) | Simulated loss of 250 | The daily loss limit and the stop-loss stopped the cycle before it bought data or sent orders. |

## Run the cycles again

1. Run `bun run services`.
2. Set up the case. Use the demo toggles in the [README](../../README.md#demo-toggles).
3. Run `bun run simulate`.
4. Reset the book with `curl -X POST localhost:8787/agent/debug/reset`.
