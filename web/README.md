# Tally web UI

A front end for the Tally contract engine: deals, contracts, the mediation desk, company records,
the Deal Desk and the Coworkers. Read-only. It never signs, funds or submits an action.

## Run

```sh
bun install && bun run services          # repo root: control API on :8787
CONTROL_DB_PATH=services/.data/agent.sqlite bun run contracts:showcase   # once: six paper contracts
cd web && bun install && bun run dev     # http://localhost:5190, proxies /reliability and /studio to :8787
```

Set `TALLY_API_URL` to proxy to another control API.

## Views and routes

| View | What it shows | Routes |
| --- | --- | --- |
| Deals | Every milestone, its stage, who acts next and the deadline. "Viewing as" filters to one party | `GET /reliability/contracts/list` |
| Contract | Funds flow, escrows, evidence, signed terms, deadlines, obligations, reliability record, audit chain | `GET /reliability/contracts`, `/contracts/case`, `/contracts/audit` |
| Mediation | Dispute queue, evidence with signer checks, both simulated rulings, the bytes a mediator signs | `/contracts/case`, `/contracts/ruling-options`, `/contracts/ruling-payload` |
| Companies | Search, KYC, live and simulated record, scores, fee offers, deals | `/reliability/profile/search`, `/reliability/profile` |
| Deal Desk | Four-step contract draft: escrows, payouts per outcome, Tier 1 options, timeline, fees | `GET /studio/templates`, `POST /studio/draft` (not served yet, see below) |
| Coworkers | Deal Desk, Mediator and Trust Check, their tools, the Masumi payment flow | static |

The Deal Desk calls two routes that the control API does not have yet. Each one wraps an existing
`CoworkerTools` method: `listTemplates()` and `draftContract(input)`. The draft runs the engine in an
in-memory sandbox and writes nothing. Until those routes exist, the Deal Desk shows a notice.

## Stack

Vite, React 19, Tailwind v4, shadcn/ui on Base UI, lucide icons, motion, and ReactBits components
(Waves, ScrollReveal, Stepper, SpotlightCard, AnimatedList, CountUp, DecryptedText), restyled for the
white-to-gray theme. Type: Unbounded, Sora, JetBrains Mono.

`bun run build` type-checks and builds. `bun run lint` runs oxlint.
