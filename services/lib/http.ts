export type Handler = (req: Request, url: URL) => Response | Promise<Response>
export type Routes = Record<string, Handler>

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })

export const readJson = async <T>(req: Request): Promise<T> => (await req.json()) as T

// Routes are keyed "METHOD /path". Logs one line per request.
export const serve = (name: string, port: number, routes: Routes) =>
  Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url)
      const handler = routes[`${req.method} ${url.pathname}`]
      let res: Response
      try {
        res = handler ? await handler(req, url) : json({ error: "not found" }, 404)
      } catch (err) {
        res = json({ error: String(err) }, 500)
      }
      console.log(`[${name}] ${req.method} ${url.pathname} -> ${res.status}`)
      return res
    },
  })
