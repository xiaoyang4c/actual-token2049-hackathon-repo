# Reliability module boundaries

The marketplace uses separate modules for transport, lifecycle rules, and policy.
Marketplace transactions are paper.
Cardano escrow is simulated by default.
The existing preprod network gates still apply.

## Domain modules

`packages/reliability/src/lifecycle.ts` coordinates stage changes, escrow calls,
and store writes. Its public exports stay available at the same import paths.

| Module under `packages/reliability/src/lifecycle/` | Responsibility |
| --- | --- |
| `contracts.ts` | Lifecycle interfaces, stage rules, delivery tiers, and the shared error class |
| `commands.ts` | Persist command identities, external-call checkpoints, and completed results. Block ambiguous resubmission. |
| `codecs.ts` | Validate timestamps and evidence. Copy terms and stored transitions. |
| `escrow-evidence.ts` | Convert an escrow session to scalar evidence. Restore the session from that evidence. |
| `outcome.ts` | Project stage history into an outcome, fault, and verification confidence. No store writes. |

The frozen domain types stay in `packages/reliability/src/types.ts`.
The scoring, pair-decay, fee, and KYC interfaces stay in their lane files.

## Service modules

| Module under `services/reliability/` | Responsibility |
| --- | --- |
| `route.ts` | Define the route contract for every lane. |
| `policies.ts` | Compose the default scoring, pair-decay, and fee policies. |
| `lifecycle-request.ts` | Parse HTTP values and dispatch lifecycle actions. No direct store access. |
| `lifecycle-service.ts` | Use one shared `AgentStore` for parties, lifecycle views, events, states, and terms. |
| `routes-lane-a.ts` | Map lifecycle requests and errors to HTTP responses. |
| `routes-plumbing.ts` | Merge stored collection records over fixtures. Read stored receipts first. |
| `masumi-escrow.ts` | Submit escrow actions. Use the shared verifier for live funds locks, payouts, and refunds. |

`createLaneARoutes` accepts policies, a clock, and an escrow factory for each store.
It keeps a separate service cache for each route table and store.
`createPlumbingRoutes` accepts the same policy bundle.
The existing `laneARoutes` and `plumbingRoutes` exports use the defaults.
The `ReliabilityRoute` export from `routes-plumbing.ts` remains available for KYC.

`omnibus-funding.ts` records paper deposits and deal allocations through the shared store.
It does not register HTTP routes or call the escrow port.
Read [paper omnibus funding](omnibus-funding.md).

## Next changes

Replace the implementations in `policies.ts` when the math and fee lanes are ready.
Use the route factories to test those implementations with an offline escrow port.
KYC routes can keep using the control API store and the current route registry.
The lifecycle view reads entity tiers from that store for each request.
The UI can keep reading the existing response shapes.

Lifecycle scoring starts from the stored state for each entity, category, and role.
Stored event ids mark outcomes that have already been applied.
The service reads that history under the SQLite write lock.
It commits new events, score updates, and terms decisions in one transaction.
Repeated reads return current terms without applying the event again.
If an older write left events without a score, the service rebuilds that missing
score from its event history under the active scoring policy.
Changed outcomes archive and replace their active events.
The service rebuilds affected scores from saved baselines and active history.
It commits corrections with current terms under the same write lock.
The score read route uses stored rows when available. Fixture rows fill missing triples.

Migration `014` stores commands, event revisions, score baselines, and listings.
The command journal claims the transaction before an external action.
It commits a completed money stage and command result together.
An unknown external response requires reconciliation.
The API does not yet provide that operator flow.

The scoring policy still uses unit weights.
Value weighting and cumulative pair history are not implemented.
The event flow calls the decay stub without using the returned weight.
The math lane must implement those rules and pair-history persistence together.
Read [Reliability math](reliability-math.md) for the target model and proposed policy curves.
Fee limits, the decay rate, and the KYC bar still require product decisions.

The fee policy returns rate offers.
The lifecycle does not collect fees or enforce the offered terms.
Read [Implementation status](implementation-status.md) for the remaining work and logic gaps.

Read [lane ownership](reliability-lanes.md) before changing a lane.
Read [transaction lifecycle](reliability-lifecycle.md) for state and escrow rules.
