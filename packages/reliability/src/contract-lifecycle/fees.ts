/**
 * @fileoverview Dispute fees. An escrow releases all or nothing, so the
 * lifecycle cannot take a fee from the escrow. It records the fee as a
 * liability. Production design: a dispute bond in a separate escrow.
 * Read docs/contract-lifecycle.md.
 */

import type {FeeRules, Winner} from './types';

export function disputeFee(
  rules: FeeRules, tierReached: 0|1|2|3, winner: Winner|null,
): {amountAtomic: string; paidBy: Winner|null} {
  let total = 0n;
  if (tierReached >= 1) total += BigInt(rules.perTierAtomic.tier1);
  if (tierReached >= 2) total += BigInt(rules.perTierAtomic.tier2);
  if (tierReached >= 3) total += BigInt(rules.perTierAtomic.tier3);
  if (total === 0n) return {amountAtomic: '0', paidBy: null};
  if (rules.rule === 'buyer_pays') return {amountAtomic: total.toString(), paidBy: 'buyer'};
  if (rules.rule === 'seller_pays') return {amountAtomic: total.toString(), paidBy: 'seller'};
  if (winner === 'buyer') return {amountAtomic: total.toString(), paidBy: 'seller'};
  if (winner === 'seller') return {amountAtomic: total.toString(), paidBy: 'buyer'};
  return {amountAtomic: total.toString(), paidBy: winner === 'split' ? 'split' : null};
}
