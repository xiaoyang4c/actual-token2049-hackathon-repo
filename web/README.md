# Tally web app

A front end for Tally: deals, contracts, the mediation desk, company records, the Deal Desk, Ask a
Coworker, the Coworkers and the operator ledger. It reads the control API and never signs, funds or
submits a contract action. Ask a Coworker gives a free preview that pays and stores nothing.
The evidence checker accepts payment details through a GET read.

## Run

```sh
CONTROL_DB_PATH=services/.data/agent.sqlite bun run contracts:showcase   # once: six paper contracts
bun run services                                                         # control API on :8787
cd web && bun install && bun run dev                                     # http://localhost:5190
```

Ask a Coworker needs the Coworker worker with `COWORKER_ASK_PORT` set. The worker needs the preprod
secrets; read [the Coworker README](../services/reliability/coworkers/README.md#on-the-tally-website).

The dev server proxies `/reliability/*` to the control API (`TALLY_API_URL`, default
`http://127.0.0.1:8787`) and `/coworkers/ask` to the Coworker ask server (`COWORKER_ASK_URL`, default
`http://127.0.0.1:8792`), the same mapping as `ui/server.ts`. Without the worker, Ask a Coworker shows
that the Coworkers are offline; every other view works.

`bun run build` type-checks and writes `dist/`. `bun run lint` runs oxlint.

## Views and routes

| View | What it shows | Routes |
| --- | --- | --- |
| Deals | Every milestone, its stage, who acts next and the deadline. "Viewing as" filters to one party | `contracts/list` |
| Contract | Funds flow, escrows, evidence, signed terms, deadlines, obligations, on-chain fingerprint, reliability record, audit chain | `contracts`, `contracts/case`, `contracts/audit`, `anchors/contract` |
| Mediation | Dispute queue, evidence with signer checks, both simulated rulings, the bytes a mediator signs | `contracts/case`, `contracts/ruling-options`, `contracts/ruling-payload` |
| Companies | Search, KYC, live and simulated record, on-chain record chain, scores, fee offers, deals | `profile/search`, `profile`, `anchors/company` |
| Deal Desk | Four-step contract draft: escrows, payouts per outcome, Tier 1 options, timeline, fees | `contracts/draft-templates`, `contracts/draft` |
| Ask a Coworker | Deal Desk, Mediator or Trust Check answers a request, fill-in format or plain English | `POST /coworkers/ask`, `GET /coworkers/ask?id=` |
| Coworkers | The three Coworkers, their tools, the Masumi payment flow, registrations | static |
| Operator | Transactions with receipts, outcomes and KYC that need attention, participants and scores, listings | `transactions`, `receipts`, `entities`, `scores`, `listings` |
| Evidence checker | Recipient, net test USDM amount, and confirmations. Real CRE simulation with live preprod reads. No DON signature | `evidence/info`, `evidence/check` |

All control API routes are under `/reliability/` and are GET. `contracts/draft` runs `createContract`
in an in-memory sandbox through `CoworkerTools.draftContract` and stores nothing.

Coworker answers are untrusted model text. The Ask view renders them as Markdown with raw HTML skipped
and links and images shown as plain text, the same rule as `ui/markdown.js`. Cardanoscan links on
settlement anchors render only for a preprod transaction URL with a 64-hex id, as in `ui/tally-views.js`.

## Stack

Vite, React 19, Tailwind v4, shadcn/ui on Base UI, lucide icons, motion, react-markdown, and ReactBits
components (Waves, ScrollReveal, Stepper, SpotlightCard, AnimatedList, CountUp, DecryptedText) restyled
for the white-to-gray theme. Type: Unbounded, Sora, JetBrains Mono.

## Public demo on Vercel

<https://tally-origins.vercel.app> is built from this repository. [`vercel.json`](../vercel.json) builds
`web/` and routes `/reliability/*` and `/coworkers/ask` to [`api/demo.ts`](../api/demo.ts), a Vercel
function on the Bun runtime. The build runs [`api/_seed.ts`](../api/_seed.ts), which seeds one paper
database with the six showcase contracts and their settlement fingerprints (`submit: false`, nothing goes
to the chain), so every function instance serves the same ids. The function the control API's GET routes only. Ask a Coworker runs without a model and answers in the same
request, so the fill-in format works and plain English gets the fill-in instructions.

```sh
bunx vercel link --project tally-origins   # once
bunx vercel deploy --prod
```
