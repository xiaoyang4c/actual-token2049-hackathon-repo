// Renders a prepared desk view as display-only HTML.

import { formatMoney, venueLabel } from "./format.js"

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;"
      case "<":
        return "&lt;"
      case ">":
        return "&gt;"
      case '"':
        return "&quot;"
      default:
        return "&#39;"
    }
  })
}

const chips = (items, emptyLabel, className) => {
  if (!items.length) return `<span class="empty">${escapeHtml(emptyLabel)}</span>`
  return items.map((item) => `<span class="${className}">${escapeHtml(item)}</span>`).join("")
}

const connectionCopy = (view) => {
  if (view.source === "fixture") return { label: "Fixture", detail: "Sample data" }
  if (view.source === "stale") return { label: "Unreachable", detail: "Last response kept" }
  return { label: "Connected", detail: view.updatedAt.text === "—" ? "Control API" : view.updatedAt.text }
}

const renderHeader = (view) => {
  const connection = connectionCopy(view)
  return `
    <header class="top">
      <div>
        <p class="eyebrow">Prediction-market agent</p>
        <h1>Operator</h1>
      </div>
      <p class="connection connection-${escapeHtml(view.source)}">
        <span class="dot" aria-hidden="true"></span>
        <span>
          <strong>${escapeHtml(connection.label)}</strong>
          <span class="connection-detail">${escapeHtml(connection.detail)}</span>
        </span>
      </p>
    </header>
  `
}

const renderFixture = (view) => `
  <div class="callout callout-fixture" role="status">
    <strong>Fixture data</strong>
    <p>The control API did not respond. These figures are a saved sample, not the running agent.</p>
    ${view.error ? `<p class="fine">${escapeHtml(view.error)}</p>` : ""}
  </div>
`

const renderStale = (view) => `
  <div class="callout callout-stale" role="status">
    <strong>Showing the last response</strong>
    <p>The control API is unreachable. The book below is the last one this page received${
      view.updatedAt.iso ? ` at ${escapeHtml(view.updatedAt.text)}` : ""
    }.</p>
    ${view.error ? `<p class="fine">${escapeHtml(view.error)}</p>` : ""}
  </div>
`

const countLine = (n, singular, plural) => `${n} ${n === 1 ? singular : plural}`

const renderMode = (view) => {
  const { kind, paper, live, unmarked } = view.execution
  if (kind === "mixed") {
    return `
      <section class="mode mode-mixed" aria-label="Execution mode">
        <div class="mode-half mode-half-paper">
          <p class="kicker">In the audit log</p>
          <strong>PAPER</strong>
          <p>${countLine(paper, "paper event", "paper events")}. Simulated. Nothing was sent to a venue.</p>
        </div>
        <div class="mode-half mode-half-live">
          <p class="kicker">In the audit log</p>
          <strong>LIVE</strong>
          <p>${countLine(live, "live event", "live events")}. Sent to a venue.</p>
        </div>
      </section>
    `
  }
  if (kind === "paper") {
    return `
      <section class="mode mode-paper" aria-label="Execution mode">
        <div>
          <p class="kicker">Execution</p>
          <strong>PAPER</strong>
        </div>
        <p>Every order in this log is simulated. Nothing was sent to a venue. ${countLine(paper, "paper event", "paper events")}.</p>
      </section>
    `
  }
  if (kind === "live") {
    return `
      <section class="mode mode-live" aria-label="Execution mode">
        <div>
          <p class="kicker">Execution</p>
          <strong>LIVE</strong>
        </div>
        <p>This log contains orders that were sent to a venue. ${countLine(live, "live event", "live events")}.</p>
      </section>
    `
  }
  const extra = unmarked > 0 ? ` ${countLine(unmarked, "fill", "fills")} ${unmarked === 1 ? "is" : "are"} missing a PAPER or LIVE tag.` : ""
  return `
    <section class="mode mode-none" aria-label="Execution mode">
      <div>
        <p class="kicker">Execution</p>
        <strong>NO FILLS</strong>
      </div>
      <p>No paper or live fills yet. Each fill will be marked PAPER or LIVE.${extra}</p>
    </section>
  `
}

const renderKill = () => `
  <div class="callout callout-kill" role="status">
    <strong>Kill switch is on</strong>
    <p>The policy will stop the loop from buying data or placing orders.</p>
  </div>
`

const renderPolicy = (policy) => `
  <section class="card" id="policy" aria-labelledby="policy-heading">
    <h2 id="policy-heading">Policy</h2>
    <div class="kill ${policy.killSwitch ? "kill-on" : "kill-off"}">
      <span>Kill switch</span>
      <strong>${policy.killSwitch ? "On" : "Off"}</strong>
    </div>
    <dl class="facts">
      <div><dt>Max bet</dt><dd>${escapeHtml(policy.maxBet)}</dd></div>
      <div><dt>Max daily loss</dt><dd>${escapeHtml(policy.maxDailyLoss)}</dd></div>
      <div><dt>Stop loss</dt><dd>${escapeHtml(policy.stopLoss)}</dd></div>
    </dl>
    <div class="group">
      <h3>Venues</h3>
      <div class="chips">${chips(policy.venues.map(venueLabel), "None enabled", "chip")}</div>
    </div>
    <div class="group">
      <h3>Allowed categories</h3>
      <div class="chips">${chips(policy.allow, "Any", "chip")}</div>
    </div>
    <div class="group">
      <h3>Denied categories</h3>
      <div class="chips">${chips(policy.deny, "None", "chip chip-deny")}</div>
    </div>
  </section>
`

const lossMeter = (portfolio, policy) => {
  const limit = policy.maxDailyLossValue
  const pnl = portfolio.dailyPnlValue
  if (limit === null || limit <= 0 || pnl === null) return ""
  const used = Math.max(0, -pnl)
  const ratio = Math.min(1, used / limit)
  const width = (ratio * 100).toFixed(1)
  const over = used >= limit
  return `
    <div class="meter-block">
      <div class="meter ${over ? "meter-over" : ""}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(ratio * 100)}" aria-label="Daily loss used">
        <span style="width: ${width}%"></span>
      </div>
      <p>Daily loss ${escapeHtml(formatMoney(used))} of ${escapeHtml(formatMoney(limit))} limit</p>
    </div>
  `
}

const renderPositions = (positions) => {
  if (!positions.length) return `<p class="empty-block">No open positions.</p>`
  const rows = positions
    .map((position) => {
      const sideClass = position.side === "yes" || position.side === "no" ? `side side-${position.side}` : "side"
      return `
        <tr>
          <td>
            <div class="market" title="${escapeHtml(position.marketId)}">${escapeHtml(position.marketId)}</div>
            <div class="venue">${escapeHtml(position.venue)}</div>
          </td>
          <td class="${sideClass}">${escapeHtml(position.side)}</td>
          <td>${escapeHtml(position.size)}</td>
          <td>${escapeHtml(position.avgPrice)}</td>
          <td>${escapeHtml(position.cost)}</td>
        </tr>
      `
    })
    .join("")
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Market</th>
            <th scope="col">Side</th>
            <th scope="col">Size</th>
            <th scope="col">Avg</th>
            <th scope="col">Cost</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `
}

const renderPortfolio = (portfolio, policy) => `
  <section class="card" id="portfolio" aria-labelledby="portfolio-heading">
    <h2 id="portfolio-heading">Portfolio</h2>
    <div class="stats">
      <div class="stat">
        <span>Cash</span>
        <strong>${escapeHtml(portfolio.cash)}</strong>
      </div>
      <div class="stat">
        <span>Equity</span>
        <strong>${escapeHtml(portfolio.equity)}</strong>
      </div>
      <div class="stat pnl ${portfolio.pnlClass}">
        <span>Daily PnL</span>
        <strong>${escapeHtml(portfolio.dailyPnl)}</strong>
      </div>
    </div>
    ${lossMeter(portfolio, policy)}
    <p class="meta">Start of day ${escapeHtml(portfolio.startOfDay)} · High water ${escapeHtml(portfolio.highWater)}</p>
    <h3 class="positions-heading">Positions</h3>
    ${renderPositions(portfolio.positions)}
  </section>
`

const fillBadge = (event) => {
  if (event.mode === "paper") return `<span class="badge badge-paper">PAPER</span>`
  if (event.mode === "live") return `<span class="badge badge-live">LIVE</span>`
  if (event.isFill) return `<span class="badge badge-unmarked">FILL</span>`
  return ""
}

const renderEvent = (event) => {
  const tone = event.mode === "paper" ? "fill-paper" : event.mode === "live" ? "fill-live" : event.isFill ? "fill-unmarked" : ""
  return `
    <div class="event ${tone}">
      <div class="event-badge">${fillBadge(event)}</div>
      <div class="event-type">${escapeHtml(event.type)}</div>
      <div class="event-detail">${escapeHtml(event.detail)}</div>
    </div>
  `
}

const renderCycle = (cycle) => `
  <article class="cycle">
    <header>
      <h3>${escapeHtml(cycle.cycleId)}</h3>
      ${cycle.received.iso ? `<time datetime="${escapeHtml(cycle.received.iso)}">${escapeHtml(cycle.received.text)}</time>` : `<time>—</time>`}
    </header>
    <div class="events">${cycle.events.map(renderEvent).join("")}</div>
  </article>
`

const renderAudit = (cycles) => `
  <section class="card" id="audit" aria-labelledby="audit-heading">
    <div class="section-head">
      <h2 id="audit-heading">Audit</h2>
      <p class="legend">
        <span class="badge badge-paper">PAPER</span> simulated
        <span class="badge badge-live">LIVE</span> sent to a venue
      </p>
    </div>
    ${
      cycles.length
        ? `<div class="audit-list">${cycles.map(renderCycle).join("")}</div>`
        : `<p class="empty-block">No cycles recorded.</p>`
    }
  </section>
`

export function renderDesk(view) {
  return `
    <div class="desk mode-${view.mode}" data-source="${escapeHtml(view.source)}" data-mode="${escapeHtml(view.mode)}">
      ${renderHeader(view)}
      ${view.source === "fixture" ? renderFixture(view) : ""}
      ${view.source === "stale" ? renderStale(view) : ""}
      ${renderMode(view)}
      ${view.policy.killSwitch ? renderKill() : ""}
      <main class="grid">
        ${renderPolicy(view.policy)}
        ${renderPortfolio(view.portfolio, view.policy)}
        ${renderAudit(view.cycles)}
      </main>
      <footer class="foot">Read-only. Polls GET /agent/state and GET /audit every 2 seconds.</footer>
    </div>
  `
}

export function deskTitle(view) {
  const names = { paper: "PAPER", live: "LIVE", mixed: "MIXED", none: "NO FILLS" }
  const prefix = view.source === "fixture" ? "Fixture · " : ""
  return `${prefix}Operator · ${names[view.mode] ?? "Operator"}`
}
