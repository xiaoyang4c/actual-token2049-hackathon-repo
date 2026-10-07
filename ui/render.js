// Render prepared read models. Controls only select and filter local views.

import { escapeHtml, formatFee, formatPct, formatValue, label, stamp } from "./format.js"
import { evidenceRows, participantName } from "./model.js"
import { renderCompanies, renderContractsTable, renderDeals, renderMediation } from "./tally-views.js"

export { escapeHtml }

/** The Tally mark: four tally strokes and a fifth across them. Transparent, so it takes the text colour. */
const BRAND_MARK = `<svg class="brand-svg" viewBox="10 16 80 68" aria-hidden="true"><defs><mask id="brand-gap" maskUnits="userSpaceOnUse"><rect width="100" height="100" fill="white"/><polygon fill="black" points="18.58,79.05 90.58,36.45 81.42,20.95 9.42,63.55"/></mask></defs><g fill="currentColor" mask="url(#brand-gap)"><rect x="17.5" y="32.5" width="11" height="50"/><rect x="35.5" y="27.5" width="11" height="50"/><rect x="53.5" y="22.5" width="11" height="50"/><rect x="71.5" y="17.5" width="11" height="50"/></g><polygon fill="currentColor" points="16.55,75.6 88.55,33 83.45,24.4 11.45,67"/></svg>`

export const AREAS = ["deals", "mediation", "companies", "operator"]
const AREA_TEXT = {
  deals: ["My deals", "Every milestone, who acts next, and by when."],
  mediation: ["Mediation desk", "Disputes that need a decision, with the evidence and what each ruling pays."],
  companies: ["Companies", "A company's Tally record before you deal with it. Facts, not a verdict."],
  operator: ["Operator", "The marketplace ledger, participants, listings, and every contract."],
}

const e = escapeHtml
const tabName = (tab) => tab === "attention" ? "Needs attention" : label(tab)
const ICONS = {
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  service: '<path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6"/>',
  invoice: '<rect x="6" y="3" width="12" height="18" rx="1"/><path d="M9 7h6M9 11h6M9 15h6M9 18h3"/>',
  goods: '<path d="m12 3 9 5v9l-9 5-9-5V8zM3 8l9 5 9-5M12 13v9M7.5 5.5l9 5"/>',
  next: '<path d="m9 5 7 7-7 7"/>',
  back: '<path d="m15 5-7 7 7 7"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16v1"/>',
  check: '<path d="m6 12 4 4 8-8"/>',
  moon: '<path d="M20.5 13A9 9 0 0 1 11 3.5 9 9 0 1 0 20.5 13Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  link: '<path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>',
}
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ICONS.service}</svg>`
const badge = (state) => `<span class="status status-${e(state)}"><span class="status-dot" aria-hidden="true"></span>${e(label(state))}</span>`
const modeBadge = (mode) => `<span class="mode-label mode-${e(mode)}">${e(mode.toUpperCase())}</span>`
const facts = (rows) => `<dl class="facts">${rows.map(([key, value]) => `<div><dt>${e(key)}</dt><dd>${e(value)}</dd></div>`).join("")}</dl>`
const empty = (title, detail) => `<div class="empty-state"><strong>${e(title)}</strong><p>${e(detail)}</p></div>`

function renderHeader(view, theme, area) {
  const connection = { connected: "Connected", fixture: view.error ? "Offline sample" : "Loading", stale: "Connection lost" }[view.source]
  return `<header class="app-header">
    <a class="brand" href="/" aria-label="Tally home">${BRAND_MARK}Tally</a>
    <nav aria-label="Tally views">${AREAS.map((name) =>
      `<button type="button" id="nav-${name}" data-area="${name}" ${area === name ? 'aria-current="page"' : ""}>${AREA_TEXT[name][0]}</button>`).join("")}</nav>
    <div class="header-status"><span class="local-label">Demo · read only</span><span class="connection connection-${view.source}"><span class="status-dot" aria-hidden="true"></span>${connection}</span>
    <button type="button" id="theme-toggle" class="icon-button" data-theme-toggle aria-label="Switch to ${theme === "dark" ? "light" : "dark"} mode" title="Switch to ${theme === "dark" ? "light" : "dark"} mode">${icon(theme === "dark" ? "sun" : "moon")}</button>
    <button type="button" id="refresh-marketplace" class="icon-button" data-refresh aria-label="Refresh marketplace">${icon("refresh")}</button></div>
  </header>`
}

function renderNotice(view) {
  const status = view.source === "fixture" ?
    `<div class="connection-notice" role="status"><strong>Saved demo snapshot</strong> ${view.error ? "The control API is unavailable." : "Waiting for the control API."} This sample is not current data. ${e(view.error)}</div>` :
    view.source === "stale" ?
      `<div class="connection-notice" role="status"><strong>Showing the last response</strong> Last received ${e(stamp(view.updatedAt))}. ${e(view.error)}</div>` : ""
  return `${status}<div class="demo-notice">${icon("alert")}<strong>Tally demo</strong><span>Cardano preprod with test USDM. Paper contracts are labelled SIMULATED. Scores and fees use stubs. KYC is mocked. Role views are lenses, not sign-in.</span></div>`
}

function renderMetrics(view) {
  const metrics = view.metrics
  return `<dl class="metrics">${[
    ["Transactions", metrics.total], ["Completed", metrics.completed],
    ["Needs attention", metrics.attention], ["Participants", metrics.participants],
  ].map(([key, value]) => `<div><dt>${key === "Needs attention" ? '<button type="button" id="attention-summary" class="text-button" data-open-attention aria-label="View items that need attention">Needs attention →</button>' : key}</dt><dd>${value}</dd>${key === "Needs attention" ? `<small>${metrics.attentionTransactions} transactions · ${metrics.attentionParticipants} participants</small>` : ""}</div>`).join("")}</dl>
  ${metrics.unknown ? `<p class="data-warning" role="status">${metrics.unknown} transaction receipt${metrics.unknown === 1 ? " is" : "s are"} unavailable. Outcomes are unknown.</p>` : ""}`
}

function renderToolbar(view) {
  const placeholders = {
    transactions: "Search transactions or participants", attention: "Search transactions or participants", participants: "Search participants", listings: "Search listings or sellers",
  }
  return `<div class="toolbar"><label class="search-field">${icon("search")}<span class="sr-only">${placeholders[view.tab]}</span><input id="search" type="search" value="${e(view.controls.query)}" placeholder="${placeholders[view.tab]}" autocomplete="off"></label>
  ${["transactions", "attention"].includes(view.tab) ? `<label class="outcome-select"><span class="sr-only">Filter by outcome</span><select id="outcome"><option value="">All outcomes</option>${(view.tab === "attention" ? ["pending", "failed", "disputed", "unresolved", "unknown"] : ["successful", "pending", "failed", "disputed", "cancelled", "unresolved", "unknown"]).map((state) => `<option value="${state}" ${view.controls.outcome === state ? "selected" : ""}>${label(state)}</option>`).join("")}</select></label>
  <div class="type-filters" role="group" aria-label="Filter by transaction type">${[["", "All types"], ["goods", "Goods"], ["service", "Services"], ["invoice", "Invoices"]].map(([value, text]) => `<button type="button" id="type-${value || "all"}" data-type="${value}" aria-pressed="${view.controls.type === value}">${text}</button>`).join("")}</div>` : ""}</div>`
}

function renderLedger(view) {
  const start = view.filteredCount ? view.page * view.pageSize + 1 : 0
  return `<section class="panel ledger" aria-label="Transaction ledger">${renderToolbar(view)}
    ${view.rows.length ? `<div class="table-wrap"><table><caption class="sr-only">Marketplace transactions. Select a transaction to inspect its receipt.</caption>
    <thead><tr><th scope="col">Transaction</th><th scope="col">Counterparties</th><th scope="col">Value</th><th scope="col">Outcome</th><th scope="col">Mode</th></tr></thead>
    <tbody>${view.rows.map((transaction) => `<tr class="${transaction.id === view.selected?.id ? "selected-row" : ""}">
      <td><button type="button" id="select-${e(transaction.id)}" class="transaction-link" data-select-id="${e(transaction.id)}" aria-pressed="${transaction.id === view.selected?.id}" aria-controls="receipt">${icon(transaction.type)}<span><strong>${e(transaction.title)}</strong><small>${e(transaction.id)} · ${e(label(transaction.type))}</small></span></button></td>
      <td class="counterparties">${transaction.participants.map((party) => `<span title="${e(label(party.role))}">${e(party.name)}</span>`).join("")}</td>
      <td class="numeric">${e(transaction.valueText)}</td><td>${badge(transaction.outcome)}${view.tab === "attention" ? `<small class="attention-reason">${transaction.attentionReasons.map(e).join(" · ")}</small>` : ""}</td><td>${modeBadge(transaction.orderMode)}${transaction.escrow.mode === "live" ? '<small class="live-note">LIVE escrow</small>' : ""}</td>
    </tr>`).join("")}</tbody></table></div>` : empty(view.tab === "attention" && !view.controls.query && !view.controls.type && !view.controls.outcome ? "No transactions need attention" : "No matching transactions", view.tab === "attention" ? "This view covers loaded records. Inspect other transactions by ID below." : "Change the search or filters to see more agreements.")}
    <footer class="ledger-footer"><span>${start}–${Math.min(view.filteredCount, (view.page + 1) * view.pageSize)} of ${view.filteredCount} transactions</span><div class="pagination"><button type="button" class="icon-button" data-page="${view.page - 1}" aria-label="Previous page" ${view.page === 0 ? "disabled" : ""}>${icon("back")}</button><button type="button" class="icon-button" data-page="${view.page + 1}" aria-label="Next page" ${view.page + 1 >= view.pages ? "disabled" : ""}>${icon("next")}</button></div></footer>
  </section>`
}

function renderDecisions(receipt, entities) {
  const decisions = receipt.termsDecisions ?? (receipt.termsDecision ? [receipt.termsDecision] : [])
  if (!decisions.length) return `<section class="receipt-section"><h3>Fee decision</h3><p class="muted">No fee decision returned for this receipt.</p></section>`
  return decisions.map((decision) => `<section class="receipt-section">
    <div class="section-heading"><h3>Fee decision</h3><span class="subtle-label">${e(decision.policyVersion)}</span></div>
    <p class="muted">Decision for ${e(participantName(entities, decision.entityId))} · ${e(decision.category)}</p>
    ${facts([["Buyer fee offer", formatFee(decision.buyerFeeBps)], ["Seller fee offer", formatFee(decision.sellerFeeBps)], ["Reason", label(decision.reasonCode)]])}
    <p class="fine">Policy offer for this entity. These rates are not recorded charges to both parties.</p>
    <details id="decision-${e(decision.entityId)}"><summary>Decision inputs and terms</summary><pre>${e(JSON.stringify({inputs: decision.inputs, terms: decision.terms, decidedAt: decision.decidedAt}, null, 2))}</pre></details>
  </section>`).join("")
}

function renderReceipt(view, copy) {
  const transaction = view.selected
  if (!transaction) return `<aside class="panel receipt" id="receipt" aria-label="Receipt inspector">${empty("Select a transaction", "Choose an agreement in the ledger to inspect its receipt.")}</aside>`
  const receipt = transaction.receipt
  const outcome = receipt?.outcome
  const evidence = evidenceRows(receipt)
  return `<aside class="panel receipt" id="receipt" aria-labelledby="receipt-heading" tabindex="-1">
    <div class="receipt-top"><h2 id="receipt-heading">Receipt <small>${e(transaction.id)}</small></h2><div>${badge(transaction.outcome)}${modeBadge(transaction.orderMode)}</div></div>
    <h3 class="receipt-title">${e(transaction.title)}</h3><div class="receipt-value">${e(transaction.valueText)}</div><p class="muted">${transaction.currency ? `Transaction value · ${e(transaction.currency)}` : "Currency not provided"}</p>
    <div class="receipt-actions" role="group" aria-label="Copy receipt details"><button type="button" id="copy-transaction-id" class="secondary-button" data-copy="id" data-transaction-id="${e(transaction.id)}" aria-busy="${copy.transactionId === transaction.id && copy.busy ? "true" : "false"}">${icon("copy")}Copy ID</button><button type="button" id="copy-receipt-link" class="secondary-button" data-copy="link" data-transaction-id="${e(transaction.id)}" aria-busy="${copy.transactionId === transaction.id && copy.busy ? "true" : "false"}">${icon("link")}Copy receipt link</button></div>
    <p id="copy-message" class="fine copy-message" role="status">${copy.transactionId === transaction.id ? e(copy.message) : ""}</p>
    ${copy.transactionId === transaction.id && copy.fallback ? `<label class="copy-fallback" for="copy-value">${copy.kind === "id" ? "Transaction ID" : "Receipt link"}<input id="copy-value" readonly value="${e(copy.value)}"></label>` : ""}
    ${!receipt ? `<div class="connection-notice" role="status"><strong>Receipt unavailable</strong> ${e(transaction.receiptError || "No receipt was returned.")}</div>` : ""}
    <section class="receipt-section"><h3 class="sr-only">Recorded evidence</h3>
      ${evidence.length ? `<ol class="evidence-timeline">${evidence.map((row) => `<li><span class="timeline-point">${icon("check")}</span><div><span>${e(row.title)}</span><small>${e(stamp(row.at))}${row.mode === "paper" || row.mode === "live" ? ` · ${row.mode.toUpperCase()}` : ""}</small></div></li>`).join("")}</ol>` : '<p class="muted">No lifecycle evidence returned.</p>'}
      <p class="evidence-caption">Recorded outcome evidence</p><p class="fine">${e(transaction.escrow.text)}</p>
      ${outcome?.resolver ? facts([["Resolver", outcome.resolver], ["Resolve by", stamp(outcome.resolveBy)], ["Escrow disposition", outcome.evidence?.escrowDisposition ?? "Not provided"]]) : ""}
    </section>
    <section class="receipt-section">${facts(transaction.participants.map((party) => [label(party.role), party.name]))}</section>
    <section class="receipt-section"><h3>Verification</h3>${facts([
      ["Method", outcome ? label(outcome.verificationMethod) : "Not provided"],
      ["Confidence", formatPct(outcome?.verificationConfidence)],
      ["At-fault role", outcome?.fault ? label(outcome.fault) : outcome?.state === "successful" ? "None" : "Not recorded"],
    ])}</section>
    ${receipt ? renderDecisions(receipt, view.entities) : ""}
    <section class="receipt-section"><details id="raw-evidence"><summary>Terms and raw evidence</summary>
      <h4>Terms versions</h4><pre>${e(JSON.stringify(transaction.versions ?? [], null, 2))}</pre>
      <h4>Outcome and evidence</h4><pre>${e(JSON.stringify(outcome ?? null, null, 2))}</pre>
      <h4>Reliability events</h4><pre>${e(JSON.stringify(receipt?.events ?? [], null, 2))}</pre>
      ${receipt?.transitions ? `<h4>Lifecycle transitions</h4><pre>${e(JSON.stringify(receipt.transitions, null, 2))}</pre>` : ""}
    </details></section>
  </aside>`
}

function roleScores(entity, role) {
  const scores = entity.scores.filter((score) => score.role === role)
  if (!scores.length) return '<span class="muted">No score returned</span>'
  return scores.map((score) => `<div class="role-score"><strong>${e(formatPct(score.value))}</strong><span>${e(label(score.category))}</span><small>Lower bound ${e(formatPct(score.lowerBound))} · Confidence ${e(formatPct(score.confidence))} · ${e(score.eventCount)} events</small></div>`).join("")
}

function renderKyc(entity) {
  return `${badge(entity.kycBadge)}<small>${e(label(entity.kycTier))} tier · ${e(entity.kycSource)}</small>${entity.checkPending ? '<small class="data-warning">New check pending</small>' : ""}
  ${entity.kycError ? `<small class="data-warning">${e(entity.kycError)}</small>` : ""}
  ${entity.reRegistration ? `<p class="flag">Re-registration flag: ${e(entity.reRegistration.ofEntityId)} · ${e(label(entity.reRegistration.signal))}</p><p class="fine">The reliability record of the earlier entity does not transfer to this entity.</p>` : ""}`
}

function renderAttentionParticipants(view) {
  return `<section class="panel attention-participants" aria-labelledby="attention-kyc-heading"><div class="attention-heading"><h2 id="attention-kyc-heading">Participant KYC attention</h2><p class="fine">Search applies here. Transaction type and outcome filters apply to the ledger above.</p></div>
    ${view.attentionEntities.length ? `<ul class="attention-list">${view.attentionEntities.map((entity) => `<li><div><strong>${e(entity.displayName)}</strong><small>${e(entity.id)}</small><p class="attention-reason">${entity.attentionReasons.map(e).join(" · ")}</p></div><div>${renderKyc(entity)}</div><button type="button" id="review-${e(entity.id)}" class="secondary-button" data-open-participant="${e(entity.id)}">View participant<span class="sr-only"> ${e(entity.displayName)}</span></button></li>`).join("")}</ul>` : empty(view.controls.query ? "No matching KYC issues" : "No KYC issues in loaded participants", "Expired, rejected, pending, and unavailable KYC records appear here. Unverified status alone is not an alert.")}
  </section>`
}

function renderParticipants(view) {
  const query = view.controls.query.toLowerCase().trim()
  const entities = view.entities.filter((entity) => `${entity.id} ${entity.displayName}`.toLowerCase().includes(query))
  return `<section class="panel">${renderToolbar(view)}${entities.length ? `<div class="table-wrap"><table class="participants-table">
    <thead><tr><th scope="col">Participant</th><th scope="col">Buyer reliability</th><th scope="col">Seller reliability</th><th scope="col">Mock KYC</th></tr></thead>
    <tbody>${entities.map((entity) => `<tr><td><strong>${e(entity.displayName)}</strong><small>${e(entity.id)}</small><small>${e(entity.roles.map(label).join(" · "))}</small><details id="entity-${e(entity.id)}"><summary>Wallets and KYC history</summary><pre>${e(JSON.stringify({wallets: entity.wallets, history: entity.kycHistory}, null, 2))}</pre></details></td>
    <td>${roleScores(entity, "buyer")}</td><td>${roleScores(entity, "seller")}</td><td>${renderKyc(entity)}</td></tr>`).join("")}</tbody></table></div>` : empty("No matching participants", "Change the search to see participant records.")}
    <p class="panel-note">Score means, lower bounds, confidence, and event counts stay separate. A score in one category does not prove another. Scoring, value weighting, and repeat-pair decay are unfinished.</p></section>
    <section class="panel example-panel"><h2>Mock KYC examples</h2><p class="muted">Badge examples from the KYC fixture route. These examples are not marketplace participants.</p>
      ${view.kycExamples.length ? `<div class="kyc-examples">${view.kycExamples.map((example) => `<div>${badge(example.badge)}<strong>${e(example.id)}</strong><p>${e(example.label)}</p><small>${e(label(example.tier))} tier${example.reRegistrationOf ? ` · Re-registration of ${e(example.reRegistrationOf)}` : ""}</small></div>`).join("")}</div>` : empty("KYC examples unavailable", view.kycExamplesError || "No badge examples returned.")}
    </section>`
}

function renderListings(view) {
  const query = view.controls.query.toLowerCase().trim()
  const listings = view.listings.filter((listing) => `${listing.id} ${listing.title} ${participantName(view.entities, listing.sellerId)}`.toLowerCase().includes(query))
  return `<section class="panel">${renderToolbar(view)}${listings.length ? `<div class="listing-list">${listings.map((listing) => `<article class="listing-row"><div class="listing-icon">${icon(listing.transactionType)}</div><div class="listing-content"><small>${e(label(listing.transactionType))} · ${e(listing.id)}</small><h2>${e(listing.title)}</h2><p class="muted">${e(participantName(view.entities, listing.sellerId))}</p><div class="listing-requirements"><span>Buyer minimum: ${e(formatPct(listing.minBuyerReliability))}</span><span>Seller minimum: ${e(formatPct(listing.minSellerReliability))}</span></div><details id="listing-${e(listing.id)}"><summary>Required terms</summary><pre>${e(JSON.stringify(listing.requiredTerms ?? {}, null, 2))}</pre></details></div><div class="listing-price"><strong>${listing.price === undefined ? "Variable fee" : e(formatValue(listing.price, listing.requiredTerms?.currency))}</strong><small>${e(label(listing.pricingMethod))}</small></div></article>`).join("")}</div>` : empty("No matching listings", "Change the search to see available offers.")}
    <p class="panel-note">Listing requirements are displayed as returned. Missing reliability thresholds and currencies are not inferred. This desk does not accept offers.</p></section>`
}

export function renderLookup(lookup = {}) {
  return `<section class="lookup-section" aria-label="Transaction lookup"><form id="lookup-form"><label for="transaction-id">Inspect a transaction by ID</label><div><input id="transaction-id" name="transactionId" placeholder="Transaction ID" value="${e(lookup.value ?? "")}" required><button type="submit" class="button" ${lookup.busy ? "disabled" : ""}>${lookup.busy ? "Loading…" : "Inspect receipt"}</button></div></form><p class="fine">Read a durable lifecycle transaction or a demo receipt.</p><p id="lookup-message" class="data-warning" role="status">${e(lookup.error ?? "")}</p></section>`
}

const OPERATOR_TABS = ["transactions", "attention", "participants", "listings", "contracts"]

function renderOperator(view, lookup, tally, copy) {
  const descriptions = {
    transactions: "Inspect agreements, outcomes, and the evidence behind each result.",
    attention: "Review transaction exceptions and participant KYC issues in the loaded records.",
    participants: "Separate buyer and seller reliability scores, with the evidence and identity status behind each score.",
    listings: "Inspect goods and service offers, seller records, and required terms.",
    contracts: "Every Tally contract and milestone, with the next action on each.",
  }
  const tab = OPERATOR_TABS.includes(tally.operatorTab) ? tally.operatorTab : view.tab
  return `<div class="subnav" role="group" aria-label="Operator views">${OPERATOR_TABS.map((name) =>
      `<button type="button" id="tab-${name}" data-tab="${name}" aria-pressed="${tab === name}">${tabName(name)}</button>`).join("")}</div>
    <p class="subnav-note">${descriptions[tab]}</p>
    ${tab === "contracts" ? renderContractsTable(tally) : `${renderMetrics(view)}${["transactions", "attention"].includes(tab) ?
      `<div class="workspace">${renderLedger(view)}${renderReceipt(view, copy)}</div>${tab === "attention" ? renderAttentionParticipants(view) : ""}${renderLookup(lookup)}` :
      tab === "participants" ? renderParticipants(view) : renderListings(view)}`}`
}

export function renderDesk(view, lookup = {}, theme = "light", copy = {}, tally = null) {
  const state = tally ?? { area: "operator", operatorTab: view.tab, contracts: [] }
  const area = AREAS.includes(state.area) ? state.area : "deals"
  const [title, description] = AREA_TEXT[area]
  const body = area === "deals" ? renderDeals(state) : area === "mediation" ? renderMediation(state) :
    area === "companies" ? renderCompanies(state) : renderOperator(view, lookup, state, copy)
  return `<div class="desk" data-source="${e(view.source)}">${renderHeader(view, theme, area)}<main id="main" class="main-shell">
    <div class="page-heading"><div><h1 id="page-title" tabindex="-1">${e(title)}</h1><p>${e(description)}</p></div><span class="read-only">${icon("lock")}Read only</span></div>
    ${renderNotice(view)}${state.contractsError && area !== "operator" ? `<div class="connection-notice" role="status"><strong>Contracts</strong> ${e(state.contractsError)}</div>` : ""}
    ${body}
    <footer class="app-footer"><span>Tally · Cardano preprod demo · Read only</span><span>${view.source === "fixture" ? "Saved demo snapshot" : `Last received ${e(stamp(view.updatedAt))}`}</span></footer>
  </main></div>`
}

export function deskTitle(view, area = "operator", operatorTab = view.tab) {
  const name = area === "operator" ? tabName(operatorTab) : AREA_TEXT[area]?.[0] ?? tabName(view.tab)
  return `${view.source === "fixture" ? "Offline sample · " : view.source === "stale" ? "Stale · " : ""}${name} · Tally`
}
