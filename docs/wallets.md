# Wallet accounts and live deposits

A Tally account is a Cardano wallet. A person signs in with the wallet, passes KYC, and deposits test funds for live deals.
Tally never holds a wallet key.

Sign-in and KYC write account records. They move no funds.
Deposits are **live**: they are real Cardano preprod transactions with test ADA or test USDM.
Paper deals need no deposit.

## Get a wallet

The Account page (`/account` in the web app) offers three ways:

| Way | Keys | Proof |
| --- | --- | --- |
| Connect Lace, Eternl, or another [CIP-30](https://cips.cardano.org/cip/CIP-0030) wallet set to Preprod | Stay in the wallet extension | The stake key signs. The proof covers every address of the wallet |
| Create a wallet in the browser | Derived in the browser from a new 24-word phrase ([CIP-1852](https://cips.cardano.org/cip/CIP-1852)). Any Cardano wallet can restore the phrase | The stake key signs |
| Restore a wallet from a recovery phrase | Same as above | The stake key signs |

A browser wallet keeps its phrase on the device, encrypted with a password that the user chooses (PBKDF2-SHA-256 and AES-GCM).
Tally never receives the phrase or the password.
The written phrase is the only backup.

Every way signs in with the stake address (`stake_test1…`).
A stake address cannot receive funds.
Send test funds to a receive address (`addr_test1…`) on Preprod.
The **Receive test funds** section on the Account page shows the receive address:

- A browser wallet: the base address of the wallet on this device.
- A wallet extension: the extension's change address, after you select **Show my receive address**.
  The page shows it only if its stake part matches a proven stake address.

A signed-in account can add more wallets.
A wallet belongs to one account.

## Sign in

1. The browser asks for a challenge: `POST /reliability/wallets/challenge` with the address.
2. The wallet signs the challenge message ([CIP-8](https://cips.cardano.org/cip/CIP-0008) COSE_Sign1, the CIP-30 `signData` format).
3. `POST /reliability/wallets/verify` checks the signature, the key, and the address.
   The first sign-in creates an entity. Later sign-ins open the same entity.
4. The response holds a session token. Send it as `Authorization: Bearer <token>`.

[`wallet-proof.ts`](../services/reliability/wallet-proof.ts) verifies the signature.
A stake (reward) address proves the stake key. A base or enterprise address proves the payment key of that address.

## KYC

`POST /reliability/account/kyc` submits the mock check for the signed-in entity and resolves it at once.
Read [Mock KYC](kyc.md) for the tiers and the demo prefixes.

## Deposits

Send test USDM or test ADA to the Tally deposit address from a wallet that you signed in with.
Two ways:

- From the Account page. Tally builds the unsigned transaction. The wallet signs it in the browser. Tally adds the signature and sends it.
- From any wallet app. Use a wallet that you signed in with.

The deposit worker ([`deposit-watcher.ts`](../services/reliability/deposit-watcher.ts)) reads the deposit address through Blockfrost.

| Case | Result |
| --- | --- |
| Every input comes from one account's proven wallet | `pending`, then `confirmed` after `TALLY_DEPOSIT_CONFIRMATIONS` blocks (default 3) |
| An input comes from no proven wallet, or inputs come from two accounts | `unattributed`. An operator reviews it. It is credited if its sender later proves the wallet |
| A pending deposit leaves the chain | `rolled_back`. It is credited if the same transaction comes back on the chain |
| The transaction spends from the deposit address | Not a deposit |

The balance is the sum of confirmed deposits, less what the account's live contracts as buyer hold or spent.
An open live contract reserves its full amount.
A closed live contract spends each funded milestone amount, less the refunds to the buyer.
A refund and a milestone that was never funded leave the balance.

A deposit that the chain rejects with HTTP 400 returns `deposit_rejected`. Start it again.
A full mempool or a rate limit keeps the deposit build available until it expires. Retry the same build.
See the [Blockfrost error codes](https://github.com/blockfrost/openapi/blob/master/openapi.yaml).

The worker remembers each transaction while it stays in the scan window.
A steady pass makes two Blockfrost calls, so the default 20-second pace stays inside the free daily quota.

## Checks on every deal

The marketplace gate runs before every sale, offer, invoice, and contract.
Read [Marketplace rules](marketplace.md).

- KYC, always.
- A proven wallet, when `MARKETPLACE_REQUIRE_WALLET=on`. Code `wallet_required`.
- Contract key registration: the payout address must be a proven wallet of the entity, when `MARKETPLACE_REQUIRE_WALLET=on`.
- A live contract: the buyer's available balance must cover it. Code `deposit_required`. The message names no balance, because the requester can be the other party.

## Security

- Tally stores no wallet key, phrase, or password.
- A challenge works once, for one address, for 10 minutes. It names the website (`TALLY_SIGN_IN_DOMAIN`) and says that signing moves no funds.
- A session lasts 24 hours. Tally stores only the SHA-256 of the token. Sign-out ends it.
- Each visitor has limits per 10 minutes: 20 sign-in requests, 10 KYC checks, 20 deposit requests, and 300 account reads.
  The limiter keeps at most 10,000 visitors and drops the oldest one when it is full.
- An ended session token does not block a new sign-in.
- To add a new payment key to an account with a proven stake key, sign in with the stake key first.
- After you link the payment key, it can sign in to the same account.
- Tally checks every wallet signature against the transaction body before it sends a deposit.
- The UI server forwards only the account routes in `ACCOUNT_ROUTES`, only a well-formed Bearer token, and bodies up to 256 KiB.
  Only the web app origins in `TALLY_WEB_ORIGINS` may call them from a browser.
- The web app on Vercel sends a Content-Security-Policy and refuses framing. Read [`vercel.json`](../vercel.json).

Not built: sign-in rate limits that survive a restart, a way to remove a wallet, and operator tools for unattributed deposits.

## Settings

| Setting | Where | Purpose |
| --- | --- | --- |
| `TALLY_DEPOSIT_ADDRESS` | Control API and deposit worker | Public preprod address that receives deposits. Empty turns deposits off. A bad deposit setting turns deposits off in the control API and is logged. The deposit worker stops |
| `BLOCKFROST_PROJECT_ID`, or `blockfrost_preprod` in `TALLY_SECRETS_DIR` | Control API and deposit worker | Chain reads and sends |
| `TALLY_DEPOSIT_CONFIRMATIONS` | Both | Blocks before a deposit is credited. Default 3 |
| `MARKETPLACE_REQUIRE_WALLET` | Control API | `on` makes every deal need a proven wallet |
| `TALLY_SIGN_IN_DOMAIN` | Control API | Website named in the sign-in message. Default `tally-origins.vercel.app` |
| `CONTROL_API_HOST` | Control API | Listening address. Default `127.0.0.1`. The account rate limits trust the visitor header that the UI server sets, so keep the control API private |
| `DEPOSIT_POLL_MS` | Deposit worker | Time between passes. Default 20000 |
| `TALLY_WEB_ORIGINS` | UI server | Web app origins that may call chat, accounts, and app routes |
| `VITE_TALLY_SERVER_URL` | Web app build | Server for account routes and app deal routes |

Run the worker:

```sh
bun run deposits:status
bun run deposits:worker
```

Migration `017_wallet_accounts.sql` holds challenges, wallet proofs, sessions, deposits, and deposit submissions.

## Signed-in app deals

`VITE_TALLY_EDITION=app` builds the signed-in website.
The demo remains a paper showcase with a "Viewing as" lens.
The app shows only the session entity's own deals.
Its Mediation and Operator routes are absent.
Read [Two Amplify editions](amplify.md).

Every `/reliability/app/*` route needs a live Bearer session.
The server takes the caller's entity from that session.
A party cannot read another deal's terms, audit, evidence, or anchors.
Those requests return 404.
An action with a different `partyId` returns 403.
App requests cannot set `at` or move the paper clock.
The app exposes no tick, ruling, two-sided agreement, or mutual termination route.
Public company records and sandbox drafts remain readable.

### Set up deal signing

Pass mock KYC on Account.
Select **Set up deal signing**.
The wallet signs this exact message with CIP-30 `signData` or the browser wallet's `signMessage`:

```text
Tally deal key v1
Account: <entityId>
Site: <TALLY_SIGN_IN_DOMAIN>
This creates your Tally deal signing key. It moves no funds. Sign this only on <domain>.
```

Both domain placeholders use the server's `TALLY_SIGN_IN_DOMAIN` value.
The client reads it from `/reliability/app/me`.
The message has no final newline.
The client extracts the final 64 signature bytes from COSE_Sign1 (`58 40` plus the bytes).
SHA-256 of those bytes supplies the Ed25519 seed.
The same account, site, wallet key, and CIP-8 signing bytes produce the same deal key on another device.
Keep the site domain stable after registration.
A wallet implementation that encodes different protected signing headers can produce another key.
Use the original wallet signing implementation in that case.

The client registers only the public key and preprod payout address with `POST /reliability/app/party`.
The payout is the extension's change address or the browser wallet's base address.
The address must start with `addr_test1`.
The app always checks that the entity proved this address.
It makes that check even if the demo wallet gate is off.
Repeating the same registration succeeds.
A different key or address returns `party_exists`.
Deal keys cannot be replaced in this build.
Use the original wallet for later actions.

The private deal key stays in browser memory for one action.
The client clears its seed after the request.
It never stores or sends the private key.
A registered deal key is frozen into each contract's terms.
The client signs the UTF-8 `termsBytes` from the session-gated terms route.
For actions, it uses the engine's RFC 8785 canonical JSON and evidence SHA-256 hashes.
Read [the canonical JSON specification](https://www.rfc-editor.org/rfc/rfc8785).

This derivation has a trade-off.
Anyone who gets the user to sign this exact message can derive the deal key.
The message names the account and site to reduce this risk.
Sign it only on that site.
The derivation message moves no funds.
The later signed deal action can instruct the escrow.

### App readiness and limits

Account shows wallet proof, mock KYC, and the registered deal key.
It adds a deposit step in live mode.
Paper deals simulate escrow and need no deposit.
Live deals use real Cardano preprod transactions with test funds.
No mainnet mode is supported.

The app UI gate accepts only listed app methods.
It forwards only a well-formed Bearer token and a server-set visitor address.
It forwards no cookie or client identity header.
Its app body limit is 1,500,000 bytes to allow base64 evidence.
Each engine evidence item remains limited to 1 MiB.
App reads and writes share the 300-request account read limit per visitor per 10 minutes.
The existing account limits remain in place.

The app server, contract worker, and deposit worker use a separate SQLite database.
The app database has no showcase seed.
Live contracts need `bun run contracts:worker`.
The app deposit worker must use the app's dedicated preprod pool.
Read [the server setup](../deploy/preprod/README.md#app-edition-server).
Tier 1 two-sided outcome agreement, mutual termination, and inspector templates are not in the app yet.
