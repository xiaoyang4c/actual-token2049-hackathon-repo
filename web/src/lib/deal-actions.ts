import type {ContractView, MilestoneSummary, Role} from './api'
import type {PartyActionType} from './deals'

export interface AvailableAction {action: PartyActionType | 'sign_terms'; label: string}

/** Match the engine's role, transition, pending-write, and deadline checks. */
export function availableActions(view: ContractView, index: number, role: Role, next?: MilestoneSummary['next']): AvailableAction[] {
  const milestone = view.milestones[index]
  if (!milestone || milestone.pending || next?.actor === 'escrow') return []
  const now = Date.parse(view.now)
  const before = (time: string | null | undefined) => !time || now < Date.parse(time)
  const action = (name: PartyActionType | 'sign_terms', label: string): AvailableAction => ({action: name, label})
  switch (milestone.state) {
    case 'draft':
      return view.milestones.every((item) => item.state === 'draft') ? [action('submit_for_acceptance', 'Submit for acceptance'), action('cancel', 'Cancel deal')] : []
    case 'pending_acceptance': {
      const partyId = role === 'buyer' ? view.contract.buyerId : view.contract.sellerId
      return view.contract.signatures[partyId] ? [] : [action('sign_terms', 'Sign the terms')]
    }
    case 'funded':
      return role === 'seller' && before(milestone.deadlines?.submitResultTime) ? [action('deliver', 'Deliver')] : []
    // delivered is the engine's transient state before inspection_opened.
    case 'in_inspection':
      return role === 'buyer' && before(milestone.inspectionCutoffAt) ? [action('accept', 'Accept delivery'), action('dispute', 'Dispute delivery')] : []
    case 'tier_1_negotiation':
      return before(milestone.tierDeadline) ? [action('escalate', 'Escalate'), ...(role === 'seller' ? [action('concede_refund', 'Concede refund')] : [])] : []
    case 'return_pending':
      return before(next?.dueAt?.utc) && (!next || next.actor === role || next.actor === 'both' || next.actor === 'either')
        ? [role === 'buyer' ? action('record_return_shipment', 'Record return shipment') : action('confirm_return_received', 'Confirm return received')] : []
    case 'redo_pending':
      return role === 'seller' && before(next?.dueAt?.utc) ? [action('redeliver', 'Redeliver')] : []
    case 'redo_inspection':
      return role === 'buyer' && before(next?.dueAt?.utc) ? [action('accept_redo', 'Accept redo'), action('reject_redo', 'Reject redo')] : []
    case 'resolved':
      return milestone.obligations.some((item) => item.party === role && item.compliedAt === null && item.forcedAt === null)
        ? [action('comply_with_ruling', 'Comply with ruling')] : []
    default: return []
  }
}
