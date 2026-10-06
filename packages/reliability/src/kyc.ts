/**
 * @fileoverview Mock KYC provider for lane A.
 * There is no live vendor. Outcomes come from scripts. Tiers come
 * from kyc-rules.ts. The provider stores entities, wallets, and
 * status history through KycRecordStore. A wallet is not proof that
 * two entities are independent, and a new entity does not inherit
 * reliability.
 *
 * Frozen entity status values are unverified, pending, verified, and
 * rejected. Expiry is a history badge. After expiry the entity row
 * is unverified at tier none.
 *
 * Allowed moves:
 * - unverified, rejected, or pending -> pending on submit
 * - verified stays verified on submit until the check resolves
 * - pending -> verified, rejected, or still pending on resolve
 * - verified -> verified at the new tier on a passing resolve. A
 *   rejected or held check keeps the current tier.
 * - verified -> unverified with badge expired
 */

import type {Entity, EntityRole, KycStatus, KycTier} from './types';
import {
  DEMO_KYC_SCRIPTS,
  KYC_CHECK,
  KYC_TIER_RULES,
  countsAsVerified,
  kycTierRank,
  tierForSubmittedChecks,
  vendorDecisionFor,
  type KycScript,
  type KycSubjectKind,
  type KycTierRules,
  type KycVendorDecision,
} from './kyc-rules';

export const MOCK_KYC_PROVIDER_NAME = 'mock-kyc-provider';

export {
  DEMO_KYC_SCRIPTS,
  KYC_CHECK,
  KYC_TIER_RULES,
  countsAsVerified,
  tierForSubmittedChecks,
};
export type {KycScript, KycSubjectKind, KycTierRules, KycVendorDecision};

/** KYC result for one entity. Status stays inside the frozen set. */
export interface KycResult {
  status: KycStatus;
  tier: KycTier;
  provider: string;
  checkedAt: string;
}

/**
 * KYC seam. fetchStatus reads the frozen status and tier.
 * The UI badge, including expired, is on KycView.
 */
export interface KycProvider {
  readonly name: string;
  fetchStatus(entity: Entity, now: string): KycResult;
}

/** UI badge. `expired` is not a frozen KycStatus. */
export type KycBadge = KycStatus|'expired';

/** How a status row was reached. */
export type KycHow =
  'registered'|'check_submitted'|'vendor_approved'|'tier_raised'|
  'vendor_rejected'|'vendor_hold'|'checks_short_of_tier'|'expired';

export const KYC_BADGES: readonly KycBadge[] = [
  'unverified', 'pending', 'verified', 'rejected', 'expired',
];

export const KYC_HOWS: readonly KycHow[] = [
  'registered', 'check_submitted', 'vendor_approved', 'tier_raised',
  'vendor_rejected', 'vendor_hold', 'checks_short_of_tier', 'expired',
];

/** One stored step. The list is append-only. */
export interface KycStatusRecord {
  id: string;
  entityId: string;
  status: KycStatus;
  tier: KycTier;
  badge: KycBadge;
  how: KycHow;
  at: string;
  provider: string;
  rulesVersion: string;
  detail: {[key: string]: string};
}

/** Profile stored beside the entity row. */
export interface KycProfile {
  entityId: string;
  subjectKind: KycSubjectKind;
  documentId?: string;
  registrationNumber?: string;
  beneficialOwnerDocumentId?: string;
  submittedChecks: readonly string[];
  reRegistrationOf?: string;
  reRegistrationSignal?: KycReRegistrationSignal;
  reRegistrationValue?: string;
  rulesVersion: string;
  verifiedAt?: string;
  /** Time of the submission that waits for resolveCheck. */
  pendingSince?: string;
  updatedAt: string;
}

export type KycReRegistrationSignal = 'document'|'registration_number';

export const KYC_RE_REGISTRATION_SIGNALS: readonly KycReRegistrationSignal[] = [
  'document', 'registration_number',
];

/** Same mocked document or registration number. Not a wallet match. */
export interface KycReRegistration {
  ofEntityId: string;
  signal: KycReRegistrationSignal;
  matchedValue: string;
}

/**
 * Inputs for the fees and terms policy. Read this object.
 * Do not copy reliability from reRegistrationOf.
 */
export interface KycPolicyInput {
  entityId: string;
  kycStatus: KycStatus;
  kycTier: KycTier;
  badge: KycBadge;
  countsAsVerified: boolean;
  reRegistrationOf: string|null;
  rulesVersion: string;
}

/** Read model for one entity. */
export interface KycView {
  entity: Entity;
  /** Null when the entity was created outside KYC onboarding. */
  subjectKind: KycSubjectKind|null;
  status: KycStatus;
  tier: KycTier;
  badge: KycBadge;
  countsAsVerified: boolean;
  /** True while a submitted check waits for resolveCheck. */
  checkPending: boolean;
  reRegistration: KycReRegistration|null;
  rulesVersion: string;
  verifiedAt?: string;
  /** Checks of the latest submission. Expiry clears them. */
  submittedChecks: readonly string[];
  history: KycStatusRecord[];
  policyInput: KycPolicyInput;
}

/** Store seam. AgentStore implements it. */
export interface KycRecordStore {
  transaction<T>(work: () => T): T;
  insertEntity(entity: Entity): Entity;
  getEntity(id: string): Entity|undefined;
  updateEntityKyc(id: string, status: KycStatus, tier: KycTier): Entity;
  addWallet(entityId: string, wallet: string, addedAt: string): void;
  getWalletEntityId(wallet: string): string|undefined;
  saveKycProfile(profile: KycProfile): KycProfile;
  getKycProfile(entityId: string): KycProfile|undefined;
  listKycProfilesByDocument(documentId: string): KycProfile[];
  listKycProfilesByRegistration(registrationNumber: string): KycProfile[];
  insertKycStatusRecord(record: KycStatusRecord): void;
  listKycStatusRecords(entityId: string): KycStatusRecord[];
}

export type KycFlowErrorCode =
  'store_required'|'entity_exists'|'wallet_in_use'|'wallet_required'|
  'roles_required'|'unknown_role'|'unknown_entity'|'kind_mismatch'|
  'not_pending'|'not_verified'|'not_due'|'bad_time'|'bad_input';

/** Expected KYC flow failure. Routes map it to HTTP 400 or 404. */
export class KycFlowError extends Error {
  readonly code: KycFlowErrorCode;

  constructor(code: KycFlowErrorCode, message: string) {
    super(message);
    this.name = 'KycFlowError';
    this.code = code;
  }
}

export type RegisterEntityInput = {
  id: string;
  displayName: string;
  roles: readonly string[];
  wallets: readonly string[];
  at: string;
} & (
  | {kind: 'person'; documentId?: string}
  | {
    kind: 'business';
    registrationNumber?: string;
    beneficialOwnerDocumentId?: string;
  }
);

export type KycCheckInput = {
  entityId: string;
  at: string;
} & (
  | {kind: 'person'; documentId: string; addressChecked?: boolean}
  | {
    kind: 'business';
    registrationNumber: string;
    beneficialOwnerDocumentId?: string;
  }
);

export interface MockKycOptions {
  store?: KycRecordStore;
  rules?: KycTierRules;
  scripts?: readonly KycScript[];
}

/** Deterministic mock. Performs no identity check and calls no vendor. */
export class MockKycProvider implements KycProvider {
  readonly name = MOCK_KYC_PROVIDER_NAME;
  private readonly table: ReadonlyMap<string, KycResult>;
  private readonly store: KycRecordStore|undefined;
  private readonly rules: KycTierRules;
  private readonly scripts: readonly KycScript[];

  constructor(
    overrides: ReadonlyMap<string, KycResult> = new Map(),
    options: MockKycOptions = {},
  ) {
    this.table = overrides;
    this.store = options.store;
    this.rules = options.rules ?? KYC_TIER_RULES;
    this.scripts = options.scripts ?? DEMO_KYC_SCRIPTS;
  }

  /**
   * Frozen status and tier. An override map wins. Otherwise the
   * store row wins. An unknown id is unverified at tier none.
   * Expiry is not returned here. Read KycView.badge for that.
   * KycView and its policyInput read the same status.
   */
  fetchStatus(entity: Entity, now: string): KycResult {
    return {
      ...this.statusOf(entity.id, this.store?.getEntity(entity.id)),
      provider: this.name,
      checkedAt: now,
    };
  }

  /** Registers a buyer, a seller, or both. Starts unverified. */
  registerEntity(input: RegisterEntityInput): KycView {
    const store = this.requireStore();
    const at = requireTime(input.at);
    const roles = normalizeRoles(input.roles);
    const wallets = normalizeWallets(input.wallets);
    const id = requireLabel(input.id, 'id');
    const displayName = requireLabel(input.displayName, 'displayName');
    return store.transaction(() => {
      if (store.getEntity(id)) {
        throw new KycFlowError('entity_exists', 'entity already exists');
      }
      this.requireFreeWallets(store, wallets);
      const entity = store.insertEntity({
        id,
        displayName,
        wallets,
        kycStatus: 'unverified',
        kycTier: 'none',
        roles,
        createdAt: at,
      });
      const profile = this.withFlag(
        store, blankProfile(entity.id, input, at, this.rules.version),
      );
      store.saveKycProfile(profile);
      this.append(store, entity.id, profile, {
        status: 'unverified',
        tier: 'none',
        badge: 'unverified',
        how: 'registered',
        at,
        decision: undefined,
      });
      return this.readView(store, entity.id);
    });
  }

  /**
   * Attaches one wallet. Does not change KYC status and does not
   * copy reliability. A wallet already used by this entity is a
   * no-op. A wallet used by another entity is refused.
   */
  attachWallet(entityId: string, wallet: string, at: string): KycView {
    const store = this.requireStore();
    const id = requireLabel(entityId, 'entityId');
    const when = requireTime(at);
    const normalized = normalizeWallets([wallet]);
    const next = normalized[0];
    if (next === undefined) {
      throw new KycFlowError(
        'wallet_required', 'wallet must be a non-empty string',
      );
    }
    return store.transaction(() => {
      this.requireEntity(store, id);
      const owner = store.getWalletEntityId(next);
      if (owner === id) return this.readView(store, id);
      if (owner !== undefined) {
        throw new KycFlowError('wallet_in_use', 'wallet is already registered');
      }
      store.addWallet(id, next, when);
      return this.readView(store, id);
    });
  }

  /**
   * Records one submission. It replaces the earlier checks and
   * identifiers, so send every check for the tier you want. A
   * verified entity keeps its status and tier until the check
   * resolves. Any other entity moves to pending. An entity that was
   * created outside KYC onboarding gets its profile here.
   */
  submitCheck(input: KycCheckInput): KycView {
    const store = this.requireStore();
    const entityId = requireLabel(input.entityId, 'entityId');
    const at = requireTime(input.at);
    return store.transaction(() => {
      const entity = this.requireEntity(store, entityId);
      const current = store.getKycProfile(entityId);
      if (current !== undefined && current.subjectKind !== input.kind) {
        throw new KycFlowError(
          'kind_mismatch', 'check kind does not match the entity',
        );
      }
      const verified = entity.kycStatus === 'verified';
      const profile = this.withFlag(store, {
        ...submittedProfile(entityId, input),
        reRegistrationOf: current?.reRegistrationOf,
        reRegistrationSignal: current?.reRegistrationSignal,
        reRegistrationValue: current?.reRegistrationValue,
        rulesVersion: this.rules.version,
        verifiedAt: verified ? current?.verifiedAt : undefined,
        pendingSince: at,
        updatedAt: at,
      });
      const status = verified ? 'verified' : 'pending';
      return this.finish(store, entityId, profile, {
        status,
        tier: verified ? entity.kycTier : 'none',
        badge: status,
        how: 'check_submitted',
        at,
        decision: undefined,
      });
    });
  }

  /**
   * Applies the scripted vendor outcome. The tier comes from the
   * config and the submitted checks, not from the script. When the
   * check does not pass, a verified entity keeps its current tier.
   */
  resolveCheck(entityId: string, at: string): KycView {
    const store = this.requireStore();
    const id = requireLabel(entityId, 'entityId');
    const when = requireTime(at);
    return store.transaction(() => {
      const entity = this.requireEntity(store, id);
      const current = store.getKycProfile(id);
      if (current?.pendingSince === undefined) {
        throw new KycFlowError('not_pending', 'resolve a pending check');
      }
      const decision = vendorDecisionFor(current, this.scripts);
      const tier = decision === 'pass' ?
        tierForSubmittedChecks(
          current.subjectKind, current.submittedChecks, this.rules,
        ) :
        'none';
      const verified = entity.kycStatus === 'verified';
      if (tier !== 'none') {
        const raised = verified &&
          kycTierRank(tier) > kycTierRank(entity.kycTier);
        return this.finish(store, id, {
          ...this.settled(current, when),
          verifiedAt: when,
        }, {
          status: 'verified',
          tier,
          badge: 'verified',
          how: raised ? 'tier_raised' : 'vendor_approved',
          at: when,
          decision,
        });
      }
      const how = NOT_PASSED_HOW[decision];
      if (verified) {
        // The current verification stands. Only a hold stays open.
        return this.finish(store, id, {
          ...this.settled(current, when),
          pendingSince: decision === 'hold' ? current.pendingSince : undefined,
        }, {
          status: 'verified',
          tier: entity.kycTier,
          badge: 'verified',
          how,
          at: when,
          decision,
        });
      }
      const status = decision === 'reject' ? 'rejected' : 'pending';
      return this.finish(store, id, {
        ...this.settled(current, when),
        verifiedAt: undefined,
        pendingSince: status === 'pending' ? current.pendingSince : undefined,
      }, {
        status,
        tier: 'none',
        badge: status,
        how,
        at: when,
        decision,
      });
    });
  }

  /**
   * Expires a verified entity. The entity row becomes unverified
   * at tier none. The history badge is `expired`. The submitted
   * checks and any open check are cleared, so the entity submits
   * again. Pass force to skip the config TTL. Otherwise `at` must be
   * at or after verifiedAt plus verificationTtlMs. An entity with no
   * recorded verification time needs force.
   */
  expireVerification(entityId: string, at: string, force = false): KycView {
    const store = this.requireStore();
    const id = requireLabel(entityId, 'entityId');
    const when = requireTime(at);
    return store.transaction(() => {
      const entity = this.requireEntity(store, id);
      if (entity.kycStatus !== 'verified') {
        throw new KycFlowError(
          'not_verified', 'only a verified entity can expire',
        );
      }
      const profile = store.getKycProfile(id);
      const verifiedAt = profile?.verifiedAt;
      if (!force) {
        if (verifiedAt === undefined) {
          throw new KycFlowError(
            'not_due', 'verification time is unknown. Send force.',
          );
        }
        if (!isDue(verifiedAt, when, this.rules.verificationTtlMs)) {
          throw new KycFlowError('not_due', 'verification is not due');
        }
      }
      const next = profile === undefined ? undefined : {
        ...this.settled(profile, when),
        submittedChecks: [],
        verifiedAt: undefined,
      };
      return this.finish(store, id, next, {
        status: 'unverified',
        tier: 'none',
        badge: 'expired',
        how: 'expired',
        at: when,
        decision: undefined,
      });
    });
  }

  /** Current badge, history, and policy input. */
  view(entityId: string): KycView {
    const store = this.requireStore();
    return this.readView(store, requireLabel(entityId, 'entityId'));
  }

  /** One status source for fetchStatus and the view. */
  private statusOf(
    entityId: string, stored: Entity|undefined,
  ): {status: KycStatus; tier: KycTier} {
    const known = this.table.get(entityId);
    if (known) return {status: known.status, tier: known.tier};
    if (stored) return {status: stored.kycStatus, tier: stored.kycTier};
    return {status: 'unverified', tier: 'none'};
  }

  /** Profile after a step that closes the open check. */
  private settled(profile: KycProfile, at: string): KycProfile {
    return {
      ...profile,
      rulesVersion: this.rules.version,
      pendingSince: undefined,
      updatedAt: at,
    };
  }

  private finish(
    store: KycRecordStore,
    entityId: string,
    profile: KycProfile|undefined,
    step: StatusStep,
  ): KycView {
    if (profile !== undefined) store.saveKycProfile(profile);
    store.updateEntityKyc(entityId, step.status, step.tier);
    this.append(store, entityId, profile, step);
    return this.readView(store, entityId);
  }

  private append(
    store: KycRecordStore,
    entityId: string,
    profile: KycProfile|undefined,
    step: StatusStep,
  ): void {
    const count = store.listKycStatusRecords(entityId).length + 1;
    const record: KycStatusRecord = {
      id: `${entityId}:kyc:${String(count).padStart(4, '0')}`,
      entityId,
      status: step.status,
      tier: step.tier,
      badge: step.badge,
      how: step.how,
      at: step.at,
      provider: this.name,
      rulesVersion: this.rules.version,
      detail: statusDetail(profile, step),
    };
    store.insertKycStatusRecord(record);
  }

  private readView(store: KycRecordStore, entityId: string): KycView {
    const entity = this.requireEntity(store, entityId);
    const profile = store.getKycProfile(entityId);
    const history = store.listKycStatusRecords(entityId);
    const {status, tier} = this.statusOf(entity.id, entity);
    const badge = badgeFor(status, history);
    const verified = countsAsVerified(status, tier, this.rules);
    const reRegistration = profile === undefined ?
      null :
      reRegistrationOf(profile);
    const policyInput: KycPolicyInput = {
      entityId: entity.id,
      kycStatus: status,
      kycTier: tier,
      badge,
      countsAsVerified: verified,
      reRegistrationOf: reRegistration?.ofEntityId ?? null,
      rulesVersion: this.rules.version,
    };
    return {
      entity,
      subjectKind: profile?.subjectKind ?? null,
      status,
      tier,
      badge,
      countsAsVerified: verified,
      checkPending: profile?.pendingSince !== undefined,
      reRegistration,
      rulesVersion: this.rules.version,
      verifiedAt: profile?.verifiedAt,
      submittedChecks: profile?.submittedChecks ?? [],
      history,
      policyInput,
    };
  }

  /**
   * Flags the same mocked document or registration number.
   * Does not read wallets and does not copy reliability.
   * Keeps an existing flag.
   */
  private withFlag(store: KycRecordStore, profile: KycProfile): KycProfile {
    if (profile.reRegistrationOf !== undefined) return profile;
    const flag = detectReRegistration(store, profile);
    if (!flag) return profile;
    return {
      ...profile,
      reRegistrationOf: flag.ofEntityId,
      reRegistrationSignal: flag.signal,
      reRegistrationValue: flag.matchedValue,
    };
  }

  private requireStore(): KycRecordStore {
    if (!this.store) {
      throw new KycFlowError('store_required', 'KYC onboarding needs a store');
    }
    return this.store;
  }

  private requireEntity(store: KycRecordStore, entityId: string): Entity {
    const entity = store.getEntity(entityId);
    if (!entity) throw new KycFlowError('unknown_entity', 'unknown entity');
    return entity;
  }

  private requireFreeWallets(
    store: KycRecordStore, wallets: readonly string[],
  ): void {
    for (const wallet of wallets) {
      if (store.getWalletEntityId(wallet) !== undefined) {
        throw new KycFlowError('wallet_in_use', 'wallet is already registered');
      }
    }
  }
}

interface StatusStep {
  status: KycStatus;
  tier: KycTier;
  badge: KycBadge;
  how: KycHow;
  at: string;
  decision: KycVendorDecision|undefined;
}

/** History cause when a check does not reach a tier. */
const NOT_PASSED_HOW: {[key in KycVendorDecision]: KycHow} = {
  pass: 'checks_short_of_tier',
  hold: 'vendor_hold',
  reject: 'vendor_rejected',
};

type KycSubmission = Pick<
  KycProfile,
  'entityId'|'subjectKind'|'documentId'|'registrationNumber'|
  'beneficialOwnerDocumentId'|'submittedChecks'
>;

/** Identifiers and checks from one submission. Older values are dropped. */
function submittedProfile(
  entityId: string, input: KycCheckInput,
): KycSubmission {
  if (input.kind === 'person') {
    const checks: string[] = [KYC_CHECK.personIdentity];
    if (input.addressChecked === true) checks.push(KYC_CHECK.personAddress);
    return {
      entityId,
      subjectKind: 'person',
      documentId: requireLabel(input.documentId, 'documentId'),
      submittedChecks: checks.sort(),
    };
  }
  const checks: string[] = [KYC_CHECK.businessRegistration];
  let beneficialOwnerDocumentId: string|undefined;
  if (input.beneficialOwnerDocumentId !== undefined) {
    beneficialOwnerDocumentId = requireLabel(
      input.beneficialOwnerDocumentId, 'beneficialOwnerDocumentId',
    );
    checks.push(KYC_CHECK.businessBeneficialOwner);
  }
  return {
    entityId,
    subjectKind: 'business',
    registrationNumber: requireLabel(
      input.registrationNumber, 'registrationNumber',
    ),
    beneficialOwnerDocumentId,
    submittedChecks: checks.sort(),
  };
}

/**
 * The badge is the status, except that an unverified entity whose
 * last step was an expiry shows `expired`. The badge cannot
 * contradict the status.
 */
function badgeFor(
  status: KycStatus, history: readonly KycStatusRecord[],
): KycBadge {
  if (status === 'unverified' && history.at(-1)?.how === 'expired') {
    return 'expired';
  }
  return status;
}

function blankProfile(
  entityId: string,
  input: RegisterEntityInput,
  at: string,
  rulesVersion: string,
): KycProfile {
  const profile: KycProfile = {
    entityId,
    subjectKind: input.kind,
    submittedChecks: [],
    rulesVersion,
    updatedAt: at,
  };
  if (input.kind === 'person') {
    if (input.documentId !== undefined) {
      profile.documentId = requireLabel(input.documentId, 'documentId');
    }
    return profile;
  }
  if (input.registrationNumber !== undefined) {
    profile.registrationNumber = requireLabel(
      input.registrationNumber, 'registrationNumber',
    );
  }
  if (input.beneficialOwnerDocumentId !== undefined) {
    profile.beneficialOwnerDocumentId = requireLabel(
      input.beneficialOwnerDocumentId, 'beneficialOwnerDocumentId',
    );
  }
  return profile;
}

function detectReRegistration(
  store: KycRecordStore, profile: KycProfile,
): KycReRegistration|undefined {
  const document = firstOther(
    store, profile.entityId, profile.documentId, 'document',
  );
  if (document) return document;
  const ownerDocument = firstOther(
    store, profile.entityId, profile.beneficialOwnerDocumentId, 'document',
  );
  if (ownerDocument) return ownerDocument;
  if (profile.registrationNumber === undefined) return undefined;
  const matches = store.listKycProfilesByRegistration(
    profile.registrationNumber,
  )
    .filter((row) => row.entityId !== profile.entityId);
  const match = matches[0];
  if (!match) return undefined;
  return {
    ofEntityId: match.entityId,
    signal: 'registration_number',
    matchedValue: profile.registrationNumber,
  };
}

function firstOther(
  store: KycRecordStore,
  entityId: string,
  documentId: string|undefined,
  signal: 'document',
): KycReRegistration|undefined {
  if (documentId === undefined) return undefined;
  const matches = store.listKycProfilesByDocument(documentId)
    .filter((row) => row.entityId !== entityId);
  const match = matches[0];
  if (!match) return undefined;
  return {ofEntityId: match.entityId, signal, matchedValue: documentId};
}

function reRegistrationOf(profile: KycProfile): KycReRegistration|null {
  if (
    profile.reRegistrationOf === undefined ||
    profile.reRegistrationSignal === undefined ||
    profile.reRegistrationValue === undefined
  ) {
    return null;
  }
  return {
    ofEntityId: profile.reRegistrationOf,
    signal: profile.reRegistrationSignal,
    matchedValue: profile.reRegistrationValue,
  };
}

function statusDetail(
  profile: KycProfile|undefined, step: StatusStep,
): {[key: string]: string} {
  return stringDetail([
    ['subjectKind', profile?.subjectKind],
    ['decision', step.decision],
    ['documentId', profile?.documentId],
    ['registrationNumber', profile?.registrationNumber],
    ['beneficialOwnerDocumentId', profile?.beneficialOwnerDocumentId],
    ['submittedChecks', profile?.submittedChecks.join(',')],
    ['reRegistrationOf', profile?.reRegistrationOf],
    ['reRegistrationSignal', profile?.reRegistrationSignal],
  ]);
}

function stringDetail(
  pairs: ReadonlyArray<readonly [string, string|undefined]>,
): {[key: string]: string} {
  const detail: {[key: string]: string} = {};
  for (const [key, value] of pairs) {
    if (value !== undefined && value !== '') detail[key] = value;
  }
  return detail;
}

function isDue(verifiedAt: string, at: string, ttlMs: number): boolean {
  return Date.parse(at) >= Date.parse(verifiedAt) + ttlMs;
}

/** Returns the time as UTC ISO text, so stored times compare in order. */
function requireTime(value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new KycFlowError('bad_time', 'at must be an ISO time');
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new KycFlowError('bad_time', 'at must be an ISO time');
  }
  return new Date(parsed).toISOString();
}

function requireLabel(value: string, label: string): string {
  if (typeof value !== 'string') {
    throw new KycFlowError('bad_input', `${label} must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new KycFlowError('bad_input', `${label} must be a non-empty string`);
  }
  return trimmed;
}

function normalizeRoles(roles: readonly string[]): EntityRole[] {
  if (roles.length === 0) {
    throw new KycFlowError('roles_required', 'register at least one role');
  }
  const out: EntityRole[] = [];
  const add = (role: EntityRole): void => {
    if (!out.includes(role)) out.push(role);
  };
  for (const role of roles) {
    if (role === 'both') {
      add('buyer');
      add('seller');
      continue;
    }
    if (role === 'buyer' || role === 'seller') {
      add(role);
      continue;
    }
    throw new KycFlowError('unknown_role', 'role must be buyer or seller');
  }
  return out;
}

function normalizeWallets(wallets: readonly string[]): string[] {
  if (wallets.length === 0) {
    throw new KycFlowError(
      'wallet_required', 'wallet must be a non-empty string',
    );
  }
  const out: string[] = [];
  for (const wallet of wallets) {
    if (typeof wallet !== 'string' || wallet.trim() === '') {
      throw new KycFlowError(
        'wallet_required', 'wallet must be a non-empty string',
      );
    }
    const trimmed = wallet.trim();
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}
