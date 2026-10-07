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
The async methods record paper stages after the adapter call.
Live stages also require confirmed chain evidence.
A pending action keeps the prior stage.

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

The lifecycle also checks delivery evidence against `terms.delivery` (goods) and `terms.service` (services).
A late delivery needs the buyer's confirmation.
Carrier proof never accepts a service.
Read [delivery and acceptance terms](marketplace.md#delivery-and-acceptance-terms).

## Disputes

Name `resolver` and `resolveBy` when you open a dispute.

`resolveBy` must be a UTC timestamp after the open time.

Before the deadline, the outcome is `disputed`.

The resolver can uphold the seller.
That submits a Masumi result.
A paper action records `payment_settled`.
A live action waits for a verified seller payout before recording that stage.

The outcome is `successful`.

A successful outcome leaves `fault` empty.

The verification method is `manual-review`.

The confidence is 0.85.

The resolver can uphold the buyer. That requests a refund.

The outcome is `failed`.

`Outcome.fault` is `seller`.

A refund with `fault: buyer` produces `failed`.

`Outcome.fault` is `buyer`.

The HTTP action validates and forwards this fault.
It rejects other supplied fault values.
Without a fault, a voluntary refund produces `cancelled` with `fault: none`.
A live refund needs confirmed buyer payment before the final outcome.

After the deadline, the outcome is `unresolved`.

The evidence field `timeoutResult` is `unresolved`.

The evidence field `escrowDisposition` is `held`.

The paper escrow stays held.

The lifecycle does not release it.

The lifecycle does not refund it.

A resolve after the deadline throws `the dispute deadline has passed; the result is unresolved`.
HTTP actions check both `at` and the current server time.
A stored timeout cannot become disputed again after a backdated read.
A backdated request cannot bypass that timeout.

## Terms

`open` checks KYC, exposure limits, and invoice due dates first.
Both parties must exist and pass KYC. `open` no longer creates unknown parties.
Read [checks before a sale opens](marketplace.md#checks-before-a-sale-opens).

`open` stores terms version 1.
It adds the accepted fees as `platformFees` and both parties' score-based terms as `reliabilityTerms`.
An amendment keeps both values.

The reason is `initial terms`.

Call `amendTerms` to change terms.

`amendTerms` appends a version.

`amendTerms` does not edit an older version.

A terminal stage freezes terms.

`amendTerms` rejects an amendment after the dispute deadline.
Transitions and amendments cannot precede the latest transition or terms version.
A pending escrow command blocks other mutations and terms changes.

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

That call uses the Masumi refund request.
A paper result is simulated.
A live result waits for a verified buyer refund before recording `refunded`.

The consent record is the seam for a later on-chain check.

The outcome is `cancelled`.

`Outcome.fault` is `none`.

The outcome emits no reliability events.

A one-sided `cancel` stays available before funding.

A one-sided `cancel` does not record both consents.

## Chain evidence

Each escrow step records `txHash`, `escrowState`, and `blockTime` when the chain has a block time.

Live money stages require `settlementVerified: true`.
The adapter uses the shared Cardano settlement verifier.
It binds the proof to the original escrow terms and deposit transaction.
It checks the buyer and seller addresses, result hash, and payout amounts.

`escrow_funded` needs a confirmed `FundsLocked` state.
`payment_settled` needs a verified seller withdrawal.
`refunded` needs a verified buyer refund.
A queued action or a Masumi status string alone is not proof.

An action without proof returns HTTP 202.
The command keeps its saved external response and its prior stage.
Retry that command to check proof again.
The retry does not submit the external action again.

An old live terminal record without proof projects as `pending` and `unverified`.
It emits no score event.
Those old records need a separate reconciliation process.
Paper stages record `settlementVerified: false`.
They do not prove a real payout or refund.
Read [settlement reconciliation](masumi-settlement.md) for the shared verifier.

`mode` is `paper` for a simulated order.

`mode` is `live` for an enabled preprod order.

A dry run sets `onChainState` to `DryRun` and `txHash` to `dry-run`.

`dry-run` is not a Cardano transaction hash.

## Preprod

Copy [the preprod example](../services/reliability/.env.preprod.example).

Keep `CARDANO_ALLOW_NETWORK` at `false` for a dry run.

A dry run does not call Masumi or Blockfrost.

These gates are required for live adapters.
They do not bypass the v1 live funding guard.
Use the [contract setup](contract-lifecycle.md#run) for a live contract.

Set the adapter gates as follows:

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
`open` needs `value`. A rule failure returns HTTP 403 with `violations`.

Without `now`, a GET uses the current server time.
An explicit `now` supports paper test scenarios.
It cannot reverse a stored timeout.
The HTTP mutation deadline still uses the server clock.

The lifecycle read saves the projected outcome.
`decidedAt` is the transition time.
For a timeout, it is the dispute deadline.
Later reads keep the decision and event timestamps.

The GET runs the outcome through `outcomeToEvents` and the current terms policy.
It also settles the accepted fee charge and returns it as `feeCharge`.

The service loads the stored buyer and seller states for the transaction category.

Each new event updates its own entity, category, and role.

The service commits the event, score, and terms decision in one SQLite transaction.

A failed write rolls back all scoring writes. A later read can retry the projection.

Repeated reads do not apply stored events again. This also holds after a database restart.

The response shows terms recalculated from the current cumulative scores. Persisted terms decisions keep the inputs used when the event was applied.

`GET /reliability/scores` shows stored score rows. Fixture rows fill missing triples.

The math lane can replace the policies through the shared policy composition seam.

The service saves a baseline for each entity, category, and role.
It keeps imported score history in that baseline.
For existing unit-weight history, it recovers the baseline by subtracting recorded contributions.
An inconsistent legacy baseline requires repair before a rebuild.
A missing score can be rebuilt from its event history.
Older overwritten history cannot be recovered from absent records.

When an outcome changes, the service archives its old events.
It replaces the active transaction events.
It rebuilds each affected score from its baseline and all active events.
Replay orders events by decision time and event ID.
The archive, events, scores, and terms commit in one SQLite transaction.

For example, seller fault replaces an earlier seller success with a failure.
It also removes that transaction's buyer success.
Repeated reads do not apply the correction again.
Changing the scoring policy still requires a separate controlled rebuild.

## Command retries

`fund`, `release`, `refund`, `terminate`, and `resolve` accept an optional `commandId`.
The default identity uses the transaction and action.
For resolution, it also includes the dispute generation.
Use the same identity for a retry.
A changed action or payload with the same identity returns HTTP 409.
The first request fixes `at`.
A retry with a later `at` keeps that original time.
A completed command returns its saved transition.

The journal permits one pending command per transaction.
It saves a checkpoint before an external call.
It saves the response before checking chain proof.
SQL locks do not span network calls.
Separate database writers cannot submit the same recorded call twice.

If a call starts but its response is lost, a retry returns HTTP 409.
The error requires reconciliation before another submission.
The current API has no operator reconciliation action.
Do not delete that checkpoint and resubmit without checking the external action.

A saved response can resume after a restart.
A pending chain check returns HTTP 202 until proof is available.
The final stage, outcome, and command result commit together.

The scoring projection uses local records only. It does not call Cardano, Masumi, or Chainlink. Tests use explicit simulated escrow.

Stage history uses `packages/db/migrations/011_lane_a_lifecycle.sql`.
Migration `014_lifecycle_commands.sql` adds the command journal, event archive,
score baselines, and stored listings.

KYC uses migration `008`.

Lane D keeps migration `009`.
