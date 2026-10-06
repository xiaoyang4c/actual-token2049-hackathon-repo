// Market feed: polls each venue's public API in the background and serves the
// latest good snapshot, so the workflow always reads recent data. A failed poll
// keeps the last good snapshot; a snapshot older than maxAgeMs is refused with
// 503 instead of being served stale.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import {
  normalizeGammaMarkets,
  normalizeKalshiEvents,
  type GammaMarket,
  type KalshiEventsResponse,
  type NormalizedMarket,
  type Venue,
} from "../packages/core/src"
import { json, serve, type Routes } from "./lib/http"

export type VenueSource = {
  venue: Venue
  url: string
  normalize: (raw: unknown) => NormalizedMarket[]
}

export const DEFAULT_SOURCES: VenueSource[] = [
  {
    venue: "polymarket",
    url:
      process.env.POLYMARKET_URL ??
      "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=10&order=volume24hr&ascending=false&include_tag=true",
    normalize: (raw) => normalizeGammaMarkets(raw as GammaMarket[]),
  },
  {
    venue: "kalshi",
    url:
      process.env.KALSHI_URL ??
      "https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=KXFED&status=open&with_nested_markets=true&limit=2",
    normalize: (raw) => normalizeKalshiEvents(raw as KalshiEventsResponse),
  },
]

export type Snapshot = { raw: unknown; markets: NormalizedMarket[]; fetchedAt: number }

type VenueStatus = {
  venue: Venue
  url: string
  polls: number
  failures: number
  markets: number
  fetchedAt: number
  lastError: string
}

export type FeedOptions = {
  sources: VenueSource[]
  maxAgeMs: number
  fetchJson?: (url: string) => Promise<unknown>
  now?: () => number
  onSnapshot?: (venue: Venue, snapshot: Snapshot) => void
}

const fetchJsonWithTimeout = async (url: string): Promise<unknown> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export const createMarketFeed = ({ sources, maxAgeMs, fetchJson = fetchJsonWithTimeout, now = Date.now, onSnapshot }: FeedOptions) => {
  const snapshots = new Map<Venue, Snapshot>()
  const status = new Map<Venue, VenueStatus>(
    sources.map((s) => [s.venue, { venue: s.venue, url: s.url, polls: 0, failures: 0, markets: 0, fetchedAt: 0, lastError: "" }]),
  )

  const pollVenue = async (source: VenueSource) => {
    const s = status.get(source.venue)!
    s.polls++
    try {
      const raw = await fetchJson(source.url)
      const markets = source.normalize(raw)
      if (markets.length === 0) throw new Error("no tradable markets in response")
      const snapshot = { raw, markets, fetchedAt: now() }
      snapshots.set(source.venue, snapshot)
      s.markets = markets.length
      s.fetchedAt = snapshot.fetchedAt
      s.lastError = ""
      onSnapshot?.(source.venue, snapshot)
    } catch (err) {
      s.failures++
      s.lastError = err instanceof Error ? err.message : String(err)
    }
  }

  let inFlight: Promise<void> | null = null
  // Concurrent callers share one round of polls instead of stacking requests.
  const pollAll = (): Promise<void> => {
    inFlight ??= Promise.all(sources.map(pollVenue)).then(() => {
      inFlight = null
    })
    return inFlight
  }

  const serveVenue = (venue: Venue): Response => {
    const snapshot = snapshots.get(venue)
    if (!snapshot) return json({ error: `${venue} feed has no data yet` }, 503)
    const ageMs = now() - snapshot.fetchedAt
    if (ageMs > maxAgeMs) return json({ error: `${venue} data is stale (${Math.round(ageMs / 1000)}s old)` }, 503)
    // The venue's own response format, so the workflow's venue readers work unchanged.
    return new Response(JSON.stringify(snapshot.raw), {
      headers: {
        "content-type": "application/json",
        "x-fetched-at": new Date(snapshot.fetchedAt).toISOString(),
        "x-age-ms": String(ageMs),
      },
    })
  }

  const routes: Routes = {
    "GET /markets/status": () =>
      json(
        [...status.values()].map((s) => ({
          ...s,
          fetchedAt: s.fetchedAt ? new Date(s.fetchedAt).toISOString() : null,
          ageSeconds: s.fetchedAt ? Math.round((now() - s.fetchedAt) / 1000) : null,
          stale: !s.fetchedAt || now() - s.fetchedAt > maxAgeMs,
        })),
      ),
  }
  for (const source of sources) routes[`GET /markets/${source.venue}`] = () => serveVenue(source.venue)

  return { pollAll, routes, snapshots }
}

// Writes each venue's latest raw response and appends a compact price tick,
// so there's a record of what the agent saw over time.
const persistSnapshot = (dir: URL) => {
  mkdirSync(dir, { recursive: true })
  return (venue: Venue, snapshot: Snapshot) => {
    writeFileSync(new URL(`${venue}.latest.json`, dir), JSON.stringify(snapshot.raw))
    const tick = {
      t: new Date(snapshot.fetchedAt).toISOString(),
      venue,
      prices: snapshot.markets.map((m) => [m.marketId, m.bestBid, m.bestAsk, m.yesPrice]),
    }
    appendFileSync(new URL("ticks.jsonl", dir), JSON.stringify(tick) + "\n")
  }
}

export const start = (port: number, intervalMs: number) => {
  const feed = createMarketFeed({
    sources: DEFAULT_SOURCES,
    // Allow a couple of missed polls before refusing to serve.
    maxAgeMs: Math.max(3 * intervalMs, 90_000),
    onSnapshot: persistSnapshot(new URL("./.data/markets/", import.meta.url)),
  })

  const pollAndLog = () =>
    feed.pollAll().then(() => {
      const line = DEFAULT_SOURCES.map((s) => {
        const snap = feed.snapshots.get(s.venue)
        return snap ? `${s.venue} ${snap.markets.length} markets @ ${new Date(snap.fetchedAt).toISOString()}` : `${s.venue} no data`
      }).join(" | ")
      console.log(`[market-feed] ${line}`)
    })

  pollAndLog()
  setInterval(pollAndLog, intervalMs)
  return serve("market-feed", port, feed.routes)
}
