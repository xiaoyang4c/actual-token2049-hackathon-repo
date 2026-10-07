# Contract lifecycle

The contract lifecycle runs escrowed deals between parties who do not know each other.
Funds lock in a Masumi V2 escrow when the deal starts.
Funds move according to evidence that both parties agreed to before funding.
Disputes go through tiers.
Every finished milestone produces an `Outcome` for the reliability score.

The system does not judge quality.
It enforces the evidence rules and the judge that the parties named in the contract.

Read [Transaction lifecycle](reliability-lifecycle.md) for the v1 lifecycle.
Read [lane ownership](reliability-lanes.md) for lane boundaries.

## Paper and live

Contracts are paper by default.
A paper contract uses a local model of the Masumi V2 escrow. It sends no transaction.

A contract is live only when both gates are on:

1. `CARDANO_MODE=preprod`
2. `CARDANO_ALLOW_NETWORK=true`

A live contract also needs `MASUMI_PAYMENT_SOURCE_TYPE=Web3CardanoV2` and a registered Masumi agent.
Only Cardano preprod is possible.
The deal asset is test USDM. ADA is never the deal asset.

Every contract, audit row, and outcome records `mode: paper` or `mode: live`.
A paper contract is never sent to the live escrow, and a live contract is never sent to the paper escrow.

Read [the settings example](../services/reliability/.env.contracts.example) for every setting.

## Custody

The platform holds the escrow keys in this build.
That makes the platform a custodian.
Holding customer funds can need a licence from the Monetary Authority of Singapore.
This repo gives no legal advice. Check before any mainnet use.

The build handles custody in three parts:

1. **Demo:** platform-managed preprod test wallets. `custodyModel: platform_custodial_test_only` is in the signed terms and in every outcome.
2. **Ruling enforcement today:** the reliability score. The platform does not move disputed funds on its own. Each ruling gives each party an obligation with a deadline. A party that misses the deadline is recorded as `ignored`. The score module applies the penalty.
3. **Production path (not built):** an escrow contract with three keys: buyer, seller, and the platform as arbiter. Any two keys release or refund. The platform alone can never move funds.

In the demo, a ruling that a party ignores is executed by the platform wallet after the deadline.
That keeps funds from staying locked.
The audit log records `ruling_executed_by_custodian`. The outcome records `rulingExecutedBy: platform_custodial_fallback`.
In the production design, the winner and the arbiter sign this step together.

## Templates

A template is a JSON file in `packages/reliability/src/contract-lifecycle/templates/`.
It sets the deliverable schema, the evidence rules, the judge, the windows, the remedies, the fees, and the milestone rules.

| Template | Status | Judge |
| --- | --- | --- |
| `digital-machine-checkable` | enabled | Code compares the file hash with the agreed hash |
| `physical-objective-spec` | enabled | The named inspector's signed lab report |
| `digital-subjective` | design only | Buyer, then mediator |
| `physical-subjective` | design only | Buyer, then mediator |
| `ongoing-service` | design only | Signed monitoring data |

The production inspection window is 72 hours.
Demo settings can shorten windows. The terms that both parties sign record the windows in use.

## Remedies

The parties fix the remedy before funding. Nobody chooses it after a dispute.

| Remedy | Buyer wins |
| --- | --- |
| `partial_release` | The seller keeps the core. The holdback goes back to the buyer. |
| `full_refund_with_return` | The refund waits until the seller confirms the returned goods. |
| `full_refund_no_return` | Full refund. |
| `redo_or_replace` | The seller gets one retry. A failed retry is a full refund. |

A Masumi escrow releases all or nothing.
A `partial_release` milestone therefore uses two escrows: the core and the holdback.
`CONTRACT_MAX_TRANCHES_PER_MILESTONE` limits the escrows for each milestone.

## Disputes

1. **Tier 1:** the parties sign one fixed outcome: `full_release`, `core_only`, or `full_refund`. Tier 1 is free.
2. **Tier 2:** the named judge decides. The code judge decides at once. An inspector decides with a signed report bound to the contract and the milestone.
3. **Tier 3:** the platform mediator signs a ruling that names a winner. The remedy decides the money.

Each tier has a deadline. A missed deadline moves the dispute to the next tier.
A missed Tier 3 deadline applies the template default.
After a ruling, the buyer authorizes the release of `release` escrows. The seller authorizes the refund of `refund` escrows.

## States

Each milestone runs the table in `packages/reliability/src/contract-lifecycle/transitions.ts`.

`draft` → `pending_acceptance` → `awaiting_funding` → `funded` → `delivered` → `in_inspection`.
From `in_inspection`: `accepted_pending_release`, `auto_released`, or `disputed`.
A dispute goes through `tier_1_negotiation`, `tier_2_evidence_rule`, and `tier_3_mediation` to `resolved`.
`return_pending`, `redo_pending`, and `redo_inspection` hold the remedy follow-ups.
Terminal states: `settled`, `cancelled`, `expired`, `refunded`.

`accepted_pending_release` means the buyer accepted. Money moves at the Masumi unlock time.
A money state needs confirmed escrow status. A queued request is not a state change.

A refund from `FundsLocked` or `ResultSubmitted` starts with the buyer's refund request.
The seller authorizes the refund after `RefundRequested` or `Disputed` is confirmed.
This procedure applies to concessions, mutual termination, and cleanup after partial funding.
A new refund request must reach the escrow before `unlockTime`.
If automatic payment finishes first, the engine records that payment.
The audit log records `refund_lost_to_release`.
If only part of a requested refund is paid, `closedReason` is `refund_partially_executed`.

Each escrow has a separate confirmed state.
If one dispute request fails, the other disputed escrow still goes through the dispute tiers.
Completed payments remain in the settlement record.
Payment obligations apply only to escrows that permit the required action.
If the final payment does not meet the ruling, `closedReason` is `ruling_partially_executed`.
The audit log records `settlement_shortfall` with the actual amounts.

## Masumi rules that the lifecycle enforces

These rules come from masumi-payment-service rev `d569a33`. Check them against the node's `/api-docs` before a live run.

- MPS needs at least 15 minutes between `submitResultTime`, `unlockTime`, and `externalDisputeUnlockTime`.
- `identifierFromPurchaser` is 14 to 26 hex characters. Each escrow gets a new one.
- The input and result hashes follow MIP-004. A plain SHA-256 is not a MIP-004 hash.
- On V2, only the buyer can release a disputed escrow (`/purchase/cancel-refund-request`). Only the seller can refund it (`/payment/authorize-refund`).
- MPS withdraws 10 minutes after `unlockTime`.

## Reliability output

Each milestone is one `MarketplaceTransaction` with id `<contractId>/m<index>`.
Its result is one `Outcome`.
The service publishes it through `services/reliability/reliability-projection.ts`.
The projection follows the cumulative rules of the v1 lifecycle service and uses the policies in `policies.ts`.

| Result | `Outcome.state` | `fault` | Confidence |
| --- | --- | --- | --- |
| Buyer accepted | `successful` | none | 0.7 |
| Auto release | `successful` | none | 0.4 |
| Dispute, seller wins | `successful` | none | 0.95 code judge, 0.9 Tier 1, 0.85 inspector or mediator |
| Dispute, buyer wins or split | `failed` | `seller` | as above |
| Seller refund before delivery | `cancelled` | `none` | 0.9 |
| Seller refund after delivery | `failed` | `seller` | 0.9 |
| Seller missed delivery | `failed` | `seller` | 1 |
| Buyer did not fund in time | `failed` | `buyer` | 1 |
| Cancelled or mutual termination | `cancelled` | `none` | 1 |

A party that ignores a ruling also gets one `failure` event in the `dispute` category.

`Outcome.evidence` holds the `contract-settlement.v1` record:
amounts paid to each side, the tier reached, the winner, the ruling compliance of each party, the on-time flag, `buyerAcceptedAt`, the escrow ids, the settlement transactions, `mode`, and `custodyModel`.
`collectionTxHash` is set only for a live contract.

## Routes

| Method | Path | Action |
| --- | --- | --- |
| `GET` | `/reliability/contracts/templates` | List templates |
| `POST` | `/reliability/contracts/parties` | Link a signing key and a preprod address to an entity |
| `POST` | `/reliability/contracts` | Create a contract |
| `GET` | `/reliability/contracts?id=` | Read the contract, milestones, obligations, escrows, and outcomes |
| `GET` | `/reliability/contracts/terms?id=` | Read the exact bytes that both parties sign |
| `POST` | `/reliability/contracts/sign` | Sign the terms |
| `POST` | `/reliability/contracts/action` | One signed party action |
| `POST` | `/reliability/contracts/agree` | Tier 1 outcome signed by both parties |
| `POST` | `/reliability/contracts/terminate` | Mutual termination signed by both parties |
| `POST` | `/reliability/contracts/ruling` | Tier 3 ruling signed by the mediator |
| `POST` | `/reliability/contracts/tick` | Run one scheduler pass |
| `GET` | `/reliability/contracts/audit?id=` | Read the audit log and the hash chain status |

Each party action carries an `actionId` and an Ed25519 signature over `partyActionBytes`.
A repeated `actionId` returns the earlier result.
In paper mode, a POST body can carry `at` to move paper time forward. Live mode rejects `at`.

## Run

```sh
bun run contracts:demo     # paper demo: template 1 auto release, template 3 dispute
bun run contracts:worker   # scheduler for live contracts
bun run contracts:smoke    # day 2 preprod proof (needs both gates)
```

## Reliability of the lifecycle

- State, the audit row, and each journaled escrow write commit in one transaction.
- A worker leases an escrow write and records the attempt before it sends the write.
- A retry after an unknown result asks the escrow first. A timeout never sends the same write twice.
- The audit log is append-only. A hash chain detects edits.
- A restart continues from the stored state.

The worker also reads confirmed transaction history.
It can recover delivery after the escrow has completed automatic payment.
The delivery and settlement times use confirmed history when available.
An identical delivery submission uses the existing operation row.
A retry keeps the attempt count and inspects the escrow before another write.

Tier agreements, judge reports, mediator rulings, return actions, and redo decisions must arrive before their deadlines.
An action at the deadline is late.
The engine checks the deadline before it stores evidence or changes the contract.
A late ruling compliance instruction remains permitted and receives the existing late penalty.

## Known gaps and next work

1. **No live run yet.** The Masumi adapter is tested against a fake payment service only.
2. **Cooldowns are not modelled.** Masumi V2 makes a party wait about 7 minutes between its own actions. A seller refund right after a dispute can fail until the cooldown ends.
3. **Seller payout stays on the platform selling wallet.** `CONTRACT_SELLER_PAYOUT=seller_return_address` is untested with MPS.
4. **The Blockfrost check reads ADA only.** A net USDM receipt check needs asset parsing.
5. **Party registration is open.** Anyone can register a key for an entity id that has none. KYC is on main (pull request #8). Link key registration to a verified KYC entity, and let a template require a KYC tier.
6. **Scoring and fees are still stubs** (`policies.ts`). Scores accumulate (pull request #15). The math lane owns value weighting and pair decay.
7. **Platform fees are not in the escrow amount.** Lane B owns fees.
8. **The mediator is a key, not a Coworker.** Plan: a Sokosumi Coworker returns the ruling; a platform signer checks the paid Task and signs.
9. **Evidence lives in SQLite.** Production needs object storage.
10. **The operator UI does not show contracts yet.** The routes exist for lane C.
11. **Two lifecycles exist.** Keep v1 for the paper sales demo. Use contracts for live escrow. The v1 live path now stops with a clear error before it reaches Masumi.

### Improvements to consider

- **Score-based terms:** use the `TermsDecision` from lane B to set a larger holdback or a lower amount limit for low-score sellers. That closes the loop from rating to contract terms.
- **Dispute bond:** the party that opens a paid tier funds a small separate escrow. The loser forfeits it. This enforces "loser pays" on-chain and discourages weak disputes.
- **Non-custodial escrow:** the 2-of-3 design above.
