# Tally UI

This display shows Tally: escrowed deals, disputes, company records, and the marketplace.
It does not edit policy, accept offers, send orders, sign, or change KYC.
One area takes input: Ask a Coworker sends a request to Tally's Coworkers and shows the answer. It pays nothing and stores nothing.

The hosted demo is <https://13-210-42-0.sslip.io>. It shows paper data only.

## Areas

| Area | For | Shows |
| --- | --- | --- |
| My deals | Buyers and sellers | Contracts and milestones, the stage of each, who acts next and by when, escrows, deadlines, history |
| Mediation desk | The platform mediator | Disputes by urgency, the case file with signer status, what each ruling pays, and the bytes to sign |
| Companies | Anyone checking a counterparty | Scores, terms decisions, and deal history, live and simulated apart |
| Ask a Coworker | Anyone | A free preview of Deal Desk, Mediator, and Trust Check: a contract draft, a dispute case, or a company record |
| Operator | The platform team | The marketplace ledger, participants, listings, and every contract |

"Viewing as" in My deals is a lens, not sign-in. Anyone can choose any party.
Before real data, add sign-in and show each party only its own deals. Keep the Mediation desk private.

Every amount, deadline, payout, and score comes from the control API, which takes them from the contract engine.
The UI formats them. It does not calculate them.
Open an area directly with `/?view=deals`, `/?view=mediation`, `/?view=companies`, `/?view=ask`, or `/?view=operator`.

Ask a Coworker shows the answer as Markdown. [`markdown.js`](markdown.js) escapes every character first and turns only headings, lists, tables, code, bold, and italics into markup. Links and HTML stay plain text, because a language model can write the answer.
The answer comes from the Coworker worker. Read [the Coworker README](../services/reliability/coworkers/README.md#on-the-tally-website).

Start the services first. Then start the UI.

```sh
bun run services
# In another terminal:
bun run ui/server.ts
```

Open <http://localhost:8791>.
The UI server listens on `127.0.0.1`.
Use `UI_PORT` to change the port.
Use `CONTROL_API_URL` to select the control API.

## Views

- Transactions: search by agreement or participant. Filter by type and outcome.
  Select a row to read its receipt, fault, fee offers, and raw evidence.
- Needs attention: review pending, failed, disputed, unresolved, and unknown outcomes.
  A reason marks a passed resolution deadline without changing the recorded outcome.
  Review expired, rejected, pending, or unavailable mock KYC and pending renewal checks.
  The summary counts each transaction or participant once, even with several reasons.
  Search applies to both groups. Type and outcome filters apply to transactions only.
  Select **View participant** to read that participant's scores and KYC history.
- Participants: read separate buyer and seller scores in each category.
  Each score shows its mean, lower bound, confidence, and event count.
  Read mock KYC badges, pending checks, history, and re-registration flags.
- Listings: read seller records, prices, reliability thresholds, and required terms.

Use the transaction ID field to read a durable lifecycle transaction.
You can also open `/?transactionId=YOUR_ID`.
The lifecycle read accepts a transaction ID.
It supplies the current UTC time so a passed dispute deadline shows unresolved.
If it returns 404, the UI reads the demo receipt for that ID.
Other lifecycle errors do not trigger a fixture fallback.
Unknown IDs show an error and keep the current display.

Use **Copy ID** or **Copy receipt link** in the receipt inspector.
If clipboard access fails, copy from the selected text field.
Receipt links open on the same local operator UI and read the latest available data.
They are not public links or saved receipt snapshots.

## Data and evidence

The UI polls the marketplace read routes every five seconds.
Entity, listing, and transaction reads combine stored records with seed fixtures.
A stored record takes precedence for the same ID.
New stored transactions appear in the transaction collection.
Receipt reads use stored transactions, outcomes, and events first.
Use the transaction ID field to inspect the complete lifecycle history.
The Needs attention view covers loaded records, including the current ID lookup.
An empty view does not prove that all stored transactions are clear.
The score route combines stored states with fixtures. A stored state takes precedence
for the same entity, category, and role.
The mock KYC route can return a stored entity record.
When no KYC record exists, the participant row labels its seed fixture status.
KYC badge examples are separate from marketplace participants.

Marketplace orders are paper.
Each transaction row and receipt says `PAPER`.
Escrow mode is separate.
A receipt with `mode: live` also says `LIVE escrow`.
This means enabled preprod escrow activity. It does not prove chain settlement.
A simulated escrow receipt says that no chain settlement proof is present.
Missing escrow mode stays unknown.
The timeline shows recorded evidence only.

Scoring and fees use stubs.
Value weighting and repeat-pair decay are not implemented.
The UI does not calculate these rules.
It shows the scores and fee offers returned by the API.
A fee decision names its entity, category, reason, and policy version.
Its buyer and seller rates are that entity's policy offers.
They are not charged fee totals for both transaction participants.
The UI does not infer missing values, currencies, or reliability thresholds.

If a collection read fails, the UI keeps and labels the last complete response.
If no response exists, it shows a saved sample from the seed routes.
The saved sample covers one service, invoice, and goods sale.
It is not current activity.
Unavailable individual receipts show an unknown outcome.
An unavailable KYC read shows an unknown badge. It does not reuse a verified seed badge.
Search, filters, focus, and evidence disclosures survive refreshes.

Read [lane ownership](../docs/reliability-lanes.md),
[transaction lifecycle](../docs/reliability-lifecycle.md), and
[mock KYC](../docs/kyc.md) for the contracts behind these views.
Read [Implementation status](../docs/implementation-status.md) for current features and known limits.

## Appearance

Use the sun or moon button in the header to switch between light and dark mode.
The first visit uses the system theme.
Your choice is saved in this browser when local storage is available.

## Checks

```sh
bun test ui
bun run typecheck:control
bun run lint
```

The server allows only listed GET and HEAD routes.
It retains the existing `/agent/state` and `/audit` read proxies.
It forwards the query string for receipts, lifecycle views, and KYC.
POST, PUT, PATCH, and DELETE requests are rejected, except one route.
`POST /coworkers/ask` and `GET /coworkers/ask?id=` go to the Coworker worker (`COWORKER_ASK_URL`, default `http://127.0.0.1:8792`).
The server sends the visitor address from `X-Forwarded-For` (the last entry, set by Caddy) and refuses a body over 16 KiB.
