// Prepare marketplace read responses for display. No scoring or fee policy here.

import { formatValue, label } from "./format.js"
export { allEvents, executionOf, fillMode } from "./audit.js"

const OUTCOMES = new Set(["pending", "successful", "failed", "disputed", "cancelled", "unresolved"])
const ATTENTION = new Set(["failed", "disputed", "unresolved"])
const SOURCES = new Set(["connected", "fixture", "stale"])
const KYC_BADGES = new Set(["unverified", "pending", "verified", "rejected", "expired"])

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

const list = (value) => Array.isArray(value) ? value.filter(isRecord) : []

export function transactionTitle(transaction) {
  const terms = transaction?.terms ?? {}
  return String(terms.service ?? terms.goods ?? terms.title ??
    (terms.invoiceId ? `Invoice ${terms.invoiceId}` : transaction?.id ?? "Transaction"))
}

export function outcomeOf(receipt) {
  const state = receipt?.outcome?.state
  return OUTCOMES.has(state) ? state : "unknown"
}

export function escrowOf(receipt) {
  const evidence = receipt?.outcome?.evidence ?? {}
  const mode = evidence.mode ?? receipt?.mode
  if (mode === "live") return { mode: "live", text: "Live preprod escrow. Check the recorded chain evidence." }
  if (mode === "paper") return { mode: "paper", text: "Simulated escrow. No chain settlement proof." }
  return { mode: "unknown", text: "Escrow mode not provided. No chain settlement proof." }
}

export function participantName(entities, id) {
  return entities.find((entity) => entity.id === id)?.displayName ?? id ?? "Not provided"
}

function presentEntity(entity, scores, kycById, kycErrors, storedEntityIds) {
  const kyc = kycById?.[entity.id]
  const error = kycErrors?.[entity.id]
  const current = kyc?.entity ?? entity
  const badge = error ? "unknown" : kyc?.badge ?? entity.kycStatus
  return {
    ...current,
    displayName: String(current.displayName ?? entity.id),
    roles: Array.isArray(current.roles) ? current.roles : [],
    wallets: Array.isArray(current.wallets) ? current.wallets : [],
    kycBadge: KYC_BADGES.has(badge) ? badge : "unknown",
    kycTier: error ? "unknown" : kyc?.tier ?? entity.kycTier ?? "none",
    kycSource: error ? "Mock KYC unavailable" : kyc ? "Mock KYC record" :
      storedEntityIds.includes(entity.id) ? "Stored entity status" : "Seed fixture status",
    kycError: error ?? "",
    checkPending: kyc?.checkPending === true,
    reRegistration: kyc?.reRegistration ?? null,
    kycHistory: list(kyc?.history),
    scores: scores.filter((score) => score.entityId === entity.id),
  }
}

function presentTransaction(transaction, snapshot, entities) {
  const receipt = snapshot.receipts?.[transaction.id]
  const participants = list(transaction.participants).map((party) => ({
    ...party, name: participantName(entities, party.entityId),
  }))
  const currency = transaction.terms?.currency
  const title = transactionTitle(transaction)
  return {
    ...transaction, title, participants, currency,
    valueText: formatValue(transaction.value, currency),
    outcome: outcomeOf(receipt),
    // Marketplace sales are paper. Escrow has its own observed mode.
    orderMode: "paper",
    escrow: escrowOf(receipt),
    receipt,
    receiptError: snapshot.receiptErrors?.[transaction.id] ?? "",
    search: [transaction.id, title, ...participants.map((party) => party.name)].join(" ").toLowerCase(),
  }
}

export function buildView(snapshot = {}, meta = {}, controls = {}) {
  const entities = list(snapshot.entities).map((entity) =>
    presentEntity(entity, list(snapshot.scores), snapshot.kycById, snapshot.kycErrors, snapshot.storedEntityIds ?? []))
  const transactions = list(snapshot.transactions).map((transaction) =>
    presentTransaction(transaction, snapshot, entities))
  const query = String(controls.query ?? "").trim().toLowerCase()
  const filtered = transactions.filter((transaction) =>
    (!query || transaction.search.includes(query)) &&
    (!controls.type || transaction.type === controls.type) &&
    (!controls.outcome || transaction.outcome === controls.outcome))
  const pageSize = 8
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const page = Math.min(Math.max(0, controls.page ?? 0), pages - 1)
  const selection = controls.selectedId ?
    filtered.find((transaction) => transaction.id === controls.selectedId) : filtered[page * pageSize]
  return {
    source: SOURCES.has(meta.source) ? meta.source : "fixture",
    updatedAt: meta.updatedAt ?? "",
    error: String(meta.error ?? "").slice(0, 200),
    tab: ["transactions", "participants", "listings"].includes(controls.tab) ? controls.tab : "transactions",
    controls: { query: controls.query ?? "", type: controls.type ?? "", outcome: controls.outcome ?? "", page },
    entities,
    listings: list(snapshot.listings),
    kycExamples: list(snapshot.kycExamples?.cases),
    kycExamplesError: snapshot.kycExamplesError ?? "",
    transactions,
    selected: selection,
    rows: filtered.slice(page * pageSize, (page + 1) * pageSize),
    filteredCount: filtered.length,
    pageSize, pages, page,
    metrics: {
      total: transactions.length,
      completed: transactions.filter((transaction) => transaction.outcome === "successful").length,
      attention: transactions.filter((transaction) => ATTENTION.has(transaction.outcome)).length,
      unknown: transactions.filter((transaction) => transaction.outcome === "unknown").length,
      participants: entities.length,
    },
  }
}

export function validateReceipt(value, id) {
  if (!isRecord(value) || !isRecord(value.transaction) || typeof id !== "string" ||
      value.transaction.id !== id || !Array.isArray(value.events)) {
    throw new Error(`Receipt for ${id} is malformed`)
  }
  return value
}

export function evidenceRows(receipt) {
  if (Array.isArray(receipt?.transitions) && receipt.transitions.length) {
    return receipt.transitions.map((transition) => ({
      title: label(transition.to ?? transition.stage), at: transition.at,
      mode: transition.evidence?.mode,
    }))
  }
  const transaction = receipt?.transaction
  const evidence = receipt?.outcome?.evidence
  if (!transaction || !evidence) return []
  const rows = [{ title: "Agreement recorded", at: transaction.createdAt }]
  if (evidence.deliveryConfirmedAt) rows.push({ title: "Delivery confirmed", at: evidence.deliveryConfirmedAt })
  if (evidence.stage) rows.push({ title: label(evidence.stage), at: receipt.outcome.decidedAt })
  else if (evidence.settlementTimestamp) rows.push({ title: "Settlement timestamp recorded", at: evidence.settlementTimestamp })
  return rows
}
