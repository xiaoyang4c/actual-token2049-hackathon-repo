# B2B and B2C reliability marketplace

This repository builds a marketplace for goods and services.
It supports business-to-business (B2B) and business-to-consumer (B2C) transactions.
The reliability checker uses transaction outcomes to assess buyers and sellers.
Each entity has a separate buyer score and seller score for each category.

Read [PLAN.md](PLAN.md) for the product scope and work order.
Read [Implementation status](docs/implementation-status.md) for implemented features and known gaps.
Read [lane ownership](docs/reliability-lanes.md) before you change a module.
Read [Reliability math](docs/reliability-math.md) for equations, examples, and open parameters.

## Target rules

- Scale each score change with transaction value: $w = \ln(1 + v / v_0)$.
  $v$ is the transaction value. $v_0$ is the value scale.
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
| `services/reliability` | Read routes, lifecycle actions, the contract lifecycle service, mock KYC, and the Masumi escrow adapters |
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
| `GET` | `/reliability/entities` | Read stored participants and fixtures |
| `GET` | `/reliability/scores` | Read stored scores and fixture scores |
| `GET` | `/reliability/listings` | Read stored listings and fixtures |
| `GET` | `/reliability/transactions` | Read stored transactions and fixtures |
| `GET` | `/reliability/receipts` | Read a stored or fixture receipt and fee offers |
| `GET` | `/reliability/kyc` | Read a mock KYC record |
| `GET` | `/reliability/lifecycle` | Read a stored lifecycle by transaction ID |
| `POST` | `/reliability/lifecycle/open` | Open a stored transaction |
| `POST` | `/reliability/lifecycle/terms` | Record transaction terms |
| `POST` | `/reliability/lifecycle/transition` | Submit a lifecycle action |
| `GET` | `/reliability/contracts/templates` | List contract templates |
| `POST` | `/reliability/contracts/parties` | Link a signing key and a preprod address to an entity |
| `POST` | `/reliability/contracts` | Create a contract |
| `GET` | `/reliability/contracts` | Read a contract by `id` |
| `GET` | `/reliability/contracts/terms` | Read the exact terms bytes that both parties sign |
| `POST` | `/reliability/contracts/sign` | Sign the frozen terms |
| `POST` | `/reliability/contracts/action` | Submit one signed party action |
| `POST` | `/reliability/contracts/agree` | Submit a Tier 1 outcome signed by both parties |
| `POST` | `/reliability/contracts/terminate` | Submit a mutual termination signed by both parties |
| `POST` | `/reliability/contracts/ruling` | Submit a Tier 3 ruling signed by the mediator |
| `POST` | `/reliability/contracts/tick` | Run one contract scheduler pass |
| `GET` | `/reliability/contracts/audit` | Read a contract audit log and its hash-chain status |
| `POST` | `/reliability/listings` | Create a listing |
| `POST` | `/reliability/offers` | Make, then `/accept`, `/decline`, or `/withdraw` an offer |
| `GET` | `/reliability/offers` | Read offers |
| `POST` | `/reliability/invoices` | Issue an invoice, then `/settle` or `/review` it |
| `GET` | `/reliability/invoices` | Read an invoice by `id` |
| `GET` | `/reliability/fees` | Read the accepted fee charge for a transaction |
| `GET` | `/reliability/fees/quote` | Preview the checks and fees for a sale |
| `GET` | `/reliability/scores/explain` | Explain each score change |

Entity, listing, and transaction reads accept an optional `id` query.
Score reads accept an optional `entityId` query.
Receipt reads require `transactionId`.
Lifecycle reads require `transactionId` and accept an optional `now` query.
Collections include stored records. A stored record takes precedence over a fixture with the same ID.
Use the lifecycle read for stage history and current terms recommendations.
A sale, an invoice, and a contract open only after KYC and limit checks.
Read [Marketplace rules and writes](docs/marketplace.md) for the checks, fees, listings, offers, and invoices.

Read [Transaction lifecycle](docs/reliability-lifecycle.md) for actions and evidence rules.
Read [Contract lifecycle](docs/contract-lifecycle.md) for contract templates, tiered disputes, signed party actions, and live Masumi escrow.
Read [mock KYC](docs/kyc.md) for onboarding states and tier rules.
Read [module boundaries](docs/reliability-modules.md) before you extend a lane.

## Payment and scoring status

Marketplace orders are paper.
Cardano escrow is simulated by default.
Preprod requests need `CARDANO_MODE=preprod` and `CARDANO_ALLOW_NETWORK=true`.
An enabled preprod request has `mode: live`.
This mode does not prove confirmed settlement.

The v1 lifecycle remains the paper demo. Its standard adapter rejects live funding.
Use the signed [contract lifecycle](docs/contract-lifecycle.md) for live escrow.
A v1 live port must verify `escrow_funded`, `payment_settled`, and `refunded` on chain.
An accepted action stays pending until the required money movement is confirmed.
Paper stages remain simulations.
Commands use durable identities and saved responses for safe retries.
Read [chain evidence](docs/reliability-lifecycle.md#chain-evidence) before you use these stages.

Scores use the weighted Beta model with value weights, repeat-pair decay, and the fifth-percentile lower bound.
Each sale records an accepted buyer fee and seller fee. The paper ledger collects, waives, or refunds them.
The parameters are defaults until the product owner selects them.
Run `bun run scores:rebuild` after a policy change.
Read [Reliability math](docs/reliability-math.md).

Run `bun run funding:demo` for the paper pool ledger.
Read [paper omnibus funding](docs/omnibus-funding.md) for allocation rules and live custody requirements.
This ledger does not send chain transactions or fund lifecycle escrow.

Read [Cardano payment adapters](docs/cardano-payments.md) and
[settlement evidence](docs/masumi-settlement.md) for shared payment components.
The v1 verification seam uses the shared settlement verifier.
The contract adapter has separate settlement checks. Read its known limits before a live run.

## Checks

```sh
bun test packages services ui
bun run typecheck:control
bun run payments:typecheck
bun run lint
```

These checks cover shared code, marketplace code, and the operator UI.
No CRE installation is required for these checks.
