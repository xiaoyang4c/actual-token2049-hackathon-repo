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

The backend implements this flow for paper orders.
It has listings, offers, KYC and limit checks, accepted fees, a stored lifecycle, invoices, and weighted scores.
It does not authenticate callers, and no buyer or seller screen exists.
Read [Marketplace rules and writes](docs/marketplace.md).

## Reliability rules

Each entity has separate buyer and seller scores for each category.
Goods update delivery reliability.
Services update fulfillment reliability.
Invoices update payment reliability.

Scale score changes with transaction value: $w = \ln(1 + v / v_0)$.
$v$ is the transaction value. $v_0$ is the value scale.
Reduce the weight of repeat transactions between the same pair.
Use the fifth percentile of the Beta distribution for policy decisions.
Use the mean for display.
Read [Reliability math](docs/reliability-math.md) for the model and proposed commercial rules.
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
| 1 | Validate lifecycle payment completion | Chain checks and score corrections are implemented. Reconcile legacy records and test actual preprod settlement. |
| 1 | Complete external-action recovery | Durable commands and time checks are implemented. Add an operator flow for lost external responses. |
| 1 | Authenticate callers and authorize actions | Check participant ownership, resolver authority, and consent. |
| 2 | Implement the reliability model | Implemented with default parameters. Select the parameters. |
| 2 | Apply fees, terms, and KYC restrictions | Implemented with default parameters and mock KYC. Select fee bounds and caps. Add a verified KYC provider. Put fees inside the escrow amount. |
| 2 | Add marketplace writes | Implemented for paper orders. Caller authentication is priority 1 work. |
| 2 | Complete B2B and B2C evidence flows | Implemented for paper orders. Live invoice settlement needs the USDM receipt check. |
| 3 | Improve the operator display | Add pagination, bounded polling, and clear evidence sources. |
| 3 | Connect pooled funding to escrow | Reconcile allocations, payouts, refunds, cancellations, and available balances. |

Pull request [#17](https://github.com/xiaoyang4c/actual-token2049-hackathon-repo/pull/17) adds contract templates and a signed contract lifecycle.
It is merged into main.
Read [Contract lifecycle](docs/contract-lifecycle.md) for its implemented flows and remaining limits.

## Payment boundary

Use paper transactions for the current demo.
Use simulated escrow by default.
Label enabled preprod activity as live escrow.
Queued requests and fixture responses do not prove settlement.
Actual preprod settlement has not been tested.

The shared Cardano adapters and settlement observer provide useful payment components.
The live marketplace lifecycle uses their settlement verification checks.
The paper funding pool is a separate ledger.
It does not fund lifecycle escrow or return allocated credit after a refund.

## Source retirement

The old trading plans and demo evidence are retired.
Shared runtime code still supplies the control API store and payment types.
Refactor these dependencies before deleting their source files or migrations.
Separate marketplace startup from the legacy market feed during that refactor.
