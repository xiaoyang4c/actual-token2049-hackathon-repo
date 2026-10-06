# B2B and B2C reliability marketplace

This repository builds a marketplace for goods and services.
It supports business-to-business (B2B) and business-to-consumer (B2C) transactions.
The reliability checker uses transaction outcomes to assess buyers and sellers.
Each entity has a separate buyer score and seller score for each category.

Read [PLAN.md](PLAN.md) for the product scope and work order.
Read [Implementation status](docs/implementation-status.md) for implemented features and known gaps.
Read [lane ownership](docs/reliability-lanes.md) before you change a module.

## Target rules

- Scale each score change with transaction value: `w = log(1 + v / v0)`.
  `v` is the transaction value. `v0` is the value scale.
- Reduce score gains from repeat transactions between the same pair.
- Set buyer and seller platform fees from their reliability scores.
  Higher scores give lower fees.
- Use KYC checks and agreed terms to control participation.
- Keep delivery evidence, dispute decisions, and payment evidence separate.

These rules describe the target.
Scoring, pair decay, fees, and invoice evidence currently use stubs.
KYC currently uses a mock provider.

## Layout

| Path | Purpose |
| --- | --- |
| `packages/reliability` | Marketplace types, scoring, terms, KYC, evidence, and escrow lifecycle |
| `packages/db` | Shared SQLite store, migrations, marketplace records, and payment records |
| `services/control-api.ts` | Registers marketplace routes against one shared `AgentStore` |
| `services/reliability` | Read routes, lifecycle actions, mock KYC, and the Masumi escrow adapter |
| `services/cardano-agents-ts` | Shared Cardano and Masumi adapters, payment evidence, and settlement observer |
| `ui` | Local display for transactions, receipts, buyer and seller scores, KYC, and listings |

Some source code still supports the retired trading runtime.
The control API obtains its shared store through that runtime.
Cardano payment code also uses shared core types.
Remove these dependencies through a separate refactor.
The current product plan covers the marketplace and reliability checker.

## Run locally

Install [Bun](https://bun.sh), version 1.2.21 or later.

```sh
bun install
bun run services
# In another terminal:
bun run ui/server.ts
```

Open <http://localhost:8791>.
The operator UI is a local display.
It does not accept offers or submit lifecycle actions.
Read [UI instructions](ui/README.md) for its views and evidence labels.

The shared launcher starts the control API on port 8787.
It also starts payment services on ports 8788 and 8789.
It still starts the legacy market feed on port 8790.
Separate marketplace startup from that feed in the runtime refactor.
The marketplace UI reads the control API.

## Marketplace routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/reliability/entities` | Read participant fixtures |
| `GET` | `/reliability/scores` | Read stored scores and fixture scores |
| `GET` | `/reliability/listings` | Read listing fixtures |
| `GET` | `/reliability/transactions` | Read transaction fixtures |
| `GET` | `/reliability/receipts` | Read a fixture receipt and fee offers |
| `GET` | `/reliability/kyc` | Read a mock KYC record |
| `GET` | `/reliability/lifecycle` | Read a stored lifecycle by transaction ID |
| `POST` | `/reliability/lifecycle/open` | Open a stored transaction |
| `POST` | `/reliability/lifecycle/terms` | Record transaction terms |
| `POST` | `/reliability/lifecycle/transition` | Submit a lifecycle action |

Entity, listing, and transaction reads accept an optional `id` query.
Score reads accept an optional `entityId` query.
Receipt reads require `transactionId`.
Lifecycle reads require `transactionId` and accept an optional `now` query.
Collection reads do not discover new stored deals.
Use the lifecycle read to inspect a stored deal by ID.

Read [Transaction lifecycle](docs/reliability-lifecycle.md) for actions and evidence rules.
Read [mock KYC](docs/kyc.md) for onboarding states and tier rules.
Read [module boundaries](docs/reliability-modules.md) before you extend a lane.

## Payment and scoring status

Marketplace orders are paper.
Cardano escrow is simulated by default.
Preprod requests need `CARDANO_MODE=preprod` and `CARDANO_ALLOW_NETWORK=true`.
An enabled preprod request has `mode: live`.
This mode does not prove confirmed settlement.

`payment_settled` records an application stage.
It does not prove a confirmed seller payout.
`refunded` does not prove a completed buyer refund.
Read [chain evidence](docs/reliability-lifecycle.md#chain-evidence) before you use these stages.

The fee stub returns buyer and seller rate offers for one entity.
The lifecycle does not collect platform fees or enforce those offers.
The scoring stub uses unit event weights.
It does not apply value weighting or repeat-pair decay.

Run `bun run funding:demo` for the paper pool ledger.
Read [paper omnibus funding](docs/omnibus-funding.md) for allocation rules and live custody requirements.
This ledger does not send chain transactions or fund lifecycle escrow.

Read [Cardano payment adapters](docs/cardano-payments.md) and
[settlement evidence](docs/masumi-settlement.md) for shared payment components.
Their confirmation checks are separate from the marketplace lifecycle.

## Checks

```sh
bun test packages services ui
bun run typecheck:control
bun run payments:typecheck
bun run lint
```

These checks cover shared code, marketplace code, and the operator UI.
No CRE installation is required for these checks.
