# Implementation status

This page describes the marketplace after the priority 2 product logic.
The review date is 2026-10-07.
The change builds on main at commit `f353625`.
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
| Buyer and seller scores | Separate stored scores by category and role; outcome corrections rebuild affected scores; `bun run scores:rebuild` rebuilds every score | Selected parameters and a paper/live history split |
| Scoring model | Weighted Beta model: $W = a \cdot \ln(1 + v / v_0) \cdot D(n)$, the fifth-percentile lower bound, recorded weights, and `GET /reliability/scores/explain` | Selected value scales and display scale; calibration |
| Repeat-pair control | Stored pair positions per buyer, seller, and category; hyperbolic decay applied to each event | Selected decay rate and pair direction; a contribution cap |
| Fees and terms | Fee curve on both sides; accepted charges snapshot before a sale; collected, waived, or refunded from the outcome; exposure limits and invoice payment days enforced | Selected fee bounds and term scales; fees inside the escrow amount |
| KYC | Mock checks, tiers, history, expiry, and re-registration flags; enforced before a sale, an invoice, a contract, and key registration | A verified provider |
| Invoice evidence | Canonical terms hash at issue; payment checked for hash, currency, amount, and due date plus grace; overdue review | Live settlement source with the USDM receipt check |
| Delivery evidence | Goods delivery and service acceptance checked against `terms.delivery` and `terms.service` | Carrier and inspector identity checks |
| Listings | Listing writes, buyer offers, seller acceptance or decline, buyer withdrawal, and expiry | Caller authentication |
| Contract lifecycle | Signed terms, milestones, dispute tiers, remedies, durable escrow recovery, audit history, KYC-gated key registration, and fee charges per milestone | Actual preprod testing, token receipt checks, and score-based escrow terms |
| Tally UI | Read-only areas: My deals, Mediation desk, Companies, and Operator (transactions, attention, participants, listings, and contracts). A free chat with all three Coworkers, with follow-ups and automatic choice of the Coworker. A public demo with paper data | Sign-in, per-party visibility, pagination, clear source labels, and views for offers, invoices, and fee charges |
| Coworkers | Three Coworkers on the Masumi registry, with engine-backed tools and instructions. People chat with them on the Tally website, free. The Task worker takes paid Tasks from other agents through Sokosumi and Masumi escrow, with Gemini or the fill-in format. The first paid Task was collected on preprod | Bedrock with the instance role, and the Mediator signing flow back into Tally |
| Settlement anchors | Fingerprints of settled records, chained per company, posted to Cardano preprod as CIP-20 messages, with confirm-or-expire batch rules. The website shows anchor status | The first live batch (waits for the go-ahead), and a signed chain head for lenders |
| Hosted demo | A preprod server with the payment service, the control API, the UI, and six showcase contracts | A live escrow run and a running contract worker |
| Pooled funding | Paper deposits and deal allocations | Escrow integration, return credits, and reconciliation |

Read [Reliability math](reliability-math.md) for the equations.
Read [Marketplace rules and writes](marketplace.md) for the checks, fees, listings, offers, and invoices.
Read [scoring](../packages/reliability/src/scoring.ts),
[score ledger](../services/reliability/score-ledger.ts),
[fee policy](../packages/reliability/src/fees-policy.ts), and
[marketplace gate](../services/reliability/marketplace-gate.ts) for the implementations.

Every parameter is a default.
The product owner must decide fee bounds, value scales, pair decay, the KYC bar, and KYC caps.
Delivery evidence, dispute policy, and preprod key ownership also need decisions.
Run `bun run scores:rebuild` after a parameter change.

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
| Caller identity | Authenticate participants, sellers, buyers, and resolvers. Key registration checks KYC, but not who sends the request. |
| External recovery | Add an operator reconciliation flow for a call that started but lost its response. Automatic resubmission stays blocked. |
| Legacy records | Reconcile old live stages that lack proof. Repair score history when a valid baseline cannot be recovered. |
| Policy history | Version the selected parameters. Keep a paper score history apart from live evidence. |
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
The v1 demo routes and the marketplace write routes do not authenticate callers.
Contract actions check signatures. Key registration needs a KYC-verified entity.
Invoice payments are paper. They record `settlementVerified: false`.

## Validation

All 723 local tests pass under `packages`, `services`, and `ui`.
One intermittent failure appeared once in 13 full runs on 2026-10-07. It did not reproduce, and its test is not identified yet.
The control and payment TypeScript checks pass.
Lint passes.
Regression tests cover all seven gaps, restart behavior, and two database writers.
Score tests reproduce the worked example in the math page.
Escrow checks use injected ports and offline adapter tests.
They make no live chain calls.
Existing PR CI also runs the workflow tests and workflow TypeScript check.
Browser rendering and actual preprod settlement were not tested for the lifecycle fixes.
The Tally UI views were checked in a browser, in light and dark mode.
