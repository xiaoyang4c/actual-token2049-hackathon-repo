# Implementation status

This page describes main at commit `a88920a`.
The review date is 2026-10-06.
Update this page when a change removes a listed limit.

The current product is a transaction reliability marketplace prototype.
Marketplace orders are paper.
Escrow uses simulation by default.
An enabled preprod request has `mode: live`.
That mode does not prove confirmed settlement.

## Plans

- [Lane ownership](reliability-lanes.md) defines the marketplace target state.
- [PLAN.md](../PLAN.md) describes the prediction-market trading runtime plan.
- [PLAN_v2.md](../PLAN_v2.md) proposes capital allocation for two strategies.
  The allocator, shared-event risk gate, and outcome replay are not implemented.
- Pull request [#17](https://github.com/xiaoyang4c/actual-token2049-hackathon-repo/pull/17) proposes the contract lifecycle.
  Its templates, tiered disputes, and contract routes are not on main.

## Marketplace features

| Feature | Current implementation | Remaining work |
| --- | --- | --- |
| Buyer and seller scores | Separate stored scores for each category and role | Outcome corrections and policy rebuilds |
| Scoring model | Unit event weights and a placeholder lower bound | Value weighting and a Beta credible bound |
| Repeat-pair control | A decay interface; the event flow discards its weight | Stored pair counts and applied decay |
| Fees and terms | Buyer and seller rate offers from a stub | Agreed fee curves, fee collection, and term enforcement |
| KYC | Mock checks, tiers, history, expiry actions, and re-registration flags | A verified provider and enforced restrictions |
| Invoice evidence | A stub compares supplied payment and due dates | Agreed terms hashes and verified settlement times |
| Listings | Fixture read routes | Listing writes and a buyer/seller offer flow |
| Operator display | Read-only transactions, receipts, scores, KYC, and listings | Stored collection reads and scalable pagination |
| Pooled funding | Paper deposits and deal allocations | Escrow integration, return credits, and reconciliation |

The target value weight is `w = log(1 + v / v0)`.
The score stub does not use this weight.
The event flow does not apply repeat-pair decay.
The fee stub returns offers for one entity.
Those offers are not charged totals for both transaction participants.

Read [scoring](../packages/reliability/src/scoring.ts),
[event flow](../packages/reliability/src/event-flow.ts), and
[fee policy](../packages/reliability/src/fees-policy.ts) for the current implementations.

The product owner must decide the fee bounds, pair decay rate, and KYC bar.
The product owner must also decide delivery evidence and dispute policy.
Preprod key ownership remains an open decision.

## Runtime limits

| Area | Current limit | Source |
| --- | --- | --- |
| Execution policy | Direct orders do not enforce category, venue, or maximum bet rules. The workflow checks these rules before submission. | [Order executor](../services/agent-runtime.ts) |
| Order retries | A reused key returns the first result, even if the order body changes. | [Order executor](../services/agent-runtime.ts) |
| Outcome corrections | A dispute reversal does not replace an applied success event or rebuild its score. | [Lifecycle projection](../services/reliability/lifecycle-service.ts) |
| Escrow completion | Result and refund requests produce final application stages without confirmed payout checks. | [Escrow lifecycle](../packages/reliability/src/lifecycle.ts) |
| Lifecycle retries | Concurrent calls can reach escrow twice. A retry after a completed action can fail the stage check. | [Escrow lifecycle](../packages/reliability/src/lifecycle.ts) |
| Time checks | Supplied times can precede earlier events. A backdated request can resolve a dispute after a timeout read. | [Escrow lifecycle](../packages/reliability/src/lifecycle.ts) |
| Read timestamps | A lifecycle read saves its supplied time as the outcome decision time. | [Outcome projection](../packages/reliability/src/lifecycle/outcome.ts) |
| Stored collections | Entity, listing, transaction, and receipt routes serve fixtures. New stored deals need lookup by ID. | [Read routes](../services/reliability/routes-plumbing.ts) |
| Buyer-fault refunds | The HTTP refund action does not forward the buyer fault to the domain method. | [Request adapter](../services/reliability/lifecycle-request.ts) |
| Caller identity | Demo routes do not authenticate buyers, sellers, or resolvers. Evidence checks compare supplied strings. | [HTTP helper](../services/lib/http.ts), [escrow lifecycle](../packages/reliability/src/lifecycle.ts) |

These limits apply to the current code.
The documentation does not fix them.
Read [Transaction lifecycle](reliability-lifecycle.md) for stage names and evidence rules.

## Payment boundaries

The [paid-research runtime](cardano-payments.md) confirms a funds lock before first delivery.
Its worker keeps delivery and [settlement evidence](masumi-settlement.md) separate.
The marketplace lifecycle does not use those confirmation checks.

The [paper omnibus ledger](omnibus-funding.md) records credits and allocations only.
It sends no chain transaction.
Cancellation and refund actions do not return its allocated credit.
Live custody requires a separate implementation.

Actual preprod settlement has not been tested.
Fixture responses and queued actions do not prove chain settlement.
The demo services do not implement public authentication or caller isolation.

## Validation

The review ran 406 repository tests and 17 workflow tests.
All 423 tests passed.
The control, payment, and workflow TypeScript checks passed.
Lint passed.

Separate local checks reproduced the first nine runtime limits in the table.
The escrow checks used injected ports.
They made no live chain calls.
Browser rendering and CRE deployment were not tested.
