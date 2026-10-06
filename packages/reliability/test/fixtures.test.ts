/**
 * @fileoverview Pins the seed fixtures the UI lane builds against.
 * Lane D owns the fixtures. Other lanes add their own fixture files.
 */

import {describe, expect, test} from 'bun:test';
import {
  FIXTURE_ENTITIES,
  FIXTURE_LISTINGS,
  FIXTURE_OUTCOMES,
  FIXTURE_STATES,
  FIXTURE_TRANSACTIONS,
  OUTCOME_BUYER_FAULT,
  OUTCOME_NO_FAULT,
  OUTCOME_SELLER_FAULT,
} from '../src/fixtures/index';

describe('reliability fixtures', () => {
  test('covers a new entity, an established entity, and a farming pair', () => {
    const ids = FIXTURE_ENTITIES.map((entity) => entity.id);
    expect(ids).toEqual([
      'entity-new',
      'entity-established',
      'entity-farm-a',
      'entity-farm-b',
    ]);
    const states = new Map(
      FIXTURE_STATES.map((state) => [state.entityId, state.eventCount]),
    );
    expect(states.get('entity-new')).toBe(0);
    expect(states.get('entity-established')).toBeGreaterThan(0);
  });

  test('covers service, invoice, and farm goods transactions', () => {
    const types = new Set(
      FIXTURE_TRANSACTIONS.map((transaction) => transaction.type),
    );
    expect(types).toEqual(new Set(['service', 'invoice', 'goods']));
    const farm = FIXTURE_TRANSACTIONS.filter(
      (transaction) => transaction.id.startsWith('tx-farm-'),
    );
    expect(farm).toHaveLength(12);
    expect(FIXTURE_OUTCOMES).toHaveLength(FIXTURE_TRANSACTIONS.length);
    expect(FIXTURE_OUTCOMES.every((outcome) => outcome.fault === undefined))
      .toBe(true);
    expect(FIXTURE_OUTCOMES.some((outcome) => outcome.state === 'failed'))
      .toBe(false);
    expect(OUTCOME_SELLER_FAULT.fault).toBe('seller');
    expect(OUTCOME_BUYER_FAULT.fault).toBe('buyer');
    expect(OUTCOME_NO_FAULT.fault).toBe('none');
  });

  test('covers listings with buyer and seller minimums', () => {
    expect(FIXTURE_LISTINGS).toHaveLength(2);
    expect(
      FIXTURE_LISTINGS.some(
        (listing) => listing.minSellerReliability !== undefined,
      ),
    ).toBe(true);
    expect(
      FIXTURE_LISTINGS.some(
        (listing) => listing.minBuyerReliability !== undefined,
      ),
    ).toBe(true);
  });
});
