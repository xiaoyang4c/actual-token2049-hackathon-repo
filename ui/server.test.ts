import { describe, expect, test } from "bun:test"
import { startUi } from "./server.ts"

const withServers = async (
  run: (ui: ReturnType<typeof startUi>, upstream: ReturnType<typeof Bun.serve> | null) => Promise<void>,
  controlApiUrl?: string,
) => {
  const upstream =
    controlApiUrl === undefined
      ? Bun.serve({
          port: 0,
          fetch(req) {
            const url = new URL(req.url)
            if (url.pathname === "/agent/state") {
              return Response.json({ policy: { kill_switch: false }, portfolio: { cash: 1000 } })
            }
            if (url.pathname === "/audit") return Response.json([{ cycleId: "c1", events: [] }])
            if (url.pathname.startsWith("/reliability/")) {
              return Response.json({path: url.pathname, query: [...url.searchParams]})
            }
            return new Response("no", { status: 404 })
          },
        })
      : null
  const ui = startUi({
    port: 0,
    controlApiUrl: controlApiUrl ?? `http://127.0.0.1:${upstream!.port}`,
  })
  try {
    await run(ui, upstream)
  } finally {
    ui.stop(true)
    upstream?.stop(true)
  }
}

describe("operator ui server", () => {
  test("serves the page and proxies allowlisted reads with their queries", async () => {
    await withServers(async (ui) => {
      const origin = `http://127.0.0.1:${ui.port}`
      const page = await fetch(`${origin}/`)
      expect(page.status).toBe(200)
      expect(page.headers.get("content-type")).toContain("text/html")
      expect(await page.text()).toContain('src="/app.js"')

      const css = await fetch(`${origin}/styles.css`)
      expect(css.status).toBe(200)

      for (const name of ["app.js", "model.js", "render.js", "format.js", "fixture.js", "data.js", "audit.js", "tally.js", "tally-views.js", "markdown.js"]) {
        const module = await fetch(`${origin}/${name}`)
        expect(module.status).toBe(200)
        expect(module.headers.get("content-type")).toContain("javascript")
        expect(await module.text()).not.toBe("")

        const head = await fetch(`${origin}/${name}`, { method: "HEAD" })
        expect(head.status).toBe(200)
        expect(head.headers.get("content-type")).toContain("javascript")
        expect(await head.text()).toBe("")
      }

      const state = await fetch(`${origin}/agent/state`)
      expect(state.status).toBe(200)
      expect(await state.json()).toEqual({ policy: { kill_switch: false }, portfolio: { cash: 1000 } })

      const audit = await fetch(`${origin}/audit`)
      expect(await audit.json()).toEqual([{ cycleId: "c1", events: [] }])

      for (const path of ["/agent/state", "/audit"]) {
        const head = await fetch(`${origin}${path}`, { method: "HEAD" })
        expect(head.status).toBe(200)
        expect(await head.text()).toBe("")
      }

      const favicon = await fetch(`${origin}/favicon.svg`)
      expect(favicon.headers.get("content-type")).toContain("svg")

      for (const name of ["entities", "scores", "listings", "transactions", "receipts", "lifecycle", "kyc", "kyc/fixtures",
        "contracts", "contracts/list", "contracts/templates", "contracts/audit", "contracts/case", "contracts/ruling-options", "contracts/ruling-payload",
        "profile", "profile/search", "anchors/contract", "anchors/company"]) {
        const path = `/reliability/${name}`
        const query = new URLSearchParams({transactionId: "a/b & c", entityId: "entity-new", now: "2026-10-06T12:00:00Z"})
        const read = await fetch(`${origin}${path}?${query}`)
        expect(await read.json()).toEqual({path, query: [...query]})
        const head = await fetch(`${origin}${path}?${query}`, {method: "HEAD"})
        expect(head.status).toBe(200)
        expect(await head.text()).toBe("")
      }

      for (const path of ["/reliability/lifecycle/open", "/reliability/lifecycle/transition", "/reliability/kyc/checks",
        "/reliability/contracts/action", "/reliability/contracts/ruling", "/reliability/contracts/sign", "/reliability/contracts/tick"]) {
        expect((await fetch(`${origin}${path}`, {method: "POST", body: "{}"})).status).toBe(405)
        expect((await fetch(`${origin}${path}`)).status).toBe(404)
      }

      const post = await fetch(`${origin}/agent/policy`, { method: "POST", body: "{}" })
      expect(post.status).toBe(405)
      const shock = await fetch(`${origin}/agent/debug/shock`, { method: "POST", body: '{"pnl":-1}' })
      expect(shock.status).toBe(405)
      expect(await fetch(`${origin}/nope`)).toHaveProperty("status", 404)
    })
  })

  test("forwards Ask a Coworker with the visitor address, and nothing else", async () => {
    const seen: Array<{ method: string; path: string; visitor: string | null; body: string }> = []
    const ask = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        seen.push({ method: req.method, path: url.pathname + url.search, visitor: req.headers.get("x-tally-visitor"), body: await req.text() })
        return Response.json({ job: { id: "j1" } }, { status: req.method === "POST" ? 202 : 200 })
      },
    })
    const ui = startUi({ port: 0, controlApiUrl: "http://127.0.0.1:9", askUrl: `http://127.0.0.1:${ask.port}` })
    try {
      const origin = `http://127.0.0.1:${ui.port}`
      const body = JSON.stringify({ coworker: "deal-desk", text: "hi" })
      const posted = await fetch(`${origin}/coworkers/ask`, { method: "POST", headers: { "x-forwarded-for": "203.0.113.9, 198.51.100.7" }, body })
      expect(posted.status).toBe(202)
      expect(await posted.json()).toEqual({ job: { id: "j1" } })
      expect((await fetch(`${origin}/coworkers/ask?id=j1`)).status).toBe(200)
      expect(seen[0]).toEqual({ method: "POST", path: "/ask", visitor: "198.51.100.7", body })
      expect(seen[1]?.path).toBe("/ask?id=j1")
      expect(seen[1]?.visitor).toMatch(/127\.0\.0\.1/)

      expect((await fetch(`${origin}/coworkers/ask`, { method: "PUT", body })).status).toBe(405)
      expect((await fetch(`${origin}/coworkers/ask`, { method: "POST", body: "x".repeat(300_000) })).status).toBe(413)
      expect(seen).toHaveLength(2)
    } finally {
      ui.stop(true)
      ask.stop(true)
    }
  })

  test("forwards the account routes with the session token, the visitor, and the allowed origin only", async () => {
    const seen: Array<{ method: string; path: string; auth: string | null; visitor: string | null; cookie: string | null }> = []
    const control = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        seen.push({ method: req.method, path: url.pathname, auth: req.headers.get("authorization"), visitor: req.headers.get("x-tally-visitor"), cookie: req.headers.get("cookie") })
        return Response.json({ ok: true })
      },
    })
    const app = "https://tally-origins.vercel.app"
    const ui = startUi({ port: 0, controlApiUrl: `http://127.0.0.1:${control.port}`, askUrl: "http://127.0.0.1:9", askOrigins: [app] })
    try {
      const base = `http://127.0.0.1:${ui.port}`
      const token = "Bearer " + "a".repeat(43)
      const read = await fetch(`${base}/reliability/account`, { headers: { authorization: token, origin: app, cookie: "x=1", "x-forwarded-for": "198.51.100.7" } })
      expect(read.status).toBe(200)
      expect(read.headers.get("access-control-allow-origin")).toBe(app)
      expect(seen[0]).toEqual({ method: "GET", path: "/reliability/account", auth: token, visitor: "198.51.100.7", cookie: null })
      // A malformed token is dropped, not forwarded.
      await fetch(`${base}/reliability/wallets/challenge`, { method: "POST", headers: { authorization: "Bearer x y" }, body: "{}" })
      expect(seen[1]).toMatchObject({ path: "/reliability/wallets/challenge", auth: null })
      const preflight = await fetch(`${base}/reliability/account/kyc`, { method: "OPTIONS", headers: { origin: app } })
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get("access-control-allow-headers")).toBe("content-type, authorization")
      expect((await fetch(`${base}/reliability/account/kyc`, { method: "OPTIONS", headers: { origin: "https://evil.example" } })).status).toBe(403)
      // Only the listed methods: no GET on a POST route, no other account path.
      expect((await fetch(`${base}/reliability/account/kyc`)).status).toBe(404)
      expect((await fetch(`${base}/reliability/account/delete`, { method: "POST", body: "{}" })).status).toBe(405)
      expect((await fetch(`${base}/reliability/account/deposits/build`, { method: "POST", body: "x".repeat(300_000) })).status).toBe(413)
      expect(seen).toHaveLength(2)
    } finally {
      ui.stop(true)
      control.stop(true)
    }
  })

  test("lets only the listed web app origins call the chat from the browser", async () => {
    const ask = Bun.serve({ port: 0, fetch: () => Response.json({ job: { id: "j1" } }, { status: 202 }) })
    const app = "https://tally-origins.vercel.app"
    const ui = startUi({ port: 0, controlApiUrl: "http://127.0.0.1:9", askUrl: `http://127.0.0.1:${ask.port}`, askOrigins: [`${app}/`] })
    try {
      const base = `http://127.0.0.1:${ui.port}`
      const preflight = await fetch(`${base}/coworkers/ask`, { method: "OPTIONS", headers: { origin: app } })
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get("access-control-allow-origin")).toBe(app)
      expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, POST")
      expect((await fetch(`${base}/coworkers/ask`, { method: "OPTIONS", headers: { origin: "https://evil.example" } })).status).toBe(403)

      const posted = await fetch(`${base}/coworkers/ask`, { method: "POST", headers: { origin: app }, body: "{}" })
      expect(posted.headers.get("access-control-allow-origin")).toBe(app)
      const other = await fetch(`${base}/coworkers/ask`, { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" })
      expect(other.headers.get("access-control-allow-origin")).toBeNull()
      // The read routes stay same-origin.
      expect((await fetch(`${base}/reliability/contracts`, { headers: { origin: app } })).headers.get("access-control-allow-origin")).toBeNull()
      expect((await fetch(`${base}/reliability/contracts`, { method: "OPTIONS", headers: { origin: app } })).status).toBe(405)
    } finally {
      ui.stop(true)
      ask.stop(true)
    }
  })

  test("says the Coworkers are offline when the worker is down", async () => {
    const ui = startUi({ port: 0, controlApiUrl: "http://127.0.0.1:9", askUrl: "http://127.0.0.1:9" })
    try {
      const res = await fetch(`http://127.0.0.1:${ui.port}/coworkers/ask`, { method: "POST", body: "{}" })
      expect(res.status).toBe(502)
      expect((await res.json()).error).toContain("offline")
    } finally {
      ui.stop(true)
    }
  })

  test("returns 502 when the control API is down", async () => {
    await withServers(async (ui) => {
      const res = await fetch(`http://127.0.0.1:${ui.port}/agent/state`)
      expect(res.status).toBe(502)
      const body = await res.json()
      expect(body.error).toBe("control api unreachable")
    }, "http://127.0.0.1:9")
  })
})

describe("app edition gate", () => {
  test("forwards only app methods and public reads, with Bearer and CORS", async () => {
    const seen: Array<{method: string; path: string; auth: string | null; cookie: string | null; privateHeader: string | null}> = []
    const control = Bun.serve({port: 0, fetch(req) {
      const url = new URL(req.url)
      seen.push({method: req.method, path: url.pathname + url.search, auth: req.headers.get("authorization"), cookie: req.headers.get("cookie"), privateHeader: req.headers.get("x-private")})
      return Response.json({ok: true})
    }})
    const app = "https://app.example"
    const ui = startUi({port: 0, edition: "app", controlApiUrl: `http://127.0.0.1:${control.port}`, askOrigins: [app]})
    try {
      const origin = `http://127.0.0.1:${ui.port}`
      const token = "Bearer " + "a".repeat(43)
      const read = await fetch(`${origin}/reliability/app/contract?id=deal%2F1`, {headers: {authorization: token, origin: app, cookie: "secret=1", "x-private": "secret"}})
      expect(read.status).toBe(200)
      expect(read.headers.get("access-control-allow-origin")).toBe(app)
      expect(seen[0]).toEqual({method: "GET", path: "/reliability/app/contract?id=deal%2F1", auth: token, cookie: null, privateHeader: null})
      const preflight = await fetch(`${origin}/reliability/app/action`, {method: "OPTIONS", headers: {origin: app}})
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get("access-control-allow-headers")).toBe("content-type, authorization")
      expect((await fetch(`${origin}/reliability/app/action`, {method: "OPTIONS", headers: {origin: "https://other.example"}})).status).toBe(403)
      await fetch(`${origin}/reliability/app/action`, {method: "POST", headers: {authorization: "Bearer invalid token"}, body: "{}"})
      expect(seen[1]?.auth).toBeNull()
      for (const route of ["profile/search", "profile", "anchors/company", "contracts/templates", "contracts/draft-templates", "contracts/draft"]) {
        const res = await fetch(`${origin}/reliability/${route}?q=company`, {headers: {origin: app}})
        expect(res.status).toBe(200)
        expect(res.headers.get("access-control-allow-origin")).toBe(app)
      }
      const forwarded = seen.length
      for (const path of ["/", "/index.html", "/app.js", "/tally.js", "/tally-views.js"]) expect((await fetch(origin + path)).status).toBe(404)
      for (const path of ["/agent/state", "/audit", ...["contracts/list", "contracts", "contracts/terms", "contracts/case", "contracts/ruling-options", "contracts/ruling-payload", "contracts/audit", "anchors/contract", "transactions", "receipts", "entities", "scores", "listings", "lifecycle", "kyc", "kyc/fixtures"].map((route) => `/reliability/${route}`)]) {
        expect((await fetch(origin + path)).status).toBe(404)
        expect((await fetch(origin + path, {method: "HEAD"})).status).toBe(404)
      }
      for (const path of ["tick", "ruling", "agree", "terminate", "operator", "mediation"]) {
        expect((await fetch(`${origin}/reliability/app/${path}`, {method: "POST", body: "{}"})).status).toBe(405)
      }
      expect((await fetch(`${origin}/reliability/app/action`)).status).toBe(404)
      expect((await fetch(`${origin}/reliability/app/contracts`, {method: "DELETE"})).status).toBe(405)
      expect((await fetch(`${origin}/reliability/app/action`, {method: "POST", body: "x".repeat(1_500_001)})).status).toBe(413)
      expect(seen).toHaveLength(forwarded)
      expect((await fetch(`${origin}/reliability/account`, {headers: {authorization: token}})).status).toBe(200)
    } finally {
      ui.stop(true)
      control.stop(true)
    }
  })

  test("demo blocks the new app routes", async () => {
    const ui = startUi({port: 0, edition: "demo", controlApiUrl: "http://127.0.0.1:9"})
    try {
      const origin = `http://127.0.0.1:${ui.port}`
      expect((await fetch(`${origin}/reliability/app/me`)).status).toBe(404)
      expect((await fetch(`${origin}/reliability/app/action`, {method: "POST", body: "{}"})).status).toBe(405)
    } finally { ui.stop(true) }
  })
})
