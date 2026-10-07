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

The operator UI is display-only. The operator UI is not a public site.

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

These numbers are reserved: `007` for the math lane, `008` for KYC, and `009` for lane D.

Migrations `010`, `011`, `013`, and `014` are used.
Migration `012` is allocated to the contract lifecycle in pull request #17.

The next free number is `015`.

Use "paper" for a simulated fill. Use "live" for a real venue order.

Show whether each order is paper or live in the operator UI.

State whether each order is paper or live in the docs.

Do not commit secrets. Commit example env files only.
