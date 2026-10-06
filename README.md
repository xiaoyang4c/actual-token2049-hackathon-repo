# Token2049-origins-hackerthon

Agent runtime for prediction-market strategies. See [PLAN.md](PLAN.md).

## Layout

| Path | What |
|---|---|
| `packages/core` | Dependency-free TS shared by the workflow and services: types, policy gate, `edge-vs-signal` strategy pack, Polymarket and Kalshi normalization |
| `packages/db` | SQLite store: one `AgentStore` connection with record types, validation, and domain query modules |
| `cre/agent-loop` | Chainlink CRE workflow: config/schema, HTTP steps, and one cron-triggered cycle (state → markets per enabled venue → x402 pay → score → strategy → policy → orders → audit) |
| `services/control-api.ts` | Control API: durable policy/portfolio, paper executor, audit log, offline Polymarket and Kalshi fixtures |
| `services/cardano-agent.ts` | Offline-first payment service with Cardano/Masumi adapters, score receipts, and durable settlement reconciliation |
| `services/cardano-agents-ts` | Payment lifecycle, settlement worker, protocol evidence, simulated and preprod adapters, and offline fixture tests |
| `services/score-provider.ts` | Mock third-party x402-protected fair-value API (1 ADA per call) |
| `services/market-feed.ts` | Polls Polymarket and Kalshi every 30s in the background and serves the latest snapshot; refuses data older than 90s |
| `ui` | Display-only operator desk: state/audit parsing in `model.js`, HTML in `render.js`, and shared display formatting in `format.js` |

The payment, workflow, and store entry points preserve their existing exports.
Payment serialization stays in `PaymentRuntime`. SQLite query modules share the
store's connection and transaction. The desk reads only `GET /agent/state` and
`GET /audit`. Its renderer receives a prepared view and sends no requests.

## Run

Prerequisites: [Bun](https://bun.sh) ≥ 1.2.21, the [CRE CLI](https://docs.chain.link/cre/getting-started/cli-installation/windows), and `cre login`.

```sh
bun install
(cd cre/agent-loop && bun install)
bun run test                 # core, services, UI, and workflow tests
bun run typecheck:workflow   # workflow TypeScript check
bun run typecheck:control    # control API and SQLite TypeScript check
bun run lint                # code style checks
bun run services             # control-api :8787, cardano-agent :8788, score-provider :8789, market-feed :8790
bun run simulate             # in another terminal; markets from the background feed
bun run simulate:offline     # saved Polymarket + Kalshi snapshots, no internet needed
bun run simulate:live        # straight from the live Polymarket and Kalshi APIs
```

### Demo toggles

```sh
# Kill switch: next cycle halts before buying data or placing orders
curl -X POST localhost:8787/agent/policy -H content-type:application/json -d '{"kill_switch":true}'
# Simulated loss that trips the daily-loss and stop-loss limits
curl -X POST localhost:8787/agent/debug/shock -H content-type:application/json -d '{"pnl":-250}'
# Back to a clean book
curl -X POST localhost:8787/agent/debug/reset
```

The default policy denies `politics`. For Polymarket, election tags, politics tags, and known political aliases such as `trump` take precedence over other category tags.

The audit log is at `GET localhost:8787/audit` and `services/.data/audit.jsonl`.

The paper book, policy, and order keys persist in `services/.data/agent.sqlite`.
Set `CONTROL_DB_PATH` to choose another database. Order batches commit their fills
and book changes together. Restarting does not reset funds or allow a repeated
order to fill again. The debug reset keeps policy and order history. Startup also
reloads the JSONL audit log. See [durable paper agent state](docs/durable-agent-state.md).

`POST /audit` stores one entry per `cycleId` after the file append succeeds. Retry a failed write with the same `cycleId`.
Each event requires `type` and `detail` strings. Optional `mode` and `fill.mode` fields accept `paper` (simulated fill) or `live` (real venue order). The API preserves these fields in both audit outputs.

### Market feed

`bun run services` starts polling right away (`MARKET_POLL_SECONDS`, default 30).

- `GET localhost:8790/markets/status`: polls, failures, last fetch time and age per venue
- `GET localhost:8790/markets/polymarket`, `/markets/kalshi`: latest snapshot in the venue's own format, with `x-fetched-at` and `x-age-ms` headers; 503 if there's no data yet or it's stale
- `services/.data/markets/`: each venue's latest raw response plus `ticks.jsonl`, one line of prices per poll

### Cycle safeguards and scoring

- The agent skips scoring when no market has a side that meets the strategy constraints and can pass the current policy. This includes category, available cash, and maximum bet checks.
- The agent ranks all proposals before applying policy. Only approved orders count toward `maxIntents`, so a blocked proposal does not displace an allowed order.
- Payment quotes must contain a positive integer amount in lovelace. The agent rejects malformed amounts and amounts above `maxDataPaymentLovelace` before calling the payment service.
- After order submission, the cycle summary uses the execution modes of successful fills: `paper` for simulated fills, `live` for real venue orders, or `mixed: live/paper`. A response with no successful fills reports `no fills`.

The scoring request and each returned signal require both `venue` and `marketId`. A request market also includes `yesPrice`; a signal includes `fairYes` and `confidence`. Deploy the workflow and score provider together when upgrading this protocol. Signals without a venue cannot match a market.

Eligibility does not predict a signal's edge or confidence. An eligible cycle can purchase scores and still produce no approved orders.

### Payment integration

Run `bun run payments:demo` for the complete offline pay → confirm → scores →
receipt flow. Run `bun run payments:test` for the preprod adapter fixture tests.
Receipts persist in `services/.data/cardano.sqlite`. API access is disabled by
default. See [Cardano and Masumi payment scaffolding](docs/cardano-payments.md)
for configuration, verified protocol details, and future preprod setup.
The worker keeps delivery and settlement separate. `GET /receipts` includes
settlement summaries. `GET /settlement?receiptId=...` shows recent observations.
See [Masumi settlement reconciliation](docs/masumi-settlement.md) for state
mappings, evidence, and restart behavior.

### Paper position lifecycle

Run `bun run paper:demo` for offline valuation, a partial close, market resolution,
and UTC daily P&L rollover. Quotes and position receipts persist in SQLite.
Local development values the book from the market feed's saved snapshots.
The control API also accepts explicit quotes, closes, and outcomes through
`POST /agent/marks`, `POST /positions/close`, and `POST /markets/resolve`.
See [paper position lifecycle](docs/paper-position-lifecycle.md) for prices,
retry behavior, risk stops, daily accounting, and offline tests.

## Status

- Orders are **paper** fills. Payments default to **simulated** Cardano transactions with a local `X-PAYMENT` envelope. Preprod adapters have offline fixture coverage; actual chain settlement has not been tested.
- Every POST from the workflow carries an idempotency key and CRE cache settings, so repeats from multiple DON nodes take effect once.
