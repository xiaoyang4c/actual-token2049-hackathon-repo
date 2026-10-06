# Mock KYC

The KYC check is a mock. It does not call a live vendor.

Use `paper` for a simulated fill. Use `live` for a real venue order. Marketplace orders stay paper unless a doc says an order is live.

Read `packages/reliability/src/kyc-rules.ts` before you change a tier rule.

## Status and tier

The entity row stores a status and a tier.

Status values are `unverified`, `pending`, `verified`, and `rejected`.

Tier values are `none`, `basic`, and `enhanced`.

`packages/reliability/src/types.ts` is frozen. `expired` is not a status on that row.

A verification can expire. The entity status then becomes `unverified`. The tier becomes `none`. The history badge is `expired`.

Show the badge `expired` in the UI.

The badge is the same as the status, with one exception. An `unverified` entity whose last step was an expiry has the badge `expired`.

## Checks

Each submission replaces the earlier checks and identifiers. Send every check for the tier you want.

A verified entity stays verified at its tier while a new check waits. `checkPending` is `true` during that time.

A passing check sets the tier from the new checks. A rejected or held check keeps the current tier.

Expiry clears the submitted checks and any open check. Submit new checks to verify again.

Entities from the seed or the lifecycle routes have no KYC profile. Their view has `subjectKind: null` and an empty `history`. Submit a check to start KYC for them.

An entity with no recorded verification time can expire only with `force`.

The provider stores each `at` value as UTC ISO time. History is in the order the steps were saved.

Entity ids are trimmed in every call.

## Config

The tier rules live in `KYC_TIER_RULES`.

The file is `packages/reliability/src/kyc-rules.ts`.

That object is the only definition of a tier. It is also the only definition of what counts as verified.

The product owner has not decided these thresholds. Change that object when the product owner decides.

Default checks:

- A person reaches tier `basic` with an identity document.
- A person reaches tier `enhanced` with an identity document and an address check.
- A business reaches tier `basic` with a registration number.
- A business reaches tier `enhanced` with a registration number and a beneficial owner.
- Verified means status `verified` and tier `basic` or higher.

`countsAsVerified` reads this object.

Demo scripts live in `DEMO_KYC_SCRIPTS` in the same file. A script chooses the mock vendor outcome. The script does not choose the tier.

Use these prefixes:

- `DOC-REJECT` rejects a person check.
- `DOC-HOLD` leaves a person check pending.
- `REG-REJECT` rejects a business check.
- `REG-HOLD` leaves a business check pending.
- `BO-REJECT` rejects a beneficial owner document.
- Any other mocked id passes.

## Re-registration and wallets

Register an entity as a buyer, a seller, or both.

Attach one or more wallet addresses.

A wallet does not prove that two entities are independent.

A new wallet does not inherit reliability.

A new entity does not inherit reliability.

The same mocked document sets a re-registration flag. The same registration number sets the same kind of flag.

The new entity is stored with that flag. The flag stays on later status changes.

Keep the reliability rows of the earlier entity. Leave the new entity with no reliability rows.

A wallet that is already registered is refused. That refusal is not a KYC pass.

## Store

The provider writes through `AgentStore` accessors.

`AgentStore` implements `KycRecordStore`. Pass the store to `MockKycProvider` directly.

KYC tables are in `packages/db/migrations/008_lane_a_kyc.sql`.

Lifecycle tables are in `packages/db/migrations/011_lane_a_lifecycle.sql`.

## Fees and terms lane

Read `policyInput` on the KYC view.

Use these fields as decision inputs:

- `kycStatus`
- `kycTier`
- `badge`
- `countsAsVerified`
- `reRegistrationOf`
- `rulesVersion`

`fetchStatus` returns the frozen status and tier only. After expiry, `fetchStatus` returns `unverified` and `none`. The badge on `policyInput` is `expired`.

`fetchStatus` and `policyInput` read the same status. An override map passed to `MockKycProvider` applies to both.

Do not copy reliability from `reRegistrationOf`.

Pass `kycTier` to the existing terms input. Put `badge`, `countsAsVerified`, and `reRegistrationOf` in the decision `inputs` when you implement the fee curve.

## UI lane

Read `GET /reliability/kyc?entityId=`.

Read `badge`, `tier`, `status`, `checkPending`, and `reRegistration`.

Read `history` for the time and the cause of each status. Each row has `at`, `how`, `badge`, `status`, and `tier`.

Read `GET /reliability/kyc/fixtures` for one example of each badge.

Show a re-registration flag when `reRegistration` is present.

The operator UI stays display-only. The operator UI does not send orders.

These POST routes exist so a demo can move an entity through the cases:

- `POST /reliability/kyc/entities`
- `POST /reliability/kyc/wallets`
- `POST /reliability/kyc/checks`
- `POST /reliability/kyc/resolve`
- `POST /reliability/kyc/expire`

Send `"force": true` on the expire route to show the expired badge before the config TTL.

The route file is `services/reliability/routes-lane-a-kyc.ts`.

The routes read and write the control API `AgentStore`. The lifecycle routes use that same store.
