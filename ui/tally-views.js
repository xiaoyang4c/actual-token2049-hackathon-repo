// Tally views: My deals, Mediation desk, Companies, Ask a Coworker, and the
// operator's contract list. Render only. Every amount and deadline comes from the API.

import { escapeHtml, formatPct, label } from "./format.js"
import { renderMarkdown } from "./markdown.js"
import {
  COWORKERS, STEPS, actionFor, coworkerName, dealsView, mediationQueue, partiesOf, readable, relative, signerText, stageOf, stateText, stateTone, viewerRole,
} from "./tally.js"

const e = escapeHtml
const empty = (title, detail) => `<div class="empty-state"><strong>${e(title)}</strong><p>${e(detail)}</p></div>`
const facts = (rows) => `<dl class="facts">${rows.filter(([, value]) => value !== null && value !== undefined && value !== "")
  .map(([key, value]) => `<div><dt>${e(key)}</dt><dd>${e(value)}</dd></div>`).join("")}</dl>`
const stateBadge = (state) => `<span class="status status-${e(stateTone(state))}"><span class="status-dot" aria-hidden="true"></span>${e(stateText(state))}</span>`
const modeTag = (labelText) => `<span class="mode-label ${labelText === "LIVE" ? "mode-live" : ""}">${e(labelText)}</span>`
const pre = (value) => `<pre>${e(typeof value === "string" ? value : JSON.stringify(value, null, 2))}</pre>`

/** Singapore time for an ISO string from the contract view. */
export function sgt(iso) {
  if (typeof iso !== "string" || Number.isNaN(Date.parse(iso))) return ""
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Singapore",
  }) + " SGT"
}

/** Exact atomic amount with the contract's decimals. Display only; no rounding. */
export function atomic(amount, decimals) {
  let value
  try { value = BigInt(amount) } catch { return "—" }
  const base = 10n ** BigInt(decimals ?? 6)
  const whole = (value / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  const fraction = (value % base).toString().padStart(Number(decimals ?? 6), "0").replace(/0+$/, "")
  return `${whole}${fraction ? `.${fraction}` : ""} test USDM`
}

function due(moment, nowMs) {
  if (!moment) return ""
  return `${moment.singapore} (${relative(moment.ms, nowMs)})`
}

function stepper(state) {
  const stage = stageOf(state)
  return `<ol class="steps" aria-label="Deal stage">${STEPS.map((name, index) => {
    const status = index < stage.step ? "done" : index === stage.step ? (stage.dispute ? "dispute" : "current") : "todo"
    const text = index === stage.step && stage.dispute ? "Dispute" : name
    return `<li class="step step-${status}" ${index === stage.step ? 'aria-current="step"' : ""}><span aria-hidden="true"></span>${e(text)}</li>`
  }).join("")}</ol>`
}

function actionCallout(next, role, nowMs) {
  const action = actionFor(next, role)
  if (!action.text) return ""
  if (!action.who) return `<p class="next-action next-done">${e(action.text)}</p>`
  return `<p class="next-action ${action.mine ? "next-mine" : ""}"><strong>${action.mine ? "Your move" : `Waiting for ${e(action.who)}`}:</strong> ${e(action.text)}${next?.dueAt ? ` <span class="due">by ${e(due(next.dueAt, nowMs))}</span>` : ""}</p>`
}

// ---------------------------------------------------------------------------
// Settlement anchors (fingerprints of final records on Cardano)
// ---------------------------------------------------------------------------

const EXPLORER = "https://preprod.cardanoscan.io/transaction/"

/** A link to the explorer, only for a transaction hash the API gave in the expected form. */
function txLink(url) {
  if (typeof url !== "string" || !url.startsWith(EXPLORER) || !/^[0-9a-f]{64}$/.test(url.slice(EXPLORER.length))) return ""
  return `<a href="${e(url)}" target="_blank" rel="noopener noreferrer">View on Cardanoscan</a>`
}

export function anchorStatus(anchor) {
  if (!anchor) return ""
  if (anchor.status === "confirmed") {
    return `<p class="anchor anchor-confirmed"><strong>Fingerprint on Cardano</strong> · block ${e(anchor.blockHeight)}${anchor.anchoredAt ? ` · ${e(sgt(anchor.anchoredAt))}` : ""} · ${anchor.explorerUrls.map(txLink).join(" · ")}</p>`
  }
  if (anchor.status === "sending") return `<p class="anchor"><strong>Fingerprint sent to Cardano.</strong> Waiting for confirmations.</p>`
  return `<p class="anchor"><strong>Fingerprint recorded.</strong> It goes on Cardano with the next anchor batch.</p>`
}

function milestoneAnchors(anchors, milestoneId) {
  const records = anchors?.records?.filter((record) => record.milestoneId === milestoneId) ?? []
  if (!records.length) return ""
  return `<h4>Settlement fingerprint</h4>${records.map((record) => `${record.recordUnchanged ? "" : '<p class="data-warning">This record changed after it was fingerprinted.</p>'}${anchorStatus(record.anchor)}
    <p class="fine">Only this fingerprint goes on the chain: <code>${e(record.recordHash.slice(0, 16))}…</code> No names, amounts, or terms.</p>`).join("")}`
}

function companyChain(anchors) {
  if (!anchors) return '<p class="muted">Loading the on-chain record…</p>'
  const chain = anchors.chain
  if (!chain.length) return '<p class="muted">No settled deals yet. Each settled deal adds a fingerprint to this company\'s chain.</p>'
  const recent = anchors.entries.slice(-5).reverse()
  return `<p>${e(chain.length)} settled ${chain.length === 1 ? "record" : "records"} fingerprinted · ${e(chain.anchored)} on Cardano · chain ${chain.intact ? "<strong>intact</strong>" : '<strong class="data-warning">broken</strong>'}</p>
    ${chain.intact ? "" : `<ul class="plain">${chain.problems.map((problem) => `<li class="data-warning">${e(problem)}</li>`).join("")}</ul>`}
    <ul class="plain anchor-list">${recent.map((entry) => `<li>#${e(entry.seq)} · ${entry.anchor.status === "confirmed" ? `on Cardano · ${entry.anchor.explorerUrls.map(txLink).join(" · ")}` : entry.anchor.status === "sending" ? "sent, confirming" : "waiting for the next batch"}</li>`).join("")}</ul>
    <p class="fine">Each entry links to the one before it, so an edited or deleted deal breaks the chain. Only fingerprints are public.</p>`
}

// ---------------------------------------------------------------------------
// My deals
// ---------------------------------------------------------------------------

function partyPicker(contracts, partyId) {
  const parties = partiesOf(contracts)
  return `<label class="party-picker"><span>Viewing as</span><select id="party">
    <option value="">All parties (operator lens)</option>
    ${parties.map((party) => `<option value="${e(party.id)}" ${party.id === partyId ? "selected" : ""}>${e(party.displayName)}</option>`).join("")}
  </select></label>`
}

function dealCard(contract, partyId, selectedId, nowMs) {
  const role = viewerRole(contract, partyId)
  const counterparty = role === "buyer" ? contract.seller : role === "seller" ? contract.buyer : null
  return `<article class="deal-card ${contract.id === selectedId ? "deal-selected" : ""}">
    <button type="button" class="deal-open" data-contract="${e(contract.id)}" aria-pressed="${contract.id === selectedId}">
      <span class="deal-head"><strong>${e(contract.title)}</strong>${modeTag(contract.label)}</span>
      <small>${role ? `You are the ${e(role)} · with ${e(counterparty?.displayName)}` : `${e(contract.buyer.displayName)} buys from ${e(contract.seller.displayName)}`} · ${e(contract.total.display)}</small>
    </button>
    ${contract.milestones.map((milestone) => `<div class="deal-milestone">${stateBadge(milestone.state)}${contract.milestones.length > 1 ? `<small>Milestone ${milestone.index + 1}</small>` : ""}${actionCallout(milestone.next, role, nowMs)}</div>`).join("")}
  </article>`
}

function contractDetail(detail, summary, partyId, nowMs, anchors = null) {
  if (!detail) return empty("Select a deal", "Choose a deal to see its stages, deadlines, escrows, and history.")
  const contract = detail.contract
  const role = viewerRole(summary, partyId)
  const decimals = contract.terms?.assetDecimals ?? 6
  const ownAnchors = anchors?.contractId === contract.id ? anchors : null
  return `<div class="detail-top"><h2>${e(summary?.title ?? contract.id)}</h2>${modeTag(detail.mode === "live" ? "LIVE" : "SIMULATED")}</div>
    <p class="muted">${e(summary?.buyer.displayName ?? contract.buyerId)} (buyer) · ${e(summary?.seller.displayName ?? contract.sellerId)} (seller)${role ? ` · You are the ${e(role)}` : ""}</p>
    ${facts([["Contract", contract.id], ["Template", contract.templateId], ["Remedy", summary?.remedy], ["Custody", "Platform-managed test wallets (custodial test setup)"]])}
    ${detail.milestones.map((milestone) => {
      const item = summary?.milestones.find((entry) => entry.id === milestone.id)
      const history = contract.milestones.find((entry) => entry.id === milestone.id)?.history ?? []
      return `<section class="detail-section">
        <div class="section-heading"><h3>${e(item?.title ?? `Milestone ${milestone.index + 1}`)}</h3>${stateBadge(milestone.state)}</div>
        ${stepper(milestone.state)}
        ${item ? actionCallout(item.next, role, nowMs) : ""}
        ${facts([
          ["Amount", item?.amount.display],
          ["Pay by", sgt(milestone.deadlines?.payByTime)],
          ["Deliver by", sgt(milestone.deadlines?.submitResultTime)],
          ["Dispute until", sgt(milestone.inspectionCutoffAt)],
          ["Release at unlock", sgt(milestone.deadlines?.unlockTime)],
          ["Dispute window ends", sgt(milestone.deadlines?.externalDisputeUnlockTime)],
          ["Tier deadline", sgt(milestone.tierDeadline)],
          ["Outcome", milestone.outcome ? label(milestone.outcome) : null],
        ])}
        <h4>Escrows</h4>
        <table class="mini-table"><thead><tr><th scope="col">Escrow</th><th scope="col">Amount</th><th scope="col">Escrow state</th></tr></thead>
        <tbody>${milestone.escrows.map((escrow) => `<tr><td>${e(label(escrow.role))}</td><td class="numeric">${e(atomic(escrow.amountAtomic, decimals))}</td><td>${e(escrow.onChainState ?? "Not funded")}${escrow.confirmed === false ? " (confirming)" : ""}</td></tr>`).join("")}</tbody></table>
        ${milestone.obligations.length ? `<h4>Ruling obligations</h4><ul class="plain">${milestone.obligations.map((obligation) => `<li>${e(label(obligation.party))}: ${e(label(obligation.action))}, due ${e(sgt(obligation.dueAt))}${obligation.compliedAt ? " · done" : obligation.ignoredAt ? " · ignored" : ""}</li>`).join("")}</ul>` : ""}
        ${milestoneAnchors(ownAnchors, milestone.id)}
        ${milestone.reliability ? `<h4>Reliability record</h4>${facts([["Result", label(milestone.reliability.state)], ["At fault", milestone.reliability.fault ? label(milestone.reliability.fault) : "None"], ["Confidence", formatPct(milestone.reliability.verificationConfidence)]])}` : ""}
        <details id="history-${e(milestone.id)}"><summary>History (${history.length} steps)</summary>
          <ol class="history">${history.map((entry) => `<li><span>${e(stateText(entry.to))}</span><small>${e(sgt(new Date(entry.at).toISOString()))} · ${e(entry.actor)}</small></li>`).join("")}</ol>
        </details>
      </section>`
    }).join("")}
    <p class="fine">Audit log hash chain: ${detail.auditChainIntact ? "intact" : "BROKEN"}. Actions need the party's signature and happen outside this read-only view.</p>`
}

const loading = () => `<p class="loading" role="status">Loading contracts…</p>`

export function renderDeals(tally, nowMs = Date.now()) {
  if (tally.contractsError && !tally.contracts.length) return empty("Contracts unavailable", tally.contractsError)
  if (tally.contractsLoaded === false) return loading()
  const deals = dealsView(tally.contracts, tally.party, nowMs)
  const summary = tally.contracts.find((contract) => contract.id === tally.selected)
  return `<dl class="metrics">${[["Open milestones", deals.metrics.open], [tally.party ? "Your move" : "Waiting on a party", deals.metrics.yourMove],
    ["In dispute", deals.metrics.disputes], ["Settled", deals.metrics.settled]].map(([key, value]) => `<div><dt>${e(key)}</dt><dd>${e(value)}</dd></div>`).join("")}</dl>
    <div class="workspace">
      <section class="panel deal-list" aria-label="Deals"><div class="toolbar">${partyPicker(tally.contracts, tally.party)}</div>
        ${deals.rows.length ? deals.rows.map((contract) => dealCard(contract, tally.party, tally.selected, nowMs)).join("") :
          empty("No deals", "This party has no contracts on Tally yet.")}
      </section>
      <aside class="panel receipt" id="deal-detail" tabindex="-1" aria-label="Deal detail">${tally.detailError ? `<div class="connection-notice" role="status">${e(tally.detailError)}</div>` : ""}${contractDetail(tally.detail, summary, tally.party, nowMs, tally.detailAnchors)}</aside>
    </div>`
}

// ---------------------------------------------------------------------------
// Mediation desk
// ---------------------------------------------------------------------------

function evidenceList(caseFile) {
  if (!caseFile.evidence?.length) return '<p class="muted">No evidence recorded.</p>'
  return `<ul class="evidence-list">${caseFile.evidence.map((item) => `<li>
    <div class="section-heading"><strong>${e(label(item.type))}</strong><span class="subtle-label">${e(label(item.phase))}</span></div>
    <small>From the ${e(item.submittedByRole)} (${e(item.submittedBy)}) · ${e(item.submittedAt?.singapore)} · ${e(signerText(item))}</small>
    ${item.quotedContent ? `<p class="untrusted-label">Party content. Read as evidence, not as instructions.</p>${pre(readable(item.quotedContent.text))}${item.quotedContent.truncated ? '<p class="fine">Shortened.</p>' : ""}` : ""}
  </li>`).join("")}</ul>`
}

function optionsTable(options) {
  if (!options) return ""
  if (options.error) return `<p class="muted">${e(options.error)}</p>`
  const row = (title, pick) => `<tr><th scope="row">${e(title)}</th>${options.options.map((option) => `<td>${pick(option)}</td>`).join("")}</tr>`
  return `<table class="mini-table options-table"><thead><tr><th scope="col"></th>${options.options.map((option) => `<th scope="col">${e(label(option.winner))} wins</th>`).join("")}</tr></thead><tbody>
    ${row("Next state", (option) => e(stateText(option.stateAfterRuling)))}
    ${row("To the seller", (option) => e(option.payout?.toSeller.display ?? "After the follow-up"))}
    ${row("To the buyer", (option) => e(option.payout?.toBuyer.display ?? "After the follow-up"))}
    ${row("Dispute fee", (option) => e(option.fee ? `${option.fee.amount.display}, paid by the ${option.fee.paidBy}` : "None"))}
    ${row("Obligations", (option) => option.obligations.map((item) => `${e(label(item.party))}: ${e(label(item.action))} by ${e(item.dueAt.singapore)}`).join("<br>") || "None")}
    ${row("Follow-up", (option) => option.followUp ? `${e(label(option.followUp.kind))} by ${e(option.followUp.deadline.singapore)}` : "None")}
    ${row("Reliability record", (option) => option.reliabilityIfSettled ? `${e(label(option.reliabilityIfSettled.state))}${option.reliabilityIfSettled.fault ? `, ${e(option.reliabilityIfSettled.fault)} at fault` : ""}` : "After the follow-up")}
  </tbody></table>
  <p class="fine">If nobody rules by ${e(options.defaultIfNoRuling.appliesAt?.singapore ?? "the deadline")}, the ${e(options.defaultIfNoRuling.winner)} wins by template default. The engine simulated both rulings on a copy of this contract.</p>`
}

function rulingForm(mediation) {
  const payload = mediation.payload
  return `<form id="ruling-form" class="ruling-form">
    <fieldset><legend>Winner</legend>
      ${["buyer", "seller"].map((winner) => `<label><input type="radio" name="winner" value="${winner}" ${mediation.winner === winner ? "checked" : ""}> ${label(winner)}</label>`).join("")}
    </fieldset>
    <label for="ruling-reason">Reason (signed, visible to both parties)</label>
    <textarea id="ruling-reason" rows="4" maxlength="2000">${e(mediation.reason)}</textarea>
    <button type="submit" class="button" ${mediation.busy ? "disabled" : ""}>${mediation.busy ? "Preparing…" : "Prepare the bytes to sign"}</button>
    ${mediation.error ? `<p class="data-warning" role="status">${e(mediation.error)}</p>` : ""}
  </form>
  ${payload ? `<div class="payload"><p><strong>Sign these exact bytes with the mediator key, offline.</strong> This page never signs or submits.</p>
    ${facts([["SHA-256", payload.bytesSha256], ["Submit to", payload.endpoint]])}
    <h4>Bytes</h4>${pre(payload.bytes)}<h4>Request</h4>${pre(payload.request)}</div>` : ""}`
}

export function renderMediation(tally, nowMs = Date.now()) {
  if (tally.contractsLoaded === false) return loading()
  const queue = mediationQueue(tally.contracts)
  const mediation = tally.mediation
  const caseFile = mediation.caseFile
  const selectedKey = mediation.selected ? `${mediation.selected.id}/${mediation.selected.milestone}` : ""
  return `<dl class="metrics">${[["Disputes", queue.length], ["Waiting for a ruling", queue.filter((item) => item.milestone.state === "tier_3_mediation").length],
    ["Due within 24 h", queue.filter((item) => item.due - nowMs < 86_400_000 && item.due > nowMs).length], ["Parties negotiating", queue.filter((item) => item.milestone.state === "tier_1_negotiation").length]]
    .map(([key, value]) => `<div><dt>${e(key)}</dt><dd>${e(value)}</dd></div>`).join("")}</dl>
    <div class="demo-notice"><strong>Mediator lens</strong><span>In production this desk needs mediator sign-in. The mediator decides and signs. Tally drafts and shows the consequences.</span></div>
    <div class="workspace">
      <section class="panel deal-list" aria-label="Dispute queue">
        ${queue.length ? queue.map(({ contract, milestone }) => {
          const key = `${contract.id}/${milestone.index}`
          return `<article class="deal-card ${key === selectedKey ? "deal-selected" : ""}"><button type="button" class="deal-open" data-case="${e(contract.id)}" data-milestone="${milestone.index}" aria-pressed="${key === selectedKey}">
            <span class="deal-head"><strong>${e(milestone.title)}</strong>${modeTag(contract.label)}</span>
            <small>${e(contract.buyer.displayName)} vs ${e(contract.seller.displayName)} · ${e(milestone.amount.display)}</small></button>
            <div class="deal-milestone">${stateBadge(milestone.state)}${actionCallout(milestone.next, null, nowMs)}</div></article>`
        }).join("") : empty("No disputes", "No milestone is in a dispute tier.")}
      </section>
      <aside class="panel receipt" id="case-detail" tabindex="-1" aria-label="Case file">
        ${mediation.caseError ? `<div class="connection-notice" role="status">${e(mediation.caseError)}</div>` : ""}
        ${!caseFile ? empty("Select a case", "Choose a dispute to read its record.") : `
          <div class="detail-top"><h2>${e(caseFile.milestone.title)}</h2>${modeTag(caseFile.mode === "live" ? "LIVE" : "SIMULATED")}</div>
          <p class="muted">${e(caseFile.nextStep)}</p>
          ${facts([["Contract", caseFile.contract.id], ["Template", caseFile.contract.template.id], ["Judge", caseFile.contract.judge], ["Remedy", caseFile.contract.remedy],
            ["Amount", caseFile.milestone.amount.display], ["Tier reached", String(caseFile.milestone.dispute.tierReached)],
            ["Tier deadline", caseFile.milestone.dispute.tierDeadline ? due(caseFile.milestone.dispute.tierDeadline, nowMs) : null],
            ["Delivered on time", caseFile.milestone.deliveredOnTime === null ? null : caseFile.milestone.deliveredOnTime ? "Yes" : "No"]])}
          <section class="detail-section"><h3>Required delivery evidence</h3><ul class="plain">${caseFile.deliveryEvidenceCheck.map((check) => `<li>${check.met ? "Met" : "Missing"}: ${e(check.rule)} (found ${e(check.found)})</li>`).join("")}</ul></section>
          <section class="detail-section"><h3>Evidence</h3>${evidenceList(caseFile)}</section>
          ${caseFile.canRuleNow ? `<section class="detail-section"><h3>What each ruling does</h3>${optionsTable(mediation.options)}</section>
            <section class="detail-section"><h3>Prepare a ruling</h3>${rulingForm(mediation)}</section>` : ""}
          <details id="audit-trail"><summary>Audit trail (${caseFile.auditTrail.length} events)</summary><ol class="history">${caseFile.auditTrail.map((row) => `<li><span>${e(label(row.event))}</span><small>${e(row.at.singapore)} · ${e(row.actor)}</small></li>`).join("")}</ol></details>`}
      </aside>
    </div>`
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

export function renderCompanies(tally) {
  const companies = tally.companies
  const profile = companies.profile
  return `<div class="workspace">
    <section class="panel deal-list" aria-label="Company search">
      <form id="company-form" class="toolbar"><label class="search-field"><span class="sr-only">Company name or id</span><input id="company-query" type="search" value="${e(companies.query)}" placeholder="Company name or Tally id" autocomplete="off"></label><button type="submit" class="button" ${companies.busy ? "disabled" : ""}>Search</button></form>
      ${companies.error ? `<p class="data-warning" role="status">${e(companies.error)}</p>` : ""}
      ${companies.results.length ? companies.results.map((item) => `<article class="deal-card ${item.id === companies.selectedId ? "deal-selected" : ""}"><button type="button" class="deal-open" data-company="${e(item.id)}" aria-pressed="${item.id === companies.selectedId}"><span class="deal-head"><strong>${e(item.displayName)}</strong></span><small>${e(item.id)} · KYC ${e(item.kycStatus)}</small></button></article>`).join("") :
        `<p class="panel-note">Search for a company that trades on Tally. Try “kopi” or “highland”.</p>`}
    </section>
    <aside class="panel receipt" id="company-detail" tabindex="-1" aria-label="Company record">
      ${!profile ? empty("Select a company", "Its Tally record appears here. Facts, not a verdict.") : `
        <div class="detail-top"><h2>${e(profile.entity.displayName)}</h2><span class="subtle-label">${e(profile.entity.id)}</span></div>
        ${facts([["KYC", `${label(profile.entity.kycStatus)} · ${label(profile.entity.kycTier)} tier`], ["On Tally since", profile.entity.createdAt?.slice(0, 10)]])}
        <section class="detail-section"><h3>Record at a glance</h3>
          <table class="mini-table"><thead><tr><th scope="col"></th><th scope="col">Live</th><th scope="col">Simulated</th></tr></thead><tbody>
          ${[["Milestones", "milestones"], ["Open", "open"], ["Disputed", "disputed"], ["Disputes lost", "disputesLost"], ["Rulings ignored", "rulingsIgnored"], ["Late deliveries", "lateDeliveries"], ["At fault", "atFault"]]
            .map(([title, key]) => `<tr><th scope="row">${e(title)}</th><td class="numeric">${e(profile.contractSummary.live[key])}</td><td class="numeric">${e(profile.contractSummary.simulated[key])}</td></tr>`).join("")}
          </tbody></table></section>
        <section class="detail-section"><h3>Scores</h3>
          ${profile.scores.length ? `<table class="mini-table"><thead><tr><th scope="col">Category</th><th scope="col">Role</th><th scope="col">Score</th><th scope="col">Lower bound</th><th scope="col">Events</th></tr></thead><tbody>
          ${profile.scores.map((score) => `<tr><td>${e(label(score.category))}</td><td>${e(label(score.role))}</td><td class="numeric">${e(formatPct(score.score))}</td><td class="numeric">${e(formatPct(score.lowerBound))}</td><td class="numeric">${e(score.events.success)} ok · ${e(score.events.failure)} failed</td></tr>`).join("")}
          </tbody></table>` : '<p class="muted">No scored events yet.</p>'}
          ${profile.scoringPolicy.provisional ? `<p class="fine">Policy ${e(profile.scoringPolicy.version)} is a provisional placeholder. Read these as counts of successes and failures, not a calibrated rating.</p>` : ""}
        </section>
        <section class="detail-section"><h3>On-chain record</h3>${companyChain(companies.anchors?.entityId === profile.entity.id ? companies.anchors : null)}</section>
        <section class="detail-section"><h3>Deals</h3>
          ${profile.deals.length ? `<table class="mini-table"><thead><tr><th scope="col">Deal</th><th scope="col">Role</th><th scope="col">Amount</th><th scope="col">Result</th></tr></thead><tbody>
          ${profile.deals.map((deal) => `<tr><td>${modeTag(deal.label)} <small>${e(deal.templateId)} · with ${e(deal.counterpartyId)}</small></td><td>${e(label(deal.role))}</td><td class="numeric">${e(deal.amount.display)}</td><td>${stateBadge(deal.state)}${deal.disputed ? `<small>Dispute won by the ${e(deal.disputeWinner ?? "pending")}</small>` : ""}${deal.ignoredRuling ? '<small class="data-warning">Ignored a ruling</small>' : ""}${deal.onTime === false && deal.role === "seller" ? '<small class="data-warning">Late delivery</small>' : ""}</td></tr>`).join("")}
          </tbody></table>` : '<p class="muted">No Tally deals yet.</p>'}
        </section>
        <p class="fine">Tally records cover deals on this platform only. This is information, not a credit rating. Tally does not set contract terms from scores yet.</p>`}
    </aside>
  </div>`
}

// ---------------------------------------------------------------------------
// Ask a Coworker
// ---------------------------------------------------------------------------

function answerPanel(job) {
  if (!job) return empty("Your answer appears here", "Pick a Coworker, write your request, and press Ask. A fill-in request takes a second. A plain-English request can take a minute.")
  if (job.status === "queued" || job.status === "running") {
    return `<p class="loading" role="status">${e(coworkerName(job.coworker))} is working${job.position ? ` (${e(job.position)} ahead of you)` : ""}…</p>`
  }
  if (job.status === "failed") return `<div class="connection-notice" role="status">${e(job.error ?? "The Coworker could not answer.")}</div>`
  const tag = job.mode === "model" ? "AI answer" : job.mode === "fill-in" ? "Answered without AI" : "Needs more detail"
  // The answer is untrusted text. renderMarkdown escapes it before it adds any markup.
  return `<div class="detail-top"><h2>${e(coworkerName(job.coworker))}</h2><span class="mode-label">${e(tag)}</span></div>
    <div class="md-answer">${renderMarkdown(job.answer)}</div>`
}

export function renderAsk(tally) {
  const ask = tally.ask
  const chosen = COWORKERS.find((item) => item.slug === ask.coworker) ?? COWORKERS[0]
  return `<div class="workspace ask-workspace">
    <section class="panel ask-panel" aria-label="Ask a Coworker">
      <form id="ask-form" class="ask-form">
        <fieldset><legend>Coworker</legend>
          ${COWORKERS.map((item) => `<label class="ask-choice"><input type="radio" name="coworker" value="${e(item.slug)}" ${item.slug === chosen.slug ? "checked" : ""}><span><strong>${e(item.name)}</strong><small>${e(item.does)}</small></span></label>`).join("")}
        </fieldset>
        <label for="ask-text">Your request</label>
        <textarea id="ask-text" rows="7" maxlength="4000" placeholder="${e(chosen.example)}">${e(ask.text)}</textarea>
        <div class="ask-actions"><button type="submit" class="button" ${ask.busy ? "disabled" : ""}>${ask.busy ? "Working…" : `Ask ${e(chosen.name)}`}</button>
          <button type="button" class="text-button" data-ask-example>Use an example</button></div>
        ${ask.error ? `<p class="data-warning" role="status">${e(ask.error)}</p>` : ""}
        <p class="fine">Free preview: no payment, and nothing is saved. Plain English uses an AI model with a small daily allowance. The fill-in format always works. For a paid Task with escrow, hire the Coworker on Sokosumi.</p>
      </form>
    </section>
    <aside class="panel receipt" id="ask-answer" tabindex="-1" aria-label="Answer" aria-live="polite">${answerPanel(ask.job)}</aside>
  </div>`
}

// ---------------------------------------------------------------------------
// Operator: all contracts
// ---------------------------------------------------------------------------

export function renderContractsTable(tally, nowMs = Date.now()) {
  const rows = tally.contracts.flatMap((contract) => contract.milestones.map((milestone) => ({ contract, milestone })))
  if (!rows.length) return `<section class="panel">${empty("No contracts", tally.contractsError || "No contract is stored yet.")}</section>`
  return `<section class="panel"><div class="table-wrap"><table><caption class="sr-only">All contracts and milestones</caption>
    <thead><tr><th scope="col">Milestone</th><th scope="col">Parties</th><th scope="col">Amount</th><th scope="col">State</th><th scope="col">Next</th><th scope="col">Mode</th></tr></thead>
    <tbody>${rows.map(({ contract, milestone }) => `<tr><td><strong>${e(milestone.title)}</strong><small>${e(contract.id)} · ${e(contract.templateId)}</small></td>
      <td class="counterparties"><span>${e(contract.buyer.displayName)}</span><span>${e(contract.seller.displayName)}</span></td>
      <td class="numeric">${e(milestone.amount.display)}</td><td>${stateBadge(milestone.state)}</td>
      <td>${actionCallout(milestone.next, null, nowMs)}</td><td>${modeTag(contract.label)}</td></tr>`).join("")}</tbody></table></div>
    <p class="panel-note">Every contract here is ${tally.contracts.every((contract) => contract.label === "SIMULATED") ? "SIMULATED (paper mode)" : "labelled with its own mode"}. Next actions come from the stored contract state.</p></section>`
}
