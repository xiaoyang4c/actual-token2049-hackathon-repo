/**
 * @fileoverview KYC tier rules and demo scripts.
 *
 * PRODUCT OWNER CONFIG. The thresholds below are not decided.
 * This file is the only place that says what counts as verified
 * and which checks unlock each tier. Change this object when the
 * product owner decides the rules. Do not copy the thresholds
 * into the provider.
 *
 * Demo scripts are separate. They choose a mock vendor outcome.
 * They do not choose the tier. The tier always comes from the
 * rules and the checks that were submitted.
 */

import type {KycStatus, KycTier} from './types';

/** Mock check names. The provider records these strings. */
export const KYC_CHECK = {
  personIdentity: 'identity_document',
  personAddress: 'address',
  businessRegistration: 'registration_number',
  businessBeneficialOwner: 'beneficial_owner',
} as const;

/** Person or business. The check sets differ. */
export type KycSubjectKind = 'person'|'business';

/**
 * Tier thresholds. `countsAsVerified` is the only definition of
 * verified that fees and terms should use.
 */
export interface KycTierRules {
  version: string;
  countsAsVerified: {
    requireStatus: KycStatus;
    minimumTier: KycTier;
  };
  person: {basic: readonly string[]; enhanced: readonly string[]};
  business: {basic: readonly string[]; enhanced: readonly string[]};
  /** Read at expiry time. A verified check expires after this many ms. */
  verificationTtlMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Undecided defaults. A basic person check is an identity document.
 * An enhanced person check also has an address check. A basic
 * business check is a registration number. An enhanced business
 * check also names a beneficial owner. Verified means status
 * `verified` at tier `basic` or higher.
 */
export const KYC_TIER_RULES: KycTierRules = {
  version: 'kyc-tier-rules-v0-undecided',
  countsAsVerified: {
    requireStatus: 'verified',
    minimumTier: 'basic',
  },
  person: {
    basic: [KYC_CHECK.personIdentity],
    enhanced: [KYC_CHECK.personIdentity, KYC_CHECK.personAddress],
  },
  business: {
    basic: [KYC_CHECK.businessRegistration],
    enhanced: [
      KYC_CHECK.businessRegistration,
      KYC_CHECK.businessBeneficialOwner,
    ],
  },
  verificationTtlMs: 365 * DAY_MS,
};

/** Mock vendor outcome. The tier is not part of this decision. */
export type KycVendorDecision = 'pass'|'reject'|'hold';

/**
 * One scripted vendor outcome. All set fields must match.
 * The first matching script wins. No match means `pass`.
 */
export interface KycScript {
  decision: KycVendorDecision;
  entityId?: string;
  documentId?: string;
  registrationNumber?: string;
  documentPrefix?: string;
  registrationPrefix?: string;
  beneficialOwnerDocumentPrefix?: string;
}

/**
 * Demo outcomes. A caller can pass a different list.
 * `DOC-REJECT` and `REG-REJECT` reject. `DOC-HOLD` and
 * `REG-HOLD` stay pending. `BO-REJECT` rejects a business
 * whose beneficial owner document uses that prefix.
 */
export const DEMO_KYC_SCRIPTS: readonly KycScript[] = [
  {documentPrefix: 'DOC-REJECT', decision: 'reject'},
  {documentPrefix: 'DOC-HOLD', decision: 'hold'},
  {registrationPrefix: 'REG-REJECT', decision: 'reject'},
  {registrationPrefix: 'REG-HOLD', decision: 'hold'},
  {beneficialOwnerDocumentPrefix: 'BO-REJECT', decision: 'reject'},
];

const TIER_RANK: {[key in KycTier]: number} = {
  none: 0,
  basic: 1,
  enhanced: 2,
};

/** True when the status and tier meet the config. */
export function countsAsVerified(
  status: KycStatus,
  tier: KycTier,
  rules: KycTierRules = KYC_TIER_RULES,
): boolean {
  if (status !== rules.countsAsVerified.requireStatus) return false;
  return TIER_RANK[tier] >= TIER_RANK[rules.countsAsVerified.minimumTier];
}

/**
 * Tier for a subject from the submitted checks and the config.
 * An empty required list unlocks nothing. Enhanced is tested
 * before basic.
 */
export function tierForSubmittedChecks(
  kind: KycSubjectKind,
  submittedChecks: readonly string[],
  rules: KycTierRules = KYC_TIER_RULES,
): KycTier {
  const sets = kind === 'person' ? rules.person : rules.business;
  if (covers(submittedChecks, sets.enhanced)) return 'enhanced';
  if (covers(submittedChecks, sets.basic)) return 'basic';
  return 'none';
}

/** Rank used to tell a tier increase from a first approval. */
export function kycTierRank(tier: KycTier): number {
  return TIER_RANK[tier];
}

function covers(
  submitted: readonly string[], required: readonly string[],
): boolean {
  if (required.length === 0) return false;
  for (const check of required) {
    if (!submitted.includes(check)) return false;
  }
  return true;
}

/** First matching script, or `pass` when none match. */
export function vendorDecisionFor(
  subject: {
    entityId: string;
    documentId?: string;
    registrationNumber?: string;
    beneficialOwnerDocumentId?: string;
  },
  scripts: readonly KycScript[],
): KycVendorDecision {
  for (const script of scripts) {
    if (scriptMatches(script, subject)) return script.decision;
  }
  return 'pass';
}

function scriptMatches(
  script: KycScript,
  subject: {
    entityId: string;
    documentId?: string;
    registrationNumber?: string;
    beneficialOwnerDocumentId?: string;
  },
): boolean {
  const constrained = script.entityId !== undefined ||
    script.documentId !== undefined ||
    script.registrationNumber !== undefined ||
    script.documentPrefix !== undefined ||
    script.registrationPrefix !== undefined ||
    script.beneficialOwnerDocumentPrefix !== undefined;
  if (!constrained) return false;
  if (script.entityId !== undefined && script.entityId !== subject.entityId) {
    return false;
  }
  if (
    script.documentId !== undefined &&
    script.documentId !== subject.documentId
  ) {
    return false;
  }
  if (
    script.registrationNumber !== undefined &&
    script.registrationNumber !== subject.registrationNumber
  ) {
    return false;
  }
  if (!prefixMatches(script.documentPrefix, subject.documentId)) return false;
  if (!prefixMatches(script.registrationPrefix, subject.registrationNumber)) {
    return false;
  }
  return prefixMatches(
    script.beneficialOwnerDocumentPrefix, subject.beneficialOwnerDocumentId,
  );
}

function prefixMatches(
  prefix: string|undefined, value: string|undefined,
): boolean {
  if (prefix === undefined) return true;
  if (prefix === '') return false;
  return (value ?? '').startsWith(prefix);
}
