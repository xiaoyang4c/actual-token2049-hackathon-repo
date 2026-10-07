/**
 * @fileoverview The public read-only demo of the Tally web app on Vercel
 * (Bun runtime). It serves the control API's reliability and contract read
 * routes from a paper database with the six showcase contracts and their
 * settlement fingerprints. The build seeds it once (api/_seed.ts), so every
 * instance serves the same ids; a cold start copies it to /tmp, the only
 * writable path. Nothing is sent to a chain. The web app sends the Coworker chat to the
 * preprod Coworker worker first (VITE_COWORKER_ASK_URL). This function is its fallback: it
 * answers in the request itself, without a model, so the fill-in format works and plain
 * English gets the fill-in instructions.
 *
 * vercel.json routes /reliability/* and /coworkers/ask here and serves web/dist.
 */

import {copyFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {AgentStore} from '../packages/db/src/index';
import {AskService} from '../services/reliability/coworker-ask';
import {CoworkerTools} from '../services/reliability/coworker-tools';
import {contractServiceFor} from '../services/reliability/contract-service';
import {reliabilityRoutes} from '../services/reliability/index';

process.env.CARDANO_MODE = 'simulated';
process.env.CARDANO_ALLOW_NETWORK = 'false';

const SEED = join(process.cwd(), '.demo-data/demo.sqlite');
const DATABASE = '/tmp/tally-demo.sqlite';
const json = (body: unknown, status = 200) => Response.json(body, {status, headers: {'cache-control': 'no-store'}});
const routes = new Map(reliabilityRoutes.filter((route) => route.method === 'GET').map((route) => [route.path, route]));

function open() {
  if (!existsSync(DATABASE)) copyFileSync(SEED, DATABASE);
  const store = AgentStore.open(DATABASE);
  const service = contractServiceFor(store);
  const tools = new CoworkerTools(store, {config: service.config, templates: service.templates, now: () => service.now()});
  const ask = new AskService({tools, provider: null, now: () => Date.now(), log: () => {}});
  return {store, ask};
}

let ready: ReturnType<typeof open> | null = null;

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // vercel.json passes the original path in __path.
    const path = url.searchParams.get('__path');
    if (path) {
      url.pathname = path;
      url.searchParams.delete('__path');
    }
    try {
      ready ??= open();
      const {store, ask} = await ready;
      if (url.pathname === '/coworkers/ask' && request.method === 'POST') {
        const body = await request.json().catch(() => null) as {coworker?: unknown; text?: unknown; history?: unknown}|null;
        const visitor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
        const submitted = ask.submit(body?.coworker, body?.text, visitor, body?.history);
        if (!submitted.ok) return json({error: submitted.error}, submitted.status);
        // Answer before responding: the next request may reach another instance.
        await ask.idle();
        return json({job: ask.view(submitted.job.id)}, 202);
      }
      if (url.pathname === '/coworkers/ask') return json({error: 'This answer is no longer available.'}, 404);
      // Read-only: GET routes only, like the hosted UI server.
      const route = request.method === 'GET' ? routes.get(url.pathname) : undefined;
      if (!route) return json({error: 'not found'}, 404);
      return await route.handler(request, url, store);
    } catch (error) {
      return json({error: error instanceof Error ? error.message : String(error)}, 500);
    }
  },
};
