# Transaction lifecycle

The lifecycle sells goods and services.

Each escrow order is paper.

The lifecycle calls the simulated Masumi adapter.

The lifecycle does not broadcast a live order.

Read [Reliability marketplace: lane ownership](reliability-lanes.md) for lane boundaries.

Read [Cardano and Masumi payment scaffolding](cardano-payments.md) for the Masumi adapter.

## States

A transaction starts at `offer_accepted`.

Use the next stage from this list.

| From | To |
| --- | --- |
| `offer_accepted` | `escrow_funded`, `cancelled` |
| `escrow_funded` | `delivery_confirmed`, `dispute_opened`, `refunded` |
| `delivery_confirmed` | `payment_settled`, `dispute_opened` |
| `payment_settled` | `dispute_opened` |
| `dispute_opened` | `dispute_resolved` |
| `dispute_resolved` | `payment_settled`, `refunded` |
| `refunded` | none |
| `cancelled` | none |

`escrow_funded`, `payment_settled`, and `refunded` call the Masumi escrow port.

`advance` rejects those three stages.

An invalid transition throws `LifecycleError`.

## Outcomes

`payment_settled` produces `successful`.

`cancelled` produces `cancelled`.

A voluntary refund produces lifecycle stage `refunded` and outcome `cancelled`.

A resolver refund produces outcome `failed`.

`dispute_opened` produces `disputed` before the deadline.

`dispute_opened` produces `unresolved` after the deadline.

`pending` is not `successful`.

`disputed` is not `failed`.

`cancelled`, `pending`, `disputed`, and `unresolved` emit no reliability events.

## Delivery evidence

Put `deliveryTier` on the delivery confirmation.

Use the tiers in this order. The first tier is the strongest.

| Tier | Verification method | Confidence | Settlement |
| --- | --- | --- | --- |
| `carrier_proof` | `lifecycle` | 0.95 | allowed |
| `buyer_confirmation` | `lifecycle` | 0.7 | allowed |
| `silent_release` | `lifecycle` | 0.4 | allowed |
| `self_report` | `unverified` | 0.1 | rejected |

`carrier_proof` needs `carrier` and `proofRef`.

A seller claim is not carrier proof.

`buyer_confirmation` needs `confirmedBy` equal to the buyer id.

`silent_release` waits until `disputeWindowEnds`.

`silent_release` also requires no open dispute and no complaint.

Call `release` from `escrow_funded` with `deliveryTier` set to `silent_release`.

`self_report` stays `pending`.

Do not treat `self_report` as a strong outcome.

Give `self_report` weight 0 in scoring.

## Disputes

Name `resolver` and `resolveBy` when you open a dispute.

`resolveBy` must be a UTC timestamp after the open time.

Before the deadline, the outcome is `disputed`.

The resolver can uphold the seller. That releases escrow.

The outcome is `successful`.

The verification method is `manual-review`.

The confidence is 0.85.

The resolver can uphold the buyer. That requests a refund.

The outcome is `failed`.

The evidence field `fault` is `seller`.

After the deadline, the outcome is `unresolved`.

The evidence field `timeoutResult` is `unresolved`.

The evidence field `escrowDisposition` is `held`.

The paper escrow stays held.

The lifecycle does not release it.

The lifecycle does not refund it.

A later resolve throws `the dispute deadline has passed; the result is unresolved`.

## Terms

`open` stores terms version 1.

The reason is `initial terms`.

Call `amendTerms` to change terms.

`amendTerms` appends a version.

`amendTerms` does not edit an older version.

A terminal stage freezes terms.

An unresolved dispute freezes terms.

## Demo routes

The demo store is process memory.

Restarting the process clears it.

Every response sets `mode` to `paper`.

| Method | Path | Action |
| --- | --- | --- |
| `POST` | `/reliability/lifecycle/open` | Create the transaction and accept the offer |
| `POST` | `/reliability/lifecycle/terms` | Append a terms version |
| `POST` | `/reliability/lifecycle/transition` | Fund, deliver, release, refund, cancel, dispute, or resolve |
| `GET` | `/reliability/lifecycle?transactionId=` | Read the stage, outcome, events, and terms decisions |

Send `action` in the transition body.

Use `fund`, `deliver`, `release`, `refund`, `cancel`, `dispute`, or `resolve`.

Send `at` as a UTC timestamp such as `2026-10-06T00:00:00.000Z`.

`fund` also needs `amountLovelace`, `sellerReturnAddress`, and `disputeWindowEnds`.

`deliver` needs `evidence.deliveryTier`.

Add `now` on the GET when you want the dispute deadline checked at a later time.

The GET runs the outcome through `outcomeToEvents` and the stub terms policy.

The math lane can replace those stub calls in its own route.

Schema for the stage history is `packages/db/migrations/010_lane_a_lifecycle.sql`.

KYC uses migration `008`.

Lane D keeps migration `009`.
