/**
 * @fileoverview KYC provider seam for lane A (agents).
 * TODO(lane-A): replace MockKycProvider with a real provider behind this
 * interface. The mock is deterministic and stores nothing. It performs no
 * real identity check.
 */

import type {Entity, KycStatus, KycTier} from './types';

export const MOCK_KYC_PROVIDER_NAME = 'mock-kyc-provider';

/** KYC result for one entity. */
export interface KycResult {
  status: KycStatus;
  tier: KycTier;
  provider: string;
  checkedAt: string;
}

/**
 * KYC seam. Lane 5 owns the real provider. The mock returns a fixed
 * table with an unverified fallback.
 */
export interface KycProvider {
  readonly name: string;
  fetchStatus(entity: Entity, now: string): KycResult;
}

/** Deterministic placeholder. Performs no identity check. */
export class MockKycProvider implements KycProvider {
  readonly name = MOCK_KYC_PROVIDER_NAME;
  private readonly table: ReadonlyMap<string, KycResult>;

  constructor(overrides: ReadonlyMap<string, KycResult> = new Map()) {
    this.table = overrides;
  }

  fetchStatus(entity: Entity, now: string): KycResult {
    const known = this.table.get(entity.id);
    if (known) return {...known, provider: this.name, checkedAt: now};
    return {
      status: 'unverified', tier: 'none', provider: this.name, checkedAt: now,
    };
  }
}
