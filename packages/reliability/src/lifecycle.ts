/**
 * @fileoverview Generic transaction lifecycle seam for lane A (agents).
 *
 * Contract: every sale of goods or services moves through lifecycle
 * stages: offer_accepted, escrow_funded, delivery_confirmed,
 * payment_settled, with dispute_opened, dispute_resolved, refunded, and
 * cancelled as needed. Each verified stage transition carries evidence.
 * Terminal stages emit a verified Outcome: payment_settled emits
 * successful with no fault, refunded emits cancelled with fault none,
 * and dispute_opened emits disputed with a named resolver and deadline.
 * This stub does not assign buyer or seller fault. Lane A sets
 * Outcome.fault on a failed outcome.
 *
 * TODO(lane-A): implement the real escrow state machine here on top of
 * the existing Masumi escrow and refund code in
 * services/cardano-agents-ts (simulated by default, no network
 * broadcast). Wire stage transitions to escrow funding, delivery or
 * fulfillment confirmation, settlement, dispute handling, and refund.
 * Keep the interface shape. This stub only pins it with an in-memory
 * transition table.
 */

import type {Outcome} from './types';

export const STUB_LIFECYCLE_VERSION = 'lifecycle-stub-v0';

/** One stage of the generic sales lifecycle. */
export type LifecycleStage =
  'offer_accepted'|'escrow_funded'|'delivery_confirmed'|'payment_settled'|
  'dispute_opened'|'dispute_resolved'|'refunded'|'cancelled';

/** One verified stage transition with its evidence. */
export interface LifecycleTransition {
  transactionId: string;
  from: LifecycleStage|undefined;
  to: LifecycleStage;
  evidence: {[key: string]: string|number|boolean|null};
  at: string;
}

/** Allowed next stages. Lane A owns the real transition rules. */
const NEXT_STAGES: Record<LifecycleStage, LifecycleStage[]> = {
  offer_accepted: ['escrow_funded', 'cancelled'],
  escrow_funded: ['delivery_confirmed', 'dispute_opened', 'refunded'],
  delivery_confirmed: ['payment_settled', 'dispute_opened'],
  payment_settled: ['dispute_opened'],
  dispute_opened: ['dispute_resolved', 'refunded'],
  dispute_resolved: ['payment_settled', 'refunded'],
  refunded: [],
  cancelled: [],
};

/**
 * Transaction lifecycle seam. Lane A owns the real state machine.
 * The stub records transitions and derives outcomes from them.
 */
export interface TransactionLifecycle {
  readonly version: string;
  advance(transition: LifecycleTransition): LifecycleTransition;
  currentStage(transactionId: string): LifecycleStage|undefined;
  outcomeFor(
    transactionId: string, options: {
      resolver?: string;
      resolveBy?: string;
      now: string;
    },
  ): Outcome;
}

/** Deterministic placeholder. Holds no funds and calls no chain. */
export class StubTransactionLifecycle implements TransactionLifecycle {
  readonly version = STUB_LIFECYCLE_VERSION;
  private readonly stages = new Map<string, LifecycleTransition[]>();

  advance(transition: LifecycleTransition): LifecycleTransition {
    const history = this.stages.get(transition.transactionId) ?? [];
    const current = history.length === 0 ?
      undefined :
      history[history.length - 1]?.to;
    if (current === undefined) {
      if (transition.to !== 'offer_accepted') {
        throw new Error('a transaction starts at offer_accepted');
      }
    } else if (!NEXT_STAGES[current].includes(transition.to)) {
      throw new Error(`cannot move from ${current} to ${transition.to}`);
    }
    if (transition.from !== current) {
      throw new Error('transition source does not match the current stage');
    }
    history.push(transition);
    this.stages.set(transition.transactionId, history);
    return transition;
  }

  currentStage(transactionId: string): LifecycleStage|undefined {
    const history = this.stages.get(transactionId);
    if (!history || history.length === 0) return undefined;
    return history[history.length - 1]?.to;
  }

  outcomeFor(
    transactionId: string, options: {
      resolver?: string;
      resolveBy?: string;
      now: string;
    },
  ): Outcome {
    const stage = this.currentStage(transactionId);
    const history = this.stages.get(transactionId) ?? [];
    const evidence: {[key: string]: string|number|boolean|null} = {
      stage: stage ?? 'none',
      transitions: history.length,
      producer: this.version,
    };
    if (stage === 'payment_settled') {
      return {
        transactionId, state: 'successful', evidence,
        verificationMethod: 'lifecycle',
        verificationConfidence: 0.5, decidedAt: options.now,
      };
    }
    if (stage === 'dispute_opened') {
      if (!options.resolver || !options.resolveBy) {
        throw new Error('a dispute names a resolver and a deadline');
      }
      return {
        transactionId, state: 'disputed', evidence,
        verificationMethod: 'lifecycle',
        verificationConfidence: 0.5, resolver: options.resolver,
        resolveBy: options.resolveBy, decidedAt: options.now,
      };
    }
    if (stage === 'refunded') {
      return {
        transactionId, state: 'cancelled', fault: 'none', evidence,
        verificationMethod: 'lifecycle',
        verificationConfidence: 0.5, decidedAt: options.now,
      };
    }
    return {
      transactionId, state: 'pending', evidence,
      verificationMethod: 'lifecycle', decidedAt: options.now,
    };
  }
}
