# Reliability module boundaries

The marketplace uses separate modules for transport, lifecycle rules, and policy.
Marketplace transactions are paper.
Cardano escrow is simulated by default.
The existing preprod network gates still apply.

## Domain modules

`packages/reliability/src/lifecycle.ts` coordinates stage changes, escrow calls,
and store writes. Its public exports stay available at the same import paths.

| Module under `packages/reliability/src/lifecycle/` | Responsibility |
| --- | --- |
| `contracts.ts` | Lifecycle interfaces, stage rules, delivery tiers, and the shared error class |
| `commands.ts` | Persist command identities, external-call checkpoints, and completed results. Block ambiguous resubmission. |
| `codecs.ts` | Validate timestamps and evidence. Copy terms and stored transitions. |
| `escrow-evidence.ts` | Convert an escrow session to scalar evidence. Restore the session from that evidence. |
| `outcome.ts` | Project stage history into an outcome, fault, and verification confidence. No store writes. |

The contract lifecycle lives in `packages/reliability/src/contract-lifecycle/`.
Read [Contract lifecycle](contract-lifecycle.md).

| Module under `packages/reliability/src/contract-lifecycle/` | Responsibility |
| --- | --- |
| `engine.ts` | Contract actions, scheduler, rulings, and remedies. No store or network access. |
| `transitions.ts` | The milestone transition table |
| `ports.ts` | Store, escrow, and clock seams |
| `settlement.ts` | Map a milestone to a transaction, an outcome, and penalty events |
| `templates.ts` and `templates/` | Contract templates as configuration |
| `deadlines.ts`, `remedies.ts`, `fees.ts` | Masumi deadlines, escrow layout and payouts, dispute fees |
| `canonical-json.ts`, `hashing.ts`, `signatures.ts` | JCS, MIP-004 hashes, Ed25519 |

The frozen domain types stay in `packages/reliability/src/types.ts`.
The scoring, pair-decay, fee, and KYC interfaces stay in their lane files.

| Module under `packages/reliability/src/` | Responsibility |
| --- | --- |
| `scoring.ts` and `beta-math.ts` | Weighted Beta model, value weight, and the fifth-percentile lower bound |
| `pair-decay.ts` | Repeat-pair decay and the pair key |
| `event-weights.ts` | Event weight records with every input and policy version |
| `fees-policy.ts` | Fee curve, deposit, premium, payment days, verification, and exposure limit |
| `fee-charges.ts` | Accepted buyer and seller fees for one sale, in minor units |
| `kyc-gate.ts` | KYC restrictions for marketplace actions |
| `offers.ts` | Offer records and status moves |
| `evidence-payment.ts` | Invoice terms hash and payment outcome |
| `evidence-delivery.ts` | Goods delivery and service acceptance against agreed terms |

## Service modules

| Module under `services/reliability/` | Responsibility |
| --- | --- |
| `route.ts` | Define the route contract for every lane. |
| `policies.ts` | Compose the default scoring, pair-decay, and fee policies. |
| `lifecycle-request.ts` | Parse HTTP values and dispatch lifecycle actions. No direct store access. |
| `lifecycle-service.ts` | Use one shared `AgentStore` for parties, lifecycle views, events, states, and terms. |
| `routes-lane-a.ts` | Map lifecycle requests and errors to HTTP responses. |
| `routes-plumbing.ts` | Merge stored collection records over fixtures. Read stored receipts first. |
| `masumi-escrow.ts` | Submit escrow actions. Use the shared verifier for live funds locks, payouts, and refunds. |
| `contract-service.ts` | One contract engine per store: escrow choice, clock, and reliability publishing. |
| `reliability-projection.ts` | Cumulative outcome projection on the shared store, with extra penalty events. |
| `contract-paper-escrow.ts` | Paper model of the Masumi V2 escrow. |
| `contract-masumi-escrow.ts` | Live Masumi V2 escrow on the shared payment client. |
| `routes-lane-a-contracts.ts` | Map signed contract requests and errors to HTTP responses. |
| `score-ledger.ts` | Record event weights and pair positions. Rebuild and explain scores. |
| `marketplace-gate.ts` | Check KYC, exposure limits, invoice due dates, and listing minimums. Record and settle fee charges. |
| `marketplace-service.ts` | Listings and offers. Acceptance opens the sale. |
| `invoice-service.ts` | Issue, settle, and review invoices. |
| `routes-marketplace.ts` | Listing, offer, invoice, and fee routes. |
| `routes-scoring.ts` | The score explanation route. |

`createLaneARoutes` accepts policies, a clock, and an escrow factory for each store.
It keeps a separate service cache for each route table and store.
`createPlumbingRoutes` accepts the same policy bundle.
The existing `laneARoutes` and `plumbingRoutes` exports use the defaults.
The `ReliabilityRoute` export from `routes-plumbing.ts` remains available for KYC.

`omnibus-funding.ts` records paper deposits and deal allocations through the shared store.
It does not register HTTP routes or call the escrow port.
Read [paper omnibus funding](omnibus-funding.md).

## Next changes

Replace the implementations in `policies.ts` when the math and fee lanes are ready.
Use the route factories to test those implementations with an offline escrow port.
KYC routes can keep using the control API store and the current route registry.
The lifecycle view reads entity tiers from that store for each request.
The UI can keep reading the existing response shapes.

Lifecycle scoring starts from the stored state for each entity, category, and role.
Stored event ids mark outcomes that have already been applied.
The service reads that history under the SQLite write lock.
It commits new events, score updates, and terms decisions in one transaction.
Repeated reads return current terms without applying the event again.
If an older write left events without a score, the service rebuilds that missing
score from its event history under the active scoring policy.
Changed outcomes archive and replace their active events.
The service rebuilds affected scores from saved baselines and active history.
It commits corrections with current terms under the same write lock.
The score read route uses stored rows when available. Fixture rows fill missing triples.

Migration `014` stores commands, event revisions, score baselines, and listings.
The command journal claims the transaction before an external action.
It commits a completed money stage and command result together.
An unknown external response requires reconciliation.
The API does not yet provide that operator flow.

`withRecordedWeights` wraps the policy bundle for each store.
Every applied event then uses its recorded weight, so reads and rebuilds agree.
`STUB_RELIABILITY_POLICIES` keeps unit weights for tests of cumulative mechanics.
Read [Reliability math](reliability-math.md) for the model and the default parameters.
Fee limits, the decay rate, and the KYC bar still require product decisions.

The lifecycle, invoice, and contract services run the marketplace gate before a sale opens.
They record accepted fee charges and settle them from the outcome.
Read [Marketplace rules and writes](marketplace.md) and
[Implementation status](implementation-status.md) for the remaining work.

Read [lane ownership](reliability-lanes.md) before changing a lane.
Read [transaction lifecycle](reliability-lifecycle.md) for state and escrow rules.
