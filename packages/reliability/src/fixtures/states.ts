/**
 * @fileoverview Seed per-role reliability states for the read endpoints.
 * Lane D owns this file. The math lane replaces these placeholder
 * posteriors with real Beta states through its own fixture or seed file.
 */

import type {ReliabilityState} from '../types';

/** Placeholder posteriors. Counts match the transaction fixtures. */
export const FIXTURE_STATES: ReliabilityState[] = [
  {
    entityId: 'entity-new', category: 'fulfillment', role: 'buyer',
    alpha: 1, beta: 1, eventCount: 0,
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
  {
    entityId: 'entity-new', category: 'payment', role: 'seller',
    alpha: 1, beta: 1, eventCount: 0,
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
  {
    entityId: 'entity-established', category: 'fulfillment', role: 'seller',
    alpha: 48, beta: 2, eventCount: 50,
    updatedAt: '2026-10-05T00:00:00.000Z',
  },
  {
    entityId: 'entity-established', category: 'payment', role: 'buyer',
    alpha: 30, beta: 1, eventCount: 31,
    updatedAt: '2026-10-05T00:00:00.000Z',
  },
  {
    entityId: 'entity-farm-a', category: 'delivery', role: 'seller',
    alpha: 13, beta: 1, eventCount: 12,
    updatedAt: '2026-10-05T00:00:00.000Z',
  },
  {
    entityId: 'entity-farm-b', category: 'delivery', role: 'buyer',
    alpha: 13, beta: 1, eventCount: 12,
    updatedAt: '2026-10-05T00:00:00.000Z',
  },
];
