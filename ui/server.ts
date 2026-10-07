// Operator desk. Display only.
//
//   bun run ui/server.ts
//
// Then open http://localhost:8791
//
// The page reads GET /reliability/*. This process proxies an explicit allowlist
// to the control API (CONTROL_API_URL, default http://127.0.0.1:8787)
// so the browser stays on one origin. Port 8791 leaves the market feed on 8790.
// Writes (policy, orders, shock, reset) are not forwarded.

const FILES: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/styles.css": "styles.css",
  "/app.js": "app.js",
  "/model.js": "model.js",
  "/render.js": "render.js",
  "/format.js": "format.js",
  "/fixture.js": "fixture.js",
  "/data.js": "data.js",
  "/audit.js": "audit.js",
  "/tally.js": "tally.js",
  "/tally-views.js": "tally-views.js",
  "/favicon.svg": "favicon.svg",
}

const PROXY_PATHS = new Set([
  "/agent/state", "/audit",
  "/reliability/entities", "/reliability/scores", "/reliability/listings",
  "/reliability/transactions", "/reliability/receipts", "/reliability/lifecycle",
  "/reliability/kyc", "/reliability/kyc/fixtures",
  // Tally contract views. All GET, all read-only.
  "/reliability/contracts", "/reliability/contracts/list", "/reliability/contracts/templates",
  "/reliability/contracts/case", "/reliability/contracts/ruling-options", "/reliability/contracts/ruling-payload",
  "/reliability/profile", "/reliability/profile/search",
])

const fileUrl = (name: string) => new URL(name, import.meta.url)

const proxyGet = async (controlApiUrl: string, path: string) => {
  try {
    const upstream = await fetch(`${controlApiUrl}${path}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    })
    const body = await upstream.text()
    return new Response(body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    })
  } catch (err) {
    return Response.json({ error: "control api unreachable", detail: String(err) }, { status: 502 })
  }
}

export const startUi = (options?: { port?: number; controlApiUrl?: string }) => {
  const port = options?.port ?? Number(process.env.UI_PORT ?? 8791)
  const controlApiUrl = (options?.controlApiUrl ?? process.env.CONTROL_API_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "")

  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url)
      let res: Response
      if ((req.method === "GET" || req.method === "HEAD") && PROXY_PATHS.has(url.pathname)) {
        res = await proxyGet(controlApiUrl, url.pathname + url.search)
        // HEAD gets the GET status and headers with no body.
        if (req.method === "HEAD") res = new Response(null, { status: res.status, headers: res.headers })
      } else if (req.method !== "GET" && req.method !== "HEAD") {
        res = new Response("read only", { status: 405, headers: { "allow": "GET, HEAD" } })
      } else {
        const name = FILES[url.pathname]
        res = name
          ? new Response(Bun.file(fileUrl(name)), { headers: { "cache-control": "no-store" } })
          : new Response("not found", { status: 404 })
      }
      console.log(`[operator-ui] ${req.method} ${url.pathname} -> ${res.status}`)
      return res
    },
  })
}

if (import.meta.main) {
  const server = startUi()
  const control = process.env.CONTROL_API_URL ?? "http://127.0.0.1:8787"
  console.log(`operator ui   http://localhost:${server.port}`)
  console.log(`control api   ${control}`)
  console.log("read only — marketplace display; writes stay on the control API")
}
