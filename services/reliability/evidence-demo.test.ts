import {expect, test} from 'bun:test';
import {EVIDENCE_EXAMPLE} from '../../packages/evidence/src/protocol';

async function demoHandler() {
  const saved = {mode: process.env.CARDANO_MODE, network: process.env.CARDANO_ALLOW_NETWORK};
  try {
    return (await import('../../api/demo')).default;
  } finally {
    if (saved.mode === undefined) delete process.env.CARDANO_MODE;
    else process.env.CARDANO_MODE = saved.mode;
    if (saved.network === undefined) delete process.env.CARDANO_ALLOW_NETWORK;
    else process.env.CARDANO_ALLOW_NETWORK = saved.network;
  }
}

function requestUrl() {
  const url = new URL('https://tally.example/api/demo');
  url.searchParams.set('__path', '/reliability/evidence/check');
  for (const [key, value] of Object.entries(EVIDENCE_EXAMPLE)) url.searchParams.set(key, value);
  return url;
}

test('the Vercel evidence proxy preserves visitor limits without a paper database', async () => {
  const demo = await demoHandler();
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.CHAINLINK_EVIDENCE_PROXY_TOKEN;
  const calls: {url: string; headers: Headers}[] = [];
  process.env.CHAINLINK_EVIDENCE_PROXY_TOKEN = 'evidence-proxy-test-token';
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
    calls.push({url: String(input), headers: new Headers(options?.headers)});
    return Response.json({report: {status: 'verified'}, execution: {mode: 'simulation', donConsensus: false}});
  }, {preconnect: originalFetch.preconnect});
  try {
    const response = await demo.fetch(new Request(requestUrl(), {headers: {'x-forwarded-for': '203.0.113.7, 192.0.2.1'}}));
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0].url).pathname).toBe('/reliability/evidence/check');
    expect(new URL(calls[0].url).searchParams.has('__path')).toBe(false);
    expect(calls[0].headers.get('x-tally-visitor')).toBe('203.0.113.7');
    expect(calls[0].headers.get('x-tally-evidence-token')).toBe('evidence-proxy-test-token');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({report: {status: 'verified'}, execution: {donConsensus: false}});
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.CHAINLINK_EVIDENCE_PROXY_TOKEN;
    else process.env.CHAINLINK_EVIDENCE_PROXY_TOKEN = originalToken;
  }
});

test('the Vercel evidence proxy returns unavailable without falling back to paper evidence', async () => {
  const demo = await demoHandler();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = Object.assign(async () => {calls++; throw new Error('private-provider-detail');}, {preconnect: originalFetch.preconnect});
  try {
    const response = await demo.fetch(new Request(requestUrl()));
    expect(response.status).toBe(503);
    expect(calls).toBe(1);
    expect(await response.json()).toEqual({error: 'The evidence checker is offline. Try again later.'});
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the Vercel evidence proxy rejects invalid claims before an external request', async () => {
  const demo = await demoHandler();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = Object.assign(async () => {calls++; return Response.json({});}, {preconnect: originalFetch.preconnect});
  try {
    const url = requestUrl();
    url.searchParams.set('amount', '-1');
    const response = await demo.fetch(new Request(url));
    expect(response.status).toBe(400);
    expect(calls).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
