/**
 * @fileoverview Pins the KYC provider seam shape for lane 5.
 */

import {describe, expect, test} from 'bun:test';
import {MockKycProvider} from '../src/kyc';
import type {Entity} from '../src/types';

const NOW = '2026-10-06T00:00:00.000Z';

const ENTITY: Entity = {
  id: 'entity-established',
  displayName: 'Meridian Services',
  wallets: ['addr_test1meridian00000000000000000000000001'],
  kycStatus: 'verified',
  kycTier: 'enhanced',
  roles: ['buyer', 'seller'],
  createdAt: '2026-06-01T00:00:00.000Z',
};

describe('MockKycProvider', () => {
  test('returns the mapped status for a known entity', () => {
    const provider = new MockKycProvider(new Map([[
      ENTITY.id,
      {
        status: 'verified', tier: 'enhanced', provider: 'mock',
        checkedAt: NOW,
      },
    ]]));
    const result = provider.fetchStatus(ENTITY, NOW);
    expect(result.status).toBe('verified');
    expect(result.tier).toBe('enhanced');
    expect(result.provider).toBe(provider.name);
  });

  test('falls back to unverified for an unknown entity', () => {
    const provider = new MockKycProvider();
    const result = provider.fetchStatus({...ENTITY, id: 'entity-unknown'}, NOW);
    expect(result.status).toBe('unverified');
    expect(result.tier).toBe('none');
  });
});
