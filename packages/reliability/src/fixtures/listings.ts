/**
 * @fileoverview Seed listings for the read endpoints. Lane D owns this file.
 */

import type {Listing} from '../types';

/** Service listing with a minimum seller reliability. */
export const LISTING_SERVICE: Listing = {
  id: 'listing-service-1',
  sellerId: 'entity-established',
  transactionType: 'service',
  title: 'Monthly bookkeeping (up to 200 transactions)',
  price: 250,
  pricingMethod: 'fixed',
  requiredTerms: {
    deliveryDeadline: '2026-10-07T00:00:00.000Z',
    escrow: 'simulated',
  },
  minSellerReliability: 0.7,
  createdAt: '2026-10-04T00:00:00.000Z',
};

/** Invoice facility listing with a minimum buyer reliability. */
export const LISTING_INVOICE: Listing = {
  id: 'listing-invoice-1',
  sellerId: 'entity-established',
  transactionType: 'invoice',
  title: 'Net-30 invoice facility up to 5000',
  pricingMethod: 'variable-fee',
  requiredTerms: {paymentDays: 30, currency: 'USD'},
  minBuyerReliability: 0.5,
  createdAt: '2026-10-04T00:00:00.000Z',
};

/** Seed listings in a stable order for the read endpoints. */
export const FIXTURE_LISTINGS: Listing[] = [LISTING_SERVICE, LISTING_INVOICE];
