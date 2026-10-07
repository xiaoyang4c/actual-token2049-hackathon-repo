import {describe, expect, test} from 'bun:test'
import type {ContractView, MilestoneSummary} from '../src/lib/api'
import {availableActions} from '../src/lib/deal-actions'

function view(state: string): ContractView {
  return {
    now: '2026-10-07T00:00:00Z',
    contract: {buyerId: 'buyer', sellerId: 'seller', signatures: {}},
    milestones: [{state, pending: null, deadlines: {}, inspectionCutoffAt: '2026-10-08T00:00:00Z', tierDeadline: '2026-10-08T00:00:00Z', obligations: []}],
  } as ContractView
}
const names = (state: string, role: 'buyer' | 'seller', next?: MilestoneSummary['next']) => availableActions(view(state), 0, role, next).map((item) => item.action)

describe('role actions', () => {
  test('only offers actions for the role and engine state', () => {
    expect(names('draft', 'buyer')).toEqual(['submit_for_acceptance', 'cancel'])
    expect(names('draft', 'seller')).toEqual(['submit_for_acceptance', 'cancel'])
    expect(names('pending_acceptance', 'buyer')).toEqual(['sign_terms'])
    expect(names('funded', 'buyer')).toEqual([])
    expect(names('funded', 'seller')).toEqual(['deliver'])
    expect(names('in_inspection', 'buyer')).toEqual(['accept', 'dispute'])
    expect(names('in_inspection', 'seller')).toEqual([])
    expect(names('tier_1_negotiation', 'buyer')).toEqual(['escalate'])
    expect(names('tier_1_negotiation', 'seller')).toEqual(['escalate', 'concede_refund'])
    expect(names('redo_pending', 'seller')).toEqual(['redeliver'])
    expect(names('redo_pending', 'buyer')).toEqual([])
    expect(names('redo_inspection', 'buyer')).toEqual(['accept_redo', 'reject_redo'])
    expect(names('redo_inspection', 'seller')).toEqual([])
    for (const state of ['awaiting_funding', 'delivered', 'disputed', 'tier_2_evidence_rule', 'tier_3_mediation', 'settled', 'refunded', 'cancelled', 'expired']) {
      expect(names(state, 'buyer')).toEqual([])
      expect(names(state, 'seller')).toEqual([])
    }
  })
  test('pending writes, elapsed deadlines, signatures, and completed obligations suppress actions', () => {
    const pending = view('in_inspection')
    pending.milestones[0].pending = 'delivery'
    expect(availableActions(pending, 0, 'buyer')).toEqual([])
    const late = view('in_inspection')
    late.now = late.milestones[0].inspectionCutoffAt!
    expect(availableActions(late, 0, 'buyer')).toEqual([])
    const signed = view('pending_acceptance')
    signed.contract.signatures.buyer = 'signed'
    expect(availableActions(signed, 0, 'buyer')).toEqual([])
    expect(availableActions(signed, 0, 'seller')).toHaveLength(1)
    const resolved = view('resolved')
    resolved.milestones[0].obligations = [{party: 'seller', action: 'authorize_refund', dueAt: '', compliedAt: null, forcedAt: null, ignoredAt: null}]
    expect(availableActions(resolved, 0, 'buyer')).toEqual([])
    expect(availableActions(resolved, 0, 'seller').map((item) => item.action)).toEqual(['comply_with_ruling'])
    resolved.milestones[0].obligations[0].compliedAt = 1
    expect(availableActions(resolved, 0, 'seller')).toEqual([])
    expect(names('return_pending', 'buyer', {actor: 'buyer', action: 'Ship the return', dueAt: null})).toEqual(['record_return_shipment'])
    expect(names('return_pending', 'seller', {actor: 'buyer', action: 'Ship the return', dueAt: null})).toEqual([])
  })
})
