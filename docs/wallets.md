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
| A pending deposit leaves the chain | `rolled_back` |
| The transaction spends from the deposit address | Not a deposit |

The balance is the sum of confirmed deposits.
A live contract reserves the buyer's balance until the contract closes.

## Checks on every deal

The marketplace gate runs before every sale, offer, invoice, and contract.
Read [Marketplace rules](marketplace.md).

- KYC, always.
- A proven wallet, when `MARKETPLACE_REQUIRE_WALLET=on`. Code `wallet_required`.
- Contract key registration: the payout address must be a proven wallet of the entity, when `MARKETPLACE_REQUIRE_WALLET=on`.
- A live contract: the buyer's confirmed deposits, less open live contracts, must cover it. Code `deposit_required`.

## Security

- Tally stores no wallet key, phrase, or password.
- A challenge works once, for one address, for 10 minutes. It names the website (`TALLY_SIGN_IN_DOMAIN`) and says that signing moves no funds.
- A session lasts 24 hours. Tally stores only the SHA-256 of the token. Sign-out ends it.
- Each visitor has limits per 10 minutes: 20 sign-in requests, 10 KYC checks, 20 deposit requests, and 300 account reads.
- Tally checks every wallet signature against the transaction body before it sends a deposit.
- The UI server forwards only the account routes in `ACCOUNT_ROUTES`, only a well-formed Bearer token, and bodies up to 256 KiB.
  Only the web app origins in `TALLY_WEB_ORIGINS` may call them from a browser.
- The web app on Vercel sends a Content-Security-Policy and refuses framing. Read [`vercel.json`](../vercel.json).

Not built: sign-in rate limits that survive a restart, a way to remove a wallet, and operator tools for unattributed deposits.

## Settings

| Setting | Where | Purpose |
| --- | --- | --- |
| `TALLY_DEPOSIT_ADDRESS` | Control API and deposit worker | Public preprod address that receives deposits. Empty turns deposits off |
| `BLOCKFROST_PROJECT_ID`, or `blockfrost_preprod` in `TALLY_SECRETS_DIR` | Control API and deposit worker | Chain reads and sends |
| `TALLY_DEPOSIT_CONFIRMATIONS` | Both | Blocks before a deposit is credited. Default 3 |
| `MARKETPLACE_REQUIRE_WALLET` | Control API | `on` makes every deal need a proven wallet |
| `TALLY_SIGN_IN_DOMAIN` | Control API | Website named in the sign-in message. Default `tally-origins.vercel.app` |
| `TALLY_WEB_ORIGINS` | UI server | Web app origins that may call the chat and account routes |
| `VITE_TALLY_SERVER_URL` | Web app build | Server for the account routes |

Run the worker:

```sh
bun run deposits:status
bun run deposits:worker
```

Migration `017_wallet_accounts.sql` holds challenges, wallet proofs, sessions, deposits, and deposit submissions.
