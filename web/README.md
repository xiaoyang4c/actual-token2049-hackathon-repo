# Tally web app

A front end for Tally: deals, contracts, the mediation desk, company records, the Deal Desk, Ask a
Coworker, the Coworkers and the operator ledger. It reads the control API and never signs, funds or
submits a contract action. Its one input is Ask a Coworker, a free preview that pays and stores nothing.

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
| Contract | Funds flow, escrows, evidence, signed terms, deadlines, obligations, reliability record, audit chain | `contracts`, `contracts/case`, `contracts/audit` |
| Mediation | Dispute queue, evidence with signer checks, both simulated rulings, the bytes a mediator signs | `contracts/case`, `contracts/ruling-options`, `contracts/ruling-payload` |
| Companies | Search, KYC, live and simulated record, scores, fee offers, deals | `profile/search`, `profile` |
| Deal Desk | Four-step contract draft: escrows, payouts per outcome, Tier 1 options, timeline, fees | `contracts/draft-templates`, `contracts/draft` |
| Ask a Coworker | Deal Desk, Mediator or Trust Check answers a request, fill-in format or plain English | `POST /coworkers/ask`, `GET /coworkers/ask?id=` |
| Coworkers | The three Coworkers, their tools, the Masumi payment flow, registrations | static |
| Operator | Transactions with receipts, outcomes and KYC that need attention, participants and scores, listings | `transactions`, `receipts`, `entities`, `scores`, `listings` |

All control API routes are under `/reliability/` and are GET. `contracts/draft` runs `createContract`
in an in-memory sandbox through `CoworkerTools.draftContract` and stores nothing.

Coworker answers are untrusted model text. The Ask view renders them as Markdown with raw HTML skipped
and links and images shown as plain text, the same rule as `ui/markdown.js`.

## Stack

Vite, React 19, Tailwind v4, shadcn/ui on Base UI, lucide icons, motion, react-markdown, and ReactBits
components (Waves, ScrollReveal, Stepper, SpotlightCard, AnimatedList, CountUp, DecryptedText) restyled
for the white-to-gray theme. Type: Unbounded, Sora, JetBrains Mono.
