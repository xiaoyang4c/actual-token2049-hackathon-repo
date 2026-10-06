import { FIXTURE } from "./fixture.js"
import { loadMarketplace, loadTransaction } from "./data.js"
import { buildView } from "./model.js"
import { deskTitle, renderDesk } from "./render.js"

const POLL_MS = 5000
const app = document.querySelector("#app")
let snapshot = FIXTURE
let lastLive = null
let meta = { source: "fixture" }
let controls = { tab: "transactions", query: "", type: "", outcome: "", page: 0 }
let lookup = { value: "", busy: false, error: "" }
let inspectedId = ""
let lookupVersion = 0
let pollRunning = false

function paint() {
  const active = document.activeElement
  const focusId = active?.id
  const summaryId = active?.tagName === "SUMMARY" ? active.closest("details")?.id : null
  const selection = active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] : null
  const disclosures = [...app.querySelectorAll("details[open]")].map((element) => element.id)
  const scroll = app.querySelector(".table-wrap")?.scrollLeft ?? 0
  const windowScroll = window.scrollY
  const view = buildView(snapshot, meta, controls)
  controls.page = view.page
  document.title = deskTitle(view)
  app.innerHTML = renderDesk(view, lookup)
  for (const id of disclosures) {
    const detail = document.getElementById(id)
    if (detail instanceof HTMLDetailsElement) detail.open = true
  }
  const table = app.querySelector(".table-wrap")
  if (table) table.scrollLeft = scroll
  const focus = focusId ? document.getElementById(focusId) :
    summaryId ? document.getElementById(summaryId)?.querySelector("summary") : null
  if (focus) {
    focus.focus({ preventScroll: true })
    if (selection && focus instanceof HTMLInputElement) {
      focus.setSelectionRange(...selection)
    }
  }
  window.scrollTo({top: windowScroll, behavior: "instant"})
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

async function tick() {
  if (pollRunning) return
  pollRunning = true
  const currentVersion = lookupVersion
  const currentId = inspectedId
  try {
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

app.addEventListener("click", (event) => {
  const button = event.target.closest("button")
  if (!button || button.disabled) return
  if (button.hasAttribute("data-refresh")) { tick(); return }
  if (button.hasAttribute("data-tab")) {
    controls = { ...controls, tab: button.dataset.tab, query: "", page: 0 }
  } else if (button.hasAttribute("data-type")) {
    controls = { ...controls, type: button.dataset.type, selectedId: undefined, page: 0 }
  } else if (button.hasAttribute("data-select-id")) {
    controls.selectedId = button.dataset.selectId
  } else if (button.hasAttribute("data-page")) {
    controls.page = Number(button.dataset.page)
    controls.selectedId = undefined
  } else return
  paint()
  if (button.hasAttribute("data-select-id") && window.matchMedia("(max-width: 980px)").matches) {
    document.getElementById("receipt")?.scrollIntoView({ block: "start" })
  }
})

app.addEventListener("input", (event) => {
  if (event.target.id === "search") {
    controls = { ...controls, query: event.target.value, selectedId: undefined, page: 0 }
    paint()
  } else if (event.target.id === "transaction-id") lookup.value = event.target.value
})

app.addEventListener("change", (event) => {
  if (event.target.id === "outcome") {
    controls = { ...controls, outcome: event.target.value, selectedId: undefined, page: 0 }
    paint()
  }
})

app.addEventListener("submit", (event) => {
  if (event.target.id !== "lookup-form") return
  event.preventDefault()
  inspect(lookup.value)
})

async function loop() {
  await tick()
  setTimeout(loop, POLL_MS)
}

paint()
loop()
const transactionId = new URL(location.href).searchParams.get("transactionId")
if (transactionId) inspect(transactionId)
