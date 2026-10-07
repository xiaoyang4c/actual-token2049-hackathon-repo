# Marketplace rules and writes

This page describes the checks before a sale opens, the accepted fees, listings, offers, invoices, and delivery terms.
Every order on this page is paper.
No route on this page moves money on a chain.
The routes do not authenticate callers yet.
A seller or buyer id in a request is a consistency check, not proof of identity.

All parameters are defaults.
The product owner has not selected them.
Read [Reliability math](reliability-math.md) for the formulas.

## Checks before a sale opens

The marketplace gate runs before these actions:

- `POST /reliability/lifecycle/open`
- `POST /reliability/offers` and `POST /reliability/offers/accept`
- `POST /reliability/invoices`
- `POST /reliability/contracts` (contract creation)

The gate checks both parties.
A sale opens only when every check passes.
A failed check returns HTTP 403 with a `violations` list.
Nothing is written when a check fails.

| Check | Rule | Violation code |
| --- | --- | --- |
| KYC | The entity counts as verified under `KYC_TIER_RULES`, inside the verification TTL. | `kyc_unknown_entity`, `kyc_not_verified`, `kyc_pending`, `kyc_rejected`, `kyc_expired` |
| KYC tier | A contract template can raise the tier with `minimumKycTier`. | `kyc_tier_too_low` |
| Wallet | With `MARKETPLACE_REQUIRE_WALLET=on`, the entity has a proven wallet. Read [Wallet accounts](wallets.md). | `wallet_required` |
| Live deposit | A live contract: the buyer's confirmed deposits, less its open live contracts, cover the contract. | `deposit_required` |
| Re-registration | An entity that re-registers a rejected identity cannot trade. | `kyc_reregistration_of_rejected` |
| Value | The sale has a non-negative value in `USD` or `USDM`. USDM counts one to one with USD. | `value_required`, `currency_not_supported` |
| Exposure | The value is at most each party's limit, $\min(E_{\max} L^\gamma, E_{\mathrm{KYC}})$. | `exposure_limit` |
| Invoice due date | The due date is after the issue time and inside the buyer's payment days. | `due_date_required`, `due_date_in_past`, `payment_terms_exceed_limit` |
| Listing | The buyer and seller lower bounds meet the listing minimums. | `listing_buyer_reliability`, `listing_seller_reliability` |

Each party's limit and payment days come from its own score in its own role and category.
A new verified entity has $L = 0.05$.
Its default limit is 5,000 and its default payment period is 10 days.
Tier `none` has a zero cap, so an entity without KYC has no limit.

Contract key registration (`POST /reliability/contracts/parties`) needs a KYC-verified entity.
It returns HTTP 403 with code `kyc_required` otherwise.
With `MARKETPLACE_REQUIRE_WALLET=on`, the payout address must be a proven wallet of the entity. Otherwise it returns HTTP 403 with code `wallet_required`.

## Accepted fees

When a sale opens, the platform records one fee charge for both participants.

- The buyer fee uses the buyer's buyer-role lower bound.
- The seller fee uses the seller's seller-role lower bound.
- Both snapshots come from before the sale opens.
- The buyer pays principal plus the buyer fee.
- The seller receives principal minus the seller fee.
- Amounts are integer minor units, rounded half up.

The charge goes into the agreed terms as `platformFees`.
The score-based terms of both parties go in as `reliabilityTerms`.
A terms amendment keeps both values. A request that changes them is refused.

| Charge status | Meaning |
| --- | --- |
| `accepted` | The sale is open. |
| `collected` | The sale succeeded and the seller was paid. |
| `waived` | The sale failed or was cancelled before collection. |
| `refunded` | A correction failed or cancelled a sale after collection. |

Contract milestones get one charge each.
The charge is not part of the escrow amount yet.

## Listings and offers

1. A seller with KYC creates a listing with `POST /reliability/listings`.
2. A buyer makes an offer with `POST /reliability/offers`. The offer keeps a fee quote.
3. The seller accepts with `POST /reliability/offers/accept` or declines with `POST /reliability/offers/decline`.
4. The buyer can withdraw an open offer with `POST /reliability/offers/withdraw`.

Listing `requiredTerms` are fixed. An offer cannot change them.
An offer with `expiresAt` expires at that time.
An offer changes status only once.

Acceptance runs the gate again with fresh snapshots.
It opens transaction `offer-<offerId>`:

- A goods or service listing opens a paper escrow lifecycle sale.
- An invoice listing issues an invoice. The offer terms need `dueDate`.

## Invoices

`POST /reliability/invoices` issues an invoice.
The platform hashes the canonical invoice terms, with the due date, and stores the hash on the transaction.

`POST /reliability/invoices/settle` records one payment.
The check compares the payment with the agreed terms:

- A full payment by the due date plus `graceHours` succeeds.
- A late or short payment fails the buyer.
- One payment reference cannot settle two invoices.

`POST /reliability/invoices/review` fails an unpaid invoice after its deadline.
The decision time is the deadline.

Paper payments record `settlementVerified: false`.
A live payment stays pending until a chain check confirms it.
No live invoice source exists yet. It needs the USDM receipt check.

## Delivery and acceptance terms

A goods sale can set `terms.delivery`.
A service sale can set `terms.service`.
The lifecycle checks `deliver` and silent `release` evidence against them.

| Term | Rule |
| --- | --- |
| `deliverBy` or `completeBy` | Later delivery needs the buyer's confirmation. |
| `minimumTier` | The evidence tier must be this tier or stronger. |
| `carriers` | Carrier proof must name a listed carrier. |
| `deliverableSha256` | The delivered file hash must match. |
| `acceptanceBy: "buyer"` | Only the buyer's confirmation accepts the service. |

Carrier proof never accepts a service.
The check adds `termsCheck` and `onTime` to the evidence.

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/reliability/listings` | Create a listing |
| `POST` | `/reliability/offers` | Make an offer |
| `POST` | `/reliability/offers/accept` | Accept an offer and open the sale |
| `POST` | `/reliability/offers/decline` | Decline an offer |
| `POST` | `/reliability/offers/withdraw` | Withdraw an offer |
| `GET` | `/reliability/offers` | Read offers by `id`, `listingId`, `buyerId`, or `sellerId` |
| `POST` | `/reliability/invoices` | Issue an invoice |
| `POST` | `/reliability/invoices/settle` | Record an invoice payment |
| `POST` | `/reliability/invoices/review` | Fail an unpaid invoice after its deadline |
| `GET` | `/reliability/invoices` | Read an invoice by `id` |
| `GET` | `/reliability/fees` | Read the fee charge for `transactionId` |
| `GET` | `/reliability/fees/quote` | Preview the checks and fees for a sale. Writes nothing. |
| `GET` | `/reliability/scores/explain` | Explain each score change for `entityId`, `category`, and `role` |
