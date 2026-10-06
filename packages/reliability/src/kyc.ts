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
 * - unverified, rejected, or verified -> pending on submit
 * - pending -> verified, rejected, or still pending on resolve
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
  subjectKind: KycSubjectKind;
  status: KycStatus;
  tier: KycTier;
  badge: KycBadge;
  countsAsVerified: boolean;
  reRegistration: KycReRegistration|null;
  rulesVersion: string;
  verifiedAt?: string;
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
   */
  fetchStatus(entity: Entity, now: string): KycResult {
    const known = this.table.get(entity.id);
    if (known) return {...known, provider: this.name, checkedAt: now};
    const stored = this.store?.getEntity(entity.id);
    if (stored) {
      return {
        status: stored.kycStatus,
        tier: stored.kycTier,
        provider: this.name,
        checkedAt: now,
      };
    }
    return {
      status: 'unverified',
      tier: 'none',
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
      this.append(store, profile, {
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
    const when = requireTime(at);
    const normalized = normalizeWallets([wallet]);
    const next = normalized[0];
    if (next === undefined) {
      throw new KycFlowError(
        'wallet_required', 'wallet must be a non-empty string',
      );
    }
    return store.transaction(() => {
      this.requireEntity(store, entityId);
      const owner = store.getWalletEntityId(next);
      if (owner === entityId) return this.readView(store, entityId);
      if (owner !== undefined) {
        throw new KycFlowError('wallet_in_use', 'wallet is already registered');
      }
      store.addWallet(entityId, next, when);
      return this.readView(store, entityId);
    });
  }

  /** Moves the entity to pending and records the mocked checks. */
  submitCheck(input: KycCheckInput): KycView {
    const store = this.requireStore();
    const at = requireTime(input.at);
    return store.transaction(() => {
      const current = this.requireProfile(store, input.entityId);
      if (current.subjectKind !== input.kind) {
        throw new KycFlowError(
          'kind_mismatch', 'check kind does not match the entity',
        );
      }
      const checks = new Set(current.submittedChecks);
      const next: KycProfile = {
        ...current,
        rulesVersion: this.rules.version,
        verifiedAt: undefined,
        updatedAt: at,
      };
      if (input.kind === 'person') {
        next.documentId = requireLabel(input.documentId, 'documentId');
        checks.add(KYC_CHECK.personIdentity);
        if (input.addressChecked === true) checks.add(KYC_CHECK.personAddress);
      } else {
        next.registrationNumber = requireLabel(
          input.registrationNumber, 'registrationNumber',
        );
        checks.add(KYC_CHECK.businessRegistration);
        if (input.beneficialOwnerDocumentId !== undefined) {
          next.beneficialOwnerDocumentId = requireLabel(
            input.beneficialOwnerDocumentId, 'beneficialOwnerDocumentId',
          );
          checks.add(KYC_CHECK.businessBeneficialOwner);
        }
      }
      next.submittedChecks = [...checks].sort();
      const profile = this.withFlag(store, next);
      store.saveKycProfile(profile);
      store.updateEntityKyc(profile.entityId, 'pending', 'none');
      this.append(store, profile, {
        status: 'pending',
        tier: 'none',
        badge: 'pending',
        how: 'check_submitted',
        at,
        decision: undefined,
      });
      return this.readView(store, profile.entityId);
    });
  }

  /**
   * Applies the scripted vendor outcome. The tier comes from the
   * config and the submitted checks, not from the script.
   */
  resolveCheck(entityId: string, at: string): KycView {
    const store = this.requireStore();
    const when = requireTime(at);
    return store.transaction(() => {
      const entity = this.requireEntity(store, entityId);
      if (entity.kycStatus !== 'pending') {
        throw new KycFlowError('not_pending', 'resolve a pending check');
      }
      const current = this.requireProfile(store, entityId);
      const decision = vendorDecisionFor(current, this.scripts);
      if (decision === 'hold') {
        return this.finish(store, current, {
          status: 'pending',
          tier: 'none',
          badge: 'pending',
          how: 'vendor_hold',
          at: when,
          decision,
          verifiedAt: undefined,
        });
      }
      if (decision === 'reject') {
        return this.finish(store, current, {
          status: 'rejected',
          tier: 'none',
          badge: 'rejected',
          how: 'vendor_rejected',
          at: when,
          decision,
          verifiedAt: undefined,
        });
      }
      const tier = tierForSubmittedChecks(
        current.subjectKind, current.submittedChecks, this.rules,
      );
      if (tier === 'none') {
        return this.finish(store, current, {
          status: 'pending',
          tier: 'none',
          badge: 'pending',
          how: 'checks_short_of_tier',
          at: when,
          decision,
          verifiedAt: undefined,
        });
      }
      const prior = lastVerifiedTier(store.listKycStatusRecords(entityId));
      const how = kycTierRank(tier) > kycTierRank(prior) && prior !== 'none' ?
        'tier_raised' :
        'vendor_approved';
      return this.finish(store, current, {
        status: 'verified',
        tier,
        badge: 'verified',
        how,
        at: when,
        decision,
        verifiedAt: when,
      });
    });
  }

  /**
   * Expires a verified entity. The entity row becomes unverified
   * at tier none. The history badge is `expired`. Pass force to
   * skip the config TTL. Otherwise `at` must be at or after
   * verifiedAt plus verificationTtlMs.
   */
  expireVerification(entityId: string, at: string, force = false): KycView {
    const store = this.requireStore();
    const when = requireTime(at);
    return store.transaction(() => {
      const entity = this.requireEntity(store, entityId);
      const profile = this.requireProfile(store, entityId);
      if (entity.kycStatus !== 'verified' || profile.verifiedAt === undefined) {
        throw new KycFlowError(
          'not_verified', 'only a verified entity can expire',
        );
      }
      if (!force && !isDue(
        profile.verifiedAt, when, this.rules.verificationTtlMs,
      )) {
        throw new KycFlowError('not_due', 'verification is not due');
      }
      return this.finish(store, profile, {
        status: 'unverified',
        tier: 'none',
        badge: 'expired',
        how: 'expired',
        at: when,
        decision: undefined,
        verifiedAt: undefined,
      });
    });
  }

  /** Current badge, history, and policy input. */
  view(entityId: string): KycView {
    const store = this.requireStore();
    return this.readView(store, entityId);
  }

  private finish(
    store: KycRecordStore,
    profile: KycProfile,
    step: StatusStep,
  ): KycView {
    const next: KycProfile = {
      ...profile,
      rulesVersion: this.rules.version,
      verifiedAt: step.verifiedAt,
      updatedAt: step.at,
    };
    store.saveKycProfile(next);
    store.updateEntityKyc(next.entityId, step.status, step.tier);
    this.append(store, next, step);
    return this.readView(store, next.entityId);
  }

  private append(
    store: KycRecordStore, profile: KycProfile, step: StatusStep,
  ): void {
    const count = store.listKycStatusRecords(profile.entityId).length + 1;
    const record: KycStatusRecord = {
      id: `${profile.entityId}:kyc:${String(count).padStart(4, '0')}`,
      entityId: profile.entityId,
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
    const profile = this.requireProfile(store, entityId);
    const history = store.listKycStatusRecords(entityId);
    const latest = history[history.length - 1];
    const badge = latest?.badge ?? 'unverified';
    const verified = countsAsVerified(
      entity.kycStatus, entity.kycTier, this.rules,
    );
    const reRegistration = reRegistrationOf(profile);
    const policyInput: KycPolicyInput = {
      entityId: entity.id,
      kycStatus: entity.kycStatus,
      kycTier: entity.kycTier,
      badge,
      countsAsVerified: verified,
      reRegistrationOf: reRegistration?.ofEntityId ?? null,
      rulesVersion: this.rules.version,
    };
    return {
      entity,
      subjectKind: profile.subjectKind,
      status: entity.kycStatus,
      tier: entity.kycTier,
      badge,
      countsAsVerified: verified,
      reRegistration,
      rulesVersion: this.rules.version,
      verifiedAt: profile.verifiedAt,
      submittedChecks: profile.submittedChecks,
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

  private requireProfile(store: KycRecordStore, entityId: string): KycProfile {
    const profile = store.getKycProfile(entityId);
    if (!profile) throw new KycFlowError('unknown_entity', 'unknown entity');
    return profile;
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
  verifiedAt?: string;
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

function lastVerifiedTier(history: readonly KycStatusRecord[]): KycTier {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const row = history[index];
    if (row !== undefined && row.status === 'verified') return row.tier;
  }
  return 'none';
}

function statusDetail(
  profile: KycProfile, step: StatusStep,
): {[key: string]: string} {
  return stringDetail([
    ['subjectKind', profile.subjectKind],
    ['decision', step.decision],
    ['documentId', profile.documentId],
    ['registrationNumber', profile.registrationNumber],
    ['beneficialOwnerDocumentId', profile.beneficialOwnerDocumentId],
    ['submittedChecks', profile.submittedChecks.join(',')],
    ['reRegistrationOf', profile.reRegistrationOf],
    ['reRegistrationSignal', profile.reRegistrationSignal],
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

function requireTime(value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new KycFlowError('bad_time', 'at must be an ISO time');
  }
  if (!Number.isFinite(Date.parse(value))) {
    throw new KycFlowError('bad_time', 'at must be an ISO time');
  }
  return value;
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
