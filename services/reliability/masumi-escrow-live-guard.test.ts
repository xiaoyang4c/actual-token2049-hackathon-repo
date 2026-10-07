/**
 * @fileoverview The v1 lifecycle refuses a live Masumi order that the
 * payment service would reject, before any request is sent.
 */

import {describe, expect, test} from 'bun:test';
import type {EscrowFundRequest} from '../../packages/reliability/src/escrow-port';
import type {CardanoAdapter} from '../cardano-agents-ts/cardano';
import {loadPaymentConfig} from '../cardano-agents-ts/config';
import type {MasumiAdapter} from '../cardano-agents-ts/masumi';
import {ChainEscrow} from './masumi-escrow';

const HOUR = 3_600_000;

function guardedEscrow(): {escrow: ChainEscrow; calls: string[]} {
  const calls: string[] = [];
  const masumi = {
    simulated: false,
    createPayment: () => {
      calls.push('createPayment');
      throw new Error('the payment service must not be called');
    },
  } as unknown as MasumiAdapter;
  const escrow = new ChainEscrow(masumi, {} as CardanoAdapter, loadPaymentConfig({}), 'live', true);
  return {escrow, calls};
}

function request(transactionId: string, start: number, gaps: {unlock: number; external: number}): EscrowFundRequest {
  const submit = start + HOUR;
  return {
    transactionId,
    purchaserId: 'buyer',
    amountLovelace: 1_000_000,
    sellerReturnAddress: 'addr_test1_synthetic_seller',
    payByTime: new Date(start).toISOString(),
    submitResultTime: new Date(submit).toISOString(),
    unlockTime: new Date(submit + gaps.unlock).toISOString(),
    externalDisputeUnlockTime: new Date(submit + gaps.unlock + gaps.external).toISOString(),
    inputHash: 'a'.repeat(64),
  };
}

describe('v1 live funding guard', () => {
  test('rejects the v1 shape (transaction id nonce, equal deadlines) without calling Masumi', async () => {
    const {escrow, calls} = guardedEscrow();
    const start = Date.now() + HOUR;
    await expect(escrow.fund(request('tx-demo', start, {unlock: 0, external: 0}))).rejects.toThrow(/contract lifecycle routes/);
    expect(calls).toEqual([]);
  });

  test('lets a request that follows the MPS rules reach the payment service', async () => {
    const {escrow, calls} = guardedEscrow();
    const start = Date.now() + HOUR;
    await expect(escrow.fund(request('a1b2c3d4e5f60718293a', start, {unlock: HOUR, external: HOUR}))).rejects.toThrow(/must not be called/);
    expect(calls).toEqual(['createPayment']);
  });
});
