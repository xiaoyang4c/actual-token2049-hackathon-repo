/**
 * @fileoverview The milestone state machine as an explicit transition table.
 * A pair that is not in the table is illegal. Every milestone runs this
 * machine. A milestone owns one escrow, or core and holdback escrows that
 * move in lockstep.
 */

import {ContractError} from './errors';
import type {MilestoneEvent, MilestoneState} from './types';

type Table = {
  readonly [S in MilestoneState]: Partial<Record<MilestoneEvent, MilestoneState>>;
};

/** Masumi admins can settle any disputed escrow after externalDisputeUnlockTime. */
const ADMIN_EXIT = {admin_settlement_confirmed: 'settled'} as const;

/** A funded milestone can end by mutual termination until money moves. */
const MUTUAL_EXIT = {mutual_termination_confirmed: 'refunded'} as const;

export const TRANSITIONS: Table = {
  draft: {submit_for_acceptance: 'pending_acceptance', cancel: 'cancelled'},
  pending_acceptance: {all_parties_signed: 'awaiting_funding', cancel: 'cancelled'},
  awaiting_funding: {
    funding_confirmed: 'funded',
    funding_deadline_passed: 'expired',
    cancel: 'cancelled',
  },
  funded: {
    delivery_confirmed: 'delivered',
    delivery_deadline_refund_confirmed: 'expired',
    refund_confirmed: 'refunded',
    ...MUTUAL_EXIT,
  },
  delivered: {inspection_opened: 'in_inspection'},
  in_inspection: {
    buyer_accepted: 'accepted_pending_release',
    inspection_window_expired: 'auto_released',
    dispute_confirmed: 'disputed',
    refund_confirmed: 'refunded',
    ...MUTUAL_EXIT,
  },
  accepted_pending_release: {
    release_confirmed: 'settled',
    refund_confirmed: 'refunded',
    ...MUTUAL_EXIT,
  },
  auto_released: {
    release_confirmed: 'settled',
    refund_confirmed: 'refunded',
    ...MUTUAL_EXIT,
  },
  disputed: {
    open_tier_1: 'tier_1_negotiation',
    open_tier_2: 'tier_2_evidence_rule',
    open_tier_3: 'tier_3_mediation',
    ...ADMIN_EXIT,
  },
  tier_1_negotiation: {
    ruling_issued: 'resolved',
    // Reached only when a template has no tier after 1 and the default ruling favours the buyer.
    return_ordered: 'return_pending',
    redo_ordered: 'redo_pending',
    open_tier_2: 'tier_2_evidence_rule',
    open_tier_3: 'tier_3_mediation',
    ...ADMIN_EXIT,
  },
  tier_2_evidence_rule: {
    ruling_issued: 'resolved',
    return_ordered: 'return_pending',
    redo_ordered: 'redo_pending',
    open_tier_3: 'tier_3_mediation',
    ...ADMIN_EXIT,
  },
  tier_3_mediation: {
    ruling_issued: 'resolved',
    return_ordered: 'return_pending',
    redo_ordered: 'redo_pending',
    ...ADMIN_EXIT,
  },
  return_pending: {
    return_receipt_confirmed: 'resolved',
    return_not_shipped: 'resolved',
    return_unconfirmed: 'tier_3_mediation',
    ...ADMIN_EXIT,
  },
  redo_pending: {
    redelivery_confirmed: 'redo_inspection',
    redo_deadline_passed: 'resolved',
    ...ADMIN_EXIT,
  },
  redo_inspection: {
    redo_accepted: 'resolved',
    redo_rejected: 'resolved',
    redo_inspection_expired: 'resolved',
    ...ADMIN_EXIT,
  },
  resolved: {settlement_confirmed: 'settled', ...ADMIN_EXIT},
  settled: {},
  cancelled: {},
  expired: {},
  refunded: {},
};

/** An event is not allowed in the current state. */
export class IllegalTransitionError extends ContractError {
  readonly from: MilestoneState;
  readonly event: string;

  constructor(from: MilestoneState, event: string) {
    const allowed = Object.keys(TRANSITIONS[from]);
    super(
      'illegal_transition',
      `event ${event} is not allowed in state ${from}. Allowed events: ` +
        `${allowed.length > 0 ? allowed.join(', ') : 'none (terminal state)'}`,
    );
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.event = event;
  }
}

/** Returns the next state, or throws IllegalTransitionError. */
export function nextState(from: MilestoneState, event: MilestoneEvent): MilestoneState {
  const to = TRANSITIONS[from][event];
  if (to === undefined) throw new IllegalTransitionError(from, event);
  return to;
}

export function canTransition(from: MilestoneState, event: MilestoneEvent): boolean {
  return TRANSITIONS[from][event] !== undefined;
}
