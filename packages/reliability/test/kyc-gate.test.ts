/**
 * @fileoverview KYC restrictions for marketplace actions.
 */

import {describe, expect, test} from 'bun:test';
import {checkKyc} from '../src/kyc-gate';
import {KYC_TIER_RULES} from '../src/kyc-rules';
import type {Entity} from '../src/types';

const NOW = '2026-10-07T00:00:00.000Z';

function entity(overrides: Partial<Entity> = {}): Entity {
  return {
    id: 'e1', displayName: 'E1', wallets: [], roles: ['buyer', 'seller'],
    kycStatus: 'verified', kycTier: 'basic', createdAt: NOW, ...overrides,
  };
}

function profile(verifiedAt: string, reRegistrationOf?: string) {
  return {
    entityId: 'e1', subjectKind: 'person' as const, submittedChecks: [],
    rulesVersion: KYC_TIER_RULES.version, verifiedAt, updatedAt: verifiedAt,
    ...(reRegistrationOf ? {reRegistrationOf} : {}),
  };
}

describe('checkKyc', () => {
  test('passes a verified entity at the minimum tier', () => {
    const result = checkKyc({entityId: 'e1', entity: entity()}, NOW);
    expect(result).toMatchObject({passed: true, tier: 'basic', requiredTier: 'basic'});
    expect(result.code).toBeUndefined();
  });

  test('names the reason for each failing status', () => {
    expect(checkKyc({entityId: 'e1', entity: undefined}, NOW).code).toBe('kyc_unknown_entity');
    expect(checkKyc({entityId: 'e1', entity: entity({kycStatus: 'rejected'})}, NOW).code).toBe('kyc_rejected');
    expect(checkKyc({entityId: 'e1', entity: entity({kycStatus: 'pending'})}, NOW).code).toBe('kyc_pending');
    expect(checkKyc({entityId: 'e1', entity: entity({kycStatus: 'unverified', kycTier: 'none'})}, NOW).code)
      .toBe('kyc_not_verified');
  });

  test('raises, but never lowers, the required tier', () => {
    const basic = {entityId: 'e1', entity: entity()};
    expect(checkKyc(basic, NOW, {requiredTier: 'enhanced'})).toMatchObject({
      passed: false, code: 'kyc_tier_too_low', requiredTier: 'enhanced',
    });
    expect(checkKyc(basic, NOW, {requiredTier: 'none'}).requiredTier).toBe('basic');
  });

  test('expires a verification after the configured TTL', () => {
    const verifiedAt = '2025-10-06T00:00:00.000Z';
    const subject = {entityId: 'e1', entity: entity(), profile: profile(verifiedAt)};
    expect(checkKyc(subject, '2026-10-05T23:59:59.000Z').passed).toBe(true);
    expect(checkKyc(subject, '2026-10-06T00:00:00.000Z').code).toBe('kyc_expired');
  });

  test('refuses a re-registration of a rejected identity', () => {
    const subject = {
      entityId: 'e1', entity: entity(), profile: profile(NOW, 'old'),
      reRegisteredFrom: entity({id: 'old', kycStatus: 'rejected'}),
    };
    expect(checkKyc(subject, NOW).code).toBe('kyc_reregistration_of_rejected');
    expect(checkKyc({...subject, reRegisteredFrom: entity({id: 'old'})}, NOW).passed).toBe(true);
  });
});
