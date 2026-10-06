/**
 * @fileoverview Seed entities for the reliability marketplace reads.
 * Lane D owns this file and the other files under fixtures/. Other
 * lanes add new fixture files instead of editing these.
 */

import type {Entity} from '../types';

/** Fresh buyer and seller with no history and pending KYC. */
export const ENTITY_NEW: Entity = {
  id: 'entity-new',
  displayName: 'New Trader',
  wallets: ['addr_test1newtraderwallet00000000000000000000000001'],
  kycStatus: 'pending',
  kycTier: 'none',
  roles: ['buyer', 'seller'],
  createdAt: '2026-10-01T00:00:00.000Z',
};

/** Established provider and buyer with verified KYC. */
export const ENTITY_ESTABLISHED: Entity = {
  id: 'entity-established',
  displayName: 'Meridian Services',
  wallets: [
    'addr_test1meridianservices00000000000000000000000001',
    'addr_test1meridianservices00000000000000000000000002',
  ],
  kycStatus: 'verified',
  kycTier: 'enhanced',
  roles: ['buyer', 'seller'],
  createdAt: '2026-06-01T00:00:00.000Z',
};

/** First half of the repeat-transaction farming pair. */
export const ENTITY_FARM_A: Entity = {
  id: 'entity-farm-a',
  displayName: 'Farm Counterparty A',
  wallets: ['addr_test1farmcounterparty000000000000000000000000a'],
  kycStatus: 'verified',
  kycTier: 'basic',
  roles: ['buyer', 'seller'],
  createdAt: '2026-08-01T00:00:00.000Z',
};

/** Second half of the repeat-transaction farming pair. */
export const ENTITY_FARM_B: Entity = {
  id: 'entity-farm-b',
  displayName: 'Farm Counterparty B',
  wallets: ['addr_test1farmcounterparty000000000000000000000000b'],
  kycStatus: 'verified',
  kycTier: 'basic',
  roles: ['buyer', 'seller'],
  createdAt: '2026-08-01T00:00:00.000Z',
};

/** Seed entities in a stable order for the read endpoints. */
export const FIXTURE_ENTITIES: Entity[] = [
  ENTITY_NEW,
  ENTITY_ESTABLISHED,
  ENTITY_FARM_A,
  ENTITY_FARM_B,
];
