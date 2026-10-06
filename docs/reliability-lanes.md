# Reliability marketplace: lane ownership

Read this file before you start a lane.

Read [module boundaries](reliability-modules.md) for lifecycle internals and policy composition.

## MVP target state

The product is a transaction reliability marketplace for B2B and B2C sales of goods and services.

The product is not compute verification.

The user owns the fee floor, the fee ceiling, the pairwise decay rate, and the KYC bar.

See [Open decisions](#open-decisions).

| Item | Status | Owner |
| --- | --- | --- |
| Good UI | not started | Lane C |
| KYC verification | in open pull request #8 | Lane A |
| Score change scaled by transaction value | not started | Math lane |
| Separate buyer score and seller score | done on main | Math lane |
| Platform fee on the buyer side and the seller side | not started | Lane B |
| Diminishing returns for the same pair | not started | Math lane |

Lane C has not built the marketplace UI. Lane C builds the operator UI against `GET /reliability/*`. The operator UI sends no orders. The operator UI edits no policy.

The user approved pull request #8. It is not merged. Lane A owns mock KYC. The KYC document arrives with that pull request. `KYC_TIER_RULES` and the default KYC bar ship with pull request #8.

The target score weight is `w = log(1 + v / v0)`. `v` is the transaction value. `v0` is the value scale. `packages/reliability/src/scoring.ts` is a stub. The stub adds one to alpha on success and one to beta on failure.

Each entity has a buyer score and a seller score on main. The score numbers come from the scoring stub. A failed outcome changes only the at-fault role.

Lane B owns fees and terms in `packages/reliability/src/fees-policy.ts`. That file is a stub. The stub charges a platform fee on the buyer side and on the seller side. A higher lower bound gives a lower fee. Lane B reads the lower bound from the math lane. The agreed fee curve is not started.

The math lane owns `packages/reliability/src/pair-decay.ts`. That file is a stub. Repeat transactions between the same pair must give diminishing returns. That limit reduces repeated score gains from the same pair. The event flow calls the decay stub. The score change stays one. The agreed decay curve is not started.

## Lanes

- Math lane owns `packages/reliability/src/scoring.ts` and `packages/reliability/src/pair-decay.ts`. Migration `007` is reserved for the math lane.
- Lane B owns fees and terms in `packages/reliability/src/fees-policy.ts`. Lane B reads the lower bound from the math lane.
- Lane A (agents) owns the generic transaction lifecycle, the escrow state machine, and mock KYC. Files: `packages/reliability/src/lifecycle.ts`, `packages/reliability/src/kyc.ts`. See [Lane A lifecycle](#lane-a-lifecycle). Read [Mock KYC](kyc.md) for the mock KYC contract.
- Lane C owns the UI. It builds against `GET /reliability/*` and the fixtures.
- Lane D owns B2B payment evidence and demo fixtures. Files: `packages/reliability/src/evidence-payment.ts`, `packages/reliability/src/fixtures/`. Migration `009` is reserved for lane D.

### Lane A lifecycle

Lane A lifecycle tables use migration `011_lane_a_lifecycle.sql`.

Lane A contract lifecycle tables use migration `012_contract_lifecycle.sql`.
Read [Contract lifecycle](contract-lifecycle.md) for templates, tiered disputes, remedies, and live Masumi escrow.

KYC uses migration `008`.

Keep migration `009` for lane D.

`010_outcome_fault.sql` stores `Outcome.fault`.

The next free migration number is `013`.

Read [Transaction lifecycle](reliability-lifecycle.md) for states, evidence tiers, and demo routes.

## Merged so far

- Pull request #2 adds the reliability plumbing. It adds `packages/reliability`, migration `006_reliability_marketplace.sql`, the read routes, and this file.
- Pull request #6 values a paper trading position from `yesPrice`. A YES mark uses `yesPrice`. A NO mark uses one minus `yesPrice`.
- Pull request #7 stores `Outcome.fault` in migration `010_outcome_fault.sql`. A failed outcome scores only the at-fault role.
- Pull request #9 adds the transaction lifecycle. It adds migration `011_lane_a_lifecycle.sql`, the lifecycle routes on the shared control-API `AgentStore`, and [Transaction lifecycle](reliability-lifecycle.md).

## Open

Pull request #8 adds mock KYC. The user approved it. It is not merged.

Migration `008` is reserved for KYC.

## Open decisions

The user owns these decisions.

- Fee floor and fee ceiling.
- Pairwise decay rate.
- KYC bar. `KYC_TIER_RULES` and the default values ship with pull request #8.
- Delivery evidence and dispute settling. The v1 lifecycle keeps the current stages. [Contract lifecycle](contract-lifecycle.md) proposes evidence templates, three dispute tiers, and fixed remedies.
- Who holds the preprod Masumi keys and the Blockfrost keys. The contract lifecycle proposes platform-managed test wallets, labelled custodial. Read [custody](contract-lifecycle.md#custody).

## Frozen file

`packages/reliability/src/types.ts` is frozen after the per-role fault change.

Request further type changes through a separate small PR.

Do not change types inside a lane PR.

`Outcome.fault` records the at-fault role for a failed outcome.

The values are `buyer`, `seller`, and `none`.

Set `fault` when `state` is `failed`.

Leave `fault` empty when `state` is `successful`.

A success credits both roles.

A `seller` fault lowers only that entity's seller score.

A `buyer` fault lowers only that entity's buyer score.

`none` changes no score.

`outcomeToEvents` reads `Outcome.fault`. It does not read `evidence.fault`.

## Migration numbers

The plumbing PR adds `006_reliability_marketplace.sql`.

`010_outcome_fault.sql` stores `Outcome.fault`.

Reserved numbers follow in this order: `007` math lane, `008` lane A KYC, `009` lane D.

Lane A lifecycle uses `011_lane_a_lifecycle.sql`.

Lane A contract lifecycle uses `012_contract_lifecycle.sql`.

Take the next free migration number.

The next free number is `013`.

## Shared files

These files take one-line additions only. Expect small rebases.

- `services/reliability/index.ts` registers lane route files.
- `packages/reliability/src/fixtures/index.ts` re-exports lane fixture files.
- `services/control-api.ts` already spreads the registry. Do not edit it per lane.

Add a new file per lane instead of editing a shared file.

Example: lane A adds `services/reliability/routes-lane-a.ts` and one line in `services/reliability/index.ts`.

## Event flow

An outcome emits reliability events. Events update scores. Scores feed terms and fee decisions.

1. Lane A or lane D produces an `Outcome` with evidence.
2. Set `Outcome.fault` to `seller`, `buyer`, or `none` when `state` is `failed`.
3. `outcomeToEvents` in `packages/reliability/src/event-flow.ts` reads that fault.
4. A `successful` outcome emits one success event for each participant role.
5. A `seller` fault emits one failure event for the seller role.
6. A `buyer` fault emits one failure event for the buyer role.
7. An empty fault, `none`, `cancelled`, `pending`, `disputed`, and `unresolved` emit no events.
8. The math lane `ScoringPolicy` applies events to per-role `ReliabilityState` rows.
9. Lane B `FeeTermsPolicy` maps each state to a `TermsDecision` with fees, reason code, and policy version.

Lane B reads the lower bound from the math lane.

`cancelled` is a mutual end. It emits no events.

## Paper versus live

Marketplace orders are paper.

Cardano escrow is simulated by default.

Broadcast a preprod transaction only when `CARDANO_MODE` is `preprod` and `CARDANO_ALLOW_NETWORK` is `true`.

That broadcast is a live order.

The operator UI shows whether each order is paper or live.

The docs state whether each order is paper or live.
