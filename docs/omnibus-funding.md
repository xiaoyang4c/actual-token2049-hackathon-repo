# Paper omnibus funding

Build the funding boundary now. Add live custody later.

The current implementation is paper. It makes no chain transaction.
The addresses are opaque placeholders. They have no keys.

## Flow

```text
Business A deposit --\
                     +--> platform pool --> fresh deal address
Business B deposit --/
```

The internal ledger credits each business separately.
The ledger debits that business when it funds a deal.
One business cannot spend another business's credit.

`PaperOmnibusFunding` uses the shared `AgentStore` connection.
Migration `012_paper_omnibus_funding.sql` adds pools, deposits, and allocations.
The existing escrow adapter and lifecycle routes keep their current behavior.
There is no funding HTTP route.

## Run

```sh
bun run funding:demo
bun run funding:test
bun run typecheck:control
bun run lint
```

The demo credits two businesses to the same pool.
It allocates one fresh paper address per deal.
Each transfer view shows the same pool as its source.
It includes no business id, transaction id, deposit reference, or source wallet.
The demo prints internal balances separately.

## Contracts

Use `PaperOmnibusFunding.recordDeposit` for trusted simulation fixtures only.
It does not verify an on-chain deposit.
The business must already exist in the store.
The deposit source must start with `paper:business:`.
The pool address must start with `paper:pool:`.
The pool address cannot change after creation.

Use `fund` to allocate paper credit to a stored, incomplete marketplace deal.
The business must be the buyer of that deal.
This operation does not lock funds in Masumi escrow.
It does not deliver goods or settle payment.

Amounts are positive safe integers in lovelace.
Each credit and allocation commits in one SQLite transaction.
The transaction takes the write lock before it reads the balance.
Balances come from deposit and allocation records.
Records persist across restarts.

Each operation needs an idempotency key.
An exact retry returns the original record.
A retry can have a later request time. The saved time stays unchanged.
The store rejects a reused key with different financial fields.
The store credits each deposit transaction hash and output index once.
A deal can receive only one allocation, even with another key or pool.
Each deal address is random. It does not encode an entity or deal id.

The store contains the private business-to-deal mapping.
Do not expose those records in a public API or chain metadata.
The transfer projection does not make the existing entity routes private.

## Privacy limit

In a live implementation, a pool removes the direct business-to-deal transfer.
It does not guarantee that observers cannot connect a business to a deal.
Deposits into the pool remain public.
Amounts and timing can reveal a likely connection, especially with few users.
Cardano inputs, change outputs, and shared stake credentials can reveal links.
See [Cardano address structure, CIP-19](https://cips.cardano.org/cip/CIP-19).

The platform still knows who owns each balance and deal.
Describe the feature as pooled funding. Do not promise anonymity.

## Before live custody

The paper adapter cannot be enabled for live use with an environment flag.
A live implementation needs these components:

- A custody model and applicable legal review for pooled customer funds.
- Key management, signing limits, and secure deal wallet creation.
- Deposit attribution and verification of network, asset, destination, and amount.
- Confirmation rules and recovery from chain reorganizations.
- Durable reservations and transfer jobs with broadcast and confirmation states.
  An ambiguous broadcast must be reconciled before a retry or balance refund.
- Accounting for fees, minimum ADA, withdrawals, and confirmed refunds.
- Reconciliation of pool assets against business liabilities and pending transfers.
- Escrow integration that uses the funded deal wallet and preserves buyer identity internally.

Keep the paper allocation tables separate from live settlement records.
Do not treat a paper allocation as a confirmed chain payment.
