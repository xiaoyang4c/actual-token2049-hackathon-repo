/**
 * @fileoverview Turns template durations into the absolute deadlines that
 * Masumi signs into each escrow.
 */

import {ContractError} from './errors';
import type {ContractMode, Deadlines, Remedy, WindowSet} from './types';

const MINUTE_MS = 60_000;

/**
 * Rules that the Masumi payment service enforces on POST /payment
 * (masumi-payment-service src/routes/api/payments/index.ts, rev d569a33).
 * They are external rules, so they are constants. Check them against the
 * node's live OpenAPI before a live run.
 */
export const MPS_DEADLINE_RULES = {
  payByBeforeSubmitResultMinMs: 5 * MINUTE_MS,
  submitResultFromNowMinMs: 15 * MINUTE_MS,
  unlockAfterSubmitResultMinMs: 15 * MINUTE_MS,
  externalDisputeAfterUnlockMinMs: 15 * MINUTE_MS,
} as const;

/** Applies demo overrides. The live mode still enforces MPS_DEADLINE_RULES. */
export function effectiveWindows(base: WindowSet, overrides: Partial<WindowSet>): WindowSet {
  return {...base, ...overrides};
}

export function computeDeadlines(startMs: number, windows: WindowSet): Deadlines {
  const payByTime = startMs + windows.fundingWindowMs;
  const submitResultTime = payByTime + windows.deliveryWindowMs;
  const unlockTime = submitResultTime + windows.inspectionWindowMs;
  const externalDisputeUnlockTime = unlockTime + windows.disputeResolutionWindowMs;
  return {payByTime, submitResultTime, unlockTime, externalDisputeUnlockTime};
}

/** In live mode, rejects deadlines that MPS would reject. Paper mode skips this. */
export function validateDeadlines(deadlines: Deadlines, nowMs: number, mode: ContractMode): void {
  if (mode === 'paper') return;
  const rules = MPS_DEADLINE_RULES;
  const problems: string[] = [];
  if (deadlines.payByTime > deadlines.submitResultTime - rules.payByBeforeSubmitResultMinMs) {
    problems.push('payByTime must be at least 5 minutes before submitResultTime');
  }
  if (deadlines.submitResultTime < nowMs + rules.submitResultFromNowMinMs) {
    problems.push('submitResultTime must be at least 15 minutes from now');
  }
  if (deadlines.unlockTime < deadlines.submitResultTime + rules.unlockAfterSubmitResultMinMs) {
    problems.push('unlockTime must be at least 15 minutes after submitResultTime');
  }
  if (deadlines.externalDisputeUnlockTime < deadlines.unlockTime + rules.externalDisputeAfterUnlockMinMs) {
    problems.push('externalDisputeUnlockTime must be at least 15 minutes after unlockTime');
  }
  if (problems.length > 0) {
    throw new ContractError('invalid_deadlines', `the Masumi payment service would reject these deadlines: ${problems.join('; ')}`);
  }
}

/**
 * Longest time the dispute process can take after a dispute is confirmed.
 * It must fit before externalDisputeUnlockTime. Then the Masumi admins
 * never need to act while the platform is still resolving.
 */
export function disputeBudgetMs(windows: WindowSet, remedy: Remedy, tiers: ReadonlyArray<1|2|3>): number {
  let total = 0;
  if (tiers.includes(1)) total += windows.tier1WindowMs;
  if (tiers.includes(2)) total += windows.tier2WindowMs;
  if (tiers.includes(3)) total += windows.tier3WindowMs;
  // A return can open Tier 3 again.
  if (remedy.type === 'full_refund_with_return') total += windows.returnWindowMs + windows.tier3WindowMs;
  if (remedy.type === 'redo_or_replace') total += windows.redoWindowMs + windows.redoInspectionWindowMs;
  // The losing party's time to carry out the final ruling.
  total += windows.rulingComplianceWindowMs;
  return total;
}

export function assertDisputeBudget(windows: WindowSet, remedy: Remedy, tiers: ReadonlyArray<1|2|3>): void {
  const budget = disputeBudgetMs(windows, remedy, tiers);
  if (budget > windows.disputeResolutionWindowMs) {
    throw new ContractError(
      'invalid_windows',
      `dispute tiers, remedy follow-ups, and ruling compliance need ${budget} ms, ` +
        `but disputeResolutionWindowMs is ${windows.disputeResolutionWindowMs} ms`,
    );
  }
}

/**
 * When the platform stops accepting a dispute. The buyer gets the full
 * inspection window from delivery, but the on-chain dispute must land
 * before unlockTime.
 */
export function inspectionCutoff(
  deliveredAt: number, windows: WindowSet, deadlines: Deadlines, safetyMarginMs: number,
): number {
  return Math.min(deliveredAt + windows.inspectionWindowMs, deadlines.unlockTime - safetyMarginMs);
}
