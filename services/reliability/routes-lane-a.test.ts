/**
 * @fileoverview Demo lifecycle routes for one paper transaction.
 */

import {describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {start} from '../control-api';

const OPEN = '2026-10-06T00:00:00.000Z';
const WINDOW = '2026-10-13T00:00:00.000Z';

async function withServer(run: (origin: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'lifecycle-api-'));
  const server = start(0, {
    auditFile: join(directory, 'audit.jsonl'),
    databasePath: join(directory, 'agent.sqlite'),
  });
  try {
    await run(`http://127.0.0.1:${server.port}`);
  } finally {
    await server.stop(true);
    rmSync(directory, {recursive: true, force: true});
  }
}

describe('lifecycle demo routes', () => {
  test('drives a paper sale from offer to settlement', async () => {
    await withServer(async (origin) => {
      const opened = await fetch(`${origin}/reliability/lifecycle/open`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          id: 'tx-demo',
          type: 'goods',
          buyerId: 'buyer-demo',
          sellerId: 'seller-demo',
          terms: {goods: 'cable', quantity: 1},
          value: 50,
          at: OPEN,
        }),
      });
      expect(opened.status).toBe(200);
      const openBody = await opened.json() as {
        mode: string;
        stage: string;
        outcome: {state: string};
      };
      expect(openBody.mode).toBe('paper');
      expect(openBody.stage).toBe('offer_accepted');
      expect(openBody.outcome.state).toBe('pending');

      const amended = await fetch(`${origin}/reliability/lifecycle/terms`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          transactionId: 'tx-demo',
          terms: {goods: 'cable', quantity: 2},
          reason: 'quantity amendment',
          at: OPEN,
        }),
      });
      expect(amended.status).toBe(200);
      const amendedBody = await amended.json() as {
        transaction: {versions: unknown[]};
      };
      expect(amendedBody.transaction.versions).toHaveLength(2);

      const funded = await post(origin, {
        action: 'fund',
        transactionId: 'tx-demo',
        at: OPEN,
        amountLovelace: 50_000_000,
        sellerReturnAddress: 'addr_test1_seller',
        disputeWindowEnds: WINDOW,
      });
      expect(funded.status).toBe(200);
      const fundedBody = await funded.json() as {
        mode: string;
        stage: string;
        outcome: {evidence: {mode?: string; simulated?: boolean}};
      };
      expect(fundedBody.mode).toBe('paper');
      expect(fundedBody.stage).toBe('escrow_funded');
      expect(fundedBody.outcome.evidence.mode).toBe('paper');
      expect(fundedBody.outcome.evidence.simulated).toBe(true);

      const delivered = await post(origin, {
        action: 'deliver',
        transactionId: 'tx-demo',
        at: OPEN,
        evidence: {deliveryTier: 'buyer_confirmation', confirmedBy: 'buyer-demo'},
      });
      expect(delivered.status).toBe(200);

      const settled = await post(origin, {
        action: 'release',
        transactionId: 'tx-demo',
        at: OPEN,
      });
      expect(settled.status).toBe(200);
      const settledBody = await settled.json() as {
        stage: string;
        outcome: {state: string; verificationConfidence?: number; verificationMethod: string};
        events: {outcome: string; verificationConfidence?: number}[];
        termsDecisions: {policyVersion: string; buyerFeeBps: number; sellerFeeBps: number}[];
      };
      expect(settledBody.stage).toBe('payment_settled');
      expect(settledBody.outcome.state).toBe('successful');
      expect(settledBody.outcome.verificationMethod).toBe('lifecycle');
      expect(settledBody.outcome.verificationConfidence).toBe(0.7);
      expect(settledBody.events).toHaveLength(2);
      expect(settledBody.events.every((event) => event.outcome === 'success')).toBe(true);
      expect(settledBody.termsDecisions).toHaveLength(2);
      expect(settledBody.termsDecisions[0]?.policyVersion).toBe('fee-terms-stub-v0');
      expect(settledBody.termsDecisions[0]?.buyerFeeBps).toBeGreaterThan(0);
      expect(settledBody.termsDecisions[0]?.sellerFeeBps).toBeGreaterThan(0);

      const receipt = await fetch(
        `${origin}/reliability/lifecycle?transactionId=tx-demo`,
      );
      expect(receipt.status).toBe(200);
      const receiptBody = await receipt.json() as {
        mode: string;
        stage: string;
        transitions: unknown[];
      };
      expect(receiptBody.mode).toBe('paper');
      expect(receiptBody.stage).toBe('payment_settled');
      expect(receiptBody.transitions).toHaveLength(4);

      const rejected = await post(origin, {
        action: 'deliver',
        transactionId: 'tx-demo',
        at: OPEN,
        evidence: {deliveryTier: 'buyer_confirmation', confirmedBy: 'seller-demo'},
      });
      expect(rejected.status).toBe(400);
      expect(await (await fetch(`${origin}/reliability/lifecycle`)).status).toBe(400);
      expect(await (await fetch(
        `${origin}/reliability/lifecycle?transactionId=missing`,
      )).status).toBe(404);
    });
  });
});

function post(origin: string, body: unknown): Promise<Response> {
  return fetch(`${origin}/reliability/lifecycle/transition`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body),
  });
}
