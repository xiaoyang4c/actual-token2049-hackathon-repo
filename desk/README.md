# Agent Desk

Agent Desk is a local operator frontend for the agent runtime in this repo.
It does not change backend code. It is for local use only. It is not a public site.

The desk is not the display-only operator UI in `ui/`. The desk can edit the
policy, run cycles, and close paper positions. All orders are paper fills.
All payments are simulated ADA on cardano-preprod.

There are two versions:

- v1, in `web/`, is served at http://localhost:8800.
- v2, in `web-v2/`, is served at http://localhost:8800/v2.

## Start

Double-click `Agent Desk.command`, or run these commands:

```sh
cd web && npm install && npm run build && cd ..
cd web-v2 && npm install && npm run build && cd ..
bun run server.ts
```

The desk starts the four backend services (`bun run services` in the repo
root) if they are not already running. Press Ctrl+C to stop the desk and the
services that it started.

For hot reload, run `npm run dev` in `web/` (port 5173) or in `web-v2/`
(port 5174). The dev server sends `/api` to the desk server on port 8800.

## What it does

- Runs agent cycles. The desk server runs each step like
  `cre/agent-loop/workflow.ts`. It does not use the CRE runtime, because
  `cre workflow simulate` needs the Chainlink CLI and a `cre login`.
- Edits the policy, the kill switch, and the strategy settings.
- Shows the book, positions, live markets, data payments, the audit log,
  and closed days.
- Closes or settles paper positions, books P&L shocks, and resets the book.

The strategy settings are in `desk/.desk-settings.json`. Git ignores this file.
The book and audit data are in `services/.data/`.

The desk listens on 127.0.0.1 only.

## Stack

- v1: Vite, React, Tailwind, and React Bits components (Silk, CountUp,
  SpotlightCard, StarBorder, Magnet, ClickSpark, DecryptedText, ShinyText,
  BlurText).
- v2: Vite, React, Tailwind, motion, NumberFlow, React Bits GlassSurface,
  and a WebGL mesh gradient background. The background turns red when the
  kill switch is on.
