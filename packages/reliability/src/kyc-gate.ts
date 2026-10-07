/**
 * @fileoverview KYC restrictions for marketplace actions (lane A).
 *
 * A party passes when its entity row counts as verified under
 * KYC_TIER_RULES, its tier meets the required tier, and its verification
 * has not passed the configured TTL. A re-registration of a rejected
 * entity does not pass. The mock provider decides status and tier. This
 * module only reads them. Read docs/kyc.md.
 */

import {KYC_TIER_RULES, countsAsVerified, kycTierRank, type KycTierRules} from './kyc-rules';
import type {KycProfile} from './kyc';
import type {Entity, KycTier} from './types';

export const KYC_GATE_VERSION = 'kyc-gate-v1';

/** Why a party does not pass. */
export type KycGateCode =
  'kyc_unknown_entity'|'kyc_rejected'|'kyc_pending'|'kyc_not_verified'|
  'kyc_tier_too_low'|'kyc_expired'|'kyc_reregistration_of_rejected';

/** Result for one party. */
export interface KycGateResult {
  entityId: string;
  passed: boolean;
  code?: KycGateCode;
  message: string;
  tier: KycTier;
  requiredTier: KycTier;
  version: string;
}

/** Inputs for one party. The caller reads them from the store. */
export interface KycGateSubject {
  entityId: string;
  entity: Entity|undefined;
  profile?: KycProfile;
  /** Entity row named by profile.reRegistrationOf, when there is one. */
  reRegisteredFrom?: Entity;
}

/**
 * Checks one party. `requiredTier` raises the KYC_TIER_RULES minimum,
 * for example for a contract template. It never lowers it.
 */
export function checkKyc(
  subject: KycGateSubject,
  now: string,
  options: {requiredTier?: KycTier; rules?: KycTierRules} = {},
): KycGateResult {
  const rules = options.rules ?? KYC_TIER_RULES;
  const minimum = rules.countsAsVerified.minimumTier;
  const requiredTier = options.requiredTier && kycTierRank(options.requiredTier) > kycTierRank(minimum) ?
    options.requiredTier : minimum;
  const entity = subject.entity;
  const result = (code: KycGateCode|undefined, message: string): KycGateResult => ({
    entityId: subject.entityId, passed: code === undefined, ...(code ? {code} : {}), message,
    tier: entity?.kycTier ?? 'none', requiredTier, version: KYC_GATE_VERSION,
  });
  if (!entity) {
    return result('kyc_unknown_entity', `${subject.entityId} is not registered; register it through KYC onboarding`);
  }
  if (entity.kycStatus === 'rejected') return result('kyc_rejected', `${entity.id} failed KYC`);
  if (entity.kycStatus === 'pending') return result('kyc_pending', `${entity.id} has a KYC check in review`);
  if (!countsAsVerified(entity.kycStatus, entity.kycTier, rules)) {
    return result('kyc_not_verified', `${entity.id} is not KYC verified`);
  }
  if (kycTierRank(entity.kycTier) < kycTierRank(requiredTier)) {
    return result('kyc_tier_too_low', `${entity.id} has KYC tier ${entity.kycTier}; ${requiredTier} is required`);
  }
  const verifiedAt = subject.profile?.verifiedAt;
  if (verifiedAt && Date.parse(now) >= Date.parse(verifiedAt) + rules.verificationTtlMs) {
    return result('kyc_expired', `${entity.id} KYC verification expired; renew it`);
  }
  if (subject.reRegisteredFrom?.kycStatus === 'rejected') {
    return result(
      'kyc_reregistration_of_rejected',
      `${entity.id} re-registers the identity of rejected entity ${subject.reRegisteredFrom.id}`,
    );
  }
  return result(undefined, `${entity.id} passes KYC at tier ${entity.kycTier}`);
}
