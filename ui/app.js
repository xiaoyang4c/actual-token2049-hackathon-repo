import { FIXTURE } from "./fixture.js"
import { loadMarketplace, loadTransaction } from "./data.js"
import { buildView, receiptLink } from "./model.js"
import { AREAS, deskTitle, renderDesk } from "./render.js"
import {
  loadCase, loadContract, loadContracts, loadProfile, loadRulingOptions, loadRulingPayload, searchCompanies,
} from "./tally.js"

const POLL_MS = 5000
const THEME_KEY = "tally-theme"
const app = document.querySelector("#app")
let snapshot = FIXTURE
let lastLive = null
let meta = { source: "fixture" }
let controls = { tab: "transactions", query: "", type: "", outcome: "", page: 0 }
let lookup = { value: "", busy: false, error: "" }
let inspectedId = ""
let lookupVersion = 0
let pollRunning = false
let copy = {}
let copyVersion = 0

const startArea = new URL(location.href).searchParams.get("view")
const tally = {
  area: AREAS.includes(startArea) ? startArea : "deals",
  operatorTab: "transactions",
  contracts: [],
  contractsLoaded: false,
  contractsError: "",
  party: "",
  selected: "",
  detail: null,
  detailError: "",
  mediation: { selected: null, caseFile: null, caseError: "", options: null, winner: "buyer", reason: "", payload: null, busy: false, error: "" },
  companies: { query: "", results: [], selectedId: "", profile: null, busy: false, error: "" },
}

function paint() {
  const active = document.activeElement
  const focusId = active?.id
  const summaryId = active?.tagName === "SUMMARY" ? active.closest("details")?.id : null
  const textField = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
  const selection = textField ? [active.selectionStart, active.selectionEnd] : null
  const disclosures = [...app.querySelectorAll("details[open]")].map((element) => element.id)
  const scroll = app.querySelector(".table-wrap")?.scrollLeft ?? 0
  const navScroll = app.querySelector("nav")?.scrollLeft ?? 0
  const windowScroll = window.scrollY
  const view = buildView(snapshot, meta, controls)
  controls.page = view.page
  document.title = deskTitle(view, tally.area, tally.operatorTab)
  app.innerHTML = renderDesk(view, lookup, document.documentElement.dataset.theme, copy, tally)
  for (const id of disclosures) {
    const detail = document.getElementById(id)
    if (detail instanceof HTMLDetailsElement) detail.open = true
  }
  const table = app.querySelector(".table-wrap")
  if (table) table.scrollLeft = scroll
  const nav = app.querySelector("nav")
  if (nav) nav.scrollLeft = navScroll
  const focus = focusId ? document.getElementById(focusId) :
    summaryId ? document.getElementById(summaryId)?.querySelector("summary") : null
  if (focus) {
    focus.focus({ preventScroll: true })
    if (nav?.contains(focus)) focus.scrollIntoView({block: "nearest", inline: "nearest", behavior: "instant"})
    if (selection && (focus instanceof HTMLInputElement || focus instanceof HTMLTextAreaElement) && focus.type !== "radio") {
      try { focus.setSelectionRange(...selection) } catch {}
    }
  }
  window.scrollTo({top: windowScroll, behavior: "instant"})
}

async function copyReceipt(id, kind) {
  const version = ++copyVersion
  const value = kind === "id" ? id : receiptLink(id, location.href)
  copy = {transactionId: id, kind, value, busy: true, message: "Copying…"}
  paint()
  try {
    await navigator.clipboard.writeText(value)
    if (version !== copyVersion) return
    copy = {...copy, busy: false, message: kind === "id" ? "Transaction ID copied." : "Receipt link copied. Open it on this local operator UI."}
  } catch {
    if (version !== copyVersion) return
    copy = {...copy, busy: false, fallback: true, message: "Clipboard access is unavailable. Copy the selected text below."}
  }
  paint()
  if (copy.fallback) {
    const field = document.getElementById("copy-value")
    field?.focus({preventScroll: true})
    field?.select()
  }
}

function mergeReceipt(target, receipt) {
  const transaction = receipt.transaction
  const index = target.transactions.findIndex((entry) => entry.id === transaction.id)
  if (index === -1) target.transactions = [transaction, ...target.transactions]
  else target.transactions = target.transactions.map((entry, offset) => offset === index ? transaction : entry)
  target.receipts = { ...target.receipts, [transaction.id]: receipt }
  target.receiptErrors = { ...target.receiptErrors }
  delete target.receiptErrors[transaction.id]
  if (receipt.entities) {
    const entities = new Map(target.entities.map((entity) => [entity.id, entity]))
    for (const entity of receipt.entities) entities.set(entity.id, entity)
    target.entities = [...entities.values()]
    target.storedEntityIds = receipt.entities.map((entity) => entity.id)
    target.kycById = { ...target.kycById, ...receipt.kycById }
    target.kycErrors = { ...target.kycErrors }
    for (const entity of receipt.entities) delete target.kycErrors[entity.id]
    Object.assign(target.kycErrors, receipt.kycErrors)
  }
}

/** Contract views: the list every poll, and the open deal or case so its deadlines stay current. */
async function refreshContracts() {
  try {
    tally.contracts = await loadContracts()
    tally.contractsError = ""
  } catch (error) {
    tally.contractsError = `Contracts unavailable: ${error.message}`
  }
  // Show contracts as soon as they arrive; the marketplace collections load after them.
  if (!tally.contractsLoaded) {
    tally.contractsLoaded = true
    paint()
  }
  if (tally.selected) await openDeal(tally.selected, false)
  if (tally.mediation.selected) await openCase(tally.mediation.selected.id, tally.mediation.selected.milestone, false)
}

async function tick() {
  if (pollRunning) return
  pollRunning = true
  const currentVersion = lookupVersion
  const currentId = inspectedId
  try {
    await refreshContracts()
    const next = await loadMarketplace()
    if (currentId) {
      const receipt = await loadTransaction(currentId)
      if (currentVersion === lookupVersion) mergeReceipt(next, receipt)
    }
    if (currentVersion !== lookupVersion) return
    snapshot = next
    lastLive = next
    meta = { source: "connected", updatedAt: new Date().toISOString() }
  } catch (error) {
    if (currentVersion !== lookupVersion) return
    snapshot = lastLive ?? FIXTURE
    meta = { ...meta, source: lastLive ? "stale" : "fixture", error: error.message }
  } finally {
    pollRunning = false
    paint()
  }
}

async function inspect(id) {
  if (!id.trim()) return
  const version = ++lookupVersion
  lookup = { value: id.trim(), busy: true, error: "" }
  paint()
  try {
    const receipt = await loadTransaction(id.trim())
    if (version !== lookupVersion) return
    // Lookup results have their own source. Do not mix an offline sample with
    // a connected lifecycle response; refresh the collections first.
    const next = await loadMarketplace()
    if (version !== lookupVersion) return
    mergeReceipt(next, receipt)
    inspectedId = id.trim()
    snapshot = next
    lastLive = next
    meta = { source: "connected", updatedAt: new Date().toISOString() }
    controls = { ...controls, tab: "transactions", selectedId: id.trim(), query: "", type: "", outcome: "", page: 0 }
    tally.area = "operator"
    tally.operatorTab = "transactions"
  } catch (error) {
    if (version === lookupVersion) lookup.error = error.message
  } finally {
    if (version === lookupVersion) {
      lookup.busy = false
      paint()
      if (!lookup.error) document.getElementById("receipt")?.focus({ preventScroll: true })
    }
  }
}

async function openDeal(id, focus = true) {
  tally.selected = id
  try {
    const detail = await loadContract(id)
    if (tally.selected !== id) return
    tally.detail = detail
    tally.detailError = ""
  } catch (error) {
    if (tally.selected === id) tally.detailError = `Deal unavailable: ${error.message}`
  }
  if (focus) {
    paint()
    document.getElementById("deal-detail")?.focus({ preventScroll: true })
  }
}

async function openCase(id, milestone, focus = true) {
  const mediation = tally.mediation
  const changed = mediation.selected?.id !== id || mediation.selected?.milestone !== milestone
  mediation.selected = { id, milestone }
  if (changed) Object.assign(mediation, { caseFile: null, options: null, payload: null, error: "", reason: "" })
  try {
    const caseFile = await loadCase(id, milestone)
    if (mediation.selected?.id !== id) return
    mediation.caseFile = caseFile
    mediation.caseError = ""
    if (caseFile.canRuleNow) {
      try { mediation.options = await loadRulingOptions(id, milestone) } catch (error) { mediation.options = { error: error.message } }
    } else mediation.options = null
  } catch (error) {
    if (mediation.selected?.id === id) mediation.caseError = `Case unavailable: ${error.message}`
  }
  if (focus) {
    paint()
    document.getElementById("case-detail")?.focus({ preventScroll: true })
  }
}

async function prepareRuling() {
  const mediation = tally.mediation
  if (!mediation.selected) return
  if (!mediation.reason.trim()) {
    mediation.error = "Write the reason first. The mediator signs it."
    paint()
    return
  }
  mediation.busy = true
  mediation.error = ""
  paint()
  try {
    mediation.payload = await loadRulingPayload(mediation.selected.id, mediation.selected.milestone, mediation.winner, mediation.reason.trim())
  } catch (error) {
    mediation.error = error.message
  } finally {
    mediation.busy = false
    paint()
  }
}

async function findCompanies() {
  const companies = tally.companies
  companies.busy = true
  companies.error = ""
  paint()
  try {
    companies.results = await searchCompanies(companies.query.trim())
    if (!companies.results.length) companies.error = "No Tally record matches that name."
  } catch (error) {
    companies.error = error.message.endsWith("400") ? "Search with at least 2 characters." : error.message
    companies.results = []
  } finally {
    companies.busy = false
    paint()
  }
}

async function openCompany(id) {
  const companies = tally.companies
  companies.selectedId = id
  try {
    companies.profile = await loadProfile(id)
    companies.error = ""
  } catch (error) {
    companies.error = error.message
  }
  paint()
  document.getElementById("company-detail")?.focus({ preventScroll: true })
}

function setArea(area) {
  tally.area = area
  const url = new URL(location.href)
  url.searchParams.set("view", area)
  history.replaceState(null, "", url)
}

app.addEventListener("click", (event) => {
  const button = event.target.closest("button")
  if (!button || button.disabled) return
  if (button.hasAttribute("data-copy")) {
    copyReceipt(button.dataset.transactionId, button.dataset.copy)
    return
  }
  if (button.hasAttribute("data-theme-toggle")) {
    const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark"
    document.documentElement.dataset.theme = theme
    try { localStorage.setItem(THEME_KEY, theme) } catch {}
    paint()
    return
  }
  if (button.hasAttribute("data-refresh")) { tick(); return }
  if (button.hasAttribute("data-area")) {
    setArea(button.dataset.area)
  } else if (button.hasAttribute("data-contract")) {
    openDeal(button.dataset.contract)
    return
  } else if (button.hasAttribute("data-case")) {
    openCase(button.dataset.case, Number(button.dataset.milestone))
    return
  } else if (button.hasAttribute("data-company")) {
    openCompany(button.dataset.company)
    return
  } else if (button.hasAttribute("data-open-attention")) {
    setArea("operator")
    tally.operatorTab = "attention"
    controls = {tab: "attention", query: "", type: "", outcome: "", page: 0}
  } else if (button.hasAttribute("data-open-participant")) {
    setArea("operator")
    tally.operatorTab = "participants"
    controls = {tab: "participants", query: button.dataset.openParticipant, type: "", outcome: "", page: 0}
  } else if (button.hasAttribute("data-tab")) {
    tally.operatorTab = button.dataset.tab
    if (button.dataset.tab !== "contracts") controls = {tab: button.dataset.tab, query: "", type: "", outcome: "", page: 0}
  } else if (button.hasAttribute("data-type")) {
    controls = { ...controls, type: button.dataset.type, selectedId: undefined, page: 0 }
  } else if (button.hasAttribute("data-select-id")) {
    controls.selectedId = button.dataset.selectId
  } else if (button.hasAttribute("data-page")) {
    controls.page = Number(button.dataset.page)
    controls.selectedId = undefined
  } else return
  paint()
  if (button.hasAttribute("data-open-participant")) {
    document.getElementById("page-title")?.focus({preventScroll: true})
    window.scrollTo({top: 0, behavior: "instant"})
  }
  if (button.hasAttribute("data-select-id") && window.matchMedia("(max-width: 980px)").matches) {
    document.getElementById("receipt")?.scrollIntoView({ block: "start" })
  }
})

app.addEventListener("input", (event) => {
  const target = event.target
  if (target.id === "search") {
    controls = { ...controls, query: target.value, selectedId: undefined, page: 0 }
    paint()
  } else if (target.id === "transaction-id") lookup.value = target.value
  else if (target.id === "ruling-reason") tally.mediation.reason = target.value
  else if (target.id === "company-query") tally.companies.query = target.value
})

app.addEventListener("change", (event) => {
  const target = event.target
  if (target.id === "outcome") {
    controls = { ...controls, outcome: target.value, selectedId: undefined, page: 0 }
  } else if (target.id === "party") {
    tally.party = target.value
    tally.selected = ""
    tally.detail = null
  } else if (target.name === "winner") {
    tally.mediation.winner = target.value
    tally.mediation.payload = null
  } else return
  paint()
})

app.addEventListener("submit", (event) => {
  event.preventDefault()
  if (event.target.id === "lookup-form") inspect(lookup.value)
  else if (event.target.id === "ruling-form") prepareRuling()
  else if (event.target.id === "company-form") findCompanies()
})

async function loop() {
  await tick()
  setTimeout(loop, POLL_MS)
}

paint()
loop()
const transactionId = new URL(location.href).searchParams.get("transactionId")
if (transactionId) inspect(transactionId)
