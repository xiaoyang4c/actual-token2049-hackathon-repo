// Display formatting. Missing numbers and currencies stay missing.

export function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

export function formatValue(value, currency) {
  const number = finite(value)
  if (number === null) return "—"
  const text = number.toLocaleString("en-US", { maximumFractionDigits: 2 })
  return currency ? `${text} ${currency}` : text
}

export function formatPct(value) {
  const number = finite(value)
  if (number === null || number < 0 || number > 1) return "—"
  return number.toLocaleString("en-US", { style: "percent", maximumFractionDigits: 1 })
}

export function formatFee(value) {
  const number = finite(value)
  return number === null || number < 0 ? "—" : `${(number / 100).toFixed(2)}%`
}

export function label(value) {
  if (typeof value !== "string" || !value) return "Not provided"
  const normalized = value === value.toUpperCase() ? value.toLowerCase() : value
  const text = normalized.replaceAll("_", " ").replaceAll("-", " ")
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function stamp(value) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return "—"
  return new Date(value).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC",
  }) + " UTC"
}
