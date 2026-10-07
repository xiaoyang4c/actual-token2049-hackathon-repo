// Tally contract views: GET-only loaders and display models.
// Every amount, deadline, payout, and score comes from the control API,
// which takes them from the contract engine. This module only selects,
// groups, and labels. Relative times ("in 3 h") are display aids.

import { getJson } from "./data.js"
import { isRecord } from "./model.js"

const enc = encodeURIComponent
const PARTY_ACTORS = new Set(["buyer", "seller", "both", "either"])

function records(value, path) {
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error(`${path} was not a list of records`)
  return value
}

export async function loadContracts(fetcher = fetch) {
  return records(await getJson("/reliability/contracts/list", fetcher), "/reliability/contracts/list")
}

export async function loadContract(id, fetcher = fetch) {
  const value = await getJson(`/reliability/contracts?id=${enc(id)}`, fetcher)
  if (!isRecord(value) || !isRecord(value.contract)) throw new Error(`Contract ${id} is malformed`)
  return value
}

export async function loadCase(id, milestone, fetcher = fetch) {
  return getJson(`/reliability/contracts/case?id=${enc(id)}&milestone=${enc(milestone)}`, fetcher)
}

export async function loadRulingOptions(id, milestone, fetcher = fetch) {
  return getJson(`/reliability/contracts/ruling-options?id=${enc(id)}&milestone=${enc(milestone)}`, fetcher)
}

export async function loadRulingPayload(id, milestone, winner, reason, fetcher = fetch) {
  return getJson(`/reliability/contracts/ruling-payload?id=${enc(id)}&milestone=${enc(milestone)}&winner=${enc(winner)}&reason=${enc(reason)}`, fetcher)
}

export async function searchCompanies(query, fetcher = fetch) {
  return records(await getJson(`/reliability/profile/search?q=${enc(query)}`, fetcher), "/reliability/profile/search")
}

export async function loadProfile(entityId, fetcher = fetch) {
  const value = await getJson(`/reliability/profile?entityId=${enc(entityId)}`, fetcher)
  if (!isRecord(value) || !isRecord(value.entity)) throw new Error(`Profile ${entityId} is malformed`)
  return value
}

// ---- Display models ----

/** The deal journey. Each milestone state maps to one step. */
export const STEPS = ["Agreement", "Funding", "Delivery", "Inspection", "Release", "Closed"]
const STEP_OF = {
  draft: 0, pending_acceptance: 0,
  awaiting_funding: 1,
  funded: 2,
  delivered: 3, in_inspection: 3,
  accepted_pending_release: 4, auto_released: 4,
  settled: 5, cancelled: 5, expired: 5, refunded: 5,
}
const DISPUTE_STATES = new Set([
  "disputed", "tier_1_negotiation", "tier_2_evidence_rule", "tier_3_mediation",
  "return_pending", "redo_pending", "redo_inspection", "resolved",
])

/** Step index and whether the milestone left the normal path for a dispute. */
export function stageOf(state) {
  if (DISPUTE_STATES.has(state)) return { step: 3, dispute: true }
  return { step: STEP_OF[state] ?? 0, dispute: false }
}

const STATE_TEXT = {
  draft: "Draft", pending_acceptance: "Waiting for signatures", awaiting_funding: "Waiting for funding",
  funded: "Funded, awaiting delivery", delivered: "Delivered", in_inspection: "In inspection",
  accepted_pending_release: "Accepted, releases at unlock", auto_released: "Releases at unlock",
  disputed: "Dispute opening", tier_1_negotiation: "Tier 1: negotiation", tier_2_evidence_rule: "Tier 2: judge decides",
  tier_3_mediation: "Tier 3: mediation", return_pending: "Return in progress", redo_pending: "Redo in progress",
  redo_inspection: "Redo in inspection", resolved: "Ruling being carried out",
  settled: "Settled", cancelled: "Cancelled", expired: "Expired", refunded: "Refunded",
}

export function stateText(state) {
  return STATE_TEXT[state] ?? String(state ?? "Unknown")
}

/** A status class for the state badge. */
export function stateTone(state) {
  if (state === "settled") return "successful"
  if (state === "cancelled" || state === "expired") return "cancelled"
  if (state === "refunded") return "failed"
  if (DISPUTE_STATES.has(state)) return "disputed"
  return "pending"
}

/** The viewer's role in a contract, or null for an outside viewer. */
export function viewerRole(contract, partyId) {
  if (!partyId) return null
  if (contract?.buyer?.id === partyId) return "buyer"
  if (contract?.seller?.id === partyId) return "seller"
  return null
}

const ACTOR_TEXT = {
  buyer: "the buyer", seller: "the seller", both: "both parties", either: "either party",
  inspector: "the named inspector", mediator: "the mediator", escrow: "the escrow", none: "nobody",
}

/** Next action text from the viewer's side. `mine` is true when the viewer must act. */
export function actionFor(next, role) {
  const actor = next?.actor ?? "none"
  const mine = role !== null && (actor === role || actor === "both" || actor === "either")
  if (actor === "none") return { mine: false, who: "", text: next?.action ?? "" }
  return { mine, who: mine ? "You" : ACTOR_TEXT[actor] ?? actor, text: next?.action ?? "" }
}

/** "in 2 d 4 h", "5 h ago", or "now". */
export function relative(dueMs, nowMs = Date.now()) {
  if (typeof dueMs !== "number" || !Number.isFinite(dueMs)) return ""
  const delta = dueMs - nowMs
  const size = Math.abs(delta)
  if (size < 60_000) return "now"
  const days = Math.floor(size / 86_400_000)
  const hours = Math.floor((size % 86_400_000) / 3_600_000)
  const minutes = Math.floor((size % 3_600_000) / 60_000)
  const text = days ? `${days} d${hours ? ` ${hours} h` : ""}` : hours ? `${hours} h${minutes ? ` ${minutes} min` : ""}` : `${minutes} min`
  return delta >= 0 ? `in ${text}` : `${text} ago`
}

/** Unique parties across contracts, sorted by name. */
export function partiesOf(contracts) {
  const parties = new Map()
  for (const contract of contracts ?? []) {
    for (const party of [contract.buyer, contract.seller]) if (party?.id) parties.set(party.id, party)
  }
  return [...parties.values()].sort((left, right) => String(left.displayName).localeCompare(String(right.displayName)))
}

/** Deals for one party (or all), with counts for the metric strip. */
export function dealsView(contracts, partyId, nowMs = Date.now()) {
  const rows = (contracts ?? []).filter((contract) => !partyId || viewerRole(contract, partyId) !== null)
  const milestones = rows.flatMap((contract) => contract.milestones.map((milestone) => ({ contract, milestone })))
  const role = (contract) => viewerRole(contract, partyId)
  return {
    rows,
    metrics: {
      open: milestones.filter(({ milestone }) => !milestone.terminal).length,
      // With a party selected: that party's moves. Without one: every milestone that waits on a party.
      yourMove: milestones.filter(({ contract, milestone }) => partyId ?
        actionFor(milestone.next, role(contract)).mine : PARTY_ACTORS.has(milestone.next?.actor)).length,
      disputes: milestones.filter(({ milestone }) => milestone.inDispute).length,
      settled: milestones.filter(({ milestone }) => milestone.state === "settled").length,
    },
    dueSoon: milestones.filter(({ milestone }) => milestone.next?.dueAt && milestone.next.dueAt.ms - nowMs < 86_400_000 && milestone.next.dueAt.ms > nowMs).length,
  }
}

/** Disputed milestones, most urgent first. Tier 3 cases without a deadline go last. */
export function mediationQueue(contracts) {
  const items = []
  for (const contract of contracts ?? []) {
    for (const milestone of contract.milestones ?? []) {
      if (!milestone.inDispute) continue
      items.push({ contract, milestone, due: milestone.next?.dueAt?.ms ?? Number.POSITIVE_INFINITY })
    }
  }
  return items.sort((left, right) => left.due - right.due)
}

/** Pretty-prints a JSON document for reading. Other text stays as it is. */
export function readable(text) {
  try {
    const value = JSON.parse(text)
    return value !== null && typeof value === "object" ? JSON.stringify(value, null, 2) : text
  } catch {
    return text
  }
}

/** Signer status of one evidence item, in plain words. */
export function signerText(evidence) {
  if (!evidence?.signer) return "Unsigned"
  if (evidence.signer.namedJudge) return "Signed by the named judge"
  if (evidence.signer.whitelisted) return "Signed by a whitelisted inspector"
  return "Signed by an unlisted signer"
}
