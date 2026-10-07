# AGENTS.md

Follow this file when you write code or docs in this repo.

## Code

Follow the [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html).

Follow the repo formatter when it conflicts with that guide.

Use ESLint as the check after ESLint is present.

Lint these paths:

- `packages/*`
- `services/*`
- the operator UI (`ui/`)

## Documentation

Follow about 90% of ASD-STE100 (Simplified Technical English).

- Write short sentences.
- Put one instruction in each sentence.
- Use the active voice.
- Use the same term for the same thing.
- Do not use slang.

Do not invent Simplified Technical English dictionary words. Use a plain word when you are not sure.

Drop an STE rule when that rule makes the sentence unclear.

Also follow the [Google developer documentation best practices](https://google.github.io/styleguide/docguide/best_practices.html).

- Write the shortest doc that stays accurate.
- Update docs in the same pull request as the code.
- Link to an external guide.
- Do not copy an external guide into this repo.

## Repo facts

The product scope is the B2B and B2C marketplace with its reliability checker.

`main` holds the product plan in `PLAN.md`.

The prediction-market runtime and capital-allocation plans are retired.

Shared legacy code still supplies storage and payment dependencies.
Refactor these dependencies before deleting their source files or migrations.

Send product changes to `main` through a pull request.

Do not push directly to `main`.

Do not edit `cre/agent-loop` unless the task names that path.

Do not edit `services/market-feed.ts` unless the task names that path.

The operator UI is display-only, with three exceptions.

1. Ask a Coworker (`POST /coworkers/ask` and `GET /coworkers/ask?id=`). The UI server forwards it to the Coworker worker, which answers a free preview with read-only tools. It pays nothing and stores nothing.
2. Wallet accounts (`ACCOUNT_ROUTES` in `ui/server.ts`). A person signs in with a wallet signature, submits mock KYC, and sends live preprod deposits from their own wallet. Tally never holds a wallet key. Read `docs/wallets.md`.
3. The app edition (`APP_ROUTES` in `ui/server.ts`, only with `TALLY_EDITION=app`). A signed-in party creates deals, signs terms, and submits signed contract actions. Every app route needs the party's session. Read `ui/README.md`.

The public demo runs on AWS Amplify at `https://main.d23gra1a9ugqjs.amplifyapp.com` with paper data. The team agreed to this for judging. Read `docs/amplify.md`.
Its Ask a Coworker area takes requests from anyone, within limits: 5 requests per visitor every 10 minutes, at most 100 AI answers a day for the website (20 for one visitor), and one answer at a time.
The AI model is Mistral, through the `openai-compatible` provider.
Its role views are lenses, not access control. Wallet sign-in covers accounts only. Before real data or a launch, put the role views behind sign-in, and keep the Mediation desk private.

The operator UI reads `GET /reliability/*`. Lane C builds the UI against these routes.

The UI server also retains the legacy `GET /agent/state` and `GET /audit` read proxies.

The operator UI does not edit policy. The operator UI does not send orders.

Start the local operator UI in this order:

1. Run `bun run services`.
2. Run `bun run ui/server.ts`.
3. Open `http://localhost:8791`.

Use bun as the package manager.

Reliability routes use the shared `AgentStore` in `services/control-api.ts`.

The control API demo routes already exist. Extend the demo routes. Do not replace the demo routes with a new implementation.

`packages/reliability/src/types.ts` is frozen. Send type changes in a separate small pull request.

Take the next free migration number.

Migrations `001` to `016` are used. Settlement anchors use `015`.

The next free number is `017`.

Use "paper" for a simulated fill. Use "live" for a real venue order.

Show whether each order is paper or live in the operator UI.

State whether each order is paper or live in the docs.

Do not commit secrets. Commit example env files only.
