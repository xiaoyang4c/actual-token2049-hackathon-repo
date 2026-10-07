/**
 * @fileoverview Marketplace rules that apply before a sale opens.
 *
 * The gate checks both parties against KYC and, when MARKETPLACE_REQUIRE_WALLET
 * is on, a proven wallet. A live contract also needs the buyer's confirmed
 * deposits to cover it. The gate checks the deal value against each
 * party's exposure limit, invoice due dates against the buyer's payment
 * days, and listing minimum reliabilities. Limits and payment days come
 * from the fee and terms policy, which reads each party's score snapshot.
 * The fee book records the accepted buyer and seller fees for a sale and
 * settles them from its final outcome.
 */

import type {AgentStore} from '../../packages/db/src/index';
import {categoryForType} from '../../packages/reliability/src/event-flow';
import {
  quoteFeeCharge, settleFeeCharge, toMinorUnits, type FeeCharge,
} from '../../packages/reliability/src/fee-charges';
import {checkKyc, type KycGateResult} from '../../packages/reliability/src/kyc-gate';
import type {
  EntityRole, JsonValue, KycTier, Listing, Outcome, ReliabilityCategory, ScoreView,
  TermsDecision, TransactionType,
} from '../../packages/reliability/src/types';
import type {ReliabilityPolicies} from './policies';
import {addressKeyHashes} from './deposit-chain';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Currencies that count one to one with the accounting currency, with their decimals. */
export const MARKETPLACE_CURRENCIES: ReadonlyMap<string, number> = new Map([
  ['USD', 2],
  ['USDM', 6],
]);

/** One reason a sale cannot open. */
export interface DealViolation {
  code: string;
  party?: EntityRole;
  message: string;
}

/** Whether a party has proven control of a wallet. Read docs/wallets.md. */
export interface WalletGateResult {
  passed: boolean;
  required: boolean;
  wallets: number;
  message: string;
}

/** One party's KYC, wallet, score snapshot, and terms. */
export interface PartyCheck {
  entityId: string;
  role: EntityRole;
  category: ReliabilityCategory;
  kyc: KycGateResult;
  wallet: WalletGateResult;
  score: ScoreView;
  decision: TermsDecision;
  /** Exposure limit in the accounting currency. Zero without KYC. */
  limit: number;
}

export interface DealCheck {
  allowed: boolean;
  category: ReliabilityCategory;
  currency: string;
  decimals: number;
  value: number|undefined;
  buyer: PartyCheck;
  seller: PartyCheck;
  violations: DealViolation[];
}

export interface DealInput {
  type: TransactionType;
  /** Defaults to the category of the transaction type. */
  category?: ReliabilityCategory;
  buyerId: string;
  sellerId: string;
  value: number|undefined;
  currency?: string;
  terms?: {[key: string]: JsonValue};
  listing?: Listing;
  /** Raises the required KYC tier, for example from a contract template. */
  requiredKycTier?: KycTier;
  /** A live contract: the buyer's available deposits must cover this amount. */
  liveDeposit?: {unit: string; quantity: bigint};
  now: string;
}

/** A sale that breaks one or more marketplace rules. */
export class MarketplaceRuleError extends Error {
  constructor(readonly violations: DealViolation[]) {
    super(violations.map((violation) => violation.message).join('; '));
    this.name = 'MarketplaceRuleError';
  }
}

/** Gate checks on one store. Policies must be the plain (unwrapped) bundle or a wrapper. */
export class MarketplaceGate {
  readonly requireWallet: boolean;

  constructor(
    private readonly store: AgentStore,
    private readonly policies: ReliabilityPolicies,
    options: {requireWallet?: boolean} = {},
  ) {
    this.requireWallet = options.requireWallet ?? process.env.MARKETPLACE_REQUIRE_WALLET === 'on';
  }

  /** A proven wallet. Required only when requireWallet is on. */
  wallet(entityId: string): WalletGateResult {
    const wallets = this.store.listWalletProofs(entityId).length;
    const passed = wallets > 0 || !this.requireWallet;
    return {
      passed, required: this.requireWallet, wallets,
      message: wallets ? `${entityId} has ${wallets} proven wallet${wallets === 1 ? '' : 's'}` :
        `${entityId} has no proven wallet; sign in with a wallet first`,
    };
  }

  /** True when one of the entity's wallet proofs covers this address. */
  ownsAddress(entityId: string, address: string): boolean {
    const keys = addressKeyHashes(address);
    return this.store.listWalletProofs(entityId).some((proof) =>
      proof.credentialHash === (proof.credentialKind === 'stake' ? keys.stake : keys.payment));
  }

  /**
   * Confirmed live deposits of one asset, less the amounts of the entity's
   * open live contracts as buyer. Read docs/wallets.md.
   */
  availableDeposit(entityId: string, unit: string): {deposited: bigint; reserved: bigint; available: bigint} {
    const deposited = BigInt(this.store.confirmedDepositTotals(entityId).find((total) => total.unit === unit)?.quantity ?? '0');
    let reserved = 0n;
    for (const id of this.store.listContractIds({openOnly: true})) {
      const contract = this.store.getContract(id);
      if (contract?.mode !== 'live' || contract.buyerId !== entityId || contract.terms.assetUnit !== unit) continue;
      for (const milestone of contract.milestones) reserved += BigInt(milestone.amountAtomic);
    }
    return {deposited, reserved, available: deposited - reserved};
  }

  /** KYC only. Contract key registration uses it. */
  kyc(entityId: string, now: string, requiredTier?: KycTier): KycGateResult {
    const entity = this.store.getEntity(entityId);
    const profile = entity ? this.store.getKycProfile(entityId) : undefined;
    const reRegisteredFrom = profile?.reRegistrationOf ?
      this.store.getEntity(profile.reRegistrationOf) : undefined;
    return checkKyc({entityId, entity, profile, reRegisteredFrom}, now, {requiredTier});
  }

  /** Score snapshot and terms for one party. A party without KYC gets tier none terms. */
  party(
    entityId: string, role: EntityRole, category: ReliabilityCategory, now: string,
    requiredTier?: KycTier,
  ): PartyCheck {
    const kyc = this.kyc(entityId, now, requiredTier);
    const state = this.store.getReliabilityState(entityId, category, role) ??
      this.policies.scoring.initialState(entityId, category, role, now);
    const score = this.policies.scoring.scoreView(state);
    const decision = this.policies.fees.decide({
      entityId, category, score,
      kycTier: kyc.passed ? kyc.tier : 'none',
      repeatPairCount: 0,
      inputs: {eventCount: state.eventCount, purpose: 'deal_check'},
      now,
    });
    return {entityId, role, category, kyc, wallet: this.wallet(entityId), score, decision, limit: decision.terms.limit};
  }

  /** Checks every rule and returns all violations. */
  checkDeal(input: DealInput): DealCheck {
    const category = input.category ?? categoryForType(input.type);
    const currency = input.currency ?? 'USD';
    const decimals = MARKETPLACE_CURRENCIES.get(currency);
    const violations: DealViolation[] = [];
    if (input.buyerId === input.sellerId) {
      violations.push({code: 'same_party', message: 'the buyer and the seller must be different entities'});
    }
    if (decimals === undefined) {
      violations.push({
        code: 'currency_not_supported',
        message: `currency ${currency} has no recorded rate; use ${[...MARKETPLACE_CURRENCIES.keys()].join(' or ')}`,
      });
    }
    const value = input.value;
    const knownValue = typeof value === 'number' && Number.isFinite(value) && value >= 0;
    if (!knownValue) {
      violations.push({code: 'value_required', message: 'a sale needs a non-negative value to check limits and fees'});
    }
    const buyer = this.party(input.buyerId, 'buyer', category, input.now, input.requiredKycTier);
    const seller = this.party(input.sellerId, 'seller', category, input.now, input.requiredKycTier);
    for (const party of [buyer, seller]) {
      if (!party.kyc.passed) {
        violations.push({code: party.kyc.code ?? 'kyc_not_verified', party: party.role, message: party.kyc.message});
      } else if (!party.wallet.passed) {
        violations.push({code: 'wallet_required', party: party.role, message: party.wallet.message});
      } else if (knownValue && value > party.limit) {
        violations.push({
          code: 'exposure_limit', party: party.role,
          message: `${party.entityId} has a ${party.role} limit of ${party.limit} ${currency} in ${category}; the sale is ${value}`,
        });
      }
    }
    if (input.liveDeposit && buyer.kyc.passed) {
      const funds = this.availableDeposit(input.buyerId, input.liveDeposit.unit);
      if (funds.available < input.liveDeposit.quantity) {
        violations.push({
          code: 'deposit_required', party: 'buyer',
          message: `${input.buyerId} has ${funds.available} available of ${input.liveDeposit.unit} (deposited ${funds.deposited}, reserved ${funds.reserved}); the contract needs ${input.liveDeposit.quantity}`,
        });
      }
    }
    if (input.type === 'invoice') {
      violations.push(...this.invoiceViolations(input.buyerId, buyer, input.terms, input.now));
    }
    if (input.listing) {
      const listing = input.listing;
      if (listing.sellerId !== input.sellerId) {
        violations.push({code: 'listing_seller', party: 'seller', message: `listing ${listing.id} belongs to ${listing.sellerId}`});
      }
      if (listing.minBuyerReliability !== undefined && buyer.score.lowerBound < listing.minBuyerReliability) {
        violations.push({
          code: 'listing_buyer_reliability', party: 'buyer',
          message: `listing ${listing.id} needs a buyer lower bound of ${listing.minBuyerReliability}; ${input.buyerId} has ${round(buyer.score.lowerBound)}`,
        });
      }
      if (listing.minSellerReliability !== undefined && seller.score.lowerBound < listing.minSellerReliability) {
        violations.push({
          code: 'listing_seller_reliability', party: 'seller',
          message: `listing ${listing.id} needs a seller lower bound of ${listing.minSellerReliability}; ${input.sellerId} has ${round(seller.score.lowerBound)}`,
        });
      }
    }
    return {
      allowed: violations.length === 0, category, currency, decimals: decimals ?? 2,
      value: knownValue ? value : undefined, buyer, seller, violations,
    };
  }

  /** Throws MarketplaceRuleError when any rule fails. */
  assertDeal(input: DealInput): DealCheck {
    const check = this.checkDeal(input);
    if (!check.allowed) throw new MarketplaceRuleError(check.violations);
    return check;
  }

  /** Due-date rules for an invoice issued at `issuedAt`. */
  invoiceTermsViolations(
    buyerId: string, terms: {[key: string]: JsonValue}|undefined, issuedAt: string,
  ): DealViolation[] {
    const buyer = this.party(buyerId, 'buyer', 'payment', issuedAt);
    return this.invoiceViolations(buyerId, buyer, terms, issuedAt);
  }

  private invoiceViolations(
    buyerId: string, buyer: PartyCheck, terms: {[key: string]: JsonValue}|undefined, now: string,
  ): DealViolation[] {
    const dueDate = terms?.dueDate;
    if (typeof dueDate !== 'string' || Number.isNaN(Date.parse(dueDate))) {
      return [{code: 'due_date_required', message: 'an invoice needs terms.dueDate as an ISO time'}];
    }
    const days = (Date.parse(dueDate) - Date.parse(now)) / DAY_MS;
    if (days <= 0) return [{code: 'due_date_in_past', message: 'the invoice due date must be after the issue time'}];
    const allowed = buyer.decision.terms.paymentDays;
    if (days > allowed) {
      return [{
        code: 'payment_terms_exceed_limit', party: 'buyer',
        message: `${buyerId} can receive at most ${allowed} payment days; the invoice gives ${Math.ceil(days)}`,
      }];
    }
    return [];
  }
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** JSON copy of the accepted fees for the agreed terms. */
export function platformFeeTerms(charge: FeeCharge): {[key: string]: JsonValue} {
  return {
    version: charge.version,
    currency: charge.currency,
    decimals: charge.decimals,
    principalMinor: charge.principalMinor,
    buyerFeeBps: charge.buyer.feeBps,
    buyerFeeMinor: charge.buyer.feeMinor,
    sellerFeeBps: charge.seller.feeBps,
    sellerFeeMinor: charge.seller.feeMinor,
    buyerTotalMinor: charge.buyerTotalMinor,
    sellerNetMinor: charge.sellerNetMinor,
    rounding: charge.rounding,
    collection: charge.collection,
    refundRule: charge.refundRule,
  };
}

/** JSON copy of both parties' score-based terms for the agreed terms. */
export function reliabilityTerms(check: DealCheck): {[key: string]: JsonValue} {
  const side = (party: PartyCheck): {[key: string]: JsonValue} => ({
    entityId: party.entityId,
    lowerBound: party.score.lowerBound,
    kycTier: party.kyc.tier,
    limit: party.limit,
    deposit: party.decision.terms.deposit,
    premium: party.decision.terms.premium,
    paymentDays: party.decision.terms.paymentDays,
    verificationFrequency: party.decision.terms.verificationFrequency,
    reasonCode: party.decision.reasonCode,
    policyVersion: party.decision.policyVersion,
  });
  return {category: check.category, buyer: side(check.buyer), seller: side(check.seller)};
}

/** Accepted fee charges on one store. */
export class FeeBook {
  constructor(private readonly store: AgentStore) {}

  /**
   * Charge for one sale from a passed deal check. Contract milestones pass
   * their atomic amount and the asset decimals.
   */
  quote(
    check: DealCheck, transactionId: string, at: string,
    amount: {principalMinor?: bigint; decimals?: number} = {},
  ): FeeCharge {
    const decimals = amount.decimals ?? check.decimals;
    const principal = amount.principalMinor ?? toMinorUnits(check.value ?? 0, decimals);
    return quoteFeeCharge({
      transactionId, category: check.category, currency: check.currency, decimals,
      principalMinor: principal,
      buyer: {entityId: check.buyer.entityId, score: check.buyer.score, decision: check.buyer.decision},
      seller: {entityId: check.seller.entityId, score: check.seller.score, decision: check.seller.decision},
      at,
    });
  }

  accept(charge: FeeCharge): FeeCharge {
    this.store.insertFeeCharge(charge);
    return charge;
  }

  get(transactionId: string): FeeCharge|undefined {
    return this.store.getFeeCharge(transactionId);
  }

  /**
   * Collects on success, waives on failure or cancellation, and refunds a
   * collected charge after a correction. Safe to repeat.
   */
  settle(transactionId: string, outcome: Outcome|undefined, settledBy: string): FeeCharge|undefined {
    const charge = this.store.getFeeCharge(transactionId);
    if (!charge || !outcome) return charge;
    const next = settleFeeCharge(charge, outcome.state, outcome.decidedAt, settledBy);
    if (next === charge) return charge;
    this.store.settleFeeCharge(next, charge.status);
    return this.store.getFeeCharge(transactionId);
  }
}
