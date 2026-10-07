# Implementation status

This page describes the marketplace after the lifecycle correctness fixes.
The review date is 2026-10-07.
The fixes build on main at commit `05790d6`.
Update this page when a change removes a listed limit.

The product is Tally: a B2B and B2C marketplace with escrowed contracts and a reliability checker.
[PLAN.md](../PLAN.md) defines the product plan.
[Lane ownership](reliability-lanes.md) defines module owners and target rules.
The prediction-market runtime and capital-allocation plans are retired.

Marketplace orders are paper.
Escrow uses simulation by default.
An enabled preprod request has `mode: live`.
That mode alone does not prove settlement.
The v1 lifecycle remains a paper demo.
Its standard adapter rejects live funding before a network request.
Its live verification seam now requires confirmed chain evidence.
Use the contract lifecycle for live escrow.
The contract adapter has separate recovery and settlement checks.

Pull request [#17](https://github.com/xiaoyang4c/actual-token2049-hackathon-repo/pull/17) adds the contract lifecycle.
Its templates, tiered disputes, and signed contract routes are now on main.
Read [Contract lifecycle](contract-lifecycle.md).

## Marketplace features

| Feature | Current implementation | Remaining work |
| --- | --- | --- |
| Buyer and seller scores | Separate stored scores by category and role; outcome corrections rebuild affected scores | Controlled policy changes and complete history repair |
| Scoring model | Unit event weights and a placeholder lower bound | Value weighting and a Beta credible bound |
| Repeat-pair control | A decay interface; the event flow discards its weight | Stored pair counts and applied decay |
| Fees and terms | Buyer and seller rate offers from a stub | Agreed fee curves, fee collection, and term enforcement |
| KYC | Mock checks, tiers, history, expiry actions, and re-registration flags | A verified provider and enforced restrictions |
| Invoice evidence | A stub compares supplied payment and due dates | Agreed terms hashes and verified settlement times |
| Listings | Stored reads with fixture fallback | Listing writes and a buyer/seller offer flow |
| Contract lifecycle | Signed terms, milestones, dispute tiers, remedies, durable escrow recovery, and audit history | Verified key registration, actual preprod testing, and token receipt checks |
| Tally UI | Read-only areas: My deals, Mediation desk, Companies, and Operator (transactions, attention, participants, listings, and contracts). A public demo with paper data | Sign-in, per-party visibility, pagination, and clear source labels |
| Coworkers | Three Sokosumi Coworkers on the Masumi registry, with engine-backed tools and instructions | The Task worker, model access, and a paid Task with collection |
| Hosted demo | A preprod server with the payment service, the control API, the UI, and six showcase contracts | A live escrow run and a running contract worker |
| Pooled funding | Paper deposits and deal allocations | Escrow integration, return credits, and reconciliation |

The target value weight is $w = \ln(1 + v / v_0)$.
The score stub does not use this weight or repeat-pair decay.
Read [Reliability math](reliability-math.md) for the target equations.
The lifecycle fixes implement unit-weight corrections only.
The fee stub returns offers for one entity.
Those offers are not charged totals for both participants.

Read [scoring](../packages/reliability/src/scoring.ts),
[event flow](../packages/reliability/src/event-flow.ts), and
[fee policy](../packages/reliability/src/fees-policy.ts) for the implementations.

The product owner must decide fee bounds, pair decay, and the KYC bar.
Delivery evidence, dispute policy, and preprod key ownership also need decisions.

## Logic gaps

The seven gaps from the earlier review have fixes and regression tests.

| Area | Implemented behavior | Source |
| --- | --- | --- |
| Outcome corrections | Archive replaced events. Rebuild affected scores from their baseline and active history. | [Lifecycle projection](../services/reliability/lifecycle-service.ts) |
| Escrow completion | Keep live actions pending until chain verification confirms the funds lock, payout, or refund. | [Escrow adapter](../services/reliability/masumi-escrow.ts) |
| Lifecycle retries | Store command identity and external-call checkpoints. Replay completed results. Block ambiguous resubmission. | [Command journal](../packages/reliability/src/lifecycle/commands.ts) |
| Time checks | Reject times before stored transitions or terms. Check the server clock for dispute deadlines. Keep timeout outcomes final. | [Escrow lifecycle](../packages/reliability/src/lifecycle.ts) |
| Read timestamps | Use the transition time for a decision and the deadline for a timeout. Later reads keep these times. | [Outcome projection](../packages/reliability/src/lifecycle/outcome.ts) |
| Stored collections | Merge stored entities, listings, and transactions over fixtures. Read stored receipts first. | [Read routes](../services/reliability/routes-plumbing.ts) |
| Buyer-fault refunds | Validate and forward `fault: buyer`. Score only the buyer role. | [Request adapter](../services/reliability/lifecycle-request.ts) |

Read [Transaction lifecycle](reliability-lifecycle.md) for stage and evidence rules.

## Remaining improvements

| Area | Remaining work |
| --- | --- |
| Caller identity | Authenticate v1 participants and resolvers. Bind contract key registration to verified identity and KYC. |
| External recovery | Add an operator reconciliation flow for a call that started but lost its response. Automatic resubmission stays blocked. |
| Legacy records | Reconcile old live stages that lack proof. Repair score history when a valid baseline cannot be recovered. |
| Policy history | Store value, pair weight, and policy inputs. Add controlled policy migrations and rebuilds. |
| Agreement history | Store accepted charges separately from later score recommendations. |
| Operator freshness | Add pagination, bounded reads, and clear source labels. |
| Marketplace startup | Remove the legacy trading runtime and market-feed startup dependencies. Preserve shared storage and payment functions. |

## Payment boundaries

The v1 live verification seam uses the shared [settlement verifier](masumi-settlement.md).
The standard v1 live funding guard remains in place.
The signed contract lifecycle is the supported live path.
Its adapter currently checks ADA settlement only.
Actual USDM receipt verification still needs implementation.
Live funding needs a confirmed funds lock.
Live release needs a verified seller payout.
Live refund needs a verified buyer refund.
A queued request is not sufficient.
Paper stages remain simulations and record `settlementVerified: false`.

The [paper omnibus ledger](omnibus-funding.md) records credits and allocations only.
It sends no chain transaction.
Cancellation and refund actions do not return its allocated credit.
Live custody requires a separate implementation.

Actual preprod settlement has not been tested.
The v1 demo routes do not authenticate callers.
Contract actions check signatures, but initial key registration is open.

## Validation

All 570 local tests pass under `packages`, `services`, and `ui`.
One intermittent failure appeared once in 13 full runs on 2026-10-07. It did not reproduce, and its test is not identified yet.
The control and payment TypeScript checks pass.
Lint passes.
Regression tests cover all seven gaps, restart behavior, and two database writers.
Escrow checks use injected ports and offline adapter tests.
They make no live chain calls.
Existing PR CI also runs the workflow tests and workflow TypeScript check.
Browser rendering and actual preprod settlement were not tested for the lifecycle fixes.
The Tally UI views were checked in a browser, in light and dark mode.
