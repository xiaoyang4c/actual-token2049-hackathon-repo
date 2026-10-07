# Transaction lifecycle

The lifecycle sells goods and services.

The default escrow order is paper.

The lifecycle calls the Masumi adapter in `services/cardano-agents-ts`.

A live preprod order is sent only when `CARDANO_MODE` is `preprod` and `CARDANO_ALLOW_NETWORK` is `true`.

The v1 live path stops before it calls Masumi.
It uses the transaction id as the buyer nonce and one time for all deadlines.
The Masumi payment service rejects both.
Use the [contract lifecycle](contract-lifecycle.md) for live escrow.

Read [Reliability marketplace: lane ownership](reliability-lanes.md) for lane boundaries.

Read [Shared Cardano and Masumi payment adapters](cardano-payments.md) for the Masumi adapter.

Read [Implementation status](implementation-status.md) for features and known limits.

## States

A transaction starts at `offer_accepted`.

Use the next stage from this list.

| From | To |
| --- | --- |
| `offer_accepted` | `escrow_funded`, `cancelled` |
| `escrow_funded` | `delivery_confirmed`, `dispute_opened`, `refunded` |
| `delivery_confirmed` | `payment_settled`, `dispute_opened`, `refunded` |
| `payment_settled` | `dispute_opened` |
| `dispute_opened` | `dispute_resolved` |
| `dispute_resolved` | `payment_settled`, `refunded` |
| `refunded` | none |
| `cancelled` | none |

`escrow_funded`, `payment_settled`, and `refunded` call the Masumi escrow port.

`refunded` from `delivery_confirmed` is mutual termination.

The lifecycle accepts a voluntary refund from `escrow_funded`.

Direct calls to `advance` reject those three stages.
The async escrow methods record them after the adapter call.

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

The current carrier check validates strings only.
It does not call a carrier API.

`buyer_confirmation` needs `confirmedBy` equal to the buyer id.

The route does not authenticate the caller as that buyer.

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

The resolver can uphold the seller.
That queues a Masumi result submission and records `payment_settled`.

The outcome is `successful`.

A successful outcome leaves `fault` empty.

The verification method is `manual-review`.

The confidence is 0.85.

The resolver can uphold the buyer. That requests a refund.

The outcome is `failed`.

`Outcome.fault` is `seller`.

A direct domain refund with `fault: buyer` produces `failed`.

`Outcome.fault` is `buyer`.

The demo HTTP refund action does not forward `fault`.
A voluntary refund through that route records `fault: none` and produces `cancelled`.

After the deadline, the outcome is `unresolved`.

The evidence field `timeoutResult` is `unresolved`.

The evidence field `escrowDisposition` is `held`.

The paper escrow stays held.

The lifecycle does not release it.

The lifecycle does not refund it.

A resolve with `at` after the deadline throws `the dispute deadline has passed; the result is unresolved`.
The current code uses the supplied `at` for this check.
It does not reject a backdated request after a timeout read.

## Terms

`open` stores terms version 1.

The reason is `initial terms`.

Call `amendTerms` to change terms.

`amendTerms` appends a version.

`amendTerms` does not edit an older version.

A terminal stage freezes terms.

`amendTerms` rejects an amendment with `at` after the dispute deadline.
The current code does not enforce timestamp order across requests.

Set `contractEnds` on `open` or in the terms object.

`contractEnds` is a UTC timestamp.

The contract term runs from creation until `contractEnds`.

## Mutual termination

Both parties can end the contract before `contractEnds`.

Send `buyerConsentAt` and `sellerConsentAt`.

Each consent time is at or before the termination time.

The termination time is before `contractEnds`.

The lifecycle records both consents, both timestamps, `contractStart`, and `contractEnds` on the evidence.

A funded transaction calls `mutualTerminate` on the escrow port.

That call uses the Masumi refund request today.
It does not prove that the buyer received a refund.

The consent record is the seam for a later on-chain check.

The outcome is `cancelled`.

`Outcome.fault` is `none`.

The outcome emits no reliability events.

A one-sided `cancel` stays available before funding.

A one-sided `cancel` does not record both consents.

## Chain evidence

Each escrow step records `txHash`, `escrowState`, and `blockTime` when the chain has a block time.

These fields are observations from the adapter.
The lifecycle does not require confirmed funds locking before recording `escrow_funded`.
It records `payment_settled` after the adapter accepts result submission.
It records `refunded` after the adapter accepts a refund request.
These stage names do not prove a completed payout or refund.

The shared payment runtime has separate confirmation and settlement checks.
Those checks do not govern this marketplace lifecycle.
Read [settlement reconciliation](masumi-settlement.md) for that separate runtime.

`mode` is `paper` for a simulated order.

`mode` is `live` for an enabled preprod order.

A dry run sets `onChainState` to `DryRun` and `txHash` to `dry-run`.

`dry-run` is not a Cardano transaction hash.

## Preprod

Copy [the preprod example](../services/reliability/.env.preprod.example).

Keep `CARDANO_ALLOW_NETWORK` at `false` for a dry run.

A dry run does not call Masumi or Blockfrost.

Set both gates to send a live preprod order:

1. Set `CARDANO_MODE` to `preprod`.
2. Set `CARDANO_ALLOW_NETWORK` to `true`.
3. Set `CARDANO_NETWORK` to `cardano-preprod`.

Provide these values. Do not commit them.

- A public preprod seller return address on the fund request.
- A public preprod buyer address known to the Masumi buyer wallet.
- A Masumi payment service URL in `MASUMI_PAYMENT_URL`.
- A registered Masumi agent id in `MASUMI_AGENT_IDENTIFIER`. The id is at least 57 characters.
- The agent payment source type in `MASUMI_PAYMENT_SOURCE_TYPE`. Use `Web3CardanoV1` or `Web3CardanoV2`.
- For V2, set `MASUMI_SUPPORTED_SOURCE_INDEX` in the range 0 to 24.
- Buyer and seller Masumi API keys in the environment variables named by `MASUMI_BUYER_KEY_REF` and `MASUMI_SELLER_KEY_REF`.
- A Blockfrost preprod project id in the environment variable named by `CARDANO_BLOCKFROST_KEY_REF`.
- A funded Masumi buyer wallet. Masumi submits the purchase. This repo does not sign that transaction.

The `*_KEY_REF` values are environment variable names.

They are not the keys.

The adapters read a key only when they send a request.

Leave the gates off until those values are present.

## Demo routes

Lifecycle routes use the control API store.

Entity rows and lifecycle rows share that database.

The KYC routes use the same control API `AgentStore`.

A simulated response sets `mode` to `paper`.

A live preprod response sets `mode` to `live`.

| Method | Path | Action |
| --- | --- | --- |
| `POST` | `/reliability/lifecycle/open` | Create the transaction and accept the offer |
| `POST` | `/reliability/lifecycle/terms` | Append a terms version |
| `POST` | `/reliability/lifecycle/transition` | Fund, deliver, release, refund, cancel, terminate, dispute, or resolve |
| `GET` | `/reliability/lifecycle?transactionId=` | Read the stage, outcome, events, and terms decisions |

Send `action` in the transition body.

Use `fund`, `deliver`, `release`, `refund`, `cancel`, `terminate`, `dispute`, or `resolve`.

Send `at` as a UTC timestamp such as `2026-10-06T00:00:00.000Z`.

`fund` also needs `amountLovelace`, `sellerReturnAddress`, and `disputeWindowEnds`.

`deliver` needs `evidence.deliveryTier`.

`terminate` needs `buyerConsentAt` and `sellerConsentAt`.

`open` accepts `contractEnds`.

Add `now` on the GET when you want the dispute deadline checked at a later time.
Without `now`, the route uses the last transition time.
It does not use the current server time.

The lifecycle read saves the projected outcome.
It uses the supplied `now` as `decidedAt`, including for a completed outcome.
A later read can therefore change the returned decision and event timestamps.

The GET runs the outcome through `outcomeToEvents` and the current terms policy.

The service loads the stored buyer and seller states for the transaction category.

Each new event updates its own entity, category, and role.

The service commits the event, score, and terms decision in one SQLite transaction.

A failed write rolls back all scoring writes. A later read can retry the projection.

Repeated reads do not apply stored events again. This also holds after a database restart.

The response shows terms recalculated from the current cumulative scores. Persisted terms decisions keep the inputs used when the event was applied.

`GET /reliability/scores` shows stored score rows. Fixture rows fill missing triples.

The math lane can replace the policies through the shared policy composition seam.

Existing stored scores remain the starting point. A missing score is rebuilt from its recorded events under the active scoring policy. The service commits that score and its current terms together. This change does not rebuild older scores that were overwritten by the earlier per-outcome flow.

An applied event keeps its transaction and role id. Reversing an applied outcome or replaying it under a new policy needs a separate history rebuild.

For example, a success can credit the seller before a later dispute finds seller fault.
The failure event then has the same id as the applied success event.
The current projection skips that failure event.
It does not remove the earlier success credit.

Lifecycle mutation routes do not have the shared payment runtime's durable retry records.
A retry after funding succeeds fails the stage check.
Concurrent requests can both call the escrow adapter before one fails the stage check.

The scoring projection uses local records only. It does not call Cardano, Masumi, or Chainlink. Tests use explicit simulated escrow.

Schema for the stage history is `packages/db/migrations/011_lane_a_lifecycle.sql`.

KYC uses migration `008`.

Lane D keeps migration `009`.
