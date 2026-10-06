import { FIXTURE } from "./fixture.js"
import { buildView } from "./model.js"
import { deskTitle, renderDesk } from "./render.js"

const POLL_MS = 2000
const app = document.querySelector("#app")
let lastLive = null
let painted = ""

const getJson = async (path) => {
  const res = await fetch(path, { cache: "no-store", signal: AbortSignal.timeout(2500) })
  if (!res.ok) throw new Error(`${path} returned ${res.status}`)
  return res.json()
}

const loadLive = async () => {
  const [state, audit] = await Promise.all([getJson("/agent/state"), getJson("/audit")])
  if (!state || typeof state !== "object" || !state.policy || !state.portfolio) {
    throw new Error("/agent/state did not include policy and portfolio")
  }
  if (!Array.isArray(audit)) throw new Error("/audit was not a list")
  return { state, audit }
}

const paint = (view) => {
  const html = renderDesk(view)
  document.title = deskTitle(view)
  if (html === painted) return
  const audit = app.querySelector(".audit-list")
  const auditScroll = audit ? audit.scrollTop : 0
  const windowScroll = window.scrollY
  painted = html
  app.innerHTML = html
  const next = app.querySelector(".audit-list")
  if (next) next.scrollTop = auditScroll
  window.scrollTo(0, windowScroll)
}

const tick = async () => {
  try {
    const live = await loadLive()
    lastLive = { ...live, updatedAt: new Date().toISOString() }
    paint(buildView(live.state, live.audit, { source: "live", updatedAt: lastLive.updatedAt }))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (lastLive) {
      paint(buildView(lastLive.state, lastLive.audit, { source: "stale", updatedAt: lastLive.updatedAt, error: message }))
    } else {
      paint(buildView(FIXTURE.state, FIXTURE.audit, { source: "fixture", error: message }))
    }
  }
}

// Wait for each poll to finish before the next one starts. With setInterval a
// slow poll could resolve after a newer one and paint older data over it.
const loop = async () => {
  await tick()
  setTimeout(loop, POLL_MS)
}

loop()
