# Tally web app

A front end for Tally: deals, contracts, the mediation desk, company records, the Deal Desk, the
Coworker chat, the Coworkers and the operator ledger. It reads the control API and never signs, funds or
submits a contract action. Its one input is the Coworker chat. The chat is free. It pays and stores nothing.

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

## Views and routes

| View | What it shows | Routes |
| --- | --- | --- |
| Deals | Every milestone, its stage, who acts next and the deadline. "Viewing as" filters to one party | `contracts/list` |
| Contract | Funds flow, escrows, evidence, signed terms, deadlines, obligations, on-chain fingerprint, reliability record, audit chain | `contracts`, `contracts/case`, `contracts/audit`, `anchors/contract` |
| Mediation | Dispute queue, evidence with signer checks, both simulated rulings, the bytes a mediator signs | `contracts/case`, `contracts/ruling-options`, `contracts/ruling-payload` |
| Companies | Search, KYC, live and simulated record, on-chain record chain, scores, fee offers, deals | `profile/search`, `profile`, `anchors/company` |
| Deal Desk | Four-step contract draft: escrows, payouts per outcome, Tier 1 options, timeline, fees | `contracts/draft-templates`, `contracts/draft` |
| Chat | One chat for Deal Desk, Mediator and Trust Check. "Auto" picks the Coworker from the message. Follow-ups keep the thread. Fill-in format or plain English | `POST /coworkers/ask`, `GET /coworkers/ask?id=` |
| Coworkers | The three Coworkers, their tools, the Masumi payment flow, registrations | static |
| Operator | Transactions with receipts, outcomes and KYC that need attention, participants and scores, listings | `transactions`, `receipts`, `entities`, `scores`, `listings` |

All control API routes are under `/reliability/` and are GET. `contracts/draft` runs `createContract`
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
function on the Bun runtime. The function forwards allowlisted GET routes to the public EC2 demo.
The website and its hosted Coworker therefore use the same contract IDs.
`COWORKER_DEMO_URL` sets the read server. Its default matches the hosted chat address in `vercel.json`.
The proxy uses [Fetch](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API) with a five-second timeout.

The build runs [`api/_seed.ts`](../api/_seed.ts) to create a paper database for offline reads.
It contains six showcase contracts and their settlement fingerprints. The build sends nothing to the chain.
Each function instance uses the same fallback IDs.
The build sets `VITE_COWORKER_ASK_URL=https://13-210-42-0.sslip.io`. The browser then sends the chat
to the Coworker worker on the preprod server, which uses the Gemini model.
That server must list this site in `COWORKER_ASK_ORIGINS`. Read [the preprod server](../deploy/preprod/README.md#operator-ui).
When the hosted Coworker is offline, the chat goes to this function. It answers without a model in the same request.
The fallback accepts the fill-in format. Plain English gets the fill-in instructions.

Deploy production from `main`. Merge changes through a pull request.
In the Vercel project, open **Settings > Environments > Production > Branch Tracking**.
Set the production branch to `main` and save it. Later merges into `main` start production deployments.
If the merge already happened, create a deployment from `main` in the project's **Deployments** page.
Read the [Vercel Git deployment guide](https://vercel.com/docs/git#production-branch) for these project settings.
