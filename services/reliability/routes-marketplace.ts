/**
 * @fileoverview Marketplace write and lookup routes: listings, offers,
 * invoices, and fees. Every sale is paper. These routes do not
 * authenticate callers yet. The seller and buyer ids in a request are
 * consistency checks, not proof of identity.
 */

import type {AgentStore} from '../../packages/db/src/index';
import type {EscrowPort} from '../../packages/reliability/src/escrow-port';
import {LifecycleError} from '../../packages/reliability/src/lifecycle';
import {OfferError} from '../../packages/reliability/src/offers';
import type {JsonValue, TransactionType} from '../../packages/reliability/src/types';
import {json} from '../lib/http';
import {InvoiceError, InvoiceService, type InvoiceSettlementSource} from './invoice-service';
import {optionalText, readBody, termsField, textField, transactionType} from './lifecycle-request';
import {LifecycleService} from './lifecycle-service';
import {MarketplaceRuleError} from './marketplace-gate';
import {MarketplaceService} from './marketplace-service';
import type {ReliabilityPolicies} from './policies';
import type {ReliabilityRoute} from './route';

const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  not_found: 404,
  invalid_input: 400,
  forbidden: 403,
  conflict: 409,
};

function fail(error: unknown): Response {
  if (error instanceof MarketplaceRuleError) {
    return json({error: error.message, code: 'deal_not_allowed', violations: error.violations}, 403);
  }
  if (error instanceof OfferError || error instanceof InvoiceError) {
    return json({error: error.message, code: error.code}, STATUS_BY_CODE[error.code] ?? 400);
  }
  if (error instanceof LifecycleError) {
    return json({error: error.message}, error.message.startsWith('unknown transaction') ? 404 : 400);
  }
  throw error;
}

function optionalNumber(body: {[key: string]: unknown}, key: string): number|undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new LifecycleError(`${key} must be a number`);
  return value;
}

function requiredNumber(body: {[key: string]: unknown}, key: string): number {
  const value = optionalNumber(body, key);
  if (value === undefined) throw new LifecycleError(`${key} must be a number`);
  return value;
}

function optionalTerms(value: unknown): {[key: string]: JsonValue}|undefined {
  return value === undefined ? undefined : termsField(value);
}

interface Services {
  market: MarketplaceService;
  invoices: InvoiceService;
  sales: LifecycleService;
}

export interface MarketplaceRouteOptions {
  policies?: ReliabilityPolicies;
  clock?: () => string;
  escrowForStore?: (store: AgentStore) => EscrowPort;
  settlementsForStore?: (store: AgentStore) => InvoiceSettlementSource;
  /** KYC, limits, and fee charges. Defaults to true. */
  enforceMarketplaceRules?: boolean;
}

/** Creates the routes with one service set per store. */
export function createMarketplaceRoutes(options: MarketplaceRouteOptions = {}): ReliabilityRoute[] {
  const cache = new WeakMap<AgentStore, Services>();
  const clock = options.clock ?? (() => new Date().toISOString());
  function servicesFor(store: AgentStore|undefined): Services {
    if (!store) throw new LifecycleError('the control store is required');
    const existing = cache.get(store);
    if (existing) return existing;
    const sales = new LifecycleService(store, {
      policies: options.policies, clock, escrow: options.escrowForStore?.(store),
      enforceMarketplaceRules: options.enforceMarketplaceRules,
    });
    const invoices = new InvoiceService(store, {
      policies: options.policies, enforceMarketplaceRules: options.enforceMarketplaceRules,
      settlements: options.settlementsForStore?.(store),
    });
    const created = {sales, invoices, market: new MarketplaceService(store, sales, invoices)};
    cache.set(store, created);
    return created;
  }

  function post(
    path: string, handle: (services: Services, body: {[key: string]: unknown}) => Promise<unknown>|unknown,
  ): ReliabilityRoute {
    return {
      method: 'POST', path,
      handler: async (request, url, store) => {
        try {
          const services = servicesFor(store);
          return json(await handle(services, await readBody(request)));
        } catch (error) {
          return fail(error);
        }
      },
    };
  }

  function get(path: string, handle: (services: Services, url: URL) => unknown): ReliabilityRoute {
    return {
      method: 'GET', path,
      handler: (request, url, store) => {
        try {
          return json(handle(servicesFor(store), url));
        } catch (error) {
          return fail(error);
        }
      },
    };
  }

  return [
    post('/reliability/listings', ({market}, body) => ({
      mode: 'paper',
      listing: market.createListing({
        id: optionalText(body, 'id'),
        sellerId: textField(body, 'sellerId'),
        transactionType: transactionType(textField(body, 'transactionType')),
        title: textField(body, 'title'),
        price: requiredNumber(body, 'price'),
        currency: optionalText(body, 'currency'),
        pricingMethod: optionalText(body, 'pricingMethod'),
        requiredTerms: optionalTerms(body.requiredTerms),
        minBuyerReliability: optionalNumber(body, 'minBuyerReliability'),
        minSellerReliability: optionalNumber(body, 'minSellerReliability'),
        at: textField(body, 'at'),
      }),
    })),
    post('/reliability/offers', ({market}, body) => ({
      mode: 'paper',
      offer: market.makeOffer({
        id: optionalText(body, 'id'),
        listingId: textField(body, 'listingId'),
        buyerId: textField(body, 'buyerId'),
        price: optionalNumber(body, 'price'),
        terms: optionalTerms(body.terms),
        expiresAt: optionalText(body, 'expiresAt'),
        at: textField(body, 'at'),
      }),
    })),
    post('/reliability/offers/accept', ({market}, body) => {
      const accepted = market.acceptOffer({
        offerId: textField(body, 'offerId'), sellerId: textField(body, 'sellerId'), at: textField(body, 'at'),
      });
      return {mode: 'paper', offer: accepted.offer, transactionId: accepted.transactionId, feeCharge: accepted.feeCharge};
    }),
    post('/reliability/offers/decline', ({market}, body) => ({
      offer: market.declineOffer({
        offerId: textField(body, 'offerId'), sellerId: textField(body, 'sellerId'),
        reason: optionalText(body, 'reason'), at: textField(body, 'at'),
      }),
    })),
    post('/reliability/offers/withdraw', ({market}, body) => ({
      offer: market.withdrawOffer({
        offerId: textField(body, 'offerId'), buyerId: textField(body, 'buyerId'),
        reason: optionalText(body, 'reason'), at: textField(body, 'at'),
      }),
    })),
    get('/reliability/offers', ({market}, url) => {
      const now = url.searchParams.get('now') ?? clock();
      const id = url.searchParams.get('id');
      if (id) return market.getOffer(id, now);
      return market.listOffers({
        listingId: url.searchParams.get('listingId') ?? undefined,
        buyerId: url.searchParams.get('buyerId') ?? undefined,
        sellerId: url.searchParams.get('sellerId') ?? undefined,
      }, now);
    }),
    post('/reliability/invoices', ({invoices}, body) => invoices.issue({
      id: textField(body, 'id'),
      buyerId: textField(body, 'buyerId'),
      sellerId: textField(body, 'sellerId'),
      invoiceNumber: textField(body, 'invoiceNumber'),
      amount: requiredNumber(body, 'amount'),
      currency: optionalText(body, 'currency'),
      dueDate: textField(body, 'dueDate'),
      graceHours: optionalNumber(body, 'graceHours'),
      description: optionalText(body, 'description'),
      at: textField(body, 'at'),
    })),
    post('/reliability/invoices/settle', ({invoices}, body) => invoices.settle({
      transactionId: textField(body, 'transactionId'),
      reference: textField(body, 'reference'),
      settledAt: optionalText(body, 'settledAt'),
      amountPaid: optionalNumber(body, 'amountPaid'),
      at: textField(body, 'at'),
    })),
    post('/reliability/invoices/review', ({invoices}, body) =>
      invoices.review(textField(body, 'transactionId'), textField(body, 'at'))),
    get('/reliability/invoices', ({invoices}, url) => {
      const id = url.searchParams.get('id');
      if (!id) throw new LifecycleError('id is required');
      return invoices.view(id);
    }),
    get('/reliability/fees', ({sales}, url) => {
      const transactionId = url.searchParams.get('transactionId');
      if (!transactionId) throw new LifecycleError('transactionId is required');
      const charge = sales.fees.get(transactionId);
      if (!charge) throw new OfferError('not_found', `no fee charge for ${transactionId}`);
      return charge;
    }),
    // Read-only preview of the checks and fees for a sale. Writes nothing.
    get('/reliability/fees/quote', ({sales}, url) => {
      const param = (key: string): string => {
        const value = url.searchParams.get(key);
        if (!value) throw new LifecycleError(`${key} is required`);
        return value;
      };
      const type: TransactionType = transactionType(param('type'));
      const value = Number(param('value'));
      const dueDate = url.searchParams.get('dueDate');
      const now = url.searchParams.get('now') ?? clock();
      const check = sales.gate.checkDeal({
        type, buyerId: param('buyerId'), sellerId: param('sellerId'),
        value: Number.isFinite(value) ? value : undefined,
        currency: url.searchParams.get('currency') ?? undefined,
        terms: dueDate ? {dueDate} : {}, now,
      });
      const side = (party: typeof check.buyer) => ({
        entityId: party.entityId, kyc: party.kyc, lowerBound: party.score.lowerBound,
        limit: party.limit, terms: party.decision.terms, reasonCode: party.decision.reasonCode,
      });
      return {
        allowed: check.allowed, violations: check.violations, category: check.category,
        buyer: side(check.buyer), seller: side(check.seller),
        charge: check.value === undefined ? null : sales.fees.quote(check, 'quote', now),
      };
    }),
  ];
}

export const marketplaceRoutes: ReliabilityRoute[] = createMarketplaceRoutes();
