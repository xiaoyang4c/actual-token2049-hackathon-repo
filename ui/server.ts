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
//
// One exception: the Coworker chat. POST /coworkers/ask and GET /coworkers/ask?id=
// go to the Coworker worker (COWORKER_ASK_URL, default http://127.0.0.1:8792).
// The chat is free: its tools only read, and nothing is paid or stored.
//
// Second exception: wallet sign-in and the signed-in account (ACCOUNT_ROUTES).
// They go to the control API with the caller's Bearer session token. The control
// API checks the wallet signature and the session, and limits each visitor.
// Read docs/wallets.md.
//
// The Tally web app on another origin (TALLY_WEB_ORIGINS or COWORKER_ASK_ORIGINS,
// comma-separated) may call the chat and account routes from the browser.
// No other route allows another origin.

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
  "/markdown.js": "markdown.js",
  "/favicon.svg": "favicon.svg",
}

const PROXY_PATHS = new Set([
  "/agent/state", "/audit",
  "/reliability/entities", "/reliability/scores", "/reliability/listings",
  "/reliability/transactions", "/reliability/receipts", "/reliability/lifecycle",
  "/reliability/kyc", "/reliability/kyc/fixtures",
  // Tally contract views. All GET, all read-only.
  "/reliability/contracts", "/reliability/contracts/list", "/reliability/contracts/templates", "/reliability/contracts/audit",
  "/reliability/contracts/case", "/reliability/contracts/ruling-options", "/reliability/contracts/ruling-payload",
  "/reliability/profile", "/reliability/profile/search",
  "/reliability/anchors/contract", "/reliability/anchors/company",
  // Deal Desk: templates and a sandboxed draft. Both GET, neither writes.
  "/reliability/contracts/draft-templates", "/reliability/contracts/draft",
])

/** The app edition exposes only these public read views. */
const APP_PUBLIC_PATHS = new Set([
  "/reliability/profile/search", "/reliability/profile", "/reliability/anchors/company",
  "/reliability/contracts/templates", "/reliability/contracts/draft-templates", "/reliability/contracts/draft",
])

/** Explicit app methods. Operator and mediator routes never enter this set. */
const APP_ROUTES = new Set([
  "GET /reliability/app/me", "POST /reliability/app/party", "GET /reliability/app/contracts", "POST /reliability/app/contracts",
  "GET /reliability/app/contract", "GET /reliability/app/contract/terms", "GET /reliability/app/contract/audit",
  "GET /reliability/app/contract/case", "GET /reliability/app/contract/anchors", "POST /reliability/app/sign", "POST /reliability/app/action",
])
const APP_PATHS = new Set([...APP_ROUTES].map((route) => route.split(" ")[1]))
/** Base64 evidence can fill the engine's 1 MiB evidence limit. */
const APP_BODY_LIMIT = 1_500_000

/** Wallet sign-in and account routes, as "METHOD /path". */
const ACCOUNT_ROUTES = new Set([
  "POST /reliability/wallets/challenge", "POST /reliability/wallets/verify",
  "GET /reliability/account", "POST /reliability/account/kyc", "POST /reliability/account/sign-out",
  "POST /reliability/account/deposits/build", "POST /reliability/account/deposits/submit",
])
const ACCOUNT_PATHS = new Set([...ACCOUNT_ROUTES].map((route) => route.split(" ")[1]))
/** A deposit build carries the wallet's UTxOs, at most 300 of them. */
const ACCOUNT_BODY_LIMIT = 262_144
const BEARER = /^Bearer [A-Za-z0-9_-]{20,100}$/

const ASK_PATH = "/coworkers/ask"
/** A message is at most 4,000 characters. The chat sends at most 12 earlier messages of 6,000 characters. */
const ASK_BODY_LIMIT = 262_144

/** CORS headers for an allowed web app origin, or none. */
const corsFor = (req: Request, origins: ReadonlySet<string>): Record<string, string> => {
  const origin = req.headers.get("origin")
  return origin && origins.has(origin) ? { "access-control-allow-origin": origin, "vary": "Origin" } : {}
}

const withHeaders = (res: Response, headers: Record<string, string>) => {
  for (const [name, value] of Object.entries(headers)) res.headers.set(name, value)
  return res
}

const fileUrl = (name: string) => new URL(name, import.meta.url)

/** The visitor's address. Caddy sets X-Forwarded-For; its last entry is the address Caddy saw. */
const visitorOf = (req: Request, direct: string | undefined) =>
  req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || direct || "unknown"

const proxyAsk = async (askUrl: string, req: Request, visitor: string, search: string) => {
  let body: string | undefined
  if (req.method === "POST") {
    body = await req.text()
    if (new TextEncoder().encode(body).length > ASK_BODY_LIMIT) {
      return Response.json({ error: "The request is too long." }, { status: 413 })
    }
  }
  try {
    const upstream = await fetch(`${askUrl}/ask${req.method === "GET" ? search : ""}`, {
      method: req.method,
      headers: { "content-type": "application/json", "x-tally-visitor": visitor },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    })
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    })
  } catch {
    return Response.json({ error: "The Coworkers are offline right now. Try again later." }, { status: 502 })
  }
}

const proxyAccount = async (controlApiUrl: string, req: Request, visitor: string, path: string, bodyLimit = ACCOUNT_BODY_LIMIT) => {
  let body: string | undefined
  if (req.method === "POST") {
    body = await req.text()
    if (new TextEncoder().encode(body).length > bodyLimit) {
      return Response.json({ error: "The request is too long." }, { status: 413 })
    }
  }
  // Only a well-formed session token is passed on. No cookie or other header is.
  const authorization = req.headers.get("authorization")
  try {
    const upstream = await fetch(`${controlApiUrl}${path}`, {
      method: req.method,
      headers: {
        "content-type": "application/json", "x-tally-visitor": visitor,
        ...(authorization && BEARER.test(authorization) ? { authorization } : {}),
      },
      body,
      cache: "no-store",
      // A deposit reads the chain, so allow more time than a page read.
      signal: AbortSignal.timeout(30_000),
    })
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" },
    })
  } catch {
    return Response.json({ error: "Tally is unreachable right now. Try again later." }, { status: 502 })
  }
}

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

export const startUi = (options?: { port?: number; controlApiUrl?: string; askUrl?: string; askOrigins?: string[]; edition?: "demo" | "app" }) => {
  const appEdition = (options?.edition ?? process.env.TALLY_EDITION ?? "demo") === "app"
  const publicPaths = appEdition ? APP_PUBLIC_PATHS : PROXY_PATHS
  const port = options?.port ?? Number(process.env.UI_PORT ?? 8791)
  const controlApiUrl = (options?.controlApiUrl ?? process.env.CONTROL_API_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "")
  const askUrl = (options?.askUrl ?? process.env.COWORKER_ASK_URL ?? "http://127.0.0.1:8792").replace(/\/$/, "")
  const askOrigins = new Set((options?.askOrigins ?? `${process.env.TALLY_WEB_ORIGINS ?? ""},${process.env.COWORKER_ASK_ORIGINS ?? ""}`.split(","))
    .map((origin) => origin.trim().replace(/\/$/, "")).filter(Boolean))

  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req, server) {
      const url = new URL(req.url)
      let res: Response
      if ((ACCOUNT_PATHS.has(url.pathname) || (appEdition && APP_PATHS.has(url.pathname))) && req.method === "OPTIONS") {
        const cors = corsFor(req, askOrigins)
        res = cors["access-control-allow-origin"]
          ? new Response(null, { status: 204, headers: { ...cors, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type, authorization", "access-control-max-age": "600" } })
          : new Response("origin not allowed", { status: 403 })
      } else if (appEdition && APP_ROUTES.has(`${req.method} ${url.pathname}`)) {
        res = withHeaders(await proxyAccount(controlApiUrl, req, visitorOf(req, server.requestIP(req)?.address), url.pathname + url.search, APP_BODY_LIMIT), corsFor(req, askOrigins))
      } else if (ACCOUNT_ROUTES.has(`${req.method} ${url.pathname}`)) {
        res = withHeaders(await proxyAccount(controlApiUrl, req, visitorOf(req, server.requestIP(req)?.address), url.pathname), corsFor(req, askOrigins))
      } else if (url.pathname === ASK_PATH && req.method === "OPTIONS") {
        // The browser asks first because the chat posts JSON from another origin.
        const cors = corsFor(req, askOrigins)
        res = cors["access-control-allow-origin"]
          ? new Response(null, { status: 204, headers: { ...cors, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type", "access-control-max-age": "600" } })
          : new Response("origin not allowed", { status: 403 })
      } else if (url.pathname === ASK_PATH && (req.method === "POST" || req.method === "GET")) {
        res = withHeaders(await proxyAsk(askUrl, req, visitorOf(req, server.requestIP(req)?.address), url.search), corsFor(req, askOrigins))
      } else if ((req.method === "GET" || req.method === "HEAD") && publicPaths.has(url.pathname)) {
        res = await proxyGet(controlApiUrl, url.pathname + url.search)
        if (appEdition) res = withHeaders(res, corsFor(req, askOrigins))
        // HEAD gets the GET status and headers with no body.
        if (req.method === "HEAD") res = new Response(null, { status: res.status, headers: res.headers })
      } else if (req.method !== "GET" && req.method !== "HEAD") {
        res = new Response("read only", { status: 405, headers: { "allow": "GET, HEAD" } })
      } else {
        const name = appEdition ? undefined : FILES[url.pathname]
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
  console.log(`coworker chat ${process.env.COWORKER_ASK_URL ?? "http://127.0.0.1:8792"} (free, reads only)`)
}
