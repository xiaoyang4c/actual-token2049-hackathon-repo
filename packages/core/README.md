# Core policy gate

`checkHalt` and `gateIntents` reject invalid numeric state before an order can be
approved. The gate applies to intents for both paper fills and live orders.

- Policy numbers must be finite numbers. `max_bet` and `max_daily_loss` must be
  at least zero. `stop_loss_pct` must be between zero and one, inclusive.
- Portfolio cash, equity, start-of-day equity, high-water mark, and daily PnL
  must be finite numbers. Invalid state halts the agent with an
  `invalid_policy: <field>` or `invalid_portfolio: <field>` reason.
- Each intent must be an object with a supported venue (`polymarket` or
  `kalshi`), a nonblank market ID, a side of `yes` or `no`, and a string reason.
  Size must be finite and greater than zero. Limit must be finite and strictly
  between zero and one. Fractional sizes are permitted.
- Order cost must be finite and greater than zero. Malformed intents return
  `invalid_order`. The gate does not coerce strings to numbers.
- Cost equal to `max_bet` or available cash is permitted. Daily loss and
  drawdown limits halt at equality. Rejected intents do not reserve cash.
- The optional `maxApproved` limit must be a nonnegative safe integer. An
  invalid limit rejects all intents with `invalid_intent_limit`. Zero permits
  no orders. Only approved intents count toward the limit.

These checks complement the existing venue, market, category, and kill-switch
rules. The typed API still expects policy, portfolio, and market objects with
their declared structure. It does not parse arbitrary payloads for those objects.

Run the core tests with `bun test packages/core` from the repository root.
See the [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html)
for the repository's code conventions.
