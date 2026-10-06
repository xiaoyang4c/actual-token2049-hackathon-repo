# Cardano and Masumi payment scaffolding

The payment service uses simulation by default. It does not call Cardano or
Masumi APIs in this mode. It does not load wallet secrets.

Run the complete offline flow:

```sh
bun run payments:demo
bun run payments:test
bun run payments:typecheck
```

The demo pays, confirms the simulated transaction, prepares scores, and commits
the receipt. It stores the receipt in `services/.data/cardano.sqlite`. Run it
again to replay the same receipt and response. It uses a fixed demo key.
It does not start the market feed or call an external API.

The tests run the **preprod adapters** against local protocol fixtures.
Fixture receipts have `simulated: true`. These tests verify integration behavior.
They do not prove settlement on the actual preprod chain.

## Adapters and configuration

`services/cardano-agent.ts` keeps the existing service routes. The implementation
is in `services/cardano-agents-ts`.

| Component | Interface and implementation |
| --- | --- |
| Cardano | `CardanoAdapter` reads balance, submits externally signed CBOR, and verifies deposits and settlement evidence. The preprod implementation uses `@blockfrost/blockfrost-js` 6.2.0. Settlement checks follow the receipt's escrow outputs and decoded datums through their transaction history. |
| Masumi | `MasumiAdapter` creates a seller payment request, queues a buyer purchase, reads buyer and seller state, queues a result hash, and requests a refund. Observation reads preserve transaction history, cooldowns, and action errors. |
| Storage | `AgentStore` stores payment and delivery fields. Migration 005 adds separate settlement summaries, durable schedules, and immutable observations. |

Use the [example configuration](../services/cardano-agents-ts/.env.example).
`CARDANO_MODE` selects `simulated` or `preprod`. Only `cardano-preprod` is supported.
`CARDANO_ALLOW_NETWORK` defaults to `false`. Preprod API calls fail with 503
while this setting is false. Construction and imports do not call APIs.
Tests inject fixture transports instead of enabling network access.

The [public adapter exports](../services/cardano-agents-ts/index.ts) include
`createBlockfrostSdk`. SDK initialization does not resolve credentials or make
requests. All SDK endpoint calls use the same guarded transport as the fixtures.
The SDK does not open a second connection outside that transport.
See the [Blockfrost SDK guide](https://github.com/blockfrost/blockfrost-js#readme).

Masumi payments use the typed REST adapter. The published
[`@masumi_network/identity-sdk`](https://github.com/masumi-network/masumi-identity-sdk)
covers identity and credentials. It does not supply the payment lifecycle used
here, so it is not an application dependency.

The `*_KEY_REF` settings name environment variables. They do not contain keys.
The adapters resolve a key only when they make a request. Keys do not enter
receipts, logs, or committed configuration. The buyer and seller use separate
Masumi credential references. Endpoint URLs cannot contain credentials.

For a future preprod run, supply a preprod Blockfrost project, a compatible
Masumi payment service, its buyer and seller API keys, a registered agent
identifier, and public preprod addresses. The registered score agent must charge
1 ADA. The configured `SCORE_PAY_TO` must match its seller return address.
Select the agent's Cardano payment source type. V2 also requires its supported
source index. Supply keys through the referenced environment variables.
Network calls require an explicit `CARDANO_ALLOW_NETWORK=true` setting.

Masumi submits the purchase transaction through its own configured wallet.
The paid-score flow does not also submit an ADA transfer through Blockfrost.
The separate Cardano submission method accepts an already signed transaction.
This repository does not create wallets or implement transaction signing.

## Verified Masumi protocol

The REST contract was checked against Masumi payment-service commit
[`69297f3`](https://github.com/masumi-network/masumi-payment-service/tree/69297f308f603bffbdfd4efccb54398eaff1bd87).
Recheck compatibility when upgrading the external service.

| Method | Verified endpoint and behavior |
| --- | --- |
| Create payment | `POST /api/v1/payment` creates a seller request. The request includes an input hash, purchaser nonce, agent identifier, source type, and deadlines. It returns a signed blockchain identifier and terms. |
| Purchase | `POST /api/v1/purchase` passes those terms, the seller verification key, and `Amounts`. ADA uses the empty asset unit. The service queues funds locking. |
| Read purchase | `POST /api/v1/purchase/resolve-blockchain-identifier` returns the purchase state and transaction history. The adapter selects the original `FundsLocked` transaction. |
| Submit result | `POST /api/v1/payment/submit-result` takes `submitResultHash`. It queues result submission. An accepted request does not prove on-chain result submission or withdrawal. |
| Request refund | `POST /api/v1/purchase/request-refund` queues the buyer's request. Collection occurs later through the applicable timed or authorized path. |
| Read settlement | Buyer and seller resolve endpoints accept `includeHistory: "true"`. The observer retains the full returned history and checks relevant Cardano transactions. |

The protocol uses the `token` authentication header and the `Preprod` network
name. Payment creation uses ISO dates. Purchase terms use millisecond timestamp
strings. Duplicate creation can return HTTP 409 with the existing record under
`object`. The adapter checks the returned terms before it uses them.

Inspect the pinned [OpenAPI contract](https://github.com/masumi-network/masumi-payment-service/blob/69297f308f603bffbdfd4efccb54398eaff1bd87/src/utils/generator/swagger-generator/openapi-docs.json),
[result endpoint](https://github.com/masumi-network/masumi-payment-service/blob/69297f308f603bffbdfd4efccb54398eaff1bd87/src/routes/api/payments/submit-result/index.ts),
and [duplicate response handler](https://github.com/masumi-network/masumi-payment-service/blob/69297f308f603bffbdfd4efccb54398eaff1bd87/packages/payment-core/src/endpoint-factory.ts).

Masumi escrow does not release immediately on payment verification. The local
states track request, submission, confirmation, and delivery separately.
`refund_requested` does not credit a wallet or claim a completed refund.
The service reconciles result submission, withdrawal, disputes, and refunds in
the background. See [Masumi settlement reconciliation](masumi-settlement.md)
for evidence requirements, state mappings, and retry behavior.

The demo retains its `X-PAYMENT` envelope for workflow compatibility. This is a
local receipt reference, not a standard Cardano x402 rail or a signed chain proof.
Masumi's upstream [x402 guide](https://github.com/masumi-network/masumi-payment-service/blob/69297f308f603bffbdfd4efccb54398eaff1bd87/docs/x402.md)
describes its separate EVM rail. Use the demo services within a trusted local
environment. They do not implement public authentication or caller isolation.

## Flow and restart recovery

1. Request `POST /score` without `X-PAYMENT` to get a quote and score input hash.
2. Send the quote and an idempotency key to `POST /pay`. The service commits a
   `requested` receipt before it creates a payment or queues a purchase.
3. Call `POST /confirm` with `receiptId`. A queued or unconfirmed payment returns
   402. Retry this call with the same receipt. Once Masumi reports a funds lock
   and Blockfrost confirms it, the service stores `confirmed`.
4. Retry `POST /score` with the returned `xPayment`. The provider verifies the
   resource, payee, amount, input hash, and on-chain payment. It prepares scores.
5. The provider calls `POST /deliver`. The service stores the exact response and
   its hash, queues the Masumi result, then commits `delivered` before returning
   scores. Repeated requests return the stored response.

CRE preserves the quote's `inputHash` when it calls `POST /pay`.
Paid quotes must include a SHA256 digest with 64 lowercase hex characters.
CRE audits and rejects missing or malformed hashes before it pays.

`delivered` means that the response is committed for return. It does not prove
that the client received it or that Masumi withdrew the funds. Result submission
is a queued action. `GET /receipts` includes a separate settlement summary.
`GET /settlement?receiptId=...` returns the summary and recent observations.
`POST /verify` confirms an undelivered payment. For delivered scores, it checks
the receipt proof and returns the stored response without an upstream read.
Replay remains available through a later dispute, refund, or API outage.
`POST /confirm` continues to check current payment evidence.

The service stores the nonce and deadlines before an external mutation. It also
saves a purchase-attempt marker before the purchase call. A lost response cannot
make an attempted purchase look unsubmitted. A retry
uses the same terms. It resolves an existing purchase after a lost response.
After a lost result response, it checks the queued or on-chain result hash before
submitting again. A changed payment key binding or score response returns 409.
Receipts also bind the wallet, agent, source, endpoint, and credential references.
The simulated balance comes from stored reservations, so a restart cannot reset
it. Preprod also reserves pending payment amounts locally.

Run one payment service writer for each database. Separate simulation and preprod
databases. Keep the database file between restarts. The background worker drains
before the service closes SQLite. Await `PaymentRuntime.close()` when using the
runtime directly. Legacy escrow receipts remain readable but cannot
authorize the new flow. The CRE workflow still writes its historical
`(escrowed)` audit label; use the receipt state for the current lifecycle.
