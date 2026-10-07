/** Public reads for the payment checker. No store or payment operation. */

import {EvidenceChecker, EvidenceError, claimFromUrl, createCreRunner} from './evidence-checker';
import type {ReliabilityRoute} from './route';

const headers = {'cache-control': 'no-store'};
type EvidenceRoute = Omit<ReliabilityRoute, 'handler'> & {
  handler: (request: Request, url: URL) => Response|Promise<Response>;
};

export function createEvidenceRoutes(checker = new EvidenceChecker(createCreRunner())): EvidenceRoute[] {
  return [
    {method: 'GET', path: '/reliability/evidence/info', handler: () => Response.json(checker.info(), {headers})},
    {
      method: 'GET', path: '/reliability/evidence/check',
      handler: async (request, url) => {
        try {
          // The loopback UI and Caddy add this header. Do not use query parameters as visitor IDs.
          const visitor = request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() || 'local';
          return Response.json(await checker.check(claimFromUrl(url), visitor), {headers});
        } catch (error) {
          const known = error instanceof EvidenceError;
          return Response.json({error: known ? error.message : 'Check the payment details.'}, {
            status: known ? error.status : 400,
            headers: {...headers, ...(known && error.status === 429 ? {'retry-after': '60'} : {})},
          });
        }
      },
    },
  ];
}

/** Server-side proxy for hosts that cannot run the CRE simulator. */
export function createEvidenceProxyRoutes(baseUrl: string): EvidenceRoute[] {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname))) {
    throw new Error('The evidence service must use HTTPS or loopback HTTP.');
  }
  return ['/reliability/evidence/info', '/reliability/evidence/check'].map((path) => ({
    method: 'GET', path,
    handler: async (request, url) => {
      try {
        if (path.endsWith('/check')) claimFromUrl(url);
        const target = new URL(path, base);
        target.search = url.search;
        const upstream = await fetch(target, {signal: AbortSignal.timeout(25_000), redirect: 'error', cache: 'no-store',
          headers: {'x-tally-visitor': request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown',
            'x-tally-evidence-token': process.env.CHAINLINK_EVIDENCE_PROXY_TOKEN ?? ''},
        });
        return new Response(await upstream.text(), {status: upstream.status, headers: {...headers, 'content-type': 'application/json'}});
      } catch (error) {
        return Response.json({error: error instanceof EvidenceError ? error.message : 'The evidence checker is offline. Try again later.'}, {
          status: error instanceof EvidenceError ? error.status : 503, headers,
        });
      }
    },
  }));
}

export const evidenceRoutes = process.env.CHAINLINK_EVIDENCE_URL ? createEvidenceProxyRoutes(process.env.CHAINLINK_EVIDENCE_URL) : createEvidenceRoutes();
