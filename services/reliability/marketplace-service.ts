/**
 * @fileoverview Marketplace writes: listings and buyer offers.
 *
 * A seller with KYC creates a listing. A buyer makes an offer on a stored
 * listing. The offer records a fee quote from both score snapshots at that
 * time. The seller accepts or declines. The buyer can withdraw. Acceptance
 * runs the marketplace checks again with fresh snapshots and opens the
 * sale: an escrow lifecycle sale for goods and services, or an invoice.
 * Every opened sale is paper.
 */

import {randomUUID} from 'node:crypto';
import type {AgentStore} from '../../packages/db/src/index';
import {categoryForType} from '../../packages/reliability/src/event-flow';
import type {FeeCharge} from '../../packages/reliability/src/fee-charges';
import {
  decideOffer, effectiveOfferStatus, OfferError, type Offer,
} from '../../packages/reliability/src/offers';
import type {
  JsonValue, Listing, TransactionType,
} from '../../packages/reliability/src/types';
import type {InvoiceService} from './invoice-service';
import type {LifecycleService} from './lifecycle-service';
import {
  FeeBook, MARKETPLACE_CURRENCIES, MarketplaceGate, MarketplaceRuleError, type DealCheck,
} from './marketplace-gate';

const TRANSACTION_TYPES: readonly TransactionType[] = ['goods', 'service', 'invoice'];

export interface CreateListingInput {
  id?: string;
  sellerId: string;
  transactionType: TransactionType;
  title: string;
  /** Price in major units of `currency`. */
  price: number;
  currency?: string;
  pricingMethod?: string;
  requiredTerms?: {[key: string]: JsonValue};
  minBuyerReliability?: number;
  minSellerReliability?: number;
  at: string;
}

export interface MakeOfferInput {
  id?: string;
  listingId: string;
  buyerId: string;
  /** Defaults to the listing price. */
  price?: number;
  terms?: {[key: string]: JsonValue};
  expiresAt?: string;
  at: string;
}

/** Transaction id that an accepted offer opens. */
export function offerTransactionId(offerId: string): string {
  return `offer-${offerId}`;
}

function bound(value: number|undefined, label: string): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new OfferError('invalid_input', `${label} must be between zero and one`);
  }
}

/** Listings and offers on one store. */
export class MarketplaceService {
  private readonly gate: MarketplaceGate;
  private readonly fees: FeeBook;

  constructor(
    private readonly store: AgentStore,
    private readonly sales: LifecycleService,
    private readonly invoices: InvoiceService,
  ) {
    this.gate = sales.gate;
    this.fees = sales.fees;
  }

  /** Creates a listing for a seller with KYC. */
  createListing(input: CreateListingInput): Listing {
    if (typeof input.title !== 'string' || input.title.trim() === '') {
      throw new OfferError('invalid_input', 'title is required');
    }
    if (!TRANSACTION_TYPES.includes(input.transactionType)) {
      throw new OfferError('invalid_input', 'transactionType must be goods, service, or invoice');
    }
    if (!Number.isFinite(input.price) || input.price <= 0) {
      throw new OfferError('invalid_input', 'price must be a positive number');
    }
    const currency = input.currency ?? 'USD';
    if (!MARKETPLACE_CURRENCIES.has(currency)) {
      throw new OfferError('invalid_input', `currency ${currency} is not supported`);
    }
    bound(input.minBuyerReliability, 'minBuyerReliability');
    bound(input.minSellerReliability, 'minSellerReliability');
    const id = input.id ?? randomUUID();
    return this.store.transaction(() => {
      if (this.listing(id)) throw new OfferError('conflict', `listing ${id} already exists`);
      const seller = this.gate.party(input.sellerId, 'seller', categoryForType(input.transactionType), input.at);
      if (!seller.kyc.passed) {
        throw new MarketplaceRuleError([{code: seller.kyc.code ?? 'kyc_not_verified', party: 'seller', message: seller.kyc.message}]);
      }
      if (input.minSellerReliability !== undefined && seller.score.lowerBound < input.minSellerReliability) {
        throw new MarketplaceRuleError([{
          code: 'listing_seller_reliability', party: 'seller',
          message: `${input.sellerId} has a seller lower bound below ${input.minSellerReliability}`,
        }]);
      }
      const listing: Listing = {
        id, sellerId: input.sellerId, transactionType: input.transactionType, title: input.title,
        price: input.price,
        ...(input.pricingMethod ? {pricingMethod: input.pricingMethod} : {}),
        requiredTerms: {...input.requiredTerms, currency},
        ...(input.minBuyerReliability === undefined ? {} : {minBuyerReliability: input.minBuyerReliability}),
        ...(input.minSellerReliability === undefined ? {} : {minSellerReliability: input.minSellerReliability}),
        createdAt: input.at,
      };
      this.store.saveListing(listing);
      return listing;
    });
  }

  /** Records a buyer offer after the marketplace checks. */
  makeOffer(input: MakeOfferInput): Offer {
    const listing = this.listing(input.listingId);
    if (!listing) throw new OfferError('not_found', `unknown listing ${input.listingId}`);
    const price = input.price ?? listing.price;
    if (price === undefined || !Number.isFinite(price) || price <= 0) {
      throw new OfferError('invalid_input', 'price must be a positive number');
    }
    if (input.expiresAt !== undefined &&
        !(Date.parse(input.expiresAt) > Date.parse(input.at))) {
      throw new OfferError('invalid_input', 'expiresAt must be after the offer time');
    }
    const terms: {[key: string]: JsonValue} = {...input.terms};
    for (const [key, value] of Object.entries(listing.requiredTerms)) {
      if (terms[key] !== undefined && JSON.stringify(terms[key]) !== JSON.stringify(value)) {
        throw new OfferError('invalid_input', `the listing fixes ${key}`);
      }
      terms[key] = value;
    }
    const currency = typeof terms.currency === 'string' ? terms.currency : 'USD';
    const id = input.id ?? randomUUID();
    return this.store.transaction(() => {
      if (this.store.getOffer(id)) throw new OfferError('conflict', `offer ${id} already exists`);
      const check = this.gate.assertDeal({
        type: listing.transactionType, buyerId: input.buyerId, sellerId: listing.sellerId,
        value: price, currency, terms, listing, now: input.at,
      });
      const offer: Offer = {
        id, listingId: listing.id, buyerId: input.buyerId, sellerId: listing.sellerId,
        transactionType: listing.transactionType, price, currency, terms, status: 'open',
        quote: this.fees.quote(check, offerTransactionId(id), input.at),
        ...(input.expiresAt ? {expiresAt: input.expiresAt} : {}),
        createdAt: input.at,
      };
      this.store.insertOffer(offer);
      return offer;
    });
  }

  /**
   * Accepts an open offer as the listing seller. Opens the sale with fresh
   * checks. Nothing changes when a check fails.
   */
  acceptOffer(input: {offerId: string; sellerId: string; at: string}): {
    offer: Offer; transactionId: string; feeCharge: FeeCharge|null; check: DealCheck|null;
  } {
    const offer = this.requireOffer(input.offerId);
    if (offer.sellerId !== input.sellerId) throw new OfferError('forbidden', 'only the listing seller can accept the offer');
    const listing = this.listing(offer.listingId);
    if (!listing) throw new OfferError('not_found', `listing ${offer.listingId} no longer exists`);
    const transactionId = offerTransactionId(offer.id);
    return this.store.transaction(() => {
      const accepted = decideOffer(offer, 'accepted', input.at, {transactionId});
      let feeCharge: FeeCharge|null;
      let check: DealCheck|null = null;
      if (offer.transactionType === 'invoice') {
        const dueDate = offer.terms.dueDate;
        if (typeof dueDate !== 'string') throw new OfferError('invalid_input', 'an invoice offer needs terms.dueDate');
        const graceHours = offer.terms.graceHours;
        feeCharge = this.invoices.issue({
          id: transactionId, buyerId: offer.buyerId, sellerId: offer.sellerId,
          invoiceNumber: typeof offer.terms.invoiceNumber === 'string' ? offer.terms.invoiceNumber : `INV-${offer.id}`,
          amount: offer.price, currency: offer.currency, dueDate,
          ...(typeof graceHours === 'number' ? {graceHours} : {}),
          listing, at: input.at,
        }).feeCharge;
      } else {
        const opened = this.sales.openTransaction({
          id: transactionId, type: offer.transactionType, buyerId: offer.buyerId, sellerId: offer.sellerId,
          terms: {...offer.terms, listingId: listing.id, offerId: offer.id}, value: offer.price,
          at: input.at, listing,
        });
        feeCharge = opened.feeCharge;
        check = opened.check;
      }
      if (!this.store.updateOpenOffer(accepted, input.at)) {
        throw new OfferError('conflict', `offer ${offer.id} changed during acceptance`);
      }
      return {offer: accepted, transactionId, feeCharge, check};
    });
  }

  /** Declines an open offer as the listing seller. */
  declineOffer(input: {offerId: string; sellerId: string; reason?: string; at: string}): Offer {
    const offer = this.requireOffer(input.offerId);
    if (offer.sellerId !== input.sellerId) throw new OfferError('forbidden', 'only the listing seller can decline the offer');
    return this.close(offer, 'declined', input.at, input.reason);
  }

  /** Withdraws an open offer as its buyer. */
  withdrawOffer(input: {offerId: string; buyerId: string; reason?: string; at: string}): Offer {
    const offer = this.requireOffer(input.offerId);
    if (offer.buyerId !== input.buyerId) throw new OfferError('forbidden', 'only the buyer can withdraw the offer');
    return this.close(offer, 'withdrawn', input.at, input.reason);
  }

  /** Offer with its status at `now`. */
  getOffer(id: string, now: string): Offer {
    const offer = this.requireOffer(id);
    return {...offer, status: effectiveOfferStatus(offer, now)};
  }

  listOffers(filter: {listingId?: string; buyerId?: string; sellerId?: string}, now: string): Offer[] {
    return this.store.listOffers(filter).map((offer) => ({...offer, status: effectiveOfferStatus(offer, now)}));
  }

  private close(offer: Offer, status: 'declined'|'withdrawn', at: string, reason?: string): Offer {
    const closed = decideOffer(offer, status, at, reason ? {reason} : {});
    if (!this.store.updateOpenOffer(closed, at)) throw new OfferError('conflict', `offer ${offer.id} changed`);
    return closed;
  }

  private requireOffer(id: string): Offer {
    const offer = this.store.getOffer(id);
    if (!offer) throw new OfferError('not_found', `unknown offer ${id}`);
    return offer;
  }

  private listing(id: string): Listing|undefined {
    return this.store.listListings().find((listing) => listing.id === id);
  }
}
