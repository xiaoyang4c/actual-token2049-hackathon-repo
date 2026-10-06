/**
 * @fileoverview The contract milestone transition table. The legal list
 * below is an independent copy of the spec. The table must match it.
 */

import {describe, expect, test} from 'bun:test';
import {canTransition, IllegalTransitionError, nextState, TRANSITIONS} from '../../src/contract-lifecycle/transitions';
import {
  MILESTONE_EVENTS, MILESTONE_STATES, TERMINAL_STATES, type MilestoneEvent, type MilestoneState,
} from '../../src/contract-lifecycle/types';

const ADMIN_EXIT: Array<[MilestoneState, MilestoneEvent, MilestoneState]> = ([
  'disputed', 'tier_1_negotiation', 'tier_2_evidence_rule', 'tier_3_mediation',
  'return_pending', 'redo_pending', 'redo_inspection', 'resolved',
] as MilestoneState[]).map((state) => [state, 'admin_settlement_confirmed', 'settled']);

const MUTUAL_EXIT: Array<[MilestoneState, MilestoneEvent, MilestoneState]> = ([
  'funded', 'in_inspection', 'accepted_pending_release', 'auto_released',
] as MilestoneState[]).map((state) => [state, 'mutual_termination_confirmed', 'refunded']);

const LEGAL: Array<[MilestoneState, MilestoneEvent, MilestoneState]> = [
  ['draft', 'submit_for_acceptance', 'pending_acceptance'],
  ['draft', 'cancel', 'cancelled'],
  ['pending_acceptance', 'all_parties_signed', 'awaiting_funding'],
  ['pending_acceptance', 'cancel', 'cancelled'],
  ['awaiting_funding', 'funding_confirmed', 'funded'],
  ['awaiting_funding', 'funding_deadline_passed', 'expired'],
  ['awaiting_funding', 'cancel', 'cancelled'],
  ['funded', 'delivery_confirmed', 'delivered'],
  ['funded', 'delivery_deadline_refund_confirmed', 'expired'],
  ['funded', 'refund_confirmed', 'refunded'],
  ['delivered', 'inspection_opened', 'in_inspection'],
  ['in_inspection', 'buyer_accepted', 'accepted_pending_release'],
  ['in_inspection', 'inspection_window_expired', 'auto_released'],
  ['in_inspection', 'dispute_confirmed', 'disputed'],
  ['in_inspection', 'refund_confirmed', 'refunded'],
  ['accepted_pending_release', 'release_confirmed', 'settled'],
  ['accepted_pending_release', 'refund_confirmed', 'refunded'],
  ['auto_released', 'release_confirmed', 'settled'],
  ['auto_released', 'refund_confirmed', 'refunded'],
  ['disputed', 'open_tier_1', 'tier_1_negotiation'],
  ['disputed', 'open_tier_2', 'tier_2_evidence_rule'],
  ['disputed', 'open_tier_3', 'tier_3_mediation'],
  ['tier_1_negotiation', 'ruling_issued', 'resolved'],
  ['tier_1_negotiation', 'return_ordered', 'return_pending'],
  ['tier_1_negotiation', 'redo_ordered', 'redo_pending'],
  ['tier_1_negotiation', 'open_tier_2', 'tier_2_evidence_rule'],
  ['tier_1_negotiation', 'open_tier_3', 'tier_3_mediation'],
  ['tier_2_evidence_rule', 'ruling_issued', 'resolved'],
  ['tier_2_evidence_rule', 'return_ordered', 'return_pending'],
  ['tier_2_evidence_rule', 'redo_ordered', 'redo_pending'],
  ['tier_2_evidence_rule', 'open_tier_3', 'tier_3_mediation'],
  ['tier_3_mediation', 'ruling_issued', 'resolved'],
  ['tier_3_mediation', 'return_ordered', 'return_pending'],
  ['tier_3_mediation', 'redo_ordered', 'redo_pending'],
  ['return_pending', 'return_receipt_confirmed', 'resolved'],
  ['return_pending', 'return_not_shipped', 'resolved'],
  ['return_pending', 'return_unconfirmed', 'tier_3_mediation'],
  ['redo_pending', 'redelivery_confirmed', 'redo_inspection'],
  ['redo_pending', 'redo_deadline_passed', 'resolved'],
  ['redo_inspection', 'redo_accepted', 'resolved'],
  ['redo_inspection', 'redo_rejected', 'resolved'],
  ['redo_inspection', 'redo_inspection_expired', 'resolved'],
  ['resolved', 'settlement_confirmed', 'settled'],
  ...ADMIN_EXIT,
  ...MUTUAL_EXIT,
];

const key = (state: string, event: string) => `${state}--${event}`;
const legal = new Map(LEGAL.map(([state, event, to]) => [key(state, event), to]));

describe('contract transition table', () => {
  test('every legal transition maps to the expected state', () => {
    for (const [from, event, to] of LEGAL) {
      expect(nextState(from, event)).toBe(to);
      expect(canTransition(from, event)).toBe(true);
    }
  });

  test('the table has no transition outside the spec', () => {
    for (const state of MILESTONE_STATES) {
      for (const [event, to] of Object.entries(TRANSITIONS[state])) {
        expect(legal.get(key(state, event))).toBe(to);
      }
    }
  });

  test('every other state and event pair throws a clear IllegalTransitionError', () => {
    let checked = 0;
    for (const state of MILESTONE_STATES) {
      for (const event of MILESTONE_EVENTS) {
        if (legal.has(key(state, event))) continue;
        let thrown: unknown;
        try {
          nextState(state, event);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(IllegalTransitionError);
        expect((thrown as IllegalTransitionError).message).toContain(`not allowed in state ${state}`);
        expect((thrown as IllegalTransitionError).code).toBe('illegal_transition');
        expect(canTransition(state, event)).toBe(false);
        checked++;
      }
    }
    expect(checked).toBe(MILESTONE_STATES.length * MILESTONE_EVENTS.length - LEGAL.length);
  });

  test('terminal states have no exits', () => {
    for (const state of TERMINAL_STATES) expect(TRANSITIONS[state]).toEqual({});
  });

  test('every state can reach a terminal state', () => {
    for (const start of MILESTONE_STATES) {
      const seen = new Set<MilestoneState>([start]);
      const queue: MilestoneState[] = [start];
      let reaches = TERMINAL_STATES.has(start);
      while (queue.length > 0 && !reaches) {
        const state = queue.shift() as MilestoneState;
        for (const to of Object.values(TRANSITIONS[state])) {
          if (TERMINAL_STATES.has(to)) reaches = true;
          if (!seen.has(to)) {
            seen.add(to);
            queue.push(to);
          }
        }
      }
      expect(reaches).toBe(true);
    }
  });

  test('cancel is possible only before funding', () => {
    expect(MILESTONE_STATES.filter((state) => canTransition(state, 'cancel'))).toEqual(
      ['draft', 'pending_acceptance', 'awaiting_funding'],
    );
  });
});
