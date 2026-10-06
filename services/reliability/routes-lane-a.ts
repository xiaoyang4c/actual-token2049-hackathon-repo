/**
 * @fileoverview Demo lifecycle routes for the UI lane.
 * These routes drive one paper transaction from offer to settlement.
 * They do not edit policy and they do not send a live order.
 */

import {AgentStore} from '../../packages/db/src/index';
import {
  EscrowTransactionLifecycle,
  LifecycleError,
  flowLifecycleOutcome,
  type LifecycleTransition,
} from '../../packages/reliability/src/index';
import {StubFeeTermsPolicy} from '../../packages/reliability/src/fees-policy';
import {StubPairDecay} from '../../packages/reliability/src/pair-decay';
import {StubScoringPolicy} from '../../packages/reliability/src/scoring';
import type {
  JsonValue, TransactionType,
} from '../../packages/reliability/src/types';
import {json} from '../lib/http';
import {createSimulatedMasumiEscrow} from './masumi-escrow';
import type {ReliabilityRoute} from './routes-plumbing';

const scoring = new StubScoringPolicy();
const fees = new StubFeeTermsPolicy();
const decay = new StubPairDecay();

interface Demo {
  store: AgentStore;
  lifecycle: EscrowTransactionLifecycle;
}

let demo: Demo|undefined;

function demoLifecycle(): Demo {
  if (!demo) {
    const store = AgentStore.open(':memory:');
    demo = {
      store,
      lifecycle: new EscrowTransactionLifecycle({
        store,
        escrow: createSimulatedMasumiEscrow(),
      }),
    };
  }
  return demo;
}

function fail(error: unknown): Response {
  if (error instanceof LifecycleError) {
    const status = error.message.startsWith('unknown transaction') ? 404 : 400;
    return json({error: error.message}, status);
  }
  throw error;
}

function isRecord(value: unknown): value is {[key: string]: unknown} {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textField(body: {[key: string]: unknown}, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LifecycleError(`${key} must be a non-empty string`);
  }
  return value;
}

function optionalText(
  body: {[key: string]: unknown}, key: string,
): string|undefined {
  if (body[key] === undefined) return undefined;
  return textField(body, key);
}

function termsField(value: unknown): {[key: string]: JsonValue} {
  const parsed = jsonValue(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LifecycleError('terms must be an object');
  }
  return parsed;
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new LifecycleError('terms must be finite');
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => jsonValue(item));
  if (isRecord(value)) {
    const record: {[key: string]: JsonValue} = {};
    for (const [key, item] of Object.entries(value)) record[key] = jsonValue(item);
    return record;
  }
  throw new LifecycleError('terms must be JSON values');
}

function evidenceField(
  value: unknown,
): LifecycleTransition['evidence'] {
  if (!isRecord(value)) throw new LifecycleError('evidence must be an object');
  const evidence: LifecycleTransition['evidence'] = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') {
      evidence[key] = item;
      continue;
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      evidence[key] = item;
      continue;
    }
    throw new LifecycleError('evidence values must be scalars');
  }
  return evidence;
}

function transactionType(value: string): TransactionType {
  if (value === 'goods' || value === 'service' || value === 'invoice') return value;
  throw new LifecycleError('unknown transaction type');
}

function ensureParty(store: AgentStore, id: string, at: string): void {
  if (store.getEntity(id)) return;
  store.insertEntity({
    id,
    displayName: id,
    wallets: [],
    kycStatus: 'unverified',
    kycTier: 'none',
    roles: ['buyer', 'seller'],
    createdAt: at,
  });
}

function view(transactionId: string, now: string): {
  mode: 'paper';
  transaction: ReturnType<EscrowTransactionLifecycle['getTransaction']>;
  stage: ReturnType<EscrowTransactionLifecycle['currentStage']>;
  transitions: readonly LifecycleTransition[];
  outcome: ReturnType<EscrowTransactionLifecycle['outcomeFor']>;
  events: ReturnType<typeof flowLifecycleOutcome>['events'];
  termsDecisions: ReturnType<typeof flowLifecycleOutcome>['decisions'];
} {
  const {store, lifecycle} = demoLifecycle();
  if (!lifecycle.hasTransaction(transactionId)) {
    throw new LifecycleError(`unknown transaction ${transactionId}`);
  }
  const transaction = lifecycle.getTransaction(transactionId);
  const outcome = lifecycle.outcomeFor(transactionId, {now});
  const entities = new Map(
    store.listEntities().map((entity) => [entity.id, entity]),
  );
  const flowed = flowLifecycleOutcome(
    transaction, outcome, scoring, decay, fees, now, entities,
  );
  const existing = store.listReliabilityEventsForTransaction(transactionId);
  let inserted = false;
  for (const event of flowed.events) {
    if (!existing.some((item) => item.id === event.id)) {
      store.insertReliabilityEvent(event);
      inserted = true;
    }
  }
  if (inserted) {
    for (const state of flowed.states) store.saveReliabilityState(state);
    for (const decision of flowed.decisions) store.insertTermsDecision(decision);
  }
  return {
    mode: 'paper',
    transaction,
    stage: lifecycle.currentStage(transactionId),
    transitions: lifecycle.listTransitions(transactionId),
    outcome,
    events: flowed.events,
    termsDecisions: flowed.decisions,
  };
}

async function readBody(request: Request): Promise<{[key: string]: unknown}> {
  try {
    const value: unknown = await request.json();
    if (!isRecord(value)) throw new LifecycleError('body must be an object');
    return value;
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    throw new LifecycleError('body must be JSON');
  }
}

/** Lane A demo routes. Plumbing routes stay in their own file. */
export const laneARoutes: ReliabilityRoute[] = [
  {
    method: 'POST',
    path: '/reliability/lifecycle/open',
    handler: async (request) => {
      try {
        const body = await readBody(request);
        const at = textField(body, 'at');
        const buyerId = textField(body, 'buyerId');
        const sellerId = textField(body, 'sellerId');
        const {store, lifecycle} = demoLifecycle();
        ensureParty(store, buyerId, at);
        ensureParty(store, sellerId, at);
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
    handler: async (request) => {
      try {
        const body = await readBody(request);
        const transactionId = textField(body, 'transactionId');
        const at = textField(body, 'at');
        const version = demoLifecycle().lifecycle.amendTerms(
          transactionId, termsField(body.terms), textField(body, 'reason'), at,
        );
        return json({
          mode: 'paper',
          version,
          transaction: demoLifecycle().lifecycle.getTransaction(transactionId),
        });
      } catch (error) {
        return fail(error);
      }
    },
  },
  {
    method: 'POST',
    path: '/reliability/lifecycle/transition',
    handler: async (request) => {
      try {
        const body = await readBody(request);
        const action = textField(body, 'action');
        const transactionId = textField(body, 'transactionId');
        const at = textField(body, 'at');
        const lifecycle = demoLifecycle().lifecycle;
        const transition = await runAction(lifecycle, action, transactionId, at, body);
        return json({
          transition,
          ...view(transactionId, at),
        });
      } catch (error) {
        return fail(error);
      }
    },
  },
  {
    method: 'GET',
    path: '/reliability/lifecycle',
    handler: (request, url) => {
      try {
        const transactionId = url.searchParams.get('transactionId');
        if (!transactionId) {
          return json({error: 'transactionId is required'}, 400);
        }
        const now = url.searchParams.get('now') ??
          latestAt(transactionId);
        return json(view(transactionId, now));
      } catch (error) {
        return fail(error);
      }
    },
  },
];

function latestAt(transactionId: string): string {
  const lifecycle = demoLifecycle().lifecycle;
  const transitions = lifecycle.listTransitions(transactionId);
  const last = transitions[transitions.length - 1];
  if (!last) throw new LifecycleError(`unknown transaction ${transactionId}`);
  return last.at;
}

async function runAction(
  lifecycle: EscrowTransactionLifecycle,
  action: string,
  transactionId: string,
  at: string,
  body: {[key: string]: unknown},
): Promise<LifecycleTransition> {
  if (action === 'fund') {
    const amount = body.amountLovelace;
    if (typeof amount !== 'number') {
      throw new LifecycleError('amountLovelace must be a positive integer');
    }
    return lifecycle.fund({
      transactionId,
      amountLovelace: amount,
      sellerReturnAddress: textField(body, 'sellerReturnAddress'),
      disputeWindowEnds: textField(body, 'disputeWindowEnds'),
      at,
    });
  }
  if (action === 'deliver') {
    return lifecycle.confirmDelivery({
      transactionId,
      at,
      evidence: evidenceField(body.evidence),
    });
  }
  if (action === 'release') {
    return lifecycle.release({
      transactionId,
      at,
      evidence: body.evidence === undefined ? undefined : evidenceField(body.evidence),
    });
  }
  if (action === 'refund') {
    return lifecycle.refund({
      transactionId,
      at,
      reason: optionalText(body, 'reason'),
    });
  }
  if (action === 'cancel') {
    return lifecycle.cancel({
      transactionId, at, reason: textField(body, 'reason'),
    });
  }
  if (action === 'dispute') {
    return lifecycle.openDispute({
      transactionId,
      at,
      resolver: textField(body, 'resolver'),
      resolveBy: textField(body, 'resolveBy'),
      reason: optionalText(body, 'reason'),
    });
  }
  if (action === 'resolve') {
    const decision = textField(body, 'decision');
    if (decision !== 'uphold_seller' && decision !== 'uphold_buyer') {
      throw new LifecycleError(
        'a dispute resolution must uphold the seller or the buyer',
      );
    }
    return lifecycle.resolveDispute({
      transactionId,
      at,
      resolver: textField(body, 'resolver'),
      decision,
    });
  }
  throw new LifecycleError('unknown lifecycle action');
}
