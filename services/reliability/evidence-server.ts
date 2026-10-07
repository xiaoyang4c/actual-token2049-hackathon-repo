/** Dedicated loopback service. The public proxy exposes only these two reads. */

import {createEvidenceRoutes} from './routes-evidence';

export function startEvidenceServer(port = Number(process.env.CHAINLINK_EVIDENCE_PORT ?? 8793)) {
  const routes = new Map(createEvidenceRoutes().map((route) => [route.path, route]));
  return Bun.serve({hostname: '127.0.0.1', port, idleTimeout: 30,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== 'GET') return Response.json({error: 'Read only.'}, {status: 405, headers: {allow: 'GET'}});
      const route = routes.get(url.pathname);
      if (!route) return Response.json({error: 'Not found.'}, {status: 404});
      // A server-owned token lets the Vercel proxy preserve visitor limits.
      const token = process.env.CHAINLINK_EVIDENCE_PROXY_TOKEN;
      if (token && request.headers.get('x-tally-evidence-token') === token) {
        const forwarded = new Headers(request.headers);
        forwarded.set('x-forwarded-for', request.headers.get('x-tally-visitor') ?? 'unknown');
        request = new Request(request, {headers: forwarded});
      }
      return route.handler(request, url);
    },
  });
}

if (import.meta.main) {
  const server = startEvidenceServer();
  console.log(`Chainlink evidence checker listening on 127.0.0.1:${server.port}`);
}
