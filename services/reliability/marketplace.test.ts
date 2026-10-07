/**
 * @fileoverview Listings, offers, invoices, and fee lookups through the
 * marketplace routes. Escrow is simulated. Invoices use the paper source.
 * No external API calls.
 */

import {describe, expect, test} from 'bun:test';
import {AgentStore} from '../../packages/db/src/index';
import type {Entity} from '../../packages/reliability/src/types';
import {createSimulatedMasumiEscrow} from './masumi-escrow';
import {createLaneARoutes} from './routes-lane-a';
import {createMarketplaceRoutes} from './routes-marketplace';
import {createPlumbingRoutes} from './routes-plumbing';
import type {ReliabilityRoute} from './route';

const NOW = '2026-10-07T00:00:00.000Z';
const WINDOW = '2026-10-14T00:00:00.000Z';

type Body = {[key: string]: unknown};

function setup(): {store: AgentStore; routes: ReliabilityRoute[]} {
  const store = AgentStore.open();
  const options = {clock: () => NOW, escrowForStore: createSimulatedMasumiEscrow};
  return {
    store,
    routes: [...createPlumbingRoutes(), ...createMarketplaceRoutes(options), ...createLaneARoutes(options)],
  };
}

function party(store: AgentStore, id: string, overrides: Partial<Entity> = {}): void {
  store.insertEntity({
    id, displayName: id, wallets: [], roles: ['buyer', 'seller'],
    kycStatus: 'verified', kycTier: 'basic', createdAt: NOW, ...overrides,
  });
}

async function call(
  routes: ReliabilityRoute[], store: AgentStore, path: string, body?: Body,
): Promise<{status: number; body: Body}> {
  const method = body === undefined ? 'GET' : 'POST';
  const url = new URL(path, 'http://localhost');
  const route = routes.find((entry) => entry.method === method && entry.path === url.pathname);
  if (!route) throw new Error(`missing route ${method} ${url.pathname}`);
  const response = await route.handler(new Request(url, body === undefined ? {} : {
    method, headers: {'content-type': 'application/json'}, body: JSON.stringify(body),
  }), url, store);
  return {status: response.status, body: await response.json() as Body};
}

describe('listings and offers', () => {
  test('runs a goods listing from offer to a settled sale with collected fees', async () => {
    const {store, routes} = setup();
    try {
      party(store, 'shop');
      party(store, 'alice');
      party(store, 'mallory', {kycStatus: 'unverified', kycTier: 'none'});
      const refusedListing = await call(routes, store, '/reliability/listings', {
        sellerId: 'mallory', transactionType: 'goods', title: 'Cable', price: 40, at: NOW,
      });
      expect(refusedListing.status).toBe(403);

      const listed = await call(routes, store, '/reliability/listings', {
        id: 'cable', sellerId: 'shop', transactionType: 'goods', title: 'USB cable', price: 40,
        requiredTerms: {delivery: {deliverBy: WINDOW, minimumTier: 'buyer_confirmation'}}, at: NOW,
      });
      expect(listed.status).toBe(200);
      expect(listed.body.listing).toMatchObject({id: 'cable', requiredTerms: {currency: 'USD'}});
      const stored = await call(routes, store, '/reliability/listings?id=cable');
      expect(stored.body).toMatchObject({id: 'cable', sellerId: 'shop', price: 40});

      expect((await call(routes, store, '/reliability/offers', {
        listingId: 'cable', buyerId: 'mallory', at: NOW,
      })).status).toBe(403);
      expect((await call(routes, store, '/reliability/offers', {
        listingId: 'cable', buyerId: 'alice', terms: {delivery: {deliverBy: NOW}}, at: NOW,
      })).status).toBe(400);
      const offered = await call(routes, store, '/reliability/offers', {
        id: 'o1', listingId: 'cable', buyerId: 'alice', price: 38, at: NOW,
      });
      expect(offered.status).toBe(200);
      expect(offered.body.offer).toMatchObject({
        status: 'open', price: 38, sellerId: 'shop', quote: {principalMinor: '3800', transactionId: 'offer-o1'},
      });

      expect((await call(routes, store, '/reliability/offers/accept', {offerId: 'o1', sellerId: 'alice', at: NOW})).status)
        .toBe(403);
      const accepted = await call(routes, store, '/reliability/offers/accept', {offerId: 'o1', sellerId: 'shop', at: NOW});
      expect(accepted.status).toBe(200);
      expect(accepted.body).toMatchObject({
        transactionId: 'offer-o1', offer: {status: 'accepted', transactionId: 'offer-o1'},
        feeCharge: {status: 'accepted', principalMinor: '3800'},
      });
      expect((await call(routes, store, '/reliability/offers/accept', {offerId: 'o1', sellerId: 'shop', at: NOW})).status)
        .toBe(409);
      const sale = store.getTransaction('offer-o1')!;
      expect(sale.terms).toMatchObject({listingId: 'cable', offerId: 'o1', currency: 'USD'});
      expect(sale.value).toBe(38);

      for (const step of [
        {action: 'fund', amountLovelace: 38_000_000, sellerReturnAddress: 'addr_test1_shop', disputeWindowEnds: WINDOW},
        {action: 'deliver', evidence: {deliveryTier: 'buyer_confirmation', confirmedBy: 'alice'}},
        {action: 'release'},
      ]) {
        const moved = await call(routes, store, '/reliability/lifecycle/transition', {...step, transactionId: 'offer-o1', at: NOW});
        expect(moved.status).toBe(200);
      }
      const fees = await call(routes, store, '/reliability/fees?transactionId=offer-o1');
      expect(fees.body.status).toBe('collected');
      expect(store.getReliabilityState('shop', 'delivery', 'seller')?.eventCount).toBe(1);
    } finally {
      store.close();
    }
  });

  test('checks delivery evidence against the listing terms', async () => {
    const {store, routes} = setup();
    try {
      party(store, 'shop');
      party(store, 'alice');
      await call(routes, store, '/reliability/listings', {
        id: 'lamp', sellerId: 'shop', transactionType: 'goods', title: 'Lamp', price: 20,
        requiredTerms: {delivery: {deliverBy: '2026-10-08T00:00:00.000Z', carriers: ['DHL']}}, at: NOW,
      });
      await call(routes, store, '/reliability/offers', {id: 'o2', listingId: 'lamp', buyerId: 'alice', at: NOW});
      await call(routes, store, '/reliability/offers/accept', {offerId: 'o2', sellerId: 'shop', at: NOW});
      await call(routes, store, '/reliability/lifecycle/transition', {
        action: 'fund', transactionId: 'offer-o2', amountLovelace: 20_000_000,
        sellerReturnAddress: 'addr_test1_shop', disputeWindowEnds: WINDOW, at: NOW,
      });
      const lateCarrier = await call(routes, store, '/reliability/lifecycle/transition', {
        action: 'deliver', transactionId: 'offer-o2', at: '2026-10-09T00:00:00.000Z',
        evidence: {deliveryTier: 'carrier_proof', carrier: 'DHL', proofRef: 'track-9'},
      });
      expect(lateCarrier.status).toBe(400);
      expect(String(lateCarrier.body.error)).toContain('only the buyer can accept it');
      const accepted = await call(routes, store, '/reliability/lifecycle/transition', {
        action: 'deliver', transactionId: 'offer-o2', at: '2026-10-09T00:00:00.000Z',
        evidence: {deliveryTier: 'buyer_confirmation', confirmedBy: 'alice'},
      });
      expect(accepted.status).toBe(200);
      expect(accepted.body.transition).toMatchObject({evidence: {onTime: false, termsCheck: 'delivery-terms-check-v1'}});
    } finally {
      store.close();
    }
  });

  test('declines, withdraws, and expires offers once', async () => {
    const {store, routes} = setup();
    try {
      party(store, 'shop');
      party(store, 'alice');
      await call(routes, store, '/reliability/listings', {
        id: 'mug', sellerId: 'shop', transactionType: 'goods', title: 'Mug', price: 12, at: NOW,
      });
      for (const id of ['d', 'w', 'e']) {
        await call(routes, store, '/reliability/offers', {
          id, listingId: 'mug', buyerId: 'alice', at: NOW,
          ...(id === 'e' ? {expiresAt: '2026-10-07T01:00:00.000Z'} : {}),
        });
      }
      const declined = await call(routes, store, '/reliability/offers/decline', {
        offerId: 'd', sellerId: 'shop', reason: 'sold out', at: NOW,
      });
      expect(declined.body.offer).toMatchObject({status: 'declined', reason: 'sold out'});
      expect((await call(routes, store, '/reliability/offers/withdraw', {offerId: 'w', buyerId: 'shop', at: NOW})).status)
        .toBe(403);
      expect((await call(routes, store, '/reliability/offers/withdraw', {offerId: 'w', buyerId: 'alice', at: NOW})).body.offer)
        .toMatchObject({status: 'withdrawn'});
      const late = '2026-10-07T02:00:00.000Z';
      expect((await call(routes, store, '/reliability/offers/accept', {offerId: 'e', sellerId: 'shop', at: late})).status)
        .toBe(409);
      const listed = await call(routes, store, `/reliability/offers?listingId=mug&now=${late}`);
      expect((listed.body as unknown as {id: string; status: string}[]).map((offer) => `${offer.id}:${offer.status}`))
        .toEqual(['d:declined', 'e:expired', 'w:withdrawn']);
      expect(store.getTransaction('offer-e')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test('applies listing minimum reliabilities to offers', async () => {
    const {store, routes} = setup();
    try {
      party(store, 'shop');
      party(store, 'alice');
      await call(routes, store, '/reliability/listings', {
        id: 'vip', sellerId: 'shop', transactionType: 'goods', title: 'Bulk order', price: 100,
        minBuyerReliability: 0.3, at: NOW,
      });
      const refused = await call(routes, store, '/reliability/offers', {listingId: 'vip', buyerId: 'alice', at: NOW});
      expect(refused.status).toBe(403);
      expect(refused.body.violations).toEqual([expect.objectContaining({code: 'listing_buyer_reliability', party: 'buyer'})]);
    } finally {
      store.close();
    }
  });
});

describe('invoices', () => {
  test('issues an invoice from an accepted offer and scores an on-time payment', async () => {
    const {store, routes} = setup();
    try {
      party(store, 'supplier');
      party(store, 'retailer');
      await call(routes, store, '/reliability/listings', {
        id: 'net10', sellerId: 'supplier', transactionType: 'invoice', title: 'Stock order on net 10', price: 900,
        at: NOW,
      });
      const tooLong = await call(routes, store, '/reliability/offers', {
        listingId: 'net10', buyerId: 'retailer', terms: {dueDate: '2026-10-30T00:00:00.000Z'}, at: NOW,
      });
      expect(tooLong.status).toBe(403);
      expect(tooLong.body.violations).toEqual([expect.objectContaining({code: 'payment_terms_exceed_limit'})]);
      await call(routes, store, '/reliability/offers', {
        id: 'inv', listingId: 'net10', buyerId: 'retailer',
        terms: {dueDate: '2026-10-15T00:00:00.000Z', invoiceNumber: 'INV-77'}, at: NOW,
      });
      const accepted = await call(routes, store, '/reliability/offers/accept', {offerId: 'inv', sellerId: 'supplier', at: NOW});
      expect(accepted.status).toBe(200);
      const issued = await call(routes, store, '/reliability/invoices?id=offer-inv');
      expect(issued.body).toMatchObject({
        mode: 'paper', invoice: {invoiceNumber: 'INV-77', amountMinor: '90000', dueDate: '2026-10-15T00:00:00.000Z'},
        outcome: {state: 'pending'}, feeCharge: {status: 'accepted'},
      });
      expect(issued.body.termsHash).toMatch(/^[0-9a-f]{64}$/);

      const settled = await call(routes, store, '/reliability/invoices/settle', {
        transactionId: 'offer-inv', reference: 'bank-ref-1', settledAt: '2026-10-14T00:00:00.000Z', at: NOW,
      });
      expect(settled.status).toBe(200);
      expect(settled.body).toMatchObject({
        outcome: {state: 'successful', evidence: {onTime: true, settlementVerified: false, mode: 'paper'}},
        feeCharge: {status: 'collected'},
        settlement: {reference: 'bank-ref-1', verified: false, mode: 'paper'},
      });
      const buyer = store.getReliabilityState('retailer', 'payment', 'buyer')!;
      expect(buyer.alpha).toBeCloseTo(1 + Math.log1p(900 / 1000), 12);
      expect((await call(routes, store, '/reliability/invoices/settle', {
        transactionId: 'offer-inv', reference: 'bank-ref-1', settledAt: '2026-10-14T00:00:00.000Z', at: NOW,
      })).body.settlement).toMatchObject({reference: 'bank-ref-1'});
    } finally {
      store.close();
    }
  });

  test('fails an unpaid invoice after its deadline and refuses a reused payment', async () => {
    const {store, routes} = setup();
    try {
      party(store, 'supplier');
      party(store, 'retailer');
      for (const id of ['a', 'b']) {
        const issued = await call(routes, store, '/reliability/invoices', {
          id, buyerId: 'retailer', sellerId: 'supplier', invoiceNumber: `INV-${id}`, amount: 100,
          dueDate: '2026-10-12T00:00:00.000Z', graceHours: 12, at: NOW,
        });
        expect(issued.status).toBe(200);
      }
      await call(routes, store, '/reliability/invoices/settle', {
        transactionId: 'a', reference: 'pay-1', settledAt: '2026-10-10T00:00:00.000Z', at: NOW,
      });
      const reused = await call(routes, store, '/reliability/invoices/settle', {
        transactionId: 'b', reference: 'pay-1', settledAt: '2026-10-10T00:00:00.000Z', at: NOW,
      });
      expect(reused.status).toBe(409);
      const early = await call(routes, store, '/reliability/invoices/review', {transactionId: 'b', at: '2026-10-12T06:00:00.000Z'});
      expect((early.body.outcome as Body).state).toBe('pending');
      const overdue = await call(routes, store, '/reliability/invoices/review', {transactionId: 'b', at: '2026-10-13T00:00:00.000Z'});
      expect(overdue.body).toMatchObject({
        outcome: {state: 'failed', fault: 'buyer', decidedAt: '2026-10-12T12:00:00.000Z'},
        feeCharge: {status: 'waived'},
      });
      const buyer = store.getReliabilityState('retailer', 'payment', 'buyer')!;
      expect(buyer.beta).toBeGreaterThan(1);
      expect(store.getReliabilityState('supplier', 'payment', 'seller')?.eventCount).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe('fee quote', () => {
  test('previews checks and fees without writing', async () => {
    const {store, routes} = setup();
    try {
      party(store, 'shop');
      party(store, 'alice');
      const quote = await call(routes, store, `/reliability/fees/quote?type=goods&buyerId=alice&sellerId=shop&value=6000&now=${NOW}`);
      expect(quote.status).toBe(200);
      expect(quote.body).toMatchObject({allowed: false, category: 'delivery'});
      expect((quote.body.violations as Body[]).map((item) => item.code)).toEqual(['exposure_limit', 'exposure_limit']);
      expect(quote.body.charge).toMatchObject({principalMinor: '600000', status: 'accepted'});
      expect(store.getFeeCharge('quote')).toBeUndefined();
      expect((await call(routes, store, '/reliability/fees?transactionId=missing')).status).toBe(404);
    } finally {
      store.close();
    }
  });
});
