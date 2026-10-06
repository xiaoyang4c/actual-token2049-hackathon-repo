/**
 * @fileoverview Preprod escrow adapter against fixture transports.
 * The tests do not broadcast. Live construction does not call the network.
 */

import {describe, expect, test} from 'bun:test';
import type {EscrowFundRequest} from '../../packages/reliability/src/escrow-port';
import type {ApiTransport} from '../cardano-agents-ts/types';
import {createEscrowPort} from './masumi-escrow';

const OPEN = '2026-10-06T00:00:00.000Z';
const WINDOW = '2026-10-13T00:00:00.000Z';
const BLOCK_TIME = 1_760_000_000;
const TX = 'ab'.repeat(32);
const AGENT = 'cd'.repeat(29);
const ESCROW = 'addr_test1_fixture_escrow';
const AMOUNT = 50_000_000;

function preprodEnv(allowNetwork: string): Record<string, string> {
  const env: Record<string, string> = {};
  env.CARDANO_MODE = 'preprod';
  env.CARDANO_ALLOW_NETWORK = allowNetwork;
  env.CARDANO_RECEIPT_DB = ':memory:';
  env.MASUMI_AGENT_IDENTIFIER = AGENT;
  env.MASUMI_PAYMENT_URL = 'http://127.0.0.1:9/api/v1';
  env.CARDANO_BLOCKFROST_URL = 'https://blockfrost.fixture.invalid/api/v0';
  return env;
}

function fundRequest(): EscrowFundRequest {
  return {
    transactionId: 'tx-preprod',
    purchaserId: 'buyer-1',
    amountLovelace: AMOUNT,
    sellerReturnAddress: 'addr_test1_seller',
    payByTime: OPEN,
    submitResultTime: WINDOW,
    unlockTime: WINDOW,
    externalDisputeUnlockTime: WINDOW,
    inputHash: 'ef'.repeat(32),
  };
}

describe('Cardano escrow gates', () => {
  test('stays simulated unless preprod and network access are both on', () => {
    const simulatedEnv: Record<string, string> = {};
    simulatedEnv.CARDANO_MODE = 'simulated';
    simulatedEnv.CARDANO_ALLOW_NETWORK = 'true';
    simulatedEnv.CARDANO_RECEIPT_DB = ':memory:';
    const simulated = createEscrowPort({env: simulatedEnv});
    expect(simulated.simulated).toBe(true);
    expect(simulated.broadcast).toBe(false);

    const dryRun = createEscrowPort({env: preprodEnv('false')});
    expect(dryRun.simulated).toBe(true);
    expect(dryRun.broadcast).toBe(false);

    const live = createEscrowPort({env: preprodEnv('true')});
    expect(live.simulated).toBe(false);
    expect(live.broadcast).toBe(true);
  });

  test('a dry run records the plan and does not call the network', async () => {
    const fetched: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string|URL|Request) => {
      fetched.push(String(input));
      return new Response('blocked', {status: 500});
    }) as typeof fetch;
    try {
      const port = createEscrowPort({env: preprodEnv('false')});
      const session = await port.fund(fundRequest());
      expect(session.mode).toBe('paper');
      expect(session.simulated).toBe(true);
      expect(session.onChainState).toBe('DryRun');
      expect(session.txHash).toBe('dry-run');
      expect(session.agentIdentifier).toBe(AGENT);
      const status = await port.status(session);
      expect(status.onChainState).toBe('DryRun');
      expect(fetched).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('reads fixture chain evidence for fund, release, refund, and mutual termination', async () => {
    const state = {funded: false, resultHash: '', refunded: false};
    const masumiCalls: string[] = [];
    const masumiTransport: ApiTransport = {
      simulated: true,
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        masumiCalls.push(path);
        const body: unknown = init?.body ? JSON.parse(String(init.body)) : {};
        const record = body && typeof body === 'object' ? body as {[key: string]: unknown} : {};
        if (path.endsWith('/payment') && init?.method === 'POST') {
          return Response.json({status: 'success', data: paymentCreated(record)});
        }
        if (path.endsWith('/purchase/resolve-blockchain-identifier')) {
          if (!state.funded) return Response.json({}, {status: 404});
          return Response.json({
            status: 'success', data: purchaseView(record, state.refunded),
          });
        }
        if (path.endsWith('/purchase/request-refund')) {
          state.refunded = true;
          return Response.json({status: 'success', data: {ok: true}});
        }
        if (path.endsWith('/purchase')) {
          state.funded = true;
          return Response.json({
            status: 'success', data: purchaseView(record, false),
          });
        }
        if (path.endsWith('/payment/submit-result')) {
          state.resultHash = typeof record.submitResultHash === 'string' ?
            record.submitResultHash : '';
          return Response.json({status: 'success', data: {resultHash: state.resultHash}});
        }
        if (path.endsWith('/payment/resolve-blockchain-identifier')) {
          return Response.json({status: 'success', data: paymentView(record)});
        }
        return Response.json({}, {status: 404});
      },
    };
    const cardanoTransport: ApiTransport = {
      simulated: true,
      fetch: async (url) => {
        const path = new URL(url).pathname.replace('/api/v0', '');
        if (path === '/genesis') return Response.json({network_magic: 1});
        if (path === '/blocks/latest') return Response.json({height: 102});
        if (path === `/txs/${TX}/utxos`) {
          return Response.json({inputs: [], outputs: []});
        }
        if (path === `/txs/${TX}`) {
          return Response.json({
            hash: TX, block_height: 100, block: 'aa'.repeat(32),
            valid_contract: true, fees: '170000', block_time: BLOCK_TIME,
          });
        }
        return Response.json({}, {status: 404});
      },
    };
    const fetched: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string|URL|Request) => {
      fetched.push(String(input));
      return new Response('blocked', {status: 500});
    }) as typeof fetch;
    try {
      const port = createEscrowPort({
        env: preprodEnv('false'),
        masumiTransport,
        cardanoTransport,
        resolveCredential: () => 'fixture-key',
      });
      expect(port.simulated).toBe(true);
      expect(port.broadcast).toBe(false);
      const session = await port.fund(fundRequest());
      expect(session.mode).toBe('paper');
      expect(session.txHash).toBe(TX);
      expect(session.escrowAddress).toBe(ESCROW);
      expect(session.onChainState).toBe('FundsLocked');
      const funded = await port.status(session);
      expect(funded.onChainState).toBe('FundsLocked');
      expect(funded.blockTime).toBe(new Date(BLOCK_TIME * 1000).toISOString());
      expect(funded.txHash).toBe(TX);
      const resultHash = '12'.repeat(32);
      await port.release(session, resultHash);
      expect(state.resultHash).toBe(resultHash);
      await port.refund(session);
      const refunded = await port.status(session);
      expect(refunded.onChainState).toBe('RefundRequested');
      const mutual = await port.mutualTerminate(session, {
        buyerConsentAt: OPEN,
        sellerConsentAt: OPEN,
        contractEnds: WINDOW,
        terminatedAt: OPEN,
      });
      expect(mutual.action).toBe('mutual_termination');
      expect(mutual.buyerConsentAt).toBe(OPEN);
      expect(mutual.sellerConsentAt).toBe(OPEN);
      expect(mutual.contractEnds).toBe(WINDOW);
      expect(mutual.blockTime).toBe(new Date(BLOCK_TIME * 1000).toISOString());
      expect(masumiCalls.some((path) => path.endsWith('/purchase/request-refund'))).toBe(true);
      expect(fetched).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

function paymentCreated(body: {[key: string]: unknown}): {[key: string]: unknown} {
  const data: {[key: string]: unknown} = {
    blockchainIdentifier: '11'.repeat(32),
    agentIdentifier: body.agentIdentifier,
    inputHash: body.inputHash,
    sellerReturnAddress: body.sellerReturnAddress,
    payByTime: millis(body.payByTime),
    submitResultTime: millis(body.submitResultTime),
    unlockTime: millis(body.unlockTime),
    externalDisputeUnlockTime: millis(body.externalDisputeUnlockTime),
  };
  data.PaymentSource = source();
  const wallet: {[key: string]: unknown} = {};
  wallet.walletVkey = 'bb'.repeat(28);
  data.SmartContractWallet = wallet;
  data.RequestedFunds = [{unit: '', amount: String(AMOUNT)}];
  return data;
}

function purchaseView(
  body: {[key: string]: unknown}, refunded: boolean,
): {[key: string]: unknown} {
  const data: {[key: string]: unknown} = {
    ...identity(body),
    onChainState: refunded ? 'RefundRequested' : 'FundsLocked',
    sellerReturnAddress: 'addr_test1_seller',
  };
  data.PaidFunds = [{unit: '', amount: String(AMOUNT)}];
  data.PaymentSource = source();
  const action: {[key: string]: unknown} = {};
  action.requestedAction = refunded ?
    'SetRefundRequestedRequested' : 'WaitingForExternalAction';
  data.NextAction = action;
  data.CurrentTransaction = {
    txHash: TX, status: 'Confirmed',
    newOnChainState: refunded ? 'RefundRequested' : 'FundsLocked',
  };
  data.TransactionHistory = [];
  return data;
}

function paymentView(body: {[key: string]: unknown}): {[key: string]: unknown} {
  const data: {[key: string]: unknown} = {
    ...identity(body),
    onChainState: 'FundsLocked',
    sellerReturnAddress: 'addr_test1_seller',
    payByTime: millis(OPEN),
    submitResultTime: millis(WINDOW),
    unlockTime: millis(WINDOW),
    externalDisputeUnlockTime: millis(WINDOW),
  };
  data.RequestedFunds = [{unit: '', amount: String(AMOUNT)}];
  data.PaymentSource = source();
  const action: {[key: string]: unknown} = {};
  action.requestedAction = 'WaitingForExternalAction';
  data.NextAction = action;
  data.CurrentTransaction = {
    txHash: TX, status: 'Confirmed', newOnChainState: 'FundsLocked',
  };
  data.TransactionHistory = [];
  return data;
}

function source(): {[key: string]: unknown} {
  const value: {[key: string]: unknown} = {};
  value.network = 'Preprod';
  value.paymentSourceType = 'Web3CardanoV1';
  value.smartContractAddress = ESCROW;
  return value;
}

function identity(body: {[key: string]: unknown}): {[key: string]: unknown} {
  return {
    blockchainIdentifier: '11'.repeat(32),
    agentIdentifier: AGENT,
    inputHash: typeof body.inputHash === 'string' ? body.inputHash : 'ef'.repeat(32),
  };
}

function millis(value: unknown): string {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return String(Number.isNaN(parsed) ? value : parsed);
}
