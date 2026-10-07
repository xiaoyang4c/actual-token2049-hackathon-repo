/**
 * @fileoverview Buyer offers on marketplace listings.
 *
 * A buyer makes an offer on a listing. The listing seller accepts or
 * declines it. The buyer can withdraw an open offer. Acceptance opens a
 * marketplace transaction with the agreed terms and the accepted fee
 * charges. Only an open offer can change status, and only once.
 */

import type {FeeCharge} from './fee-charges';
import type {JsonValue, TransactionType} from './types';

export type OfferStatus = 'open'|'accepted'|'declined'|'withdrawn'|'expired';

export const OFFER_STATUSES: readonly OfferStatus[] = [
  'open', 'accepted', 'declined', 'withdrawn', 'expired',
];

/** One buyer offer. Amounts use the listing currency in major units. */
export interface Offer {
  id: string;
  listingId: string;
  buyerId: string;
  sellerId: string;
  transactionType: TransactionType;
  price: number;
  currency: string;
  terms: {[key: string]: JsonValue};
  status: OfferStatus;
  /** Fee quote at offer time. Acceptance takes a new snapshot. */
  quote: FeeCharge;
  expiresAt?: string;
  /** Transaction that acceptance opened. */
  transactionId?: string;
  reason?: string;
  createdAt: string;
  decidedAt?: string;
}

/** Error with a stable code for HTTP mapping. */
export class OfferError extends Error {
  constructor(
    readonly code: 'not_found'|'invalid_input'|'forbidden'|'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'OfferError';
  }
}

/** Status after `now` for an open offer with an expiry. */
export function effectiveOfferStatus(offer: Offer, now: string): OfferStatus {
  if (offer.status === 'open' && offer.expiresAt && Date.parse(now) >= Date.parse(offer.expiresAt)) {
    return 'expired';
  }
  return offer.status;
}

/** Moves an open offer to a final status. Throws for any other move. */
export function decideOffer(
  offer: Offer,
  status: Exclude<OfferStatus, 'open'>,
  at: string,
  details: {transactionId?: string; reason?: string} = {},
): Offer {
  const current = effectiveOfferStatus(offer, at);
  if (current !== 'open') throw new OfferError('conflict', `offer ${offer.id} is ${current}`);
  return {
    ...offer, status, decidedAt: at,
    ...(details.transactionId ? {transactionId: details.transactionId} : {}),
    ...(details.reason ? {reason: details.reason} : {}),
  };
}
