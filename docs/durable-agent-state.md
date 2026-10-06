# Durable paper agent state

The control API stores its policy and paper book in SQLite. All orders remain
paper fills. It does not call a venue API or use a wallet.

The default database is `services/.data/agent.sqlite`. Set `CONTROL_DB_PATH` to
use another file. Keep that file between restarts. Use `databasePath: ':memory:'`
only for disposable tests. The payment service keeps its separate database.

Migration 003 adds the current book to the existing store. It preserves policy,
run, order, audit, and payment records. The first start creates the default policy
and a paper balance of 1,000 when there is no saved book. It cannot recover state
from an older service that held its book only in memory.

## State and transactions

The saved book includes cash, positions, equity, start-of-day equity, daily P&L,
and the high-water mark. It refers to the active policy snapshot. A restart
preserves the kill switch and loss-limit accounting.

`POST /orders` stores each filled or rejected order by its idempotency key.
One SQLite transaction commits the entire batch, its run snapshot, and the book
changes before returning a response. A failed write rolls back the batch. A retry
returns the original fill without changing cash or positions again. As in the
existing API, the first stored order wins when a key is reused.

Each mutation takes the write lock before reading the book. Each request reads
the saved state. There is no process-local book cache. See
[Bun SQLite transactions](https://bun.sh/docs/api/sqlite#transactions).

Policy changes, simulated P&L shocks, and resets also use transactions.
Malformed policy, shock, or order input returns 400 before committing a change.
A stored book that cannot be read fails startup instead of resetting funds.

`POST /agent/debug/reset` resets the paper book to 1,000. It keeps policy, order
keys, and history. Use new keys for new orders. Retrying an order from before the
reset still returns its saved result.

The [paper position lifecycle](paper-position-lifecycle.md) adds quote-based
valuation, partial and full closes, market resolution, and UTC daily accounting.
The demo shock endpoint remains available as an explicit P&L adjustment.

## Audit and operation

The audit log remains `services/.data/audit.jsonl`. Startup reloads that file so
`GET /audit` and audit deduplication keep their history. Direct and nested fill
mode fields remain intact. Use one control service writer for each audit file.
The JSONL append remains separate from the SQLite order transaction.

Startup recovers an incomplete final JSONL append. It saves the original fragment
in an `audit.jsonl.incomplete-<id>` file before removing that fragment from the log.
Complete records and their deduplication keys remain. A complete final record
without a newline is retained. Corruption in a completed record still fails
startup and leaves the log unchanged.

Stop the service before copying its database for a backup. The operator UI
continues to read the existing state and audit routes.

Run `bun test services/agent-state.test.ts services/control-api.test.ts packages/db`
and `bun run typecheck:control`. Tests cover restarts, abrupt process termination,
failed writes, order retries, competing requests, and separate databases. They
use temporary files and local HTTP requests.
