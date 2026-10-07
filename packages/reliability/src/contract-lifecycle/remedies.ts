/**
 * @fileoverview Remedies are contract terms, fixed before funding.
 *
 * A Masumi escrow releases all or nothing. A PARTIAL_RELEASE milestone
 * is therefore funded as two escrows: the core and the holdback. The
 * holdback is released only if inspection passes.
 */

import {ContractError} from './errors';
import type {
  NegotiatedOutcome, Remedy, Tranche, TrancheDecision, TrancheRole, Winner,
} from './types';

const BPS_DENOMINATOR = 10_000n;

export function validateRemedy(remedy: Remedy): void {
  if (remedy.type === 'partial_release') {
    const bps = remedy.sellerShareBps;
    if (bps === undefined || !Number.isInteger(bps) || bps <= 0 || bps >= Number(BPS_DENOMINATOR)) {
      throw new ContractError('invalid_remedy', 'partial_release needs sellerShareBps strictly between 0 and 10000');
    }
    return;
  }
  if (remedy.sellerShareBps !== undefined) {
    throw new ContractError('invalid_remedy', `sellerShareBps is valid only for partial_release, not ${remedy.type}`);
  }
}

/** Escrow layout for one milestone amount. */
export function trancheLayout(
  amountAtomic: bigint, remedy: Remedy,
): Array<{role: TrancheRole; amountAtomic: string}> {
  if (amountAtomic <= 0n) throw new ContractError('invalid_amount', 'the milestone amount must be positive');
  if (remedy.type !== 'partial_release') return [{role: 'full', amountAtomic: amountAtomic.toString()}];
  const core = (amountAtomic * BigInt(remedy.sellerShareBps ?? 0)) / BPS_DENOMINATOR;
  const holdback = amountAtomic - core;
  if (core <= 0n || holdback <= 0n) {
    throw new ContractError('invalid_amount', 'the amount is too small for a core escrow and a holdback escrow');
  }
  return [
    {role: 'core', amountAtomic: core.toString()},
    {role: 'holdback', amountAtomic: holdback.toString()},
  ];
}

/** Tranche decisions when one side wins under the agreed remedy. */
export function decisionsFor(
  remedy: Remedy, winner: 'buyer'|'seller', tranches: readonly Tranche[],
): {[trancheId: string]: TrancheDecision} {
  const decisions: {[trancheId: string]: TrancheDecision} = {};
  for (const tranche of tranches) {
    if (winner === 'seller') {
      decisions[tranche.id] = 'release';
    } else if (remedy.type === 'partial_release') {
      decisions[tranche.id] = tranche.role === 'core' ? 'release' : 'refund';
    } else {
      decisions[tranche.id] = 'refund';
    }
  }
  return decisions;
}

/** Outcomes the parties can sign in Tier 1. `core_only` needs a holdback escrow. */
export function allowedOutcomes(tranches: readonly Tranche[]): NegotiatedOutcome[] {
  return tranches.some((tranche) => tranche.role === 'holdback') ?
    ['full_release', 'core_only', 'full_refund'] :
    ['full_release', 'full_refund'];
}

export function decisionsForOutcome(
  outcome: NegotiatedOutcome, tranches: readonly Tranche[],
): {[trancheId: string]: TrancheDecision} {
  const allowed = allowedOutcomes(tranches);
  if (!allowed.includes(outcome)) {
    throw new ContractError('outcome_not_allowed', `${outcome} is not possible for this milestone. Allowed: ${allowed.join(', ')}`);
  }
  const decisions: {[trancheId: string]: TrancheDecision} = {};
  for (const tranche of tranches) {
    if (outcome === 'full_release') decisions[tranche.id] = 'release';
    else if (outcome === 'full_refund') decisions[tranche.id] = 'refund';
    else decisions[tranche.id] = tranche.role === 'holdback' ? 'refund' : 'release';
  }
  return decisions;
}

export function winnerOfOutcome(outcome: NegotiatedOutcome): Winner {
  if (outcome === 'full_release') return 'seller';
  if (outcome === 'full_refund') return 'buyer';
  return 'split';
}
