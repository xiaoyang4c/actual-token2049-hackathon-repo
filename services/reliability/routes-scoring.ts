/**
 * @fileoverview Score explanation route for the math lane. Read-only.
 * Each entry names the event, its recorded weight inputs, and the score
 * before and after the event.
 */

import type {AgentStore} from '../../packages/db/src/index';
import type {EntityRole, ReliabilityCategory} from '../../packages/reliability/src/types';
import {json} from '../lib/http';
import {DEFAULT_RELIABILITY_POLICIES, type ReliabilityPolicies} from './policies';
import type {ReliabilityRoute} from './route';
import {ScoreLedger} from './score-ledger';

const CATEGORIES: readonly ReliabilityCategory[] = [
  'compute', 'payment', 'fulfillment', 'delivery', 'sla', 'dispute',
];

/** Creates the explanation route with the given policies. */
export function createScoringRoutes(
  policies: ReliabilityPolicies = DEFAULT_RELIABILITY_POLICIES,
  clock: () => string = () => new Date().toISOString(),
): ReliabilityRoute[] {
  const ledgers = new WeakMap<AgentStore, ScoreLedger>();
  return [{
    method: 'GET',
    path: '/reliability/scores/explain',
    handler: (request, url, store) => {
      if (!store) return json({error: 'the control store is required'}, 400);
      const entityId = url.searchParams.get('entityId');
      const category = url.searchParams.get('category') as ReliabilityCategory|null;
      const role = url.searchParams.get('role') as EntityRole|null;
      if (!entityId) return json({error: 'entityId is required'}, 400);
      if (!category || !CATEGORIES.includes(category)) return json({error: 'category is required'}, 400);
      if (role !== 'buyer' && role !== 'seller') return json({error: 'role must be buyer or seller'}, 400);
      let ledger = ledgers.get(store);
      if (!ledger) {
        ledger = new ScoreLedger(store, policies);
        ledgers.set(store, ledger);
      }
      return json(ledger.explain({entityId, category, role}, clock()));
    },
  }];
}

export const scoringRoutes: ReliabilityRoute[] = createScoringRoutes();
