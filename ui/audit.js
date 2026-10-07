// Legacy trading-audit helpers. Preserve the existing control API consumer.

const normalizeMode = (value) => {
  if (typeof value !== "string") return null
  const mode = value.trim().toLowerCase()
  return mode === "paper" || mode === "live" ? mode : null
}

export function fillMode(event) {
  if (!event || typeof event !== "object") return null
  const detail = typeof event.detail === "string" ? event.detail : ""
  const tagged = detail.match(/^\s*\[(paper|live)\]/i)
  if (tagged) return tagged[1].toLowerCase()
  const type = typeof event.type === "string" ? event.type : ""
  if (!type.startsWith("fill")) return null
  return normalizeMode(event.mode) ?? normalizeMode(event.fill?.mode)
}

export function allEvents(audit) {
  if (!Array.isArray(audit)) return []
  const events = []
  for (const entry of audit) {
    if (!entry || typeof entry !== "object") continue
    if (Array.isArray(entry.events)) {
      for (const event of entry.events) {
        if (event && typeof event === "object") events.push(event)
      }
    } else if (entry.type || entry.detail || entry.mode) {
      events.push(entry)
    }
  }
  return events
}

export function executionOf(audit) {
  let paper = 0
  let live = 0
  let unmarked = 0
  for (const event of allEvents(audit)) {
    const mode = fillMode(event)
    if (mode === "paper") paper += 1
    else if (mode === "live") live += 1
    else if (typeof event?.type === "string" && event.type.startsWith("fill")) unmarked += 1
  }
  const kind = paper && live ? "mixed" : live ? "live" : paper ? "paper" : "none"
  return { kind, paper, live, unmarked }
}
