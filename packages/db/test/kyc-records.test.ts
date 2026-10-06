/**
 * @fileoverview Round trips for KYC profile and status rows.
 */

import {describe, expect, test} from 'bun:test';
import {AgentStore} from '../src/index';
import type {KycProfile, KycStatusRecord} from '../../reliability/src/kyc';
import type {Entity} from '../../reliability/src/types';

const T0 = '2026-10-06T00:00:00.000Z';
const T1 = '2026-10-06T00:01:00.000Z';
const T2 = '2026-10-06T00:02:00.000Z';

function entity(id: string, wallet: string): Entity {
  return {
    id,
    displayName: id,
    wallets: [wallet],
    kycStatus: 'unverified',
    kycTier: 'none',
    roles: ['buyer', 'seller'],
    createdAt: T0,
  };
}

function profile(entityId: string, extra: Partial<KycProfile> = {}): KycProfile {
  return {
    entityId,
    subjectKind: 'person',
    submittedChecks: [],
    rulesVersion: 'kyc-tier-rules-v0-undecided',
    updatedAt: T0,
    ...extra,
  };
}

describe('AgentStore KYC rows', () => {
  test('stores profiles, status history, and wallet owners', () => {
    const store = AgentStore.open();
    try {
      store.insertEntity(entity('p1', 'wallet-p1'));
      store.insertEntity(entity('b1', 'wallet-b1'));
      const saved = store.saveKycProfile(profile('p1', {documentId: 'DOC-9'}));
      expect(saved.documentId).toBe('DOC-9');
      expect(store.getKycProfile('p1')?.subjectKind).toBe('person');

      store.saveKycProfile(profile('b1', {
        subjectKind: 'business',
        registrationNumber: 'REG-1',
        beneficialOwnerDocumentId: 'DOC-9',
        submittedChecks: ['beneficial_owner', 'registration_number'],
        reRegistrationOf: 'p1',
        reRegistrationSignal: 'document',
        reRegistrationValue: 'DOC-9',
        verifiedAt: T1,
        updatedAt: T1,
      }));
      expect(store.listKycProfilesByDocument('DOC-9').map((row) => row.entityId))
        .toEqual(['b1', 'p1']);
      expect(store.listKycProfilesByRegistration('REG-1')[0]?.entityId).toBe('b1');
      expect(store.getWalletEntityId('wallet-p1')).toBe('p1');
      expect(store.getWalletEntityId('missing')).toBeUndefined();

      const updated = store.updateEntityKyc('p1', 'verified', 'basic');
      expect(updated.kycStatus).toBe('verified');
      expect(updated.kycTier).toBe('basic');
      expect(updated.wallets).toEqual(['wallet-p1']);
      expect(updated.roles).toEqual(['buyer', 'seller']);
      expect(updated.displayName).toBe('p1');

      const later: KycStatusRecord = {
        id: 'p1:kyc:0002',
        entityId: 'p1',
        status: 'verified',
        tier: 'basic',
        badge: 'verified',
        how: 'vendor_approved',
        at: T2,
        provider: 'mock-kyc-provider',
        rulesVersion: 'kyc-tier-rules-v0-undecided',
        detail: {subjectKind: 'person'},
      };
      const earlier: KycStatusRecord = {
        ...later,
        id: 'p1:kyc:0001',
        status: 'pending',
        tier: 'none',
        badge: 'pending',
        how: 'check_submitted',
        at: T1,
      };
      store.insertKycStatusRecord(later);
      store.insertKycStatusRecord(earlier);
      expect(store.listKycStatusRecords('p1').map((row) => row.id)).toEqual([
        'p1:kyc:0001', 'p1:kyc:0002',
      ]);
      expect(store.listKycStatusRecords('p1')[1]?.detail).toEqual({
        subjectKind: 'person',
      });

      expect(() => store.updateEntityKyc('missing', 'pending', 'none')).toThrow(
        'entity was not stored',
      );
      expect(() => store.saveKycProfile(profile('b1', {
        reRegistrationOf: 'b1',
        reRegistrationSignal: 'document',
        reRegistrationValue: 'DOC-9',
      }))).toThrow();
      expect(() => store.saveKycProfile(profile('p1', {
        reRegistrationOf: 'b1',
      }))).toThrow();
    } finally {
      store.close();
    }
  });
});
