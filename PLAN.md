# B2B and B2C marketplace plan

The product is a marketplace for goods and services.
It supports business-to-business (B2B) and business-to-consumer (B2C) transactions.
Its reliability checker assesses buyers and sellers from transaction outcomes.

This plan replaces the retired prediction-market runtime plan.
Read [Implementation status](docs/implementation-status.md) for current code and known limits.
Read [lane ownership](docs/reliability-lanes.md) for module owners and reserved migrations.

## Product flow

1. Register the buyer and seller.
2. Check their identity, KYC status, and reliability scores.
3. Create a listing or offer.
4. Agree on price, delivery, payment, and dispute terms.
5. Fund escrow when the agreement requires it.
6. Record delivery or invoice payment evidence.
7. Resolve acceptance, expiry, cancellation, or dispute.
8. Confirm the payout or refund.
9. Update the applicable buyer and seller scores.
10. Show the outcome, evidence, and fees.

This flow is the target.
Main has fixture reads, mock KYC, a stored lifecycle, and a local operator display.
It does not implement the complete buyer and seller flow.

## Reliability rules

Each entity has separate buyer and seller scores for each category.
Goods update delivery reliability.
Services update fulfillment reliability.
Invoices update payment reliability.

Scale score changes with transaction value: `w = log(1 + v / v0)`.
`v` is the transaction value. `v0` is the value scale.
Reduce the weight of repeat transactions between the same pair.
Use a Beta lower bound to show uncertainty.
Keep verification confidence and score confidence distinct.

A success updates the applicable participant roles.
A failure updates only the at-fault role.
Pending, disputed, and cancelled outcomes do not imply success.
Correct earlier score events when a final outcome changes.

## Commercial rules

Charge a platform fee on the buyer side and the seller side.
Use each participant's reliability score to select its fee.
Higher reliability gives a lower fee.
Store accepted terms and charges with the agreement.
Keep them separate from later recommendations.

Use verified identity and KYC restrictions for marketplace actions.
Keep invoice terms, due dates, and payment evidence linked to the agreement.
Keep goods delivery evidence separate from service acceptance evidence.

The fee bounds, pair decay rate, and final KYC bar remain open decisions.
Delivery evidence and dispute policy also need product decisions.
Live preprod testing needs assigned key owners.

## Work order

| Priority | Work | Completion condition |
| --- | --- | --- |
| 1 | Correct lifecycle outcomes and payment completion | Confirm funds locks, payouts, and refunds. Correct score events after disputes. |
| 1 | Add safe action retries and time checks | Persist command identity before external calls. Use server time. Recover after restart. |
| 1 | Authenticate callers and authorize actions | Check participant ownership, resolver authority, and consent. |
| 2 | Implement the reliability model | Apply value and pair weights. Calculate the Beta lower bound. Explain each score change. |
| 2 | Apply fees, terms, and KYC restrictions | Store accepted charges. Enforce transaction limits and required verification. |
| 2 | Add marketplace writes and stored reads | Create listings and offers. Discover stored deals and receipts. |
| 2 | Complete B2B and B2C evidence flows | Verify invoice payment, service acceptance, and goods delivery against agreed terms. |
| 3 | Improve the operator display | Add pagination, bounded polling, stored deal discovery, and clear evidence sources. |
| 3 | Connect pooled funding to escrow | Reconcile allocations, payouts, refunds, cancellations, and available balances. |

Pull request [#17](https://github.com/xiaoyang4c/actual-token2049-hackathon-repo/pull/17) proposes contract templates and a contract lifecycle.
It is not merged into main.
Review its changes against these requirements before merge.

## Payment boundary

Use paper transactions for the current demo.
Use simulated escrow by default.
Label enabled preprod activity as live escrow.
Queued requests and fixture responses do not prove settlement.
Actual preprod settlement has not been tested.

The shared Cardano adapters and settlement observer provide useful payment components.
The marketplace lifecycle still needs their confirmation checks.
The paper funding pool is a separate ledger.
It does not fund lifecycle escrow or return allocated credit after a refund.

## Source retirement

The old trading plans and demo evidence are retired.
Shared runtime code still supplies the control API store and payment types.
Refactor these dependencies before deleting their source files or migrations.
Separate marketplace startup from the legacy market feed during that refactor.
