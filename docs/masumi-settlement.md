# Masumi settlement reconciliation

The payment service observes where the funds stand after a payment request.
It keeps settlement separate from score delivery. A receipt can remain
`delivered` while its settlement is pending, disputed, withdrawn, or refunded.
The worker reads evidence. It does not submit withdrawals, authorize refunds,
resolve disputes, or sign transactions.

## Read the records

`GET /receipts` includes each receipt's `settlement` summary.
`GET /settlement?receiptId=...` returns the summary and its latest 100 observations.
The database retains the complete observation history.

The summary contains the current `status`, `lastVerifiedStatus`,
`lastVerifiedAt`, `lastCheckedAt`, `lastError`, `attemptCount`, and `nextCheckAt`.
An observed status can differ from the last verified status. For example,
Masumi can report a withdrawal before its transaction has enough confirmations.
The receipt then shows `withdrawal_pending` and retains the earlier verified fact.
After a rollback, the current status can reopen while the previous verification
remains in the history with its original time.

Each observation records its status, verification result, time, and evidence.
`evidenceJson` includes the Masumi snapshot, expected result hash, relevant
transaction checks, and diagnostic notes. Chain checks retain block references
and the UTxOs used to verify the receipt. Fixture evidence remains simulated.

## Pinned mappings

Mappings use Masumi payment-service commit
[`69297f3`](https://github.com/masumi-network/masumi-payment-service/tree/69297f308f603bffbdfd4efccb54398eaff1bd87).
Check the pinned [state enums](https://github.com/masumi-network/masumi-payment-service/blob/69297f308f603bffbdfd4efccb54398eaff1bd87/prisma/schema.prisma),
[V1 validator](https://github.com/masumi-network/masumi-payment-service/blob/69297f308f603bffbdfd4efccb54398eaff1bd87/smart-contracts/payment/validators/vested_pay.ak),
and [V2 validator](https://github.com/masumi-network/masumi-payment-service/blob/69297f308f603bffbdfd4efccb54398eaff1bd87/smart-contracts/payment-v2/validators/vested_pay.ak)
before changing these mappings.

| Evidence or condition | Settlement meaning |
| --- | --- |
| Purchase or confirmation still pending | `pending`; keep checking. |
| Confirmed, matching funds-lock datum | `funds_locked`. |
| Expected hash accepted as a queued action | `result_queued`; result confirmation still needs chain evidence. |
| Confirmed result datum with the stored response hash | `result_confirmed`. |
| Confirmed result datum with the stored hash and `unlockTime` passed | `withdrawal_available`. |
| V2 `WithdrawAuthorized` with a confirmed matching datum | `withdrawal_available`; authorization bypasses the timed gate. |
| Withdrawal queued or insufficiently confirmed | `withdrawal_pending`. |
| Matching escrow spend and verified seller payout | `withdrawn`. |
| `Disputed` | `disputed`; retain subsequent state and transaction observations. |
| Refund action queued or `RefundRequested` | `refund_requested`; no completed refund is implied. |
| Confirmed empty result datum and `submitResultTime` passed in `FundsLocked` or `RefundRequested` | `refund_available`; authorization is not required for this timed path. |
| V2 `RefundAuthorized` with a confirmed matching datum | `refund_available`; the authorized path can proceed immediately. |
| Refund collection queued or insufficiently confirmed | `refund_pending`. |
| Matching escrow spend and verified buyer payout | `refunded`. |
| Verified `DisputedWithdrawn` transaction and allocation | `disputed_settled`; preserve the buyer and seller amounts. |
| Explicitly unattempted local purchase expired | `expired_unfunded`. |
| Invalid datum, conflicting evidence, or missing proof | `recovery_required` or an unverified pending status. |

`WithdrawAuthorized` and `RefundAuthorized` are V2 states. V1 authorization
uses its dispute and refund-request path. The worker records buyer and seller
cooldowns and uses relevant deadlines to schedule checks. Availability means
the pinned validator permits collection at the observed time. Masumi's
collector can apply an additional ten-minute block-time margin.

## Verify the money movement

A terminal API state needs an independently confirmed transaction. The verifier
decodes the version's datum and binds the identifier, nonces, participants,
input hash, and deadlines to the receipt. Result and seller settlement checks
also require the exact hash of the stored score response.

The verifier follows the receipt's escrow lineage through confirmed transactions.
Current-state checks require an unspent matching output. Payout checks require
the matching escrow to be spent and the correct beneficiary to receive the
expected amount. V2 payout tags identify the spent output, including batch
transactions. V1 requires a single attributable escrow input. V1 seller checks
use the matching payment source's protocol fee terms. Unavailable fee evidence
keeps the payout unverified.

Ordinary withdrawals and refunds can have empty Masumi payout arrays. Their
amounts come from chain evidence and the applicable datum and fee rules.
V2 dispute settlement records the actual tagged buyer and seller amounts. A
dispute can pay zero to either participant. V1 needs the reported allocation
because its ordinary outputs have no payout tag. An ambiguous V1 dispute,
multiple V1 escrow inputs, or an unsupported datum keeps completion unverified.
Tiny partial payouts, unrelated transactions, and deposit confirmation cannot
establish completion.

An elapsed deadline or API 404 cannot establish that an attempted purchase was
unfunded. New receipts persist `purchaseAttempted: false` before any purchase
and change it to `true` before the external call. Only the explicit unattempted
boundary can close a locally unsubmitted expiry. Older ambiguous receipts
remain scheduled for recovery. Verified unfunded expiry releases the local
wallet reservation. A refund request does not release that reservation.

## Durability and operation

The service starts one worker alongside the payment runtime. It checks due
receipts every five seconds by default, in batches of up to 25. Pending checks
use capped exponential backoff with jitter, starting at five seconds and
capped at fifteen minutes. Known deadlines can bring the next check forward.
Confirmed terminal outcomes are checked again every six hours for rollback.

SQLite commits the observation, summary, and next check in one transaction.
Network reads occur outside that transaction. Receipt operations and polling
share the same lock for each receipt. Delivery writes wake settlement checks
without erasing observations. API failures retain prior financial facts and
record an error with another due time. Retry counts do not discard a receipt.

Migration 005 adds schedules for existing protocol receipts without inferring
financial completion from legacy local states. Verified proof lookup reads the
full history, so a long API outage cannot hide a prior terminal proof behind the
display limit. Restarting uses the saved due times and attempt counts.

`RuntimeOptions.reconciliation` supports clock, jitter, interval, backoff,
batch-size, and terminal-check overrides. Tests use a fake clock and simulated
transports. They cover delays, timing gates, disputes, refunds, invalid evidence,
API failures, restart, concurrent delivery, and shutdown. These fixtures verify
the observer's behavior. Actual preprod settlement has not been tested.
