<p align="center"><img src="docs/brand/tally-logo.png" alt="Tally" width="96" height="96"></p>

# Tally

Tally is a trust layer for business deals.
Buyers and sellers who do not know each other agree on the evidence first.
Funds wait in escrow on Cardano until that evidence arrives.
Every finished deal updates a reliability record for both sides.

Tally was built for the TOKEN2049 Origins hackathon.
It runs on Cardano **preprod** with **test USDM**. Nothing has real value.

**Live demo:** <https://main.d23gra1a9ugqjs.amplifyapp.com>.
The demo shows paper contracts, labelled SIMULATED.
The signed-in app edition uses a separate database and shows each user only their own deals.
Read [Two Amplify editions](docs/amplify.md) for both website and server setups.

## What Tally does

| Part | What it does | Read more |
| --- | --- | --- |
| Escrowed contracts | Templates, milestones, and the evidence rules both parties sign. Funds lock in a Masumi V2 escrow per milestone. | [Contract lifecycle](docs/contract-lifecycle.md) |
| Disputes in tiers | Tier 1: the parties agree one fixed outcome. Tier 2: the named judge (code or an inspector) decides. Tier 3: a mediator names a winner. The remedy was fixed before funding. | [Contract lifecycle](docs/contract-lifecycle.md#disputes) |
| Reliability record | Separate buyer and seller scores per category, terms decisions, and mock KYC. Ignored rulings count against a party. | [Reliability math](docs/reliability-math.md) |
| Coworkers on Sokosumi | Tally Deal Desk drafts contracts. Tally Mediator drafts rulings for a human mediator. Tally Trust Check explains a company's record. Every number comes from Tally's code. | [Tally Coworkers](services/reliability/coworkers/README.md) |
| Tally UI | Demo views and a signed-in app edition with My deals, New deal, and signed party actions. | [UI instructions](ui/README.md) |
| Wallet accounts | Sign in with a Cardano wallet (connected or created in the browser), pass KYC, and deposit test funds for live deals. Tally never holds wallet keys. | [Wallet accounts](docs/wallets.md) |

## Status

| Area | State |
| --- | --- |
| Contract engine, disputes, remedies, audit log | Built and tested. Paper by default |
| Live Masumi V2 escrow | Built. Tested against a fake payment service. No live preprod run yet |
| Masumi payment service | Running on the preprod server with funded wallets |
| Coworkers | Registered on the Masumi registry and approved in the TOKEN2049 workspace. The Task worker runs on the server. Paid Tasks complete with Masumi escrow on preprod, and the first collection is confirmed |
| Settlement anchors | Built. Fingerprints of settled records, chained per company, for Cardano preprod. Posting waits for the team's go-ahead. Read [Settlement anchors](docs/settlement-anchors.md) |
| Tally UI | Hosted publicly with six showcase contracts and a free chat with the three Coworkers |
| Scoring, pair decay, fees | Built with default parameters: weighted Beta scores, repeat-pair decay, and buyer and seller fee charges. Read [Reliability math](docs/reliability-math.md) |
| Listings, offers, invoices | Built for paper orders. Read [Marketplace rules and writes](docs/marketplace.md) |
| KYC | Mock provider. Enforced before sales, invoices, contracts, and key registration. Self-service through the Account page |
| Sign-in | Wallet sign-in with 24-hour sessions gates deals in the app edition. The demo keeps its public role lenses |
| App deal actions | Wallet-derived deal keys, signed terms, delivery, acceptance, disputes, returns, redo, and ruling compliance. Tier 1 two-sided agreement, mutual termination, and inspector templates are not in the app yet |
| Deposits | Live preprod deposits from proven wallets, credited after 3 confirmations. Needs the deposit address and the deposit worker. Read [Wallet accounts](docs/wallets.md) |

Read [Implementation status](docs/implementation-status.md) for every feature and known gap.
Read [PLAN.md](PLAN.md) for the product scope and work order.
Read [lane ownership](docs/reliability-lanes.md) before you change a module.

## Rules

- Scale each score change with transaction value: $w = \ln(1 + v / v_0)$.
  $v$ is the transaction value. $v_0$ is the value scale.
- Reduce score gains from repeat transactions between the same pair.
- Set buyer and seller platform fees from their reliability scores.
  Higher scores give lower fees.
- Use KYC checks and agreed terms to control participation.
- Keep delivery evidence, dispute decisions, and payment evidence separate.

The code applies these rules with default parameters.
The product owner has not selected the parameters.
KYC currently uses a mock provider.

## Layout

| Path | Purpose |
| --- | --- |
| `packages/reliability` | Marketplace types, scoring, terms, KYC, evidence, the v1 lifecycle, and the contract engine (`src/contract-lifecycle`) |
| `packages/db` | Shared SQLite store, migrations, marketplace records, contract records, and payment records |
| `services/control-api.ts` | Registers the marketplace and contract routes against one shared `AgentStore` |
| `services/reliability` | Read routes, lifecycle actions, the contract service, the Masumi escrow adapters, mock KYC, and the Coworker tools |
| `services/reliability/coworkers` | Instructions for the three Coworkers |
| `services/cardano-agents-ts` | Shared Cardano and Masumi adapters, payment evidence, and settlement observer |
| `ui` | The Tally UI |
| `web` | The Tally web app: the same areas plus the Deal Desk, built with React. Read [web/README.md](web/README.md) |
| `deploy/preprod` | The preprod server: payment service, Caddy, systemd units, and the deploy script |
| `docs/brand` | The Tally mark, logo, and Coworker avatars |

Some source code still supports the retired trading runtime.
The marketplace control API opens its shared store directly.
The contract worker and paper trading demo use the same database setup.
Cardano payment code also uses shared core types.
Refactor those types before removing their source files.

## Run locally

Install [Bun](https://bun.sh), version 1.2.21 or later.

```sh
bun install
CONTROL_DB_PATH=services/.data/agent.sqlite bun run contracts:showcase   # once: six demo contracts
bun run services
# In another terminal:
bun run ui/server.ts
```

Open <http://localhost:8791>.
Open an area directly with `/?view=deals`, `/?view=mediation`, `/?view=companies`, or `/?view=operator`.

The marketplace launcher starts the control API on port 8787 and the shared payment service on port 8788.
It does not create a trading book or start venue polling.
`GET /agent/state` reads an existing paper book without changing it. It returns 404 when no book exists.
`GET /audit` and the audit demo write remain available.
Run `bun run services:legacy` for the retired paper trading demo, its score provider on port 8789, and its market feed on port 8790.
Use one launcher at a time. Both launchers use the same control and payment ports.
Read [Bun scripts](https://bun.sh/docs/runtime#run-a-packagejson-script) for script commands.

Other demos:

```sh
bun run contracts:demo     # paper contract demo in the terminal
bun run funding:demo       # paper pool ledger
bun run contracts:smoke    # preprod escrow proof (needs both network gates)
```

## Hosted demo

The preprod server runs the Masumi payment service, the control API, and the UI.
Only the UI is public. It forwards GET reads from a fixed list and refuses writes.
Deploy a git ref with `deploy/preprod/deploy-app.sh <ref>`.
Read [the preprod server](deploy/preprod/README.md) to rebuild or operate it.

## Routes

### Marketplace

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

Entity, listing, and transaction reads accept an optional `id` query.
Score reads accept an optional `entityId` query.
Receipt reads require `transactionId`.
Lifecycle reads require `transactionId` and accept an optional `now` query.
Collections include stored records. A stored record takes precedence over a fixture with the same ID.
Use the lifecycle read for stage history and current terms recommendations.
Listing and offer write routes are listed below.

### Contracts

| Method | Path | Purpose |
| --- | --- | --- |
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
| `GET` | `/reliability/contracts/list` | List contracts with the next action on each milestone |
| `GET` | `/reliability/contracts/case` | Read the case file of one disputed milestone |
| `GET` | `/reliability/contracts/ruling-options` | Simulate each Tier 3 ruling on a copy of the contract |
| `GET` | `/reliability/contracts/ruling-payload` | Return the exact bytes that the mediator signs |
| `GET` | `/reliability/profile` | Read a company record |
| `GET` | `/reliability/profile/search` | Find companies by name or id |
| `POST` | `/reliability/listings` | Create a listing |
| `POST` | `/reliability/offers` | Make, then `/accept`, `/decline`, or `/withdraw` an offer |
| `GET` | `/reliability/offers` | Read offers |
| `POST` | `/reliability/invoices` | Issue an invoice, then `/settle` or `/review` it |
| `GET` | `/reliability/invoices` | Read an invoice by `id` |
| `GET` | `/reliability/fees` | Read the accepted fee charge for a transaction |
| `GET` | `/reliability/fees/quote` | Preview the checks and fees for a sale |
| `GET` | `/reliability/scores/explain` | Explain each score change |

Every party action carries an Ed25519 signature.
The read views use the Coworker tools, so the UI and the Coworkers show the same engine numbers.
A sale, an invoice, and a contract open only after KYC and limit checks.
Read [Marketplace rules and writes](docs/marketplace.md) for the checks, fees, listings, offers, and invoices.

Read [Transaction lifecycle](docs/reliability-lifecycle.md) for v1 actions and evidence rules.
Read [Contract lifecycle](docs/contract-lifecycle.md) for templates, tiered disputes, signed party actions, and live Masumi escrow.
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

These checks cover shared code, marketplace code, contracts, the Coworker tools, and the UI.
No CRE installation is required for these checks.
