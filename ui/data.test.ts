import {describe, expect, test} from 'bun:test';
import {FIXTURE} from './fixture.js';
import {loadMarketplace, loadTransaction} from './data.js';

describe('marketplace GET transport', () => {
  test('loads collection and receipt queries without sending writes', async () => {
    const calls: string[] = [];
    const fetcher = async (path: string, options: RequestInit) => {
      calls.push(path);
      expect(options.method).toBeUndefined();
      const url = new URL(path, 'http://local');
      const name = url.pathname.split('/').at(-1)!;
      if (name === 'receipts') {
        const id = url.searchParams.get('transactionId')!;
        return Response.json(FIXTURE.receipts[id as keyof typeof FIXTURE.receipts]);
      }
      if (name === 'kyc') return new Response(null, {status: 404});
      if (name === 'fixtures') return Response.json(FIXTURE.kycExamples);
      return Response.json(FIXTURE[name as 'entities'|'scores'|'listings'|'transactions']);
    };
    const snapshot = await loadMarketplace(fetcher);
    expect(snapshot.transactions).toHaveLength(3);
    expect(snapshot.receipts['tx-invoice-1'].transaction.id).toBe('tx-invoice-1');
    expect(calls).toContain('/reliability/receipts?transactionId=tx-service-1');
    expect(calls).not.toContain('/agent/state');
  });

  test('rejects malformed collections so they cannot replace the last complete snapshot', async () => {
    await expect(loadMarketplace(async () => Response.json({error: 'bad data'})))
      .rejects.toThrow('was not a list of records');
  });

  test('isolates unavailable receipts without inventing an outcome', async () => {
    const snapshot = await loadMarketplace(async (path: string) => {
      const name = new URL(path, 'http://local').pathname.split('/').at(-1)!;
      if (name === 'receipts') return Response.json({error: 'down'}, {status: 503});
      if (name === 'kyc' || name === 'fixtures') return new Response(null, {status: 404});
      return Response.json(FIXTURE[name as 'entities'|'scores'|'listings'|'transactions']);
    });
    expect(snapshot.receipts['tx-service-1']).toBeUndefined();
    expect(snapshot.receiptErrors['tx-service-1']).toContain('503');
  });

  test('falls back from a missing lifecycle to its matching fixture receipt only on 404', async () => {
    const paths: string[] = [];
    const receipt = FIXTURE.receipts['tx-service-1'];
    const result = await loadTransaction('tx-service-1', async (path: string) => {
      paths.push(path);
      return path.startsWith('/reliability/lifecycle') ?
        new Response(null, {status: 404}) : Response.json(receipt);
    });
    expect(result).toEqual(receipt);
    expect(paths).toHaveLength(2);
    await expect(loadTransaction('tx-service-1', async () => new Response(null, {status: 503})))
      .rejects.toThrow('Lifecycle returned 503');
  });

  test('rejects mismatched receipt ids', async () => {
    await expect(loadTransaction('wrong', async () => Response.json(FIXTURE.receipts['tx-service-1'])))
      .rejects.toThrow('Receipt for wrong is malformed');
  });

  test('reads KYC for durable lifecycle parties outside the seed collection', async () => {
    const entity = {...FIXTURE.entities[0], id: 'stored-buyer'};
    const receipt = {...FIXTURE.receipts['tx-service-1'], entities: [entity], transitions: []};
    const result = await loadTransaction('tx-service-1', async (path: string) => {
      if (path.startsWith('/reliability/kyc?')) {
        expect(path).toContain('entityId=stored-buyer');
        return Response.json({entity, badge: 'expired', status: 'unverified', tier: 'none'});
      }
      expect(path).toContain('&now=');
      return Response.json(receipt);
    });
    expect(result.kycById['stored-buyer'].badge).toBe('expired');
  });
});
