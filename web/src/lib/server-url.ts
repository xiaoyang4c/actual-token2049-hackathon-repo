/** Ignore retired server URLs, including values left in hosting settings. */
export function serverUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return ''
  const base = value.trim().replace(/\/$/, '')
  try {
    const hostname = new URL(base).hostname.toLowerCase().replace(/\.$/, '')
    if (hostname === 'sslip.io' || hostname.endsWith('.sslip.io')) return ''
    return base
  } catch {
    return ''
  }
}
