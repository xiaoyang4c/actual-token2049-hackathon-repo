// Shared display formatting for the desk model and renderer.

export function formatMoney(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return "—"
  const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return (n < 0 ? "−" : "") + "$" + abs
}

export function formatPnl(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return "—"
  if (n > 0) return "+" + formatMoney(n)
  return formatMoney(n)
}

export function formatPct(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return "—"
  return n.toLocaleString("en-US", { style: "percent", maximumFractionDigits: 1 })
}

export function formatPrice(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return "—"
  return n.toFixed(2)
}

export function formatSize(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return "—"
  return Number.isInteger(n) ? String(n) : n.toLocaleString("en-US", { maximumFractionDigits: 4 })
}

export const venueLabel = (venue) => {
  if (venue === "polymarket") return "Polymarket"
  if (venue === "kalshi") return "Kalshi"
  return String(venue ?? "—")
}
