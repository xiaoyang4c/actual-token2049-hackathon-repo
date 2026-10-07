import {describe, expect, test} from 'bun:test';
import {readHostedDemo} from './coworker-demo';

describe('Vercel reads the Coworker demo records', () => {
  test('preserves hosted contract IDs and query parameters without writing', async () => {
    const contracts = [{id: 'hosted-contract', mode: 'paper'}];
    const fetcher = (async (input: URL, init: RequestInit) => {
      expect(input.toString()).toBe('https://demo.example/reliability/contracts/list?disputes=1');
      expect(init.method).toBe('GET');
      expect(init.body).toBeUndefined();
      return Response.json(contracts);
    }) as unknown as typeof fetch;
    const response = await readHostedDemo(new URL('https://web.example/reliability/contracts/list?disputes=1'), 'https://demo.example', fetcher);
    expect(await response?.json()).toEqual(contracts);
    expect(response?.headers.get('cache-control')).toBe('no-store');
  });

  test('does not forward non-reliability paths', async () => {
    const fetcher = (async () => { throw new Error('must not fetch'); }) as unknown as typeof fetch;
    expect(await readHostedDemo(new URL('https://web.example/coworkers/ask'), 'https://demo.example', fetcher)).toBeNull();
  });

  test('keeps missing hosted records missing instead of switching databases', async () => {
    const fetcher = (async () => Response.json({error: 'unknown contract'}, {status: 404})) as unknown as typeof fetch;
    const response = await readHostedDemo(new URL('https://web.example/reliability/contracts?id=missing'), 'https://demo.example', fetcher);
    expect(response?.status).toBe(404);
    expect(await response?.json()).toEqual({error: 'unknown contract'});
  });

  test('uses the paper fallback when the hosted server is offline', async () => {
    const url = new URL('https://web.example/reliability/contracts/list');
    for (const status of [502, 503, 504]) {
      const fetcher = (async () => new Response('offline', {status})) as unknown as typeof fetch;
      expect(await readHostedDemo(url, 'https://demo.example', fetcher)).toBeNull();
    }
    const fetcher = (async () => { throw new Error('network unavailable'); }) as unknown as typeof fetch;
    expect(await readHostedDemo(url, 'https://demo.example', fetcher)).toBeNull();
  });
});
