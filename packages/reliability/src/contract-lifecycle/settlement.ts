/**
 * @fileoverview Maps a milestone to the reliability contract of this repo.
 *
 * Each milestone is one MarketplaceTransaction. Its result is one
 * Outcome. The math lane reads the Outcome state, fault, and confidence.
 * The full settlement facts go into `Outcome.evidence` as a
 * contract-settlement.v1 record (schema in docs/contract-lifecycle.md).
 * This file holds no scoring math.
 */

import {
  DELIVERY_TIER_VERIFICATION, RESOLVER_CONFIDENCE, VOLUNTARY_REFUND_CONFIDENCE,
} from '../lifecycle';
import type {
  JsonValue, MarketplaceTransaction, Outcome, OutcomeFault, ReliabilityEvent,
  VerificationMethod,
} from '../types';
import type {Contract, Milestone, Side} from './types';

export const SETTLEMENT_SCHEMA = 'contract-settlement.v1';

/** A deterministic hash check by the code judge. */
export const CODE_JUDGE_CONFIDENCE = 0.95;
/** Both parties signed the outcome. */
export const PARTY_AGREEMENT_CONFIDENCE = 0.9;
/** A deterministic on-chain deadline (missed delivery, ignored ruling). */
export const CHAIN_DEADLINE_CONFIDENCE = 1;

const iso = (ms: number|null): string|null => (ms === null ? null : new Date(ms).toISOString());

/** Reliability transaction id for one milestone. */
export function milestoneTransactionId(contract: Contract, milestone: Milestone): string {
  return `${contract.id}/m${milestone.index}`;
}

/** Amount in whole asset units, for the rating weight `w = log(1 + v / v0)`. */
export function majorUnits(amountAtomic: string, decimals: number): number {
  return Number(BigInt(amountAtomic)) / 10 ** decimals;
}

export function milestoneTransaction(contract: Contract, milestone: Milestone): MarketplaceTransaction {
  const terms = contract.terms;
  const createdAt = iso(contract.createdAt) ?? new Date(0).toISOString();
  const termsJson: {[key: string]: JsonValue} = {
    contractId: contract.id,
    milestoneId: milestone.id,
    milestoneIndex: milestone.index,
    templateId: terms.template.id,
    templateVersion: terms.template.version,
    remedy: terms.remedy.type,
    amountAtomic: milestone.amountAtomic,
    assetUnit: terms.assetUnit,
    mode: contract.mode,
    custodyModel: terms.custodyModel,
  };
  return {
    id: milestoneTransactionId(contract, milestone),
    type: terms.template.transactionType,
    participants: [
      {entityId: contract.buyerId, role: 'buyer'},
      {entityId: contract.sellerId, role: 'seller'},
    ],
    terms: termsJson,
    termsHash: contract.termsSha256 ?? undefined,
    versions: [{version: 1, terms: termsJson, reason: 'terms signed by both parties', createdAt}],
    value: majorUnits(milestone.amountAtomic, terms.assetDecimals),
    createdAt,
  };
}

/** The contract-settlement.v1 facts for one milestone. */
export function settlementRecord(contract: Contract, milestone: Milestone): {[key: string]: JsonValue} {
  const sum = (pick: (paid: Milestone['tranches'][number]) => string|null): string =>
    milestone.tranches.reduce((total, tranche) => total + BigInt(pick(tranche) ?? '0'), 0n).toString();
  const deadline = milestone.deadlines?.submitResultTime ?? null;
  let onTime: boolean|null = null;
  if (milestone.deliveredAt !== null && deadline !== null) {
    // The seller's submission time, not the time a tick observed it.
    onTime = (milestone.evidenceSubmittedAt ?? milestone.deliveredAt) <= deadline;
  } else if (milestone.fundedAt !== null) {
    onTime = false;
  }
  const disputed = milestone.dispute.tierReached > 0 || milestone.disputedAt !== null;
  const compliance = (party: Side): JsonValue => {
    const obligation = milestone.dispute.obligations.find((item) => item.party === party);
    if (!obligation) return null;
    return {
      dueAt: iso(obligation.dueAt),
      compliedAt: iso(obligation.compliedAt),
      ignored: obligation.ignoredAt !== null,
    };
  };
  const sellerPayout = milestone.tranches.find(
    (tranche) => BigInt(tranche.chain.paidToSellerAtomic ?? '0') > 0n && tranche.chain.settlementTxHash,
  );
  const collectionTxHash = contract.mode === 'live' && sellerPayout?.chain.settlementTxHash &&
    /^[0-9a-f]{64}$/.test(sellerPayout.chain.settlementTxHash) ? sellerPayout.chain.settlementTxHash : null;
  return {
    schema: SETTLEMENT_SCHEMA,
    mode: contract.mode,
    custodyModel: contract.terms.custodyModel,
    contractId: contract.id,
    milestoneId: milestone.id,
    milestoneIndex: milestone.index,
    milestoneCount: contract.milestones.length,
    buyerId: contract.buyerId,
    sellerId: contract.sellerId,
    buyerAddress: contract.terms.buyer.cardanoAddress,
    sellerAddress: contract.terms.seller.cardanoAddress,
    category: contract.category,
    templateId: contract.terms.template.id,
    templateVersion: contract.terms.template.version,
    amountAtomic: milestone.amountAtomic,
    assetUnit: contract.terms.assetUnit,
    createdAt: iso(contract.createdAt),
    fundedAt: iso(milestone.fundedAt),
    deliveredAt: iso(milestone.deliveredAt),
    buyerAcceptedAt: iso(milestone.buyerAcceptedAt),
    settledAt: iso(milestone.settledAt),
    deliveryDeadline: iso(deadline),
    outcome: milestone.outcome,
    closedReason: milestone.closedReason,
    disputed,
    disputeTierReached: milestone.dispute.tierReached,
    disputeWinner: disputed ? (milestone.dispute.ruling?.winner ?? null) : null,
    decidedBy: milestone.dispute.ruling?.decidedBy ?? null,
    rulingExecutedBy: milestone.dispute.executedBy,
    rulingCompliance: milestone.dispute.obligations.length > 0 ?
      {buyer: compliance('buyer'), seller: compliance('seller')} :
      null,
    releasedToSellerAtomic: sum((tranche) => tranche.chain.paidToSellerAtomic),
    refundedToBuyerAtomic: sum((tranche) => tranche.chain.paidToBuyerAtomic),
    disputeFeeAtomic: milestone.fee?.amountAtomic ?? '0',
    disputeFeePaidBy: milestone.fee?.paidBy ?? null,
    onTime,
    masumiPaymentIds: milestone.tranches.flatMap((tranche) => (tranche.escrowRef ? [tranche.escrowRef] : [])),
    settlementTxHashes: milestone.tranches.flatMap(
      (tranche) => (tranche.chain.settlementTxHash ? [tranche.chain.settlementTxHash] : []),
    ),
    collectionTxHash,
  };
}

interface Verdict {
  state: Outcome['state'];
  fault?: OutcomeFault;
  method: VerificationMethod;
  confidence: number;
}

/** How the dispute was decided, as a verification method and confidence. */
function rulingVerification(milestone: Milestone): {method: VerificationMethod; confidence: number} {
  const decidedBy = milestone.dispute.ruling?.decidedBy ?? '';
  if (decidedBy.startsWith('code:')) return {method: 'lifecycle', confidence: CODE_JUDGE_CONFIDENCE};
  if (decidedBy === 'parties') return {method: 'lifecycle', confidence: PARTY_AGREEMENT_CONFIDENCE};
  if (decidedBy === 'buyer') return DELIVERY_TIER_VERIFICATION.buyer_confirmation;
  if (decidedBy === 'seller') return {method: 'lifecycle', confidence: VOLUNTARY_REFUND_CONFIDENCE};
  if (decidedBy.endsWith('_default') || decidedBy === 'system') return DELIVERY_TIER_VERIFICATION.silent_release;
  // A named inspector, the platform mediator, or the Masumi admins.
  return {method: 'manual-review', confidence: RESOLVER_CONFIDENCE};
}

function verdictFor(milestone: Milestone): Verdict {
  switch (milestone.outcome) {
    case 'ACCEPTED': {
      const tier = DELIVERY_TIER_VERIFICATION.buyer_confirmation;
      return {state: 'successful', method: tier.method, confidence: tier.confidence};
    }
    case 'AUTO_RELEASED': {
      const tier = DELIVERY_TIER_VERIFICATION.silent_release;
      return {state: 'successful', method: tier.method, confidence: tier.confidence};
    }
    case 'RESOLVED': {
      const how = rulingVerification(milestone);
      const winner = milestone.dispute.ruling?.winner;
      if (winner === 'seller') return {state: 'successful', ...how};
      // Buyer won, or a split: the seller did not deliver as agreed.
      return {state: 'failed', fault: 'seller', ...how};
    }
    case 'REFUNDED':
      // Before delivery a concession is a clean exit. After delivery the seller admits a failure.
      return milestone.deliveredAt === null ?
        {state: 'cancelled', fault: 'none', method: 'lifecycle', confidence: VOLUNTARY_REFUND_CONFIDENCE} :
        {state: 'failed', fault: 'seller', method: 'lifecycle', confidence: VOLUNTARY_REFUND_CONFIDENCE};
    case 'EXPIRED':
      if (milestone.fundedAt !== null) {
        return {state: 'failed', fault: 'seller', method: 'lifecycle', confidence: CHAIN_DEADLINE_CONFIDENCE};
      }
      // The buyer signed and did not fund. A rail rejection is nobody's fault.
      return milestone.closedReason === 'not_funded_by_pay_by_time' ?
        {state: 'failed', fault: 'buyer', method: 'lifecycle', confidence: CHAIN_DEADLINE_CONFIDENCE} :
        {state: 'cancelled', fault: 'none', method: 'lifecycle', confidence: CHAIN_DEADLINE_CONFIDENCE};
    case 'CANCELLED':
      return {state: 'cancelled', fault: 'none', method: 'lifecycle', confidence: CHAIN_DEADLINE_CONFIDENCE};
    default:
      return {state: 'pending', method: 'lifecycle', confidence: 0};
  }
}

/** The current Outcome of a milestone, terminal or not. */
export function milestoneOutcome(contract: Contract, milestone: Milestone, now: number): Outcome {
  const transactionId = milestoneTransactionId(contract, milestone);
  const evidence = settlementRecord(contract, milestone);
  const decidedAt = iso(now) ?? new Date(0).toISOString();
  if (milestone.outcome === null) {
    const inDispute = milestone.disputedAt !== null && milestone.dispute.ruling === null;
    if (inDispute) {
      return {
        transactionId,
        state: 'disputed',
        evidence,
        verificationMethod: 'lifecycle',
        resolver: `tier_${milestone.dispute.tierReached}`,
        resolveBy: iso(milestone.dispute.tierDeadline ?? milestone.deadlines?.externalDisputeUnlockTime ?? now) ?? undefined,
        decidedAt,
      };
    }
    return {transactionId, state: 'pending', evidence, verificationMethod: 'lifecycle', decidedAt};
  }
  const verdict = verdictFor(milestone);
  return {
    transactionId,
    state: verdict.state,
    ...(verdict.state === 'failed' || verdict.state === 'cancelled' ? {fault: verdict.fault} : {}),
    evidence,
    verificationMethod: verdict.method,
    verificationConfidence: verdict.confidence,
    ...(milestone.dispute.ruling ? {resolver: milestone.dispute.ruling.decidedBy} : {}),
    decidedAt,
  };
}

/**
 * The rating enforces rulings. A party that misses the deadline to carry
 * out a ruling gets one failure event in the `dispute` category.
 */
export function rulingComplianceEvents(contract: Contract, milestone: Milestone): ReliabilityEvent[] {
  const transaction = milestoneTransaction(contract, milestone);
  return milestone.dispute.obligations.filter((obligation) => obligation.ignoredAt !== null).map((obligation) => ({
    id: `${transaction.id}:${obligation.party === 'buyer' ? contract.buyerId : contract.sellerId}:${obligation.party}:ruling_ignored`,
    transactionId: transaction.id,
    entityId: obligation.party === 'buyer' ? contract.buyerId : contract.sellerId,
    category: 'dispute',
    role: obligation.party,
    outcome: 'failure',
    evidence: {
      reason: 'ruling_ignored',
      action: obligation.action,
      dueAt: iso(obligation.dueAt),
      compliedAt: iso(obligation.compliedAt),
      mode: contract.mode,
    },
    verificationMethod: 'lifecycle',
    verificationConfidence: CHAIN_DEADLINE_CONFIDENCE,
    value: transaction.value,
    createdAt: iso(obligation.ignoredAt) ?? transaction.createdAt,
  }));
}
