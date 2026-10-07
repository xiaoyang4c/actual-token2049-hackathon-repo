/**
 * @fileoverview Lifecycle HTTP routes. The service owns views and persistence.
 * Marketplace transactions stay paper. The escrow adapter retains its
 * explicit preprod network gates.
 */

import type {AgentStore} from '../../packages/db/src/index';
import type {EscrowPort} from '../../packages/reliability/src/escrow-port';
import {LifecycleCommandError, LifecyclePendingError} from '../../packages/reliability/src/lifecycle/commands';
import {LifecycleError} from '../../packages/reliability/src/lifecycle';
import {json} from '../lib/http';
import {
  optionalText, readBody, runAction, termsField, textField, transactionType,
} from './lifecycle-request';
import {LifecycleService} from './lifecycle-service';
import type {ReliabilityPolicies} from './policies';
import type {ReliabilityRoute} from './route';

function requireStore(store: AgentStore|undefined): AgentStore {
  if (!store) throw new LifecycleError('the control store is required');
  return store;
}

function fail(error: unknown): Response {
  if (error instanceof LifecyclePendingError) return json({pending: true, error: error.message}, 202);
  if (error instanceof LifecycleCommandError) return json({error: error.message}, 409);
  if (error instanceof LifecycleError) {
    const status = error.message.startsWith('unknown transaction') ? 404 : 400;
    return json({error: error.message}, status);
  }
  throw error;
}

/** Dependencies shared by the lifecycle handlers in one route table. */
export interface LifecycleRouteOptions {
  policies?: ReliabilityPolicies;
  clock?: () => string;
  escrowForStore?: (store: AgentStore) => EscrowPort;
}

/** Creates handlers with isolated store caches and explicit policy dependencies. */
export function createLaneARoutes(
  options: LifecycleRouteOptions = {},
): ReliabilityRoute[] {
  const services = new WeakMap<AgentStore, LifecycleService>();
  function serviceFor(store: AgentStore): LifecycleService {
    const existing = services.get(store);
    if (existing) return existing;
    const created = new LifecycleService(store, {
      policies: options.policies,
      clock: options.clock ?? (() => new Date().toISOString()),
      escrow: options.escrowForStore?.(store),
    });
    services.set(store, created);
    return created;
  }

  /** Lane A demo routes. Plumbing routes stay in their own file. */
  return [
    {
      method: 'POST',
      path: '/reliability/lifecycle/open',
      handler: async (request, url, store) => {
        try {
          const records = requireStore(store);
          const body = await readBody(request);
          const at = textField(body, 'at');
          const buyerId = textField(body, 'buyerId');
          const sellerId = textField(body, 'sellerId');
          const service = serviceFor(records);
          const lifecycle = service.lifecycle;
          service.ensureParty(buyerId, at);
          service.ensureParty(sellerId, at);
          const value = body.value;
          if (value !== undefined && typeof value !== 'number') {
            throw new LifecycleError('value must be a non-negative number');
          }
          const transaction = lifecycle.open({
            id: textField(body, 'id'),
            type: transactionType(textField(body, 'type')),
            buyerId,
            sellerId,
            terms: termsField(body.terms),
            value,
            termsHash: optionalText(body, 'termsHash'),
            contractEnds: optionalText(body, 'contractEnds'),
            at,
          });
          return json({
            mode: 'paper',
            transaction,
            stage: lifecycle.currentStage(transaction.id),
            outcome: lifecycle.outcomeFor(transaction.id, {now: at}),
          });
        } catch (error) {
          return fail(error);
        }
      },
    },
    {
      method: 'POST',
      path: '/reliability/lifecycle/terms',
      handler: async (request, url, store) => {
        try {
          const lifecycle = serviceFor(requireStore(store)).lifecycle;
          const body = await readBody(request);
          const transactionId = textField(body, 'transactionId');
          const at = textField(body, 'at');
          const version = lifecycle.amendTerms(
            transactionId, termsField(body.terms), textField(body, 'reason'), at,
          );
          return json({
            mode: 'paper',
            version,
            transaction: lifecycle.getTransaction(transactionId),
          });
        } catch (error) {
          return fail(error);
        }
      },
    },
    {
      method: 'POST',
      path: '/reliability/lifecycle/transition',
      handler: async (request, url, store) => {
        try {
          const records = requireStore(store);
          const body = await readBody(request);
          const action = textField(body, 'action');
          const transactionId = textField(body, 'transactionId');
          const at = textField(body, 'at');
          const service = serviceFor(records);
          const lifecycle = service.lifecycle;
          const transition = await runAction(lifecycle, action, transactionId, at, body);
          return json({
            transition,
            ...service.view(transactionId, at),
          });
        } catch (error) {
          return fail(error);
        }
      },
    },
    {
      method: 'GET',
      path: '/reliability/lifecycle',
      handler: (request, url, store) => {
        try {
          const records = requireStore(store);
          const transactionId = url.searchParams.get('transactionId');
          if (!transactionId) {
            return json({error: 'transactionId is required'}, 400);
          }
          const now = url.searchParams.get('now') ??
            (options.clock?.() ?? new Date().toISOString());
          return json(serviceFor(records).view(transactionId, now));
        } catch (error) {
          return fail(error);
        }
      },
    },
  ];
}

/** Default lane routes. Existing registry imports remain available. */
export const laneARoutes: ReliabilityRoute[] = createLaneARoutes();
