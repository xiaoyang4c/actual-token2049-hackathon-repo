/**
 * @fileoverview Marketplace rules before a sale opens: KYC, exposure limits,
 * invoice payment days, listing minimums, and accepted fee charges.
 * Escrow is simulated. No external API calls.
 */

import {describe, expect, test} from 'bun:test';
import {AgentStore} from '../../packages/db/src/index';
import {TemplateRegistry} from '../../packages/reliability/src/contract-lifecycle/templates';
import type {Entity, KycTier, Listing} from '../../packages/reliability/src/types';
import {createKit} from './contract-kit';
import {ContractService} from './contract-service';
import {LifecycleService} from './lifecycle-service';
import {MarketplaceGate, MarketplaceRuleError} from './marketplace-gate';
import {createSimulatedMasumiEscrow} from './masumi-escrow';
import {DEFAULT_RELIABILITY_POLICIES} from './policies';

const NOW = '2026-10-07T00:00:00.000Z';
const WINDOW = '2026-10-14T00:00:00.000Z';

function party(store: AgentStore, id: string, overrides: Partial<Entity> = {}): void {
  store.insertEntity({
    id, displayName: id, wallets: [], roles: ['buyer', 'seller'],
    kycStatus: 'verified', kycTier: 'basic', createdAt: NOW, ...overrides,
  });
}

function codes(error: unknown): string[] {
  if (!(error instanceof MarketplaceRuleError)) throw error;
  return error.violations.map((violation) => `${violation.party ?? '-'}:${violation.code}`);
}

function refusal(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    return codes(error);
  }
  throw new Error('expected a marketplace rule error');
}

function service(store: AgentStore): LifecycleService {
  return new LifecycleService(store, {
    policies: DEFAULT_RELIABILITY_POLICIES, escrow: createSimulatedMasumiEscrow(store),
  });
}

describe('marketplace gate', () => {
  test('limits a new verified entity to E_max * L for its KYC tier', () => {
    const store = AgentStore.open();
    try {
      party(store, 'buyer');
      party(store, 'seller', {kycTier: 'enhanced'});
      const gate = new MarketplaceGate(store, DEFAULT_RELIABILITY_POLICIES);
      const check = gate.checkDeal({type: 'goods', buyerId: 'buyer', sellerId: 'seller', value: 100, now: NOW});
      expect(check.allowed).toBe(true);
      // L = 0.05 for the prior, so E = 100000 * 0.05 = 5000, under both caps.
      expect(check.buyer.limit).toBe(5000);
      expect(check.seller.limit).toBe(5000);
      expect(check.category).toBe('delivery');
      const large = gate.checkDeal({type: 'goods', buyerId: 'buyer', sellerId: 'seller', value: 6000, now: NOW});
      expect(large.violations.map((item) => `${item.party}:${item.code}`))
        .toEqual(['buyer:exposure_limit', 'seller:exposure_limit']);
    } finally {
      store.close();
    }
  });

  test('refuses unverified, pending, and rejected parties and gives them no limit', () => {
    const store = AgentStore.open();
    try {
      party(store, 'buyer', {kycStatus: 'unverified', kycTier: 'none'});
      party(store, 'seller', {kycStatus: 'rejected', kycTier: 'none'});
      const gate = new MarketplaceGate(store, DEFAULT_RELIABILITY_POLICIES);
      const check = gate.checkDeal({type: 'goods', buyerId: 'buyer', sellerId: 'seller', value: 10, now: NOW});
      expect(check.violations.map((item) => `${item.party}:${item.code}`))
        .toEqual(['buyer:kyc_not_verified', 'seller:kyc_rejected']);
      expect(check.buyer.limit).toBe(0);
      expect(check.buyer.decision.reasonCode).toBe('KYC_LIMIT');
    } finally {
      store.close();
    }
  });

  test('requires a value, a supported currency, and two different parties', () => {
    const store = AgentStore.open();
    try {
      party(store, 'buyer');
      const gate = new MarketplaceGate(store, DEFAULT_RELIABILITY_POLICIES);
      const check = gate.checkDeal({
        type: 'goods', buyerId: 'buyer', sellerId: 'buyer', value: undefined, currency: 'ADA', now: NOW,
      });
      expect(check.violations.map((item) => item.code))
        .toEqual(['same_party', 'currency_not_supported', 'value_required']);
    } finally {
      store.close();
    }
  });

  test('keeps an invoice due date inside the buyer payment days', () => {
    const store = AgentStore.open();
    try {
      party(store, 'buyer');
      party(store, 'seller');
      const gate = new MarketplaceGate(store, DEFAULT_RELIABILITY_POLICIES);
      const invoice = (dueDate?: string) => gate.checkDeal({
        type: 'invoice', buyerId: 'buyer', sellerId: 'seller', value: 100,
        terms: dueDate ? {dueDate} : {}, now: NOW,
      }).violations.map((item) => item.code);
      // A new buyer has L = 0.05, so t = round(7 + 53 * 0.05) = 10 days.
      expect(invoice('2026-10-17T00:00:00.000Z')).toEqual([]);
      expect(invoice('2026-10-18T00:00:00.000Z')).toEqual(['payment_terms_exceed_limit']);
      expect(invoice('2026-10-06T00:00:00.000Z')).toEqual(['due_date_in_past']);
      expect(invoice()).toEqual(['due_date_required']);
    } finally {
      store.close();
    }
  });

  test('applies listing minimum reliabilities and the listing seller', () => {
    const store = AgentStore.open();
    try {
      party(store, 'buyer');
      party(store, 'seller');
      const gate = new MarketplaceGate(store, DEFAULT_RELIABILITY_POLICIES);
      const listing: Listing = {
        id: 'l1', sellerId: 'seller', transactionType: 'goods', title: 'Cable', price: 10,
        requiredTerms: {}, minBuyerReliability: 0.2, minSellerReliability: 0.3, createdAt: NOW,
      };
      expect(gate.checkDeal({
        type: 'goods', buyerId: 'buyer', sellerId: 'seller', value: 10, listing, now: NOW,
      }).violations.map((item) => item.code)).toEqual(['listing_buyer_reliability', 'listing_seller_reliability']);
      expect(gate.checkDeal({
        type: 'goods', buyerId: 'buyer', sellerId: 'buyer', value: 10,
        listing: {...listing, minBuyerReliability: undefined, minSellerReliability: undefined}, now: NOW,
      }).violations.map((item) => item.code)).toContain('listing_seller');
    } finally {
      store.close();
    }
  });
});

describe('gated lifecycle open', () => {
  test('records the accepted fees and score-based terms with the sale', () => {
    const store = AgentStore.open();
    try {
      party(store, 'buyer');
      party(store, 'seller');
      const lifecycle = service(store);
      const {transaction, feeCharge} = lifecycle.openTransaction({
        id: 'sale', type: 'goods', buyerId: 'buyer', sellerId: 'seller',
        terms: {item: 'cable', platformFees: 'client value is ignored'}, value: 250, at: NOW,
      });
      // L = 0.05 (a hair above in floating point): buyer fee round(25 + 275 * 0.95) = 286 bps,
      // seller fee round(20 + 230 * 0.95) = round(238.4999...) = 238 bps.
      expect(feeCharge).toMatchObject({
        principalMinor: '25000', status: 'accepted', currency: 'USD',
        buyer: {feeBps: 286, feeMinor: '715'}, seller: {feeBps: 238, feeMinor: '595'},
        buyerTotalMinor: '25715', sellerNetMinor: '24405',
      });
      expect(transaction.terms.platformFees).toMatchObject({buyerFeeBps: 286, sellerFeeBps: 238});
      expect(transaction.terms.reliabilityTerms).toMatchObject({
        category: 'delivery', buyer: {limit: 5000, paymentDays: 10}, seller: {limit: 5000},
      });
      expect(transaction.versions[0]?.terms.platformFees).toEqual(transaction.terms.platformFees);
      expect(store.getFeeCharge('sale')).toEqual(feeCharge!);
    } finally {
      store.close();
    }
  });

  test('writes nothing when a rule fails', () => {
    const store = AgentStore.open();
    try {
      party(store, 'buyer');
      const lifecycle = service(store);
      expect(refusal(() => lifecycle.openTransaction({
        id: 'sale', type: 'goods', buyerId: 'buyer', sellerId: 'ghost', terms: {}, value: 10, at: NOW,
      }))).toEqual(['seller:kyc_unknown_entity']);
      expect(store.getTransaction('sale')).toBeUndefined();
      expect(store.getFeeCharge('sale')).toBeUndefined();
      expect(store.getEntity('ghost')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test('keeps the fixed fee terms through amendments', () => {
    const store = AgentStore.open();
    try {
      party(store, 'buyer');
      party(store, 'seller');
      const lifecycle = service(store);
      const {transaction} = lifecycle.openTransaction({
        id: 'sale', type: 'goods', buyerId: 'buyer', sellerId: 'seller', terms: {item: 'cable'}, value: 50, at: NOW,
      });
      const amended = lifecycle.amendTerms('sale', {item: 'two cables'}, 'quantity', NOW);
      expect(amended.terms.platformFees).toEqual(transaction.terms.platformFees);
      expect(amended.terms.item).toBe('two cables');
      expect(() => lifecycle.amendTerms('sale', {item: 'cable', platformFees: {buyerFeeBps: 1}}, 'cut fees', NOW))
        .toThrow('platformFees are fixed when the sale opens');
    } finally {
      store.close();
    }
  });

  test('collects fees when the seller is paid and waives them on a refund', async () => {
    const store = AgentStore.open();
    try {
      party(store, 'buyer');
      party(store, 'seller');
      const lifecycle = service(store);
      for (const id of ['paid', 'refunded']) {
        lifecycle.openTransaction({
          id, type: 'goods', buyerId: 'buyer', sellerId: 'seller', terms: {item: 'cable'}, value: 50, at: NOW,
        });
        await lifecycle.lifecycle.fund({
          transactionId: id, amountLovelace: 50_000_000, sellerReturnAddress: 'addr_test1_seller',
          disputeWindowEnds: WINDOW, at: NOW,
        });
      }
      lifecycle.lifecycle.confirmDelivery({
        transactionId: 'paid', at: NOW, evidence: {deliveryTier: 'buyer_confirmation', confirmedBy: 'buyer'},
      });
      await lifecycle.lifecycle.release({transactionId: 'paid', at: NOW});
      expect(lifecycle.view('paid', NOW).feeCharge?.status).toBe('collected');
      await lifecycle.lifecycle.refund({transactionId: 'refunded', at: NOW, reason: 'seller cannot ship'});
      const refunded = lifecycle.view('refunded', NOW);
      // A refund with no fault finding is a mutual end.
      expect(refunded.outcome.state).toBe('cancelled');
      expect(refunded.feeCharge?.status).toBe('waived');
    } finally {
      store.close();
    }
  });

  test('keeps the original demo behavior with enforcement off', () => {
    const store = AgentStore.open();
    try {
      const lifecycle = new LifecycleService(store, {
        escrow: createSimulatedMasumiEscrow(store), enforceMarketplaceRules: false,
      });
      const {feeCharge} = lifecycle.openTransaction({
        id: 'sale', type: 'goods', buyerId: 'buyer', sellerId: 'seller', terms: {}, at: NOW,
      });
      expect(feeCharge).toBeNull();
      expect(store.getEntity('buyer')?.kycStatus).toBe('unverified');
    } finally {
      store.close();
    }
  });
});

describe('gated contracts', () => {
  test('refuses key registration for an entity without KYC', () => {
    const kit = createKit();
    try {
      expect(() => kit.service.registerParty({
        entityId: 'stranger', publicKeyHex: kit.keys.judge.publicKeyHex, cardanoAddress: 'addr_test1_stranger',
      })).toThrow('stranger is not registered');
    } finally {
      kit.close();
    }
  });

  test('applies the template KYC tier and records fees for each milestone', () => {
    const kit = createKit();
    try {
      const registry = TemplateRegistry.fromDirectory();
      const digital = registry.get('digital-machine-checkable')!;
      registry.add({...digital, id: 'digital-enhanced', minimumKycTier: 'enhanced'});
      const gated = new ContractService(kit.store, {
        config: kit.service.config, clock: kit.clock, templates: registry,
      });
      const input = (templateId: string) => ({
        templateId, buyerId: kit.buyerId, sellerId: kit.sellerId,
        milestones: [
          {title: 'one', amountAtomic: '2000000', deliverable: {expectedSha256: 'a'.repeat(64)}},
          {title: 'two', amountAtomic: '1500000', deliverable: {expectedSha256: 'b'.repeat(64)}},
        ],
      });
      expect(refusal(() => gated.createContract(input('digital-enhanced'), kit.buyerId)))
        .toEqual(['buyer:kyc_tier_too_low', 'seller:kyc_tier_too_low']);
      const contract = gated.createContract(input('digital-machine-checkable'), kit.buyerId);
      const view = gated.view(contract.id) as {milestones: {feeCharge: {principalMinor: string; decimals: number}}[]};
      expect(view.milestones.map((milestone) => milestone.feeCharge.principalMinor)).toEqual(['2000000', '1500000']);
      expect(view.milestones[0]?.feeCharge.decimals).toBe(contract.terms.assetDecimals);
    } finally {
      kit.close();
    }
  });

  test('checks the contract total against each party limit', () => {
    const kit = createKit();
    try {
      for (const id of [kit.buyerId, kit.sellerId]) kit.store.updateEntityKyc(id, 'verified', 'basic' as KycTier);
      // 6000 USDM is above the 5000 limit of a new entity.
      expect(refusal(() => kit.service.createContract({
        templateId: 'digital-machine-checkable', buyerId: kit.buyerId, sellerId: kit.sellerId,
        milestones: [{title: 'big', amountAtomic: '6000000000', deliverable: {expectedSha256: 'c'.repeat(64)}}],
      }, kit.buyerId))).toEqual(['buyer:exposure_limit', 'seller:exposure_limit']);
    } finally {
      kit.close();
    }
  });
});
