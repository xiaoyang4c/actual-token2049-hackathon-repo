# Tally web app

Tally has two web editions from the same source.
The public `/tutorial` route explains the showcase, test account setup, mock KYC, deal signing, and a two-party paper rehearsal.
The Tutorial link is visible in both editions.
Its account setup button opens <https://main.d35ht8wka9lmbz.amplifyapp.com>.
`VITE_TALLY_EDITION=demo`, or an unset flag, keeps the public paper showcase.
Its deal views remain read-only.
Account signs in with a wallet, submits mock KYC, and sends live preprod test deposits.
The Coworker chat remains a free read-only preview.

`VITE_TALLY_EDITION=app` enables signed-in deals.
My deals and New deal require a wallet session.
Only the buyer and seller can read a deal's private details.
The app hides the lens, Mediation, and Operator.
Account adds deal signing setup and a readiness checklist.
All funds are preprod test funds.
Read [Wallet accounts](../docs/wallets.md) for derivation and its signing-message risk.
Read [Two Amplify editions](../docs/amplify.md) for hosting.

## Run

```sh
CONTROL_DB_PATH=services/.data/agent.sqlite bun run contracts:showcase   # once: six paper contracts
bun run services                                                         # control API on :8787
cd web && bun install && bun run dev                                     # http://localhost:5190
```

The chat needs the Coworker worker with `COWORKER_ASK_PORT` set. The worker needs the preprod
secrets; read [the Coworker README](../services/reliability/coworkers/README.md#on-the-tally-website).

The dev server proxies `/reliability/*` to the control API (`TALLY_API_URL`, default
`http://127.0.0.1:8787`) and `/coworkers/ask` to the Coworker ask server (`COWORKER_ASK_URL`, default
`http://127.0.0.1:8792`), the same mapping as `ui/server.ts`. Without the worker, the chat says
that the Coworkers are offline; every other view works.

`VITE_COWORKER_ASK_URL` at build time sends the chat to another origin, for example the preprod server.
If that origin cannot be reached or says the Coworkers are offline, the chat uses `/coworkers/ask` on
its own origin.

`bun run build` type-checks and writes `dist/`. `bun run lint` runs oxlint.
`bun run test` renders the contract page with actual API responses from the paper showcase.
The tests cover outcomes that omit `fault`. The tests use a temporary database and remove it after the run.
CI runs all three checks. Read the [Bun testing guide](https://bun.com/docs/test/writing-tests) for the test runner.

The Deals and Operator filters wrap on narrow screens.
Their tab bars grow to keep each button inside the bar.
Read the [MDN flex-wrap guide](https://developer.mozilla.org/en-US/docs/Web/CSS/flex-wrap).

## Run the app edition

Set `CONTRACT_MEDIATOR_PUBLIC_KEY_HEX` to the mediator's raw Ed25519 public key first.
Keep that variable available to the control API and contract worker.
Start a separate app control API and UI gate before Vite:

```sh
TALLY_EDITION=app CONTROL_API_PORT=8797 CARDANO_AGENT_PORT=8799 CONTROL_DB_PATH=/tmp/tally-app/agent.sqlite TALLY_SIGN_IN_DOMAIN=localhost:5190 MARKETPLACE_REQUIRE_WALLET=on bun run services
TALLY_EDITION=app UI_PORT=8798 CONTROL_API_URL=http://127.0.0.1:8797 TALLY_WEB_ORIGINS=http://localhost:5190 bun run ui/server.ts
TALLY_EDITION=app CONTROL_DB_PATH=/tmp/tally-app/agent.sqlite bun run contracts:worker
cd web && VITE_TALLY_EDITION=app VITE_TALLY_SERVER_URL=http://127.0.0.1:8798 VITE_COWORKER_ASK_URL=http://127.0.0.1:8798 bun run dev
```

Run each process in a separate terminal.
These commands use paper escrow with test USDM and mock KYC.
Do not seed the app database.
The live preprod setup also needs the app deposit worker.

App routes are under `/reliability/app/`.
The client sends its Bearer token to the UI gate.
New deal uses the existing sandbox draft for payouts, deadlines, and fees.
It then creates a session-owned draft.
The deal page supports milestone selection, frozen terms, evidence files, and role-valid actions.
Each action derives a memory-only deal key with one wallet signing prompt.
The client signs the engine's canonical bytes and refreshes after submission.
The contract worker processes confirmations and deadlines.
Tier 1 two-sided agreement, mutual termination, and inspector templates are not in the app yet.

Run both builds:

```sh
cd web
bun run test
bun run lint
bun run build
VITE_TALLY_EDITION=app bun run build
```

## Demo views and routes

| View | What it shows | Routes |
| --- | --- | --- |
| Deals | Every milestone, its stage, who acts next and the deadline. "Viewing as" filters to one party | `contracts/list` |
| Contract | Funds flow, escrows, evidence, signed terms, deadlines, obligations, on-chain fingerprint, reliability record, audit chain | `contracts`, `contracts/case`, `contracts/audit`, `anchors/contract` |
| Mediation | Dispute queue, evidence with signer checks, both simulated rulings, the bytes a mediator signs | `contracts/case`, `contracts/ruling-options`, `contracts/ruling-payload` |
| Companies | Search, KYC, live and simulated record, on-chain record chain, scores, fee offers, deals | `profile/search`, `profile`, `anchors/company` |
| Deal Desk | Four-step contract draft: escrows, payouts per outcome, Tier 1 options, timeline, fees | `contracts/draft-templates`, `contracts/draft` |
| Chat | One chat for Deal Desk, Mediator and Trust Check. "Auto" picks the Coworker from the message. Follow-ups keep the thread. Fill-in format or plain English | `POST /coworkers/ask`, `GET /coworkers/ask?id=` |
| Coworkers | The three Coworkers, their tools, the Masumi payment flow, registrations | static |
| Account | Wallet sign-in (Lace, Eternl, or a wallet created in the browser), mock KYC, and live preprod deposits. Read [Wallet accounts](../docs/wallets.md) | `wallets/challenge`, `wallets/verify`, `account`, `account/kyc`, `account/deposits/*` |
| Operator | Transactions with receipts, outcomes and KYC that need attention, participants and scores, listings | `transactions`, `receipts`, `entities`, `scores`, `listings` |

All demo control API routes are under `/reliability/`. Demo deal reads use GET. Account writes need a wallet session.
App deal writes use POST with a session and, for terms and actions, an Ed25519 signature. `contracts/draft` runs `createContract`
in an in-memory sandbox through `CoworkerTools.draftContract` and stores nothing.

Coworker answers are untrusted model text. The chat renders them as Markdown with raw HTML skipped
and links and images shown as plain text, the same rule as `ui/markdown.js`. Cardanoscan links on
settlement anchors render only for a preprod transaction URL with a 64-hex id, as in `ui/tally-views.js`.

## Stack

Vite, React 19, Tailwind v4, shadcn/ui on Base UI, lucide icons, motion, react-markdown, and ReactBits
components (Waves, ScrollReveal, Stepper, SpotlightCard, AnimatedList, CountUp, DecryptedText) restyled
for the white-to-gray theme. Type: Unbounded, Sora, JetBrains Mono.

## Public demo on Vercel

<https://tally-origins.vercel.app> is built from this repository. [`vercel.json`](../vercel.json) builds
`web/` and routes `/reliability/*` and `/coworkers/ask` to [`api/demo.ts`](../api/demo.ts), a Vercel
function on the Bun runtime. It reads the EC2 showcase records at `https://13.210.42.0`.
`COWORKER_DEMO_URL` overrides that HTTPS endpoint.
The proxy uses [Fetch](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API) with a five-second timeout.
Retired server URLs are refused, including values left in hosting settings.

The build runs [`api/_seed.ts`](../api/_seed.ts) to create the paper database.
It contains six showcase contracts and their settlement fingerprints.
The build sends nothing to the chain. Each function instance uses the same fallback IDs.

Hosted chat and wallet accounts default to `https://13.210.42.0`.
`VITE_COWORKER_ASK_URL` and `VITE_TALLY_SERVER_URL` override that endpoint in hosting settings.
The preprod UI server must list this frontend in `TALLY_WEB_ORIGINS`.
When the hosted Coworker is offline, the Vercel function answers without a model.
Its fallback accepts the fill-in format. Plain English gets the fill-in instructions.

The CSP in `vercel.json` permits this origin and `https://13.210.42.0`.
Update `connect-src` when you configure another server.
The config also sets `X-Frame-Options: DENY` and `nosniff`.
Amplify uses its own API rewrites and security headers.
Read [the two Amplify setups](../docs/amplify.md).

Deploy production from `main`. Merge changes through a pull request.
In the Vercel project, open **Settings > Environments > Production > Branch Tracking**.
Set the production branch to `main` and save it. Later merges into `main` start production deployments.
If the merge already happened, create a deployment from `main` in the project's **Deployments** page.
Read the [Vercel Git deployment guide](https://vercel.com/docs/git#production-branch) for these project settings.
