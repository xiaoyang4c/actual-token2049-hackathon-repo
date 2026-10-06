import { describe, expect, test } from "bun:test"
import { createMarketFeed, type VenueSource } from "./market-feed"

const gammaMarket = {
  id: "1",
  question: "Q?",
  outcomes: '["Yes","No"]',
  outcomePrices: '["0.4","0.6"]',
  bestBid: 0.39,
  bestAsk: 0.41,
  liquidityNum: 5000,
  tags: [{ slug: "economy" }],
}

const source: VenueSource = {
  venue: "polymarket",
  url: "http://polymarket.test",
  normalize: (raw) => (raw as unknown[]).length ? [{ venue: "polymarket", marketId: "1" } as never] : [],
}

const setup = (responses: (unknown | Error)[]) => {
  let clock = 1_000_000
  const feed = createMarketFeed({
    sources: [source],
    maxAgeMs: 90_000,
    now: () => clock,
    fetchJson: async () => {
      const next = responses.shift()
      if (next instanceof Error) throw next
      return next
    },
  })
  const get = async (path: string) => {
    const res = await feed.routes[`GET ${path}`](new Request(`http://x${path}`), new URL(`http://x${path}`))
    return { status: res.status, body: await res.json(), headers: res.headers }
  }
  return { feed, get, advance: (ms: number) => (clock += ms) }
}

describe("market feed", () => {
  test("503 before the first successful poll", async () => {
    const { get } = setup([])
    expect((await get("/markets/polymarket")).status).toBe(503)
  })

  test("serves the venue's raw response with freshness headers", async () => {
    const { feed, get, advance } = setup([[gammaMarket]])
    await feed.pollAll()
    advance(5_000)
    const res = await get("/markets/polymarket")
    expect(res.status).toBe(200)
    expect(res.body).toEqual([gammaMarket])
    expect(res.headers.get("x-age-ms")).toBe("5000")
  })

  test("a failed poll keeps the last good snapshot", async () => {
    const { feed, get, advance } = setup([[gammaMarket], new Error("HTTP 500")])
    await feed.pollAll()
    advance(30_000)
    await feed.pollAll()
    expect((await get("/markets/polymarket")).status).toBe(200)
    const [status] = (await get("/markets/status")).body
    expect(status).toMatchObject({ polls: 2, failures: 1, lastError: "HTTP 500", stale: false })
  })

  test("an empty response counts as a failure", async () => {
    const { feed, get } = setup([[]])
    await feed.pollAll()
    expect((await get("/markets/status")).body[0].lastError).toBe("no tradable markets in response")
    expect((await get("/markets/polymarket")).status).toBe(503)
  })

  test("refuses to serve data older than maxAge", async () => {
    const { feed, get, advance } = setup([[gammaMarket]])
    await feed.pollAll()
    advance(90_001)
    const res = await get("/markets/polymarket")
    expect(res.status).toBe(503)
    expect(res.body.error).toContain("stale")
    expect((await get("/markets/status")).body[0].stale).toBe(true)
  })

  test("overlapping pollAll calls share one round", async () => {
    let calls = 0
    const feed = createMarketFeed({
      sources: [source],
      maxAgeMs: 90_000,
      fetchJson: async () => {
        calls++
        return [gammaMarket]
      },
    })
    await Promise.all([feed.pollAll(), feed.pollAll()])
    expect(calls).toBe(1)
  })
})
