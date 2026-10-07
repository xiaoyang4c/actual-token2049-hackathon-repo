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

      for (const name of ["app.js", "model.js", "render.js", "format.js", "fixture.js", "data.js", "audit.js", "tally.js", "tally-views.js"]) {
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
        "contracts", "contracts/list", "contracts/templates", "contracts/case", "contracts/ruling-options", "contracts/ruling-payload",
        "profile", "profile/search"]) {
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

  test("returns 502 when the control API is down", async () => {
    await withServers(async (ui) => {
      const res = await fetch(`http://127.0.0.1:${ui.port}/agent/state`)
      expect(res.status).toBe(502)
      const body = await res.json()
      expect(body.error).toBe("control api unreachable")
    }, "http://127.0.0.1:9")
  })
})
