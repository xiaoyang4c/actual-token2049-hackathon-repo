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
| `routes-plumbing.ts` | Serve fixture reads and receipts through the policy interfaces. |

`createLaneARoutes` accepts policies and an escrow factory for each store.
It keeps a separate service cache for each route table and store.
`createPlumbingRoutes` accepts the same policy bundle.
The existing `laneARoutes` and `plumbingRoutes` exports use the defaults.
The `ReliabilityRoute` export from `routes-plumbing.ts` remains available for KYC.

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
The score read route uses stored rows when available. Fixture rows fill missing triples.

The scoring policy still uses unit weights.
Value weighting and cumulative pair history are not implemented.
The event flow calls the decay stub without using the returned weight.
The math lane must implement those rules and pair-history persistence together.
Fee limits, the decay rate, and the KYC bar still require product decisions.

Read [lane ownership](reliability-lanes.md) before changing a lane.
Read [transaction lifecycle](reliability-lifecycle.md) for state and escrow rules.
