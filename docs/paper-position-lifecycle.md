# Paper position lifecycle

The control API can value, close, and settle paper positions. Quotes, receipts,
resolutions, and daily summaries persist in the agent's SQLite database.
The operator UI reads the resulting cash, equity, daily P&L, and open positions.
It remains display-only. No route here sends a live order or uses a wallet.

Run `bun run paper:demo` for a complete offline cycle. It buys YES and NO shares,
values them from a fixture quote, closes part of the YES position, resolves the
market, then advances to the next UTC day. It uses a disposable in-memory book.

## Quotes and valuation

`POST /agent/marks` accepts `{ "quotes": [...] }`. Each quote contains `venue`,
`marketId`, `yesPrice`, `bestBid`, `bestAsk`, and an ISO UTC `fetchedAt` timestamp.
Prices must be between zero and one. The bid cannot exceed the ask. A quote must
be at most 90 seconds old and cannot be in the future. `maxQuoteAgeMs` in the
service options can change that limit. Duplicate markets, malformed quotes, and
older or conflicting observations reject the entire batch.

YES uses `yesPrice`. NO uses `1 - yesPrice`. Equity is cash plus the marked value
of open positions, plus any explicit demo P&L adjustment. The result updates
daily P&L and the high-water mark used by the existing policy gate.

`GET /agent/state` adds each position's `markPrice`, `marketValue`, `unrealizedPnl`,
`markStatus`, and `markedAt`. Positions without a quote retain entry valuation
and report `entry`. The last accepted price remains visible when its quote ages
out, with status `stale`. A stale quote cannot execute a close.

Local development reads the market feed's existing saved venue snapshots.
The quote reader uses each file's modification time as its observation time.
It does not call an API. The existing feed still controls its own polling.
Supply quotes through the marks route when running the control service alone.

Saved snapshots must contain observed bid and ask prices for an execution quote.
A missing price does not become zero. An observed zero bid remains valid.
If a snapshot cannot be read, the service keeps its last accepted quotes.
Other venue snapshots remain available. Quotes still expire for execution.
State reads, policy changes, explicit marks, and settlement remain available.
`GET /agent/state` reports optional feed errors in `quoteSource.errors`.
Its `quoteSource.status` is `disabled`, `ok`, or `error`.

## Closing positions

`POST /positions/close` accepts this request:

```json
{
  "idempotencyKey": "close-001",
  "venue": "polymarket",
  "marketId": "m1",
  "side": "yes",
  "size": 5,
  "minPrice": 0.65
}
```

Omit `size` to close all held shares of that side. Omit `minPrice` to accept any
nonnegative quoted sell price. YES sells at the bid. NO sells at `1 - bestAsk`.
A close needs a fresh quote and cannot exceed the held size. It consumes lots
in fill order, preserving the cost basis of remaining shares. Realized P&L is
proceeds minus the consumed cost basis. Paper fills assume execution at that
price without fees or order-book depth simulation.

Risk stops and a kill switch block new buys. They permit closes and settlements
that reduce exposure. Venue and market ID together identify the position.

## Market resolution

`POST /markets/resolve` accepts `idempotencyKey`, `venue`, `marketId`, and `outcome`.
The outcome is `yes`, `no`, or `void`. A binary winner pays one unit of cash per
share. The losing side pays zero. A void paper market returns each lot's entry
cost. These are paper rules; actual venue cancellation rules still need a live
adapter. The caller supplies the outcome. A market end date does not determine
its outcome.

Resolution closes both sides on the specified venue and credits the payout once.
It can also record a resolution when there are no held shares. The saved market
cannot accept new buys or quotes afterward, including after a demo book reset.

Close and resolution receipts, cash changes, positions, and accounting commit
in the same SQLite transaction. A failed write rolls everything back. Repeating
the same key and request returns the saved receipt. Changing its terms returns
409. A second resolution key also returns 409. Use new keys for new operations.
`GET /positions/history` reads the receipts. The existing JSONL cycle audit
remains separate from this ledger.

## Daily accounting

The first state read or mutation after a UTC date change rolls the book forward.
It records the previous day's start equity, last observed equity, total P&L,
and realized P&L. The last observed equity becomes the new baseline before new
quotes are applied. Price changes first observed today count toward today's P&L.
This does not reconstruct unobserved prices at midnight or fabricate missing days.

Daily realized P&L resets. Cumulative realized P&L, open positions, cash, policy,
and the stop-loss high-water mark remain. `GET /agent/days` reads saved summaries.
The clock cannot precede the saved book. A demo reset clears current accounting
and open positions but keeps receipts, resolution records, order keys, and history.

Migration 004 preserves existing books and their demo P&L shocks. The accounting
fields on the portfolio are `tradingDay`, `realizedPnl`, `dailyRealizedPnl`,
`unrealizedPnl`, and `pnlAdjustment`. Monetary calculations use the existing
JavaScript number representation.

Run `bun test services/position-lifecycle.test.ts` and `bun run typecheck:control`.
Tests use fixed clocks, local protocol requests, fixture files, and temporary
databases. See [Bun SQLite transactions](https://bun.sh/docs/api/sqlite#transactions).
