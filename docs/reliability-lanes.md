# Reliability marketplace: lane ownership

Read this file before you start a lane.

## Lanes

- Math lane owns scoring and fees/terms. Files: `packages/reliability/src/scoring.ts`, `packages/reliability/src/pair-decay.ts`, `packages/reliability/src/fees-policy.ts`.
- Lane A (agents) owns the generic transaction lifecycle, the escrow state machine, and mock KYC. Files: `packages/reliability/src/lifecycle.ts`, `packages/reliability/src/kyc.ts`.
- Lane C owns the UI. It builds against `GET /reliability/*` and the fixtures.
- Lane D owns B2B payment evidence and demo fixtures. Files: `packages/reliability/src/evidence-payment.ts`, `packages/reliability/src/fixtures/`.

## Frozen file

`packages/reliability/src/types.ts` is frozen after the plumbing PR.

Request type changes through a separate small PR.

Do not change types inside a lane PR.

## Migration numbers

The plumbing PR adds `006_reliability_marketplace.sql`.

Reserved numbers follow in this order: `007` math lane, `008` lane A, `009` lane D.

Take the next free number after `009` for any new lane.

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
2. `outcomeToEvents` in `packages/reliability/src/event-flow.ts` builds one `ReliabilityEvent` per participant role.
3. The math lane `ScoringPolicy` applies events to per-role `ReliabilityState` rows.
4. The math lane `FeeTermsPolicy` maps each state to a `TermsDecision` with fees, reason code, and policy version.

Policy decisions use the lower bound, not the mean.

## Paper versus live

Every order in this marketplace is paper unless stated otherwise.

The operator UI shows whether each order is paper or live.

The docs state whether each order is paper or live.

Cardano stays simulated by default. Do not broadcast.
