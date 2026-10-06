# Reliability marketplace: lane ownership

Read this file before you start a lane.
Read [PLAN.md](../PLAN.md) for the B2B and B2C marketplace scope.
Read [Reliability math](reliability-math.md) for equations and parameter decisions.

Read [module boundaries](reliability-modules.md) for lifecycle internals and policy composition.

## MVP target state

The product is a transaction reliability marketplace for B2B and B2C sales of goods and services.

The product is not compute verification.

The user owns the fee floor, the fee ceiling, the pairwise decay rate, and the KYC bar.

See [Open decisions](#open-decisions).

| Item | Status | Owner |
| --- | --- | --- |
| Good UI | local display implemented; transactions, receipts, scores, mock KYC, and listings | Lane C |
| KYC verification | mock verification merged on main in pull request #8 | Lane A |
| Score change scaled by transaction value | not started | Math lane |
| Separate buyer score and seller score | done on main | Math lane |
| Platform fee on the buyer side and the seller side | stub rate offers; no fee collection | Lane B |
| Diminishing returns for the same pair | not started | Math lane |

Lane C builds the local operator UI against `GET /reliability/*`. It shows transactions, receipts, separate buyer and seller scores, mock KYC, and listings. Read [UI instructions](../ui/README.md). The operator UI sends no orders. The operator UI edits no policy.

Pull request #8 adds mock KYC on main. Lane A owns mock KYC. Read [mock KYC](kyc.md). `KYC_TIER_RULES` contains the default tier rules. The product owner has not decided the final KYC bar.

The target score weight is $w = \ln(1 + v / v_0)$. $v$ is the transaction value. $v_0$ is the value scale. `packages/reliability/src/scoring.ts` is a stub. The stub adds one to alpha on success and one to beta on failure.

Each entity has a buyer score and a seller score on main.
The score numbers come from the scoring stub.
A new failed outcome emits a failure event for the at-fault role.
An outcome reversal does not correct an event that was already applied.
Read [Implementation status](implementation-status.md) for the known limits.

Lane B owns fees and terms in `packages/reliability/src/fees-policy.ts`.
That file is a stub.
The stub returns buyer and seller fee rate offers for one entity.
A higher lower bound gives a lower offered rate.
The lifecycle does not collect these fees or enforce the offered terms.
Lane B reads the lower bound from the math lane.
The agreed fee curve is not implemented.

The math lane owns `packages/reliability/src/pair-decay.ts`. That file is a stub. Repeat transactions between the same pair must give diminishing returns. That limit reduces repeated score gains from the same pair. The event flow calls the decay stub. The score change stays one. The agreed decay curve is not started.

## Lanes

- Math lane owns `packages/reliability/src/scoring.ts` and `packages/reliability/src/pair-decay.ts`. Migration `007` is reserved for the math lane.
- Lane B owns fees and terms in `packages/reliability/src/fees-policy.ts`. Lane B reads the lower bound from the math lane.
- Lane A (agents) owns the generic transaction lifecycle, the escrow state machine, and mock KYC. Files: `packages/reliability/src/lifecycle.ts`, `packages/reliability/src/kyc.ts`. See [Lane A lifecycle](#lane-a-lifecycle). Read [Mock KYC](kyc.md) for the mock KYC contract.
- Lane C owns the UI. It builds against `GET /reliability/*` and the fixtures.
- Lane D owns B2B payment evidence and demo fixtures. Files: `packages/reliability/src/evidence-payment.ts`, `packages/reliability/src/fixtures/`. Migration `009` is reserved for lane D.

### Lane A lifecycle

Lane A lifecycle tables use migration `011_lane_a_lifecycle.sql`.

KYC uses migration `008`.

Keep migration `009` for lane D.

`010_outcome_fault.sql` stores `Outcome.fault`.

Migration `012` is allocated to the contract lifecycle in pull request #17.
Migration `013` stores paper omnibus deposits and deal allocations.
Read [Paper omnibus funding](omnibus-funding.md).
The next free migration number is `014`.

Read [Transaction lifecycle](reliability-lifecycle.md) for states, evidence tiers, and demo routes.

## Merged so far

- Pull request #2 adds the reliability plumbing. It adds `packages/reliability`, migration `006_reliability_marketplace.sql`, the read routes, and this file.
- Pull request #7 stores `Outcome.fault` in migration `010_outcome_fault.sql`. A failed outcome scores only the at-fault role.
- Pull request #9 adds the transaction lifecycle. It adds migration `011_lane_a_lifecycle.sql`, the lifecycle routes on the shared control-API `AgentStore`, and [Transaction lifecycle](reliability-lifecycle.md).
- Pull request #8 adds mock KYC on the shared store. It adds migration `008_lane_a_kyc.sql`, badge examples, and [Mock KYC](kyc.md).
- Pull request #15 adds cumulative score updates and recovery of missing score rows.
- Pull request #16 adds the reliability marketplace operator display.
- Pull request #18 adds the [paper omnibus funding](omnibus-funding.md) ledger.

Pull request [#17](https://github.com/xiaoyang4c/actual-token2049-hackathon-repo/pull/17) proposes the contract lifecycle.
Its templates, tiered disputes, and contract routes are not on main.

## Open decisions

The user owns these decisions.

- Fee floor and fee ceiling.
- Pairwise decay rate.
- KYC bar. `KYC_TIER_RULES` and the default values ship with pull request #8.
- Delivery evidence and dispute settling. This decision is on hold. The paper lifecycle on main keeps the current stages.
- Who holds the preprod Masumi keys and the Blockfrost keys.

## Frozen file

`packages/reliability/src/types.ts` is frozen after the per-role fault change.

Request further type changes through a separate small PR.

Do not change types inside a lane PR.

`Outcome.fault` records the at-fault role for a failed outcome.

The values are `buyer`, `seller`, and `none`.

Set `fault` when `state` is `failed`.

Leave `fault` empty when `state` is `successful`.

A success credits both roles.

A new `seller` fault updates only that entity's seller score.

A new `buyer` fault updates only that entity's buyer score.

`none` changes no score.

`outcomeToEvents` reads `Outcome.fault`. It does not read `evidence.fault`.

## Migration numbers

The plumbing PR adds `006_reliability_marketplace.sql`.

`010_outcome_fault.sql` stores `Outcome.fault`.

Reserved numbers follow in this order: `007` math lane, `008` lane A KYC, `009` lane D.

Lane A lifecycle uses `011_lane_a_lifecycle.sql`.

Take the next free migration number.

Migration `012` is allocated to the contract lifecycle in pull request #17.
Paper omnibus funding uses `013`.
The next free number is `014`.

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

An enabled live escrow request does not prove confirmed settlement.
Read [chain evidence](reliability-lifecycle.md#chain-evidence).
