import {Database} from 'bun:sqlite';
import {describe, expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {MarketQuote, PaperPortfolio, Side, Venue} from '../packages/core/src';
import {AgentStore} from '../packages/db/src';
import {createAgentRuntime, type AgentRuntime} from './agent-runtime';
import {start, type ControlOptions} from './control-api';
import {createSavedQuoteSource} from './paper-market-source';
import polymarketFixture from './fixtures/polymarket-markets.json';
import kalshiFixture from './fixtures/kalshi-events.json';

const INITIAL_TIME = '2026-10-04T12:00:00.000Z';
const withBook = async (run: (book: {
  runtime: AgentRuntime; now: () => Date; setTime: (value: string) => void;
}) => void | Promise<void>) => {
  let now = new Date(INITIAL_TIME);
  const runtime = createAgentRuntime({databasePath: ':memory:', now: () => now});
  try {
    await run({runtime, now: () => now, setTime: (value) => { now = new Date(value); }});
  } finally {
    runtime.close();
  }
};

const buy = (runtime: AgentRuntime, key: string, options: {
  venue?: Venue; marketId?: string; side?: Side; size?: number; price?: number;
} = {}) => runtime.submitOrders({cycleId: `cycle-${key}`, orders: [{
  idempotencyKey: key,
  intent: {
    venue: options.venue ?? 'polymarket', marketId: options.marketId ?? 'm1', side: options.side ?? 'yes',
    size: options.size ?? 20, limit: options.price ?? 0.5, reason: 'paper fixture',
  },
}]});

const quote = (now: Date, patch: Partial<MarketQuote> = {}): MarketQuote => ({
  venue: 'polymarket', marketId: 'm1', yesPrice: 0.7, bestBid: 0.68, bestAsk: 0.72,
  fetchedAt: now.toISOString(), ...patch,
});
const closeRequest = (key: string, patch: Record<string, unknown> = {}) => ({
  idempotencyKey: key, venue: 'polymarket', marketId: 'm1', side: 'yes', ...patch,
});
const resolutionRequest = (key: string, outcome = 'yes', patch: Record<string, unknown> = {}) => ({
  idempotencyKey: key, venue: 'polymarket', marketId: 'm1', outcome, ...patch,
});

const post = (origin: string, path: string, body: unknown) => fetch(`${origin}${path}`, {
  method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body),
});
const withApi = async (run: (context: {
  origin: () => string; restart: () => Promise<void>; databasePath: string; setTime: (value: string) => void;
}) => Promise<void>, runtimeOptions: Pick<ControlOptions, 'quoteSource'> = {}) => {
  const directory = mkdtempSync(join(tmpdir(), 'position-api-'));
  let now = new Date(INITIAL_TIME);
  const options = {...runtimeOptions, databasePath: join(directory, 'agent.sqlite'), auditFile: join(directory, 'audit.jsonl'), now: () => now};
  let server = start(0, options);
  try {
    await run({
      databasePath: options.databasePath, origin: () => `http://127.0.0.1:${server.port}`,
      setTime: (value) => { now = new Date(value); },
      restart: async () => { await server.stop(true); server = start(0, options); },
    });
  } finally {
    await server.stop(true);
    rmSync(directory, {recursive: true, force: true});
  }
};
const apiPortfolio = async (origin: string): Promise<PaperPortfolio> => {
  const response = await fetch(`${origin}/agent/state`);
  expect(response.status).toBe(200);
  return (await response.json() as {portfolio: PaperPortfolio}).portfolio;
};
const apiBuy = (origin: string, key = 'buy') => post(origin, '/orders', {
  cycleId: `cycle-${key}`, orders: [{idempotencyKey: key, intent: {
    venue: 'polymarket', marketId: 'm1', side: 'yes', size: 20, limit: 0.5, reason: 'fixture',
  }}],
});

describe('paper valuation and closing', () => {
  test('values YES and NO using complementary prices without mixing venue IDs', async () => {
    await withBook(({runtime, now}) => {
      buy(runtime, 'poly-yes');
      buy(runtime, 'poly-no', {side: 'no', size: 10, price: 0.4});
      buy(runtime, 'kalshi-yes', {venue: 'kalshi'});
      const book = runtime.updateQuotes({quotes: [quote(now()), quote(now(), {venue: 'kalshi', yesPrice: 0.2, bestBid: 0.19, bestAsk: 0.21})]});
      expect(book.cash).toBe(976);
      expect(book.equity).toBe(997);
      expect(book.dailyPnl).toBe(-3);
      expect(book.realizedPnl).toBe(0);
      expect(book.unrealizedPnl).toBeCloseTo(-3);
      expect(book.positions.map((p) => p.markPrice)).toEqual([0.7, 1 - 0.7, 0.2]);
      expect(book.positions.every((p) => p.markStatus === 'current')).toBe(true);
    });
  });

  test('partially closes FIFO lots at the bid and keeps realized and unrealized P&L separate', async () => {
    await withBook(({runtime, now}) => {
      buy(runtime, 'lot-0', {size: 10, price: 0.4});
      buy(runtime, 'lot-1', {size: 10, price: 0.6});
      runtime.updateQuotes({quotes: [quote(now(), {yesPrice: 0.8, bestBid: 0.75, bestAsk: 0.85})]});
      const closed = runtime.closePosition(closeRequest('close-12', {size: 12, minPrice: 0.75}));
      expect(closed).toMatchObject({mode: 'paper', size: 12, price: 0.75, proceeds: 9});
      expect(closed.costBasis).toBeCloseTo(5.2);
      expect(closed.realizedPnl).toBeCloseTo(3.8);
      let p = runtime.state().portfolio;
      expect(p.positions).toHaveLength(1);
      expect(p.positions[0]).toMatchObject({size: 8, avgPrice: 0.6});
      expect(p.cash).toBe(999);
      expect(p.equity).toBeCloseTo(1005.4);
      expect(p.unrealizedPnl).toBeCloseTo(1.6);
      expect(p.realizedPnl).toBeCloseTo(3.8);
      runtime.closePosition(closeRequest('close-rest'));
      p = runtime.state().portfolio;
      expect(p.positions).toEqual([]);
      expect(p.cash).toBe(1005);
      expect(p.realizedPnl).toBeCloseTo(5);
      expect(p.unrealizedPnl).toBe(0);
      expect(p.dailyPnl).toBe(5);
    });
  });

  test('sells NO at one minus the YES ask and permits risk reduction under a kill switch', async () => {
    await withBook(({runtime, now}) => {
      buy(runtime, 'no', {side: 'no', size: 10, price: 0.4});
      runtime.updateQuotes({quotes: [quote(now())]});
      runtime.updatePolicy({kill_switch: true});
      expect(() => runtime.closePosition(closeRequest('close-no', {side: 'no', minPrice: 0.29}))).toThrow('below minPrice');
      const result = runtime.closePosition(closeRequest('close-no', {side: 'no', minPrice: 0.28}));
      expect(result.price).toBeCloseTo(0.28);
      expect(result.proceeds).toBeCloseTo(2.8);
      expect(result.realizedPnl).toBeCloseTo(-1.2);
      expect(runtime.state().portfolio.positions).toEqual([]);
      expect(runtime.state().portfolio.equity).toBeCloseTo(998.8);
    });
  });

  test('refuses missing or stale execution quotes without forgetting the last valuation', async () => {
    await withBook(({runtime, now, setTime}) => {
      buy(runtime, 'yes');
      expect(runtime.state().portfolio.positions[0].markStatus).toBe('entry');
      expect(() => runtime.closePosition(closeRequest('close'))).toThrow('fresh market quote');
      runtime.updateQuotes({quotes: [quote(now())]});
      setTime('2026-10-04T12:02:00.000Z');
      const p = runtime.state().portfolio;
      expect(p.equity).toBe(1004);
      expect(p.positions[0].markStatus).toBe('stale');
      expect(() => runtime.closePosition(closeRequest('close'))).toThrow('fresh market quote');
      runtime.updateQuotes({quotes: [quote(now())]});
      expect(runtime.closePosition(closeRequest('close')).mode).toBe('paper');
    });
  });

  test('handles zero-price exits and fractional lots without leaving a phantom position', async () => {
    await withBook(({runtime, now}) => {
      buy(runtime, 'fraction-0', {size: 0.1});
      buy(runtime, 'fraction-1', {size: 0.2});
      runtime.updateQuotes({quotes: [quote(now(), {yesPrice: 0, bestBid: 0, bestAsk: 0})]});
      const result = runtime.closePosition(closeRequest('fraction-close', {size: 0.3}));
      expect(result.proceeds).toBe(0);
      expect(result.realizedPnl).toBeCloseTo(-0.15);
      expect(runtime.state().portfolio.positions).toEqual([]);
    });
  });

  test('rejects bad, duplicate, future, and older quote batches atomically', async () => {
    await withBook(({runtime, now, setTime}) => {
      buy(runtime, 'yes');
      const initial = runtime.state().portfolio;
      for (const bad of [
        quote(now(), {yesPrice: 2}), quote(now(), {bestBid: 0.9, bestAsk: 0.1}),
        quote(now(), {fetchedAt: '2026-02-30T12:00:00.000Z'}), quote(now(), {fetchedAt: '2026-10-04T12:01:00.000Z'}),
      ]) {
        expect(() => runtime.updateQuotes({quotes: [quote(now(), {marketId: 'prefix'}), bad]})).toThrow();
        expect(runtime.state().portfolio).toEqual(initial);
      }
      expect(() => runtime.updateQuotes({quotes: [quote(now()), quote(now())]})).toThrow('duplicate');
      runtime.updateQuotes({quotes: [quote(now())]});
      setTime('2026-10-04T12:00:01.000Z');
      runtime.updateQuotes({quotes: [quote(now(), {yesPrice: 0.8})]});
      expect(() => runtime.updateQuotes({quotes: [quote(new Date(INITIAL_TIME))]})).toThrow('newer observation');
      expect(runtime.state().portfolio.positions[0].markPrice).toBe(0.8);
      expect(() => runtime.closePosition(closeRequest('oversell', {size: 21}))).toThrow('exceeds held size');
      expect(runtime.history()).toEqual([]);
    });
  });
});

describe('paper resolution and rollover', () => {
  test('settles both sides of a binary market and blocks later entries', async () => {
    await withBook(({runtime}) => {
      buy(runtime, 'yes', {size: 10, price: 0.4});
      buy(runtime, 'no', {side: 'no', size: 10, price: 0.6});
      buy(runtime, 'other-venue', {venue: 'kalshi', size: 10});
      runtime.updatePolicy({kill_switch: true});
      const result = runtime.resolveMarket(resolutionRequest('settle'));
      expect(result).toMatchObject({mode: 'paper', outcome: 'yes', proceeds: 10, realizedPnl: 0});
      expect(result.settlements).toMatchObject([{side: 'yes', price: 1, realizedPnl: 6}, {side: 'no', price: 0, realizedPnl: -6}]);
      expect(runtime.state().portfolio.positions).toHaveLength(1);
      expect(runtime.state().portfolio.positions[0].venue).toBe('kalshi');
      runtime.updatePolicy({kill_switch: false});
      expect(buy(runtime, 'reopen').fills[0]).toMatchObject({status: 'rejected', reason: 'market_resolved'});
      expect(() => runtime.resolveMarket(resolutionRequest('other-key', 'no'))).toThrow('already resolved');
      runtime.reset();
      expect(buy(runtime, 'reopen-after-reset').fills[0].reason).toBe('market_resolved');
      expect(runtime.resolveMarket(resolutionRequest('settle'))).toEqual(result);
      expect(runtime.state().portfolio.cash).toBe(1000);
    });
  });

  test('records losing settlements and returns entry cost for void paper markets', async () => {
    await withBook(({runtime}) => {
      buy(runtime, 'lose', {size: 10, price: 0.4});
      const lost = runtime.resolveMarket(resolutionRequest('lose-settle', 'no'));
      expect(lost.proceeds).toBe(0);
      expect(lost.realizedPnl).toBe(-4);
      buy(runtime, 'void', {marketId: 'void', size: 10, price: 0.3});
      const cancelled = runtime.resolveMarket(resolutionRequest('void-settle', 'void', {marketId: 'void'}));
      expect(cancelled.proceeds).toBe(3);
      expect(cancelled.realizedPnl).toBe(0);
      expect(runtime.state().portfolio.cash).toBe(996);
      expect(runtime.state().portfolio.realizedPnl).toBe(-4);
      expect(runtime.state().portfolio.positions).toEqual([]);
    });
  });

  test('rolls UTC days once, counts overnight marks today, and retains drawdown stops', async () => {
    await withBook(({runtime, now, setTime}) => {
      runtime.updatePolicy({max_bet: 1000});
      buy(runtime, 'large', {size: 1000});
      setTime('2026-10-04T23:59:00.000Z');
      runtime.updateQuotes({quotes: [quote(now(), {yesPrice: 0.9, bestBid: 0.9, bestAsk: 0.9})]});
      expect(runtime.state().portfolio.highWaterMark).toBe(1400);
      setTime('2026-10-04T23:59:01.000Z');
      runtime.updateQuotes({quotes: [quote(now(), {yesPrice: 0.3, bestBid: 0.3, bestAsk: 0.3})]});
      expect(runtime.state().portfolio.dailyPnl).toBe(-200);
      expect(buy(runtime, 'blocked-today').fills[0].status).toBe('rejected');
      setTime('2026-10-05T00:01:00.000Z');
      const rolled = runtime.state().portfolio;
      expect(rolled).toMatchObject({tradingDay: '2026-10-05', startOfDayEquity: 800, dailyPnl: 0, highWaterMark: 1400});
      expect(runtime.days()).toMatchObject([{tradingDay: '2026-10-04', pnl: -200, endEquity: 800}]);
      expect(buy(runtime, 'blocked-next-day').fills[0].reason).toContain('stop_loss_triggered');
      runtime.updateQuotes({quotes: [quote(now(), {yesPrice: 0.2, bestBid: 0.2, bestAsk: 0.2})]});
      expect(runtime.state().portfolio.dailyPnl).toBe(-100);
      runtime.closePosition(closeRequest('reduce-risk', {size: 500}));
      expect(runtime.state().portfolio.dailyRealizedPnl).toBe(-150);
      expect(runtime.days()).toHaveLength(1);
      setTime('2026-10-08T12:00:00.000Z');
      expect(runtime.state().portfolio.dailyRealizedPnl).toBe(0);
      expect(runtime.state().portfolio.realizedPnl).toBe(-150);
      expect(runtime.days().map((day) => day.tradingDay)).toEqual(['2026-10-04', '2026-10-05']);
    });
  });

  test('rejects a backwards clock without rewriting accounting history', async () => {
    await withBook(({runtime, setTime}) => {
      runtime.shock({pnl: -20});
      setTime('2026-10-03T23:59:00.000Z');
      expect(() => runtime.state()).toThrow('clock precedes');
      setTime(INITIAL_TIME);
      expect(runtime.state().portfolio.dailyPnl).toBe(-20);
      expect(runtime.days()).toEqual([]);
    });
  });

  test('records quote observation time even when no position uses that quote yet', async () => {
    await withBook(({runtime, now, setTime}) => {
      setTime('2026-10-04T12:01:00.000Z');
      runtime.updateQuotes({quotes: [quote(now())]});
      setTime(INITIAL_TIME);
      expect(() => buy(runtime, 'lookahead')).toThrow('clock precedes');
      setTime('2026-10-04T12:01:00.000Z');
      expect(runtime.state().portfolio.positions).toEqual([]);
      expect(buy(runtime, 'lookahead').fills[0].status).toBe('filled');
    });
  });
});

describe('durable position API', () => {
  test('replays close and resolution receipts after restart and rejects changed requests', async () => {
    await withApi(async ({origin, restart}) => {
      expect((await apiBuy(origin())).status).toBe(200);
      expect((await post(origin(), '/agent/marks', {quotes: [quote(new Date(INITIAL_TIME))]})).status).toBe(200);
      const request = closeRequest('close', {size: 5});
      const response = await post(origin(), '/positions/close', request);
      expect(response.status).toBe(200);
      const closed = await response.json();
      const before = await apiPortfolio(origin());
      await restart();
      expect(await apiPortfolio(origin())).toEqual(before);
      expect(await (await post(origin(), '/positions/close', request)).json()).toEqual(closed);
      expect((await post(origin(), '/positions/close', {...request, size: 6})).status).toBe(409);
      expect((await post(origin(), '/markets/resolve', resolutionRequest('close'))).status).toBe(409);
      const resolution = resolutionRequest('resolve');
      const settled = await post(origin(), '/markets/resolve', resolution);
      expect(settled.status).toBe(200);
      const receipt = await settled.json();
      const after = await apiPortfolio(origin());
      expect(after.positions).toEqual([]);
      expect(after.realizedPnl).toBeCloseTo(8.4);
      await restart();
      expect(await (await post(origin(), '/markets/resolve', resolution)).json()).toEqual(receipt);
      expect(await apiPortfolio(origin())).toEqual(after);
      const conflict = await post(origin(), '/markets/resolve', {...resolution, outcome: 'no'});
      expect(conflict.status).toBe(409);
      expect(await (await fetch(`${origin()}/positions/history`)).json()).toEqual([closed, receipt]);
    });
  });

  test('rolls back closes, resolutions, and rollover summaries on database failure', async () => {
    await withApi(async ({origin, databasePath, setTime}) => {
      await apiBuy(origin());
      await post(origin(), '/agent/marks', {quotes: [quote(new Date(INITIAL_TIME))]});
      const before = await apiPortfolio(origin());
      const db = new Database(databasePath);
      try {
        db.run(`CREATE TRIGGER fail_book BEFORE UPDATE ON agent_state
          BEGIN SELECT RAISE(ABORT, 'test lifecycle failure'); END`);
        for (const [path, request] of [
          ['/positions/close', closeRequest('close')], ['/markets/resolve', resolutionRequest('resolve')],
        ] as const) {
          const response = await post(origin(), path, request);
          expect(response.status).toBe(500);
          await response.text();
          expect(await apiPortfolio(origin())).toEqual(before);
        }
        const store = AgentStore.open(databasePath);
        try {
          expect(store.listPositionEvents()).toEqual([]);
          expect(store.getMarketResolution('polymarket', 'm1')).toBeUndefined();
          setTime('2026-10-05T12:00:00.000Z');
          const failedRollover = await fetch(`${origin()}/agent/state`);
          expect(failedRollover.status).toBe(500);
          await failedRollover.text();
          expect(store.listDailySummaries()).toEqual([]);
          expect(store.getAgentState()!.accounting.tradingDay).toBe('2026-10-04');
        } finally {
          store.close();
        }
        db.run('DROP TRIGGER fail_book');
        expect((await apiPortfolio(origin())).dailyPnl).toBe(0);
        expect(await (await fetch(`${origin()}/agent/days`)).json()).toHaveLength(1);
        expect((await post(origin(), '/markets/resolve', resolutionRequest('resolve'))).status).toBe(200);
        expect((await apiPortfolio(origin())).positions).toEqual([]);
      } finally {
        db.close();
      }
    });
  });

  test('competing resolution requests credit a payout only once', async () => {
    await withApi(async ({origin}) => {
      await apiBuy(origin());
      const requests = await Promise.all([
        post(origin(), '/markets/resolve', resolutionRequest('resolve-0')),
        post(origin(), '/markets/resolve', resolutionRequest('resolve-1')),
      ]);
      expect(requests.map((response) => response.status).sort()).toEqual([200, 409]);
      await Promise.all(requests.map((response) => response.text()));
      expect((await apiPortfolio(origin())).cash).toBe(1010);
      expect(await (await fetch(`${origin()}/positions/history`)).json()).toHaveLength(1);
    });
  });

  test('competing closes cannot sell more shares than the book holds', async () => {
    await withApi(async ({origin}) => {
      await apiBuy(origin());
      await post(origin(), '/agent/marks', {quotes: [quote(new Date(INITIAL_TIME))]});
      const responses = await Promise.all([
        post(origin(), '/positions/close', closeRequest('close-0', {size: 15})),
        post(origin(), '/positions/close', closeRequest('close-1', {size: 15})),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      await Promise.all(responses.map((response) => response.text()));
      const p = await apiPortfolio(origin());
      expect(p.positions).toHaveLength(1);
      expect(p.positions[0].size).toBe(5);
      expect(p.cash).toBeCloseTo(1000.2);
      expect(await (await fetch(`${origin()}/positions/history`)).json()).toHaveLength(1);
    });
  });
});

describe('existing data integration', () => {
  test('requires observed bid and ask prices before a saved snapshot can execute a close', () => {
    const directory = mkdtempSync(join(tmpdir(), 'paper-missing-quotes-'));
    const now = new Date(INITIAL_TIME);
    const source = createSavedQuoteSource(directory);
    const runtime = createAgentRuntime({databasePath: ':memory:', now: () => now, quoteSource: source});
    const market = {id: 'm1', question: 'Paper fixture', outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]'};
    const file = join(directory, 'polymarket.latest.json');
    try {
      buy(runtime, 'no', {side: 'no'});
      for (const missingPrices of [{}, {bestBid: 0}, {bestAsk: 0.52}]) {
        writeFileSync(file, JSON.stringify([{...market, ...missingPrices}]));
        utimesSync(file, now, now);
        expect(source()).toEqual([]);
        expect(() => runtime.closePosition(closeRequest('unquoted-close', {side: 'no'}))).toThrow('fresh market quote');
        expect(runtime.state().portfolio.cash).toBe(990);
        expect(runtime.history()).toEqual([]);
      }
      // An observed zero bid is a valid paper sell price.
      writeFileSync(file, JSON.stringify([{...market, bestBid: 0, bestAsk: 0.52}]));
      utimesSync(file, now, now);
      expect(source()).toHaveLength(1);
      buy(runtime, 'yes');
      expect(runtime.closePosition(closeRequest('zero-price-close')).proceeds).toBe(0);
      expect(runtime.closePosition(closeRequest('quoted-no-close', {side: 'no'})).price).toBe(0.48);
    } finally {
      runtime.close();
      rmSync(directory, {recursive: true, force: true});
    }
  });

  test('does not turn absent or blank Kalshi bid prices into execution quotes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'paper-kalshi-quotes-'));
    const source = createSavedQuoteSource(directory);
    const file = join(directory, 'kalshi.latest.json');
    const market = {ticker: 'm1', title: 'Paper fixture', market_type: 'binary', status: 'active', yes_ask_dollars: '0.52'};
    try {
      for (const bid of [undefined, '', ' ', 'invalid']) {
        writeFileSync(file, JSON.stringify({events: [{event_ticker: 'e1', category: 'Economics', title: 'Fixture',
          markets: [{...market, yes_bid_dollars: bid}],
        }]}));
        expect(source()).toEqual([]);
      }
      writeFileSync(file, JSON.stringify({events: [{event_ticker: 'e1', category: 'Economics', title: 'Fixture',
        markets: [{...market, yes_bid_dollars: '0.00'}],
      }]}));
      expect(source()).toMatchObject([{venue: 'kalshi', marketId: 'm1', bestBid: 0, bestAsk: 0.52}]);
    } finally {
      rmSync(directory, {recursive: true, force: true});
    }
  });

  test('keeps book access and healthy venue quotes available while a saved snapshot is unreadable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'paper-source-recovery-'));
    const source = createSavedQuoteSource(directory);
    const file = join(directory, 'polymarket.latest.json');
    const market = {id: 'm1', question: 'Fixture', outcomes: '["Yes","No"]', outcomePrices: '["0.7","0.3"]', bestBid: 0.68, bestAsk: 0.72};
    try {
      writeFileSync(file, JSON.stringify([market]));
      utimesSync(file, new Date(INITIAL_TIME), new Date(INITIAL_TIME));
      const kalshiFile = join(directory, 'kalshi.latest.json');
      writeFileSync(kalshiFile, JSON.stringify(kalshiFixture));
      utimesSync(kalshiFile, new Date(INITIAL_TIME), new Date(INITIAL_TIME));
      await withApi(async ({origin, restart, setTime}) => {
        expect((await apiBuy(origin())).status).toBe(200);
        const before = await apiPortfolio(origin());
        writeFileSync(file, '{"interrupted":');
        expect(source().every((quote) => quote.venue === 'kalshi')).toBe(true);
        expect(source().length).toBeGreaterThan(0);
        const degraded = await (await fetch(`${origin()}/agent/state`)).json();
        expect(degraded.portfolio).toEqual(before);
        expect(degraded.quoteSource.status).toBe('error');
        expect(degraded.quoteSource.errors[0]).toContain('polymarket:');
        expect((await post(origin(), '/agent/policy', {kill_switch: true})).status).toBe(200);
        await restart();
        expect((await (await fetch(`${origin()}/agent/state`)).json()).policy.kill_switch).toBe(true);
        expect(await apiPortfolio(origin())).toEqual(before);
        const updatedTime = '2026-10-04T12:00:01.000Z';
        setTime(updatedTime);
        expect((await post(origin(), '/agent/marks', {quotes: [quote(new Date(updatedTime))]})).status).toBe(200);
        expect((await post(origin(), '/positions/close', closeRequest('close', {size: 5}))).status).toBe(200);
        expect((await post(origin(), '/markets/resolve', resolutionRequest('resolve'))).status).toBe(200);
        expect((await apiPortfolio(origin())).cash).toBeCloseTo(1008.4);
        writeFileSync(file, JSON.stringify([market]));
        utimesSync(file, new Date(updatedTime), new Date(updatedTime));
        expect((await (await fetch(`${origin()}/agent/state`)).json()).quoteSource).toEqual({status: 'ok', errors: []});
      }, {quoteSource: source});
    } finally {
      rmSync(directory, {recursive: true, force: true});
    }
  });

  test('retains stale marks through a throwing source and still permits policy and settlement', async () => {
    let unavailable = false;
    await withApi(async ({origin, setTime}) => {
      await apiBuy(origin());
      unavailable = true;
      setTime('2026-10-04T12:02:00.000Z');
      const state = await (await fetch(`${origin()}/agent/state`)).json();
      expect(state.quoteSource).toEqual({status: 'error', errors: ['feed unavailable']});
      expect(state.portfolio.positions[0].markStatus).toBe('stale');
      expect(state.portfolio.equity).toBe(1004);
      expect((await post(origin(), '/positions/close', closeRequest('stale-close'))).status).toBe(409);
      expect((await post(origin(), '/agent/policy', {kill_switch: true})).status).toBe(200);
      expect((await post(origin(), '/markets/resolve', resolutionRequest('settle'))).status).toBe(200);
      expect((await apiPortfolio(origin())).cash).toBe(1010);
    }, {quoteSource: () => {
      if (unavailable) throw new Error('feed unavailable');
      return [quote(new Date(INITIAL_TIME))];
    }});
  });

  test('ignores malformed source quotes without weakening explicit quote validation', async () => {
    await withApi(async ({origin}) => {
      const state = await (await fetch(`${origin()}/agent/state`)).json();
      expect(state.quoteSource.status).toBe('error');
      expect(state.quoteSource.errors).toHaveLength(2);
      expect((await post(origin(), '/agent/policy', {kill_switch: true})).status).toBe(200);
      expect((await post(origin(), '/agent/marks', {quotes: [quote(new Date(INITIAL_TIME), {yesPrice: 2})]})).status).toBe(400);
      expect((await post(origin(), '/markets/resolve', resolutionRequest('settle'))).status).toBe(200);
    }, {quoteSource: () => [quote(new Date(INITIAL_TIME), {yesPrice: 2}), quote(new Date(INITIAL_TIME)), quote(new Date(INITIAL_TIME))]});
  });

  test('reads saved venue snapshots for valuation without a network client', () => {
    const directory = mkdtempSync(join(tmpdir(), 'paper-source-'));
    const now = new Date(INITIAL_TIME);
    const source = createSavedQuoteSource(directory);
    const runtime = createAgentRuntime({databasePath: ':memory:', now: () => now, quoteSource: source});
    try {
      expect(source()).toEqual([]);
      buy(runtime, 'poly', {marketId: '5126779'});
      buy(runtime, 'kalshi', {venue: 'kalshi', marketId: 'KXFED-26OCT-T2.75'});
      for (const [name, data] of [['polymarket', polymarketFixture], ['kalshi', kalshiFixture]] as const) {
        const path = join(directory, `${name}.latest.json`);
        writeFileSync(path, JSON.stringify(data));
        utimesSync(path, now, now);
      }
      const p = runtime.state().portfolio;
      expect(p.positions.map((position) => position.markPrice)).toEqual([0.145, 0.99]);
      expect(p.equity).toBeCloseTo(1002.7);
      expect(p.positions.every((position) => position.markStatus === 'current')).toBe(true);
    } finally {
      runtime.close();
      rmSync(directory, {recursive: true, force: true});
    }
  });

  test('migration preserves an existing book, order key, and P&L shock', () => {
    const directory = mkdtempSync(join(tmpdir(), 'paper-upgrade-'));
    const path = join(directory, 'agent.sqlite');
    const db = new Database(path);
    try {
      db.run('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
      for (const [index, name] of ['001_initial.sql', '002_payment_lifecycle.sql', '003_agent_state.sql'].entries()) {
        db.run(readFileSync(new URL(`../packages/db/migrations/${name}`, import.meta.url), 'utf8'));
        db.run('INSERT INTO schema_migrations VALUES (?, ?, ?)', [index + 1, name, INITIAL_TIME]);
      }
      db.run(`INSERT INTO policy VALUES (1, 25, 100, '[]', '["politics"]', '["polymarket"]', 0.2, 0, ?)` , [INITIAL_TIME]);
      const positions = JSON.stringify([{venue: 'polymarket', marketId: 'm1', side: 'yes', size: 20, avgPrice: 0.5}]);
      db.run(`INSERT INTO agent_state VALUES (1, 1, 990, 950, 1000, 1000, -50, ?, ?)`, [positions, INITIAL_TIME]);
      db.run(`INSERT INTO runs VALUES ('old-cycle', 1, ?, ?, 'completed', 'paper', 990, 950, 1000, 1000, -50, ?)`,
        [INITIAL_TIME, INITIAL_TIME, positions]);
      db.run(`INSERT INTO orders VALUES ('old-key', 'old-cycle', 'polymarket', 'm1', 'yes', 20, 0.5, 0.5, 'filled', 'paper', 'old fill', ?)`, [INITIAL_TIME]);
    } finally {
      db.close();
    }
    const runtime = createAgentRuntime({databasePath: path, now: () => new Date(INITIAL_TIME)});
    try {
      const p = runtime.state().portfolio;
      expect(p).toMatchObject({cash: 990, equity: 950, dailyPnl: -50, pnlAdjustment: -50, realizedPnl: 0});
      expect(p.positions).toHaveLength(1);
      expect(buy(runtime, 'old-key').fills[0].reason).toBe('old fill');
      expect(runtime.state().portfolio).toEqual(p);
    } finally {
      runtime.close();
      rmSync(directory, {recursive: true, force: true});
    }
  });
});
