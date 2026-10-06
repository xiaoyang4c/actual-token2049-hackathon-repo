import {describe, expect, spyOn, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore, type PaymentReceiptRecord} from '../../packages/db/src';
import {start as startAgent} from '../cardano-agent';
import {scoreMarkets, start as startProvider} from '../score-provider';
import {PreprodCardanoAdapter} from './cardano';
import {createBlockfrostSdk} from './blockfrost-sdk';
import {loadPaymentConfig} from './config';
import paymentFixture from './fixtures/payment.json';
import purchaseFixture from './fixtures/purchase.json';
import {SimulatedMasumiAdapter} from './masumi';
import {createPaymentRuntime, type RuntimeOptions} from './runtime';
import {object, scoreInputHash, sha256, type ApiTransport, type PaymentRequirement} from './types';

const TX_HASH = 'ab'.repeat(32);
const INPUT = {markets: [
  {venue: 'polymarket' as const, marketId: 'same-id', yesPrice: 0.5},
  {venue: 'kalshi' as const, marketId: 'same-id', yesPrice: 0.5},
]};
const clone = (value: unknown): Record<string, unknown> => object(JSON.parse(JSON.stringify(value)));
const reply = (data: unknown, status = 200) => Response.json(data, {status});

/** Protocol fixtures, never a network passthrough or a wallet. */
class PreprodFixture {
  readonly config = loadPaymentConfig(Object.fromEntries([
    ['CARDANO_MODE', 'preprod'], ['CARDANO_RECEIPT_DB', ':memory:'],
    ['CARDANO_WALLET_ADDRESS', 'addr_test1_fixture_buyer'], ['SCORE_PAY_TO', 'addr_test1_fixture_provider'],
    ['MASUMI_AGENT_IDENTIFIER', 'a'.repeat(64)],
    ['CARDANO_BLOCKFROST_URL', 'https://blockfrost.fixture.invalid/api/v0'],
    ['MASUMI_PAYMENT_URL', 'https://masumi.fixture.invalid/api/v1'],
  ]));
  readonly calls: {path: string; body?: Record<string, unknown>}[] = [];
  payment?: Record<string, unknown>;
  purchase?: Record<string, unknown>;
  tipHeight = 102;
  networkMagic = 1;
  indexed = true;
  validContract = true;
  outputAddress = 'addr_test1_fixture_escrow';
  outputAmount = '1000000';
  losePaymentResponse = false;
  losePurchaseResponse = false;
  loseResultResponse = false;
  queuePurchase = false;

  readonly cardanoTransport: ApiTransport = {simulated: true, fetch: async (url, init) => {
    expect(new Headers(init.headers).get('project_id')).toBe(`fixture:${this.config.blockfrostKeyRef}`);
    const path = new URL(url).pathname.replace('/api/v0', '');
    this.calls.push({path});
    if (path === '/genesis') return reply({network_magic: this.networkMagic});
    if (path.startsWith('/addresses/')) return reply({amount: [{unit: 'lovelace', quantity: '100000000'}]});
    if (path === '/tx/submit') {
      expect(new Headers(init.headers).get('content-type')).toBe('application/cbor');
      expect(Buffer.from(init.body as Uint8Array).toString('hex')).toBe('a100');
      return reply(TX_HASH);
    }
    if (path === `/txs/${TX_HASH}`) return this.indexed
      ? reply({hash: TX_HASH, block_height: 100, valid_contract: this.validContract}) : reply({}, 404);
    if (path === '/blocks/latest') return reply({height: this.tipHeight});
    if (path === `/txs/${TX_HASH}/utxos`) return reply({outputs: [
      {address: this.outputAddress, amount: [{unit: 'lovelace', quantity: this.outputAmount}]},
    ]});
    throw new Error(`unexpected fixture Cardano path ${path}`);
  }};

  readonly masumiTransport: ApiTransport = {simulated: true, fetch: async (url, init) => {
    const path = new URL(url).pathname.replace('/api/v1', '');
    const roleRef = path.startsWith('/purchase') ? this.config.masumiBuyerKeyRef : this.config.masumiSellerKeyRef;
    expect(new Headers(init.headers).get('token')).toBe(`fixture:${roleRef}`);
    const body = object(JSON.parse(String(init.body)));
    this.calls.push({path, body});
    if (path === '/payment') {
      if (this.payment) return reply({status: 'error', object: this.payment}, 409);
      const data = clone(paymentFixture);
      data.blockchainIdentifier = `fixture:${body.identifierFromPurchaser}`;
      data.agentIdentifier = body.agentIdentifier;
      data.inputHash = body.inputHash;
      data.sellerReturnAddress = body.sellerReturnAddress;
      object(data.PaymentSource).paymentSourceType = body.paymentSourceType;
      for (const field of ['payByTime', 'submitResultTime', 'unlockTime', 'externalDisputeUnlockTime']) {
        data[field] = String(Date.parse(String(body[field])));
      }
      this.payment = data;
      if (this.losePaymentResponse) {
        this.losePaymentResponse = false;
        throw new Error('fixture connection lost after payment creation');
      }
      return reply({status: 'success', data});
    }
    if (path === '/purchase/resolve-blockchain-identifier') return this.purchase
      ? reply({status: 'success', data: this.purchase}) : reply({status: 'error'}, 404);
    if (path === '/purchase') {
      if (this.purchase) return reply({status: 'error', object: this.purchase}, 409);
      const data = clone(purchaseFixture);
      data.blockchainIdentifier = body.blockchainIdentifier;
      data.agentIdentifier = body.agentIdentifier;
      data.inputHash = body.inputHash;
      object(data.PaymentSource).paymentSourceType = body.paymentSourceType;
      if (this.queuePurchase) {
        data.onChainState = null;
        data.CurrentTransaction = null;
        object(data.NextAction).requestedAction = 'FundsLockingRequested';
      }
      this.purchase = data;
      if (this.losePurchaseResponse) {
        this.losePurchaseResponse = false;
        throw new Error('fixture connection lost after purchase creation');
      }
      return reply({status: 'success', data});
    }
    if (path === '/payment/resolve-blockchain-identifier') return reply({status: 'success', data: this.payment});
    if (path === '/payment/submit-result') {
      expect(body.network).toBe('Preprod');
      expect(body.blockchainIdentifier).toBe(this.payment?.blockchainIdentifier);
      object(this.payment!.NextAction).requestedAction = 'SubmitResultRequested';
      object(this.payment!.NextAction).resultHash = body.submitResultHash;
      if (this.loseResultResponse) {
        this.loseResultResponse = false;
        throw new Error('fixture connection lost after result submission');
      }
      return reply({status: 'success', data: this.payment});
    }
    if (path === '/purchase/request-refund') {
      object(this.purchase!.NextAction).requestedAction = 'SetRefundRequestedRequested';
      return reply({status: 'success', data: this.purchase});
    }
    throw new Error(`unexpected fixture Masumi path ${path}`);
  }};

  options(databasePath = ':memory:'): RuntimeOptions {
    return {
      config: {...this.config, databasePath}, cardanoTransport: this.cardanoTransport,
      masumiTransport: this.masumiTransport, resolveCredential: (reference) => `fixture:${reference}`,
    };
  }

  count(path: string): number {
    return this.calls.filter((call) => call.path === path).length;
  }
}

function requirement(payTo = 'addr_test1qz_demo_score_provider'): PaymentRequirement {
  return {
    scheme: 'exact', network: 'cardano-preprod', maxAmountRequired: '1000000', asset: 'lovelace',
    payTo, resource: 'http://localhost:8789/score', description: 'Fixture scores',
    maxTimeoutSeconds: 60, inputHash: scoreInputHash(INPUT),
  };
}

const verification = (paid: {receipt: PaymentReceiptRecord; xPayment: string}) => ({
  xPayment: paid.xPayment, resource: paid.receipt.resource, amount: paid.receipt.amount,
  payTo: paid.receipt.payTo, inputHash: scoreInputHash(INPUT),
});

async function withDatabase(run: (databasePath: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'cardano-payment-'));
  try {
    await run(join(directory, 'receipts.sqlite'));
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) => fetch(url, {
  method: 'POST', headers: {'content-type': 'application/json', ...headers}, body: JSON.stringify(body),
});

describe('preprod adapter integration with offline protocol fixtures', () => {
  test('pay → confirm → deliver scores → persist receipt, then replay after restart', async () => {
    await withDatabase(async (databasePath) => {
      const fixture = new PreprodFixture();
      let agent = startAgent(0, fixture.options(databasePath));
      const agentUrl = `http://127.0.0.1:${agent.port}`;
      const provider = startProvider(0, agentUrl, fixture.config);
      const providerUrl = `http://127.0.0.1:${provider.port}/score`;
      try {
        const quote = await post(providerUrl, INPUT);
        const accepts = object(await quote.json()).accepts as PaymentRequirement[];
        const payBody = {idempotencyKey: 'preprod-http-flow', requirement: accepts[0]};
        const payResponse = await post(`${agentUrl}/pay`, payBody);
        expect(payResponse.status).toBe(200);
        const paid = await payResponse.json() as {receipt: PaymentReceiptRecord; xPayment: string};
        expect(paid.receipt.status).toBe('submitted');
        expect(paid.receipt.simulated).toBe(true);
        fixture.tipHeight = 100;
        const pending = await post(providerUrl, INPUT, {'x-payment': paid.xPayment});
        expect(pending.status).toBe(402);
        expect(await pending.json()).not.toHaveProperty('signals');
        expect(fixture.count('/payment/submit-result')).toBe(0);
        fixture.tipHeight = 102;
        const confirmedResponse = await post(`${agentUrl}/confirm`, {receiptId: paid.receipt.receiptId});
        const confirmed = await confirmedResponse.json() as {receipt: PaymentReceiptRecord};
        expect(confirmed.receipt.status).toBe('confirmed');
        expect(confirmed.receipt.responseJson).toBeUndefined();
        const scored = await post(providerUrl, INPUT, {'x-payment': paid.xPayment});
        expect(scored.status).toBe(200);
        const scores = await scored.json();
        expect(scores).toEqual(scoreMarkets(INPUT));
        const header = object(JSON.parse(Buffer.from(scored.headers.get('x-payment-response')!, 'base64').toString()));
        expect(header.simulated).toBe(true);
        const port = agent.port;
        await agent.stop(true);
        agent = startAgent(port, fixture.options(databasePath));
        const repeatedPay = await post(`${agentUrl}/pay`, payBody);
        expect((await repeatedPay.json() as {receipt: PaymentReceiptRecord}).receipt.status).toBe('delivered');
        const replay = await post(providerUrl, INPUT, {'x-payment': paid.xPayment});
        expect(replay.status).toBe(200);
        expect(await replay.json()).toEqual(scores);
        const store = AgentStore.open(databasePath);
        try {
          const saved = store.getPaymentReceipt(paid.receipt.receiptId)!;
          expect(saved.responseJson).toBe(JSON.stringify(scores));
          expect(saved.resultHash).toBe(sha256(JSON.stringify(scores)));
          expect(saved.confirmedAt).toBeDefined();
          expect(saved.deliveredAt).toBeDefined();
          expect(saved.status).toBe('delivered');
        } finally {
          store.close();
        }
        expect(fixture.count('/payment')).toBe(1);
        expect(fixture.count('/purchase')).toBe(1);
        expect(fixture.count('/payment/submit-result')).toBe(1);
        expect(fixture.count('/tx/submit')).toBe(0);
        const purchase = fixture.calls.find((call) => call.path === '/purchase')!.body!;
        expect(purchase.Amounts).toEqual([{unit: '', amount: '1000000'}]);
        expect(purchase.forceLayer).toBe('L1');
        expect(purchase).not.toHaveProperty('supportedPaymentSourceIndex');
        expect(purchase.payByTime).toMatch(/^[0-9]+$/);
        const changedInput = {markets: [{...INPUT.markets[0], yesPrice: 0.6}]};
        const invalid = await post(providerUrl, changedInput, {'x-payment': paid.xPayment});
        expect(invalid.status).toBe(402);
        expect(await invalid.json()).not.toHaveProperty('signals');
      } finally {
        provider.stop(true);
        await agent.stop(true);
      }
    });
  });

  test.each(['payment', 'purchase'] as const)('recovers a lost %s response without a second funds lock', async (stage) => {
    await withDatabase(async (databasePath) => {
      const fixture = new PreprodFixture();
      if (stage === 'payment') fixture.losePaymentResponse = true;
      else fixture.losePurchaseResponse = true;
      const body = {idempotencyKey: 'lost-response', requirement: requirement(fixture.config.scorePayTo)};
      let runtime = createPaymentRuntime(fixture.options(databasePath));
      await expect(runtime.pay(body)).rejects.toThrow('request failed');
      const saved = runtime.store.getPaymentReceiptByKey(body.idempotencyKey)!;
      expect(saved.status).toBe('requested');
      await runtime.close();
      runtime = createPaymentRuntime(fixture.options(databasePath));
      try {
        const paid = await runtime.pay(body);
        expect(paid.receipt.receiptId).toBe(saved.receiptId);
        expect(paid.receipt.status).toBe('submitted');
        expect(fixture.count('/purchase')).toBe(1);
        const attempts = fixture.calls.filter((call) => call.path === '/payment');
        if (attempts.length > 1) expect(attempts[0].body).toEqual(attempts[1].body);
      } finally {
        await runtime.close();
      }
    });
  });

  test('waits for a queued purchase, keeps the original deposit after result submission, and detects rollback', async () => {
    const fixture = new PreprodFixture();
    fixture.queuePurchase = true;
    const runtime = createPaymentRuntime(fixture.options());
    try {
      const paid = await runtime.pay({idempotencyKey: 'queued', requirement: requirement(fixture.config.scorePayTo)});
      expect(paid.receipt.txHash).toBe('');
      await expect(runtime.verify(verification(paid))).rejects.toThrow('not confirmed');
      const deposit = clone(purchaseFixture).CurrentTransaction;
      fixture.purchase!.onChainState = 'FundsLocked';
      fixture.purchase!.CurrentTransaction = deposit;
      expect(await runtime.verify(verification(paid))).toHaveProperty('txHash', TX_HASH);
      await runtime.deliver({...verification(paid), response: scoreMarkets(INPUT)});
      fixture.purchase!.TransactionHistory = [deposit];
      fixture.purchase!.CurrentTransaction = {
        txHash: 'cd'.repeat(32), status: 'Confirmed', newOnChainState: 'ResultSubmitted',
      };
      fixture.purchase!.onChainState = 'ResultSubmitted';
      expect(await runtime.verify(verification(paid))).toHaveProperty('txHash', TX_HASH);
      object(deposit).status = 'RolledBack';
      await expect(runtime.confirm(paid.receipt.receiptId)).rejects.toThrow('not confirmed');
      expect(await runtime.verify(verification(paid))).toHaveProperty('response', scoreMarkets(INPUT));
      expect(fixture.count('/purchase')).toBe(1);
      expect(fixture.count('/payment/submit-result')).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  test('replays delivered scores through disputes and an API outage after restart', async () => {
    await withDatabase(async (databasePath) => {
      const fixture = new PreprodFixture();
      let runtime = createPaymentRuntime(fixture.options(databasePath));
      const paid = await runtime.pay({idempotencyKey: 'replay-outage', requirement: requirement(fixture.config.scorePayTo)});
      const delivery = {...verification(paid), response: scoreMarkets(INPUT)};
      await runtime.deliver(delivery);
      fixture.purchase!.onChainState = 'Disputed';
      const reads = fixture.count('/purchase/resolve-blockchain-identifier');
      expect(await runtime.verify(verification(paid))).toHaveProperty('response', delivery.response);
      expect((await runtime.deliver(delivery)).response).toEqual(delivery.response);
      expect(fixture.count('/purchase/resolve-blockchain-identifier')).toBe(reads);
      await runtime.close();
      let calls = 0;
      runtime = createPaymentRuntime({...fixture.options(databasePath), masumiTransport: {
        simulated: true, fetch: async () => { calls++; throw new Error('fixture API unavailable'); },
      }});
      try {
        expect(await runtime.verify(verification(paid))).toHaveProperty('response', delivery.response);
        expect((await runtime.deliver(delivery)).receipt.status).toBe('delivered');
        await expect(runtime.deliver({...delivery, response: {signals: []}})).rejects.toThrow('different score response');
        await expect(runtime.verify({...verification(paid), inputHash: '0'.repeat(64)})).rejects.toThrow('does not match');
        expect(calls).toBe(0);
      } finally {
        await runtime.close();
      }
    });
  });

  test('persists the purchase attempt before a lost response and recovers it after expiry', async () => {
    await withDatabase(async (databasePath) => {
      const fixture = new PreprodFixture();
      let now = Date.now();
      const options = {...fixture.options(databasePath), reconciliation: {now: () => now, random: () => 0}};
      let runtime = createPaymentRuntime(options);
      const body = {idempotencyKey: 'ambiguous-expiry', requirement: requirement(fixture.config.scorePayTo)};
      fixture.losePurchaseResponse = true;
      await expect(runtime.pay(body)).rejects.toThrow('request failed');
      const saved = runtime.store.getPaymentReceiptByKey(body.idempotencyKey)!;
      expect(object(JSON.parse(saved.protocolData!)).purchaseAttempted).toBe(true);
      expect(runtime.store.getPaymentSettlement(saved.receiptId)?.nextCheckAt).toBeDefined();
      await runtime.close();
      now += 120_000;
      runtime = createPaymentRuntime(options);
      try {
        const recovered = await runtime.pay(body);
        expect(recovered.receipt.status).toBe('submitted');
        expect(recovered.receipt.txHash).toBe(TX_HASH);
        expect(fixture.count('/purchase')).toBe(1);
      } finally {
        await runtime.close();
      }
    });
  });

  test('reconciles an unsubmitted expiry after restart without another purchase', async () => {
    await withDatabase(async (databasePath) => {
      const fixture = new PreprodFixture();
      let now = Date.now();
      const options = {...fixture.options(databasePath), reconciliation: {now: () => now, random: () => 0}};
      let runtime = createPaymentRuntime(options);
      fixture.losePaymentResponse = true;
      await expect(runtime.pay({idempotencyKey: 'unsubmitted-expiry', requirement: requirement(fixture.config.scorePayTo)}))
        .rejects.toThrow('request failed');
      const receipt = runtime.store.getPaymentReceiptByKey('unsubmitted-expiry')!;
      expect(object(JSON.parse(receipt.protocolData!)).purchaseAttempted).toBe(false);
      await runtime.close();
      now += 120_000;
      runtime = createPaymentRuntime(options);
      try {
        expect(await runtime.reconcile()).toBe(1);
        expect(runtime.store.getPaymentSettlement(receipt.receiptId)).toMatchObject({
          status: 'expired_unfunded', lastVerifiedStatus: 'expired_unfunded', attemptCount: 1,
        });
        expect(runtime.store.getPaymentReceipt(receipt.receiptId)).toEqual(receipt);
        expect(fixture.count('/purchase')).toBe(0);
      } finally {
        await runtime.close();
      }
    });
  });

  test('serializes reconciliation with delivery and exposes settlement history over HTTP', async () => {
    const fixture = new PreprodFixture();
    let release: () => void = () => {};
    let enter: () => void = () => {};
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const transport: ApiTransport = {simulated: true, fetch: async (url, init) => {
      if (new URL(url).pathname.endsWith('/submit-result')) { enter(); await blocked; }
      return fixture.masumiTransport.fetch(url, init);
    }};
    const runtime = createPaymentRuntime({...fixture.options(), masumiTransport: transport});
    try {
      const paid = await runtime.pay({idempotencyKey: 'delivery-reconcile-race', requirement: requirement(fixture.config.scorePayTo)});
      const delivery = runtime.deliver({...verification(paid), response: scoreMarkets(INPUT)});
      await entered;
      const reconciled = runtime.reconcile();
      release();
      await Promise.all([delivery, reconciled]);
      const receipt = runtime.store.getPaymentReceipt(paid.receipt.receiptId)!;
      expect(receipt.status).toBe('delivered');
      expect(receipt.responseJson).toBe(JSON.stringify(scoreMarkets(INPUT)));
      expect(receipt.resultHash).toBe(sha256(receipt.responseJson!));
      expect(runtime.settlement(receipt.receiptId).observations).toHaveLength(1);
      expect(runtime.receipts()[0].settlement?.attemptCount).toBe(1);
    } finally {
      release();
      await runtime.close();
    }
    const routeFixture = new PreprodFixture();
    const agent = startAgent(0, routeFixture.options());
    const base = `http://127.0.0.1:${agent.port}`;
    try {
      const response = await post(`${base}/pay`, {idempotencyKey: 'settlement-route', requirement: requirement(routeFixture.config.scorePayTo)});
      expect(response.status).toBe(200);
      const paid = await response.json() as {receipt: PaymentReceiptRecord};
      const history = await fetch(`${base}/settlement?receiptId=${paid.receipt.receiptId}`);
      expect(history.status).toBe(200);
      expect(await history.json()).toMatchObject({settlement: {receiptId: paid.receipt.receiptId}, observations: []});
      const receipts = await (await fetch(`${base}/receipts`)).json() as {settlement?: {receiptId: string}}[];
      expect(receipts[0].settlement?.receiptId).toBe(paid.receipt.receiptId);
      const missing = await fetch(`${base}/settlement`);
      expect(missing.status).toBe(400);
      await missing.text();
    } finally {
      await agent.stop(true);
    }
  });

  test('closes SQLite after an in-flight reconciliation write fails', async () => {
    const fixture = new PreprodFixture();
    let release: () => void = () => {};
    let enter: () => void = () => {};
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const transport: ApiTransport = {simulated: true, fetch: async (url, init) => {
      if (new URL(url).pathname.endsWith('/payment/resolve-blockchain-identifier')) { enter(); await blocked; }
      return fixture.masumiTransport.fetch(url, init);
    }};
    const runtime = createPaymentRuntime({...fixture.options(), masumiTransport: transport});
    const write = spyOn(runtime.store, 'recordPaymentSettlementObservation').mockImplementation(() => {
      throw new Error('fixture write failed');
    });
    try {
      await runtime.pay({idempotencyKey: 'shutdown-failure', requirement: requirement(fixture.config.scorePayTo)});
      const tick = runtime.reconcile().catch((error: unknown) => error);
      await entered;
      const shutdown = runtime.close().catch((error: unknown) => error);
      release();
      const [tickFailure, shutdownFailure] = await Promise.all([tick, shutdown]);
      expect(tickFailure).toBeInstanceOf(Error);
      expect((tickFailure as Error).message).toBe('fixture write failed');
      expect(shutdownFailure).toBeInstanceOf(Error);
      expect((shutdownFailure as Error).message).toBe('fixture write failed');
      expect(() => runtime.store.listPaymentReceipts()).toThrow();
    } finally {
      release();
      write.mockRestore();
    }
  });

  test('passes the supported payment source index for V2', async () => {
    const fixture = new PreprodFixture();
    fixture.config.masumiPaymentSourceType = 'Web3CardanoV2';
    fixture.config.masumiSupportedSourceIndex = 3;
    const runtime = createPaymentRuntime(fixture.options());
    try {
      await runtime.pay({idempotencyKey: 'v2', requirement: requirement(fixture.config.scorePayTo)});
      for (const path of ['/payment', '/purchase']) {
        expect(fixture.calls.find((call) => call.path === path)?.body).toHaveProperty('supportedPaymentSourceIndex', 3);
      }
    } finally {
      await runtime.close();
    }
  });

  test('recovers a queued result after restart and keeps the exact response', async () => {
    await withDatabase(async (databasePath) => {
      const fixture = new PreprodFixture();
      let runtime = createPaymentRuntime(fixture.options(databasePath));
      const paid = await runtime.pay({idempotencyKey: 'lost-result', requirement: requirement(fixture.config.scorePayTo)});
      const delivery = {...verification(paid), response: scoreMarkets(INPUT)};
      fixture.loseResultResponse = true;
      await expect(runtime.deliver(delivery)).rejects.toThrow('request failed');
      expect(runtime.store.getPaymentReceipt(paid.receipt.receiptId)?.status).toBe('confirmed');
      expect(runtime.store.getPaymentReceipt(paid.receipt.receiptId)?.responseJson).toBe(JSON.stringify(delivery.response));
      await runtime.close();
      runtime = createPaymentRuntime(fixture.options(databasePath));
      try {
        const delivered = await runtime.deliver(delivery);
        expect(delivered.receipt.status).toBe('delivered');
        expect(delivered.response).toEqual(delivery.response);
        expect(fixture.count('/payment/submit-result')).toBe(1);
        await expect(runtime.deliver({...delivery, response: {signals: []}})).rejects.toThrow('different score response');
        await expect(runtime.refund(paid.receipt.receiptId)).rejects.toThrow('not refundable');
      } finally {
        await runtime.close();
      }
    });
  });

  test('rejects unindexed, invalid, underpaid, misdirected, and disputed payments', async () => {
    const fixture = new PreprodFixture();
    const runtime = createPaymentRuntime(fixture.options());
    try {
      const paid = await runtime.pay({idempotencyKey: 'bad-evidence', requirement: requirement(fixture.config.scorePayTo)});
      fixture.indexed = false;
      await expect(runtime.verify(verification(paid))).rejects.toThrow('not indexed');
      fixture.indexed = true;
      fixture.validContract = false;
      await expect(runtime.verify(verification(paid))).rejects.toThrow('invalid transaction');
      fixture.validContract = true;
      fixture.outputAmount = '999999';
      await expect(runtime.verify(verification(paid))).rejects.toThrow('amount or escrow address');
      fixture.outputAmount = '1000000';
      fixture.outputAddress = 'addr_test1_wrong_escrow';
      await expect(runtime.verify(verification(paid))).rejects.toThrow('amount or escrow address');
      fixture.outputAddress = 'addr_test1_fixture_escrow';
      fixture.purchase!.onChainState = 'Disputed';
      await expect(runtime.verify(verification(paid))).rejects.toThrow('disputed/refunded');
      expect(runtime.store.getPaymentReceipt(paid.receipt.receiptId)?.status).toBe('submitted');
      expect(fixture.count('/payment/submit-result')).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  test('queues a refund without claiming completion or crediting the wallet', async () => {
    const fixture = new PreprodFixture();
    const runtime = createPaymentRuntime(fixture.options());
    try {
      const paid = await runtime.pay({idempotencyKey: 'refund-request', requirement: requirement(fixture.config.scorePayTo)});
      expect((await runtime.refund(paid.receipt.receiptId)).status).toBe('refund_requested');
      expect((await runtime.refund(paid.receipt.receiptId)).status).toBe('refund_requested');
      expect(fixture.count('/purchase/request-refund')).toBe(1);
      await expect(runtime.verify(verification(paid))).rejects.toThrow('not available for delivery');
    } finally {
      await runtime.close();
    }
  });

  test('supports signed CBOR submission and rejects another network before submitting', async () => {
    const fixture = new PreprodFixture();
    const adapter = new PreprodCardanoAdapter(fixture.config, fixture.cardanoTransport, (reference) => `fixture:${reference}`);
    expect(await adapter.submitTransaction('a100')).toBe(TX_HASH);
    const wrongNetwork = new PreprodFixture();
    wrongNetwork.networkMagic = 2;
    const invalid = new PreprodCardanoAdapter(wrongNetwork.config, wrongNetwork.cardanoTransport, (reference) => `fixture:${reference}`);
    await expect(invalid.submitTransaction('a100')).rejects.toThrow('not preprod');
    expect(wrongNetwork.count('/tx/submit')).toBe(0);
  });

  test('keeps preprod APIs disabled by default, even when keys resolve', async () => {
    const called = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(
      async () => {throw new Error('unexpected external request');}, {preconnect: () => {}},
    ));
    const config = loadPaymentConfig(Object.fromEntries([
      ['CARDANO_MODE', 'preprod'], ['CARDANO_RECEIPT_DB', ':memory:'],
    ]));
    const runtime = createPaymentRuntime({config, resolveCredential: () => 'fixture-key'});
    try {
      let resolutions = 0;
      const sdk = createBlockfrostSdk(config, undefined, () => {resolutions++; return 'fixture-key';});
      expect(sdk.options.network).toBe('preprod');
      expect(sdk.apiUrl).toBe(config.blockfrostUrl);
      expect(typeof sdk.addresses).toBe('function');
      expect(typeof sdk.txSubmit).toBe('function');
      expect(resolutions).toBe(0);
      await expect(runtime.wallet()).rejects.toThrow('API access is disabled');
      await expect(runtime.pay({idempotencyKey: 'disabled', requirement: requirement()})).rejects.toThrow('API access is disabled');
      expect(called).not.toHaveBeenCalled();
      expect(runtime.store.listPaymentReceipts()).toEqual([]);
    } finally {
      called.mockRestore();
      await runtime.close();
    }
  });
});

describe('durable simulated payments', () => {
  test('releases an unsubmitted reservation only after verified expiry', async () => {
    const config = {...loadPaymentConfig({}), databasePath: ':memory:', initialBalanceLovelace: 1_000_000};
    let now = Date.now();
    const runtime = createPaymentRuntime({config, reconciliation: {now: () => now, random: () => 0}});
    const creation = spyOn(SimulatedMasumiAdapter.prototype, 'createPayment').mockImplementationOnce(async () => {
      throw new Error('fixture payment service unavailable');
    });
    try {
      await expect(runtime.pay({idempotencyKey: 'expired-reservation', requirement: requirement()}))
        .rejects.toThrow('fixture payment service unavailable');
      const receipt = runtime.store.getPaymentReceiptByKey('expired-reservation')!;
      expect(await runtime.wallet()).toHaveProperty('balanceLovelace', 0);
      await runtime.reconcile();
      expect(await runtime.wallet()).toHaveProperty('balanceLovelace', 0);
      now += 120_000;
      await runtime.reconcile();
      expect(runtime.store.getPaymentSettlement(receipt.receiptId)).toMatchObject({
        status: 'expired_unfunded', lastVerifiedStatus: 'expired_unfunded',
      });
      expect(runtime.store.getPaymentReceipt(receipt.receiptId)).toEqual(receipt);
      expect(await runtime.wallet()).toHaveProperty('balanceLovelace', 1_000_000);
      await runtime.pay({idempotencyKey: 'after-expiry', requirement: requirement()});
      expect(await runtime.wallet()).toHaveProperty('balanceLovelace', 0);
    } finally {
      creation.mockRestore();
      await runtime.close();
    }
  });

  test('preserves the balance and enforces key and proof bindings after restart', async () => {
    await withDatabase(async (databasePath) => {
      const config = {...loadPaymentConfig({}), databasePath};
      let runtime = createPaymentRuntime({config});
      const body = {idempotencyKey: 'simulated-restart', requirement: requirement()};
      const paid = await runtime.pay(body);
      await runtime.close();
      runtime = createPaymentRuntime({config});
      try {
        expect(await runtime.pay(body)).toEqual(paid);
        expect(await runtime.wallet()).toHaveProperty('balanceLovelace', 99_000_000);
        await expect(runtime.pay({...body, requirement: {...body.requirement, maxAmountRequired: '1500000'}})).rejects.toThrow('another payment');
        const changed = createPaymentRuntime({config: {...config, masumiAgentIdentifier: 'another-agent'}});
        try {
          await expect(changed.pay(body)).rejects.toThrow('another payment');
          await expect(changed.refund(paid.receipt.receiptId)).rejects.toThrow('another payment configuration');
        } finally {
          await changed.close();
        }
        for (const changed of [{resource: 'other'}, {payTo: 'other'}, {amount: 1}, {inputHash: 'a'.repeat(64)}]) {
          await expect(runtime.verify({...verification(paid), ...changed})).rejects.toThrow('does not match');
        }
        expect((await runtime.refund(paid.receipt.receiptId)).status).toBe('refund_requested');
        expect(await runtime.wallet()).toHaveProperty('balanceLovelace', 99_000_000);
      } finally {
        await runtime.close();
      }
    });
  });

  test('serializes concurrent payments and rejects invalid amounts before reserving funds', async () => {
    const config = {...loadPaymentConfig({}), databasePath: ':memory:', initialBalanceLovelace: 1_000_000};
    const runtime = createPaymentRuntime({config});
    try {
      for (const amount of ['0', '-1', '1.5', '1e6', 'NaN', '9007199254740993', '2000001']) {
        await expect(runtime.pay({idempotencyKey: `bad:${amount}`, requirement: {...requirement(), maxAmountRequired: amount}})).rejects.toThrow();
      }
      expect(runtime.store.listPaymentReceipts()).toHaveLength(0);
      const repeated = await Promise.all(Array.from({length: 5}, () =>
        runtime.pay({idempotencyKey: 'same-key', requirement: requirement()})));
      expect(new Set(repeated.map((payment) => payment.receipt.receiptId)).size).toBe(1);
      expect(runtime.store.listPaymentReceipts()).toHaveLength(1);
      await expect(runtime.pay({idempotencyKey: 'another-key', requirement: requirement()})).rejects.toThrow('insufficient balance');
      expect(await runtime.wallet()).toHaveProperty('balanceLovelace', 0);
    } finally {
      await runtime.close();
    }
  });
});
