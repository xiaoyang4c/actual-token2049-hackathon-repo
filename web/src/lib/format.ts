/** Human labels and tones for engine states. */

export const STATE_LABEL: Record<string, string> = {
  draft: 'Draft',
  pending_acceptance: 'Awaiting signatures',
  awaiting_funding: 'Awaiting funding',
  funded: 'Funded, awaiting delivery',
  delivered: 'Delivered',
  in_inspection: 'In inspection',
  accepted_pending_release: 'Accepted, release at unlock',
  auto_released: 'Released automatically',
  disputed: 'Disputed',
  tier_1_negotiation: 'Tier 1 · Negotiation',
  tier_2_evidence_rule: 'Tier 2 · Named judge',
  tier_3_mediation: 'Tier 3 · Mediation',
  resolved: 'Ruling being carried out',
  return_pending: 'Return pending',
  redo_pending: 'Redo pending',
  redo_inspection: 'Redo in inspection',
  settled: 'Settled',
  cancelled: 'Cancelled',
  expired: 'Expired',
  refunded: 'Refunded',
}

export type Tone = 'ink' | 'up' | 'warn' | 'blue' | 'down' | 'quiet'

export function stateTone(state: string): Tone {
  if (state === 'settled' || state === 'auto_released' || state === 'accepted_pending_release') return 'up'
  if (state === 'tier_3_mediation' || state === 'resolved') return 'blue'
  if (state.startsWith('tier_') || state === 'disputed' || state.endsWith('_pending') || state === 'redo_inspection') return 'warn'
  if (state === 'cancelled' || state === 'expired' || state === 'refunded') return 'quiet'
  return 'ink'
}

/** The six stages a milestone moves through, and where each engine state sits. */
export const STAGES = ['Agreement', 'Funding', 'Delivery', 'Inspection', 'Release', 'Closed'] as const

export function stageIndex(state: string, terminal: boolean): {index: number; disputed: boolean} {
  if (terminal || ['settled', 'cancelled', 'expired', 'refunded'].includes(state)) return {index: 5, disputed: false}
  if (['draft', 'pending_acceptance'].includes(state)) return {index: 0, disputed: false}
  if (state === 'awaiting_funding') return {index: 1, disputed: false}
  if (state === 'funded') return {index: 2, disputed: false}
  if (['delivered', 'in_inspection'].includes(state)) return {index: 3, disputed: false}
  if (['accepted_pending_release', 'auto_released', 'resolved'].includes(state)) return {index: 4, disputed: state === 'resolved'}
  return {index: 3, disputed: true}
}

export const ACTION_LABEL: Record<string, string> = {
  authorize_withdrawal: 'Authorize withdrawal',
  authorize_refund: 'Authorize refund',
}

export const OUTCOME_LABEL: Record<string, string> = {
  full_release: 'Full release',
  core_only: 'Core only',
  full_refund: 'Full refund',
}

export const REMEDY_LABEL: Record<string, string> = {
  partial_release: 'Partial release',
  full_refund_with_return: 'Full refund with return',
  full_refund_no_return: 'Full refund, no return',
  redo_or_replace: 'Redo or replace',
}

export const REMEDY_HELP: Record<string, string> = {
  partial_release: 'The seller keeps the core. The holdback goes back to the buyer.',
  full_refund_with_return: 'The refund waits until the seller confirms the returned goods.',
  full_refund_no_return: 'The buyer gets a full refund.',
  redo_or_replace: 'The seller gets one retry. A failed retry is a full refund.',
}

export const EVIDENCE_LABEL: Record<string, string> = {
  inspection_certificate: 'Inspection certificate',
  dispatch_photo: 'Dispatch photo',
  seal_id: 'Seal id',
  lab_report: 'Lab report',
  arrival_photo: 'Arrival photo',
  note: 'Note',
  file_hash: 'File hash',
  delivered_file: 'Delivered file',
}

export const pretty = (value: string) => value.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

/** "in 2 d 4 h" or "3 h ago", from now. */
export function relative(ms: number, now = Date.now()): string {
  const diff = ms - now
  const abs = Math.abs(diff)
  const d = Math.floor(abs / 86_400_000)
  const h = Math.floor((abs % 86_400_000) / 3_600_000)
  const m = Math.floor((abs % 3_600_000) / 60_000)
  const span = d > 0 ? `${d} d ${h} h` : h > 0 ? `${h} h ${m} min` : `${m} min`
  return diff >= 0 ? `in ${span}` : `${span} ago`
}

export function dateTime(value: number | string): string {
  const d = new Date(value)
  return d.toLocaleString('en-GB', {day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Singapore'}) + ' SGT'
}

export function day(value: number | string): string {
  return new Date(value).toLocaleDateString('en-GB', {day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Singapore'})
}

/** Atomic test USDM (6 decimals) to display. */
export function usdm(atomic: string | number | bigint): string {
  const value = BigInt(atomic)
  const whole = value / 1_000_000n
  const frac = value % 1_000_000n
  const fracText = frac === 0n ? '' : '.' + frac.toString().padStart(6, '0').replace(/0+$/, '')
  return `${whole.toLocaleString('en-US')}${fracText}`
}

export const shortHash = (hash: string, n = 6) => (hash.length > 2 * n + 1 ? `${hash.slice(0, n)}…${hash.slice(-n)}` : hash)

export const pct = (value: number, digits = 0) => `${(value * 100).toFixed(digits)}%`
