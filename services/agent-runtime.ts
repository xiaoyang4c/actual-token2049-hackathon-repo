// Local paper execution. SQLite is the source of policy, book, and order state.
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {
  checkHalt, closeLots, markPositions, marketKey, settleLots,
  type Intent, type MarketQuote, type PaperAccounting, type PaperPortfolio,
  type Policy, type Portfolio, type ResolutionOutcome, type Settlement, type Side, type Venue,
} from '../packages/core/src';
import {AgentStore, type AgentStateRecord, type OrderRecord} from '../packages/db/src';
import type {MarketQuoteSource} from './paper-market-source';

const STARTING_CASH = 1000;
const DEFAULT_POLICY: Policy = {
  max_bet: 25,
  max_daily_loss: 100,
  category_allow: [],
  category_deny: ['politics'],
  venues_enabled: ['polymarket', 'kalshi'],
  stop_loss_pct: 0.2,
  kill_switch: false,
};
const POLICY_FIELDS = Object.keys(DEFAULT_POLICY);

export interface AgentRuntimeOptions {
  databasePath?: string;
  store?: AgentStore;
  now?: () => Date;
  quoteSource?: MarketQuoteSource;
  maxQuoteAgeMs?: number;
}

export interface QuoteSourceHealth {
  status: 'disabled'|'ok'|'error';
  errors: string[];
}

export interface CloseReceipt {
  idempotencyKey: string;
  kind: 'close';
  mode: 'paper';
  venue: Venue;
  marketId: string;
  side: Side;
  size: number;
  price: number;
  minPrice: number;
  proceeds: number;
  costBasis: number;
  realizedPnl: number;
  createdAt: string;
}

export interface ResolutionReceipt {
  idempotencyKey: string;
  kind: 'resolve';
  mode: 'paper';
  venue: Venue;
  marketId: string;
  outcome: ResolutionOutcome;
  settlements: Settlement[];
  proceeds: number;
  realizedPnl: number;
  createdAt: string;
}

export type Fill = Pick<OrderRecord,
  'idempotencyKey'|'status'|'mode'|'venue'|'marketId'|'side'|'size'|'price'|'reason'> & {limit: number};

export class AgentRequestError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export function createAgentRuntime(options: AgentRuntimeOptions = {}): AgentRuntime {
  const databasePath = options.databasePath ?? process.env.CONTROL_DB_PATH ??
    fileURLToPath(new URL('./.data/agent.sqlite', import.meta.url));
  if (!options.store && databasePath !== ':memory:') mkdirSync(dirname(databasePath), {recursive: true});
  const store = options.store ?? AgentStore.open(databasePath);
  try {
    return new AgentRuntime(store, !options.store, options);
  } catch (error) {
    if (!options.store) store.close();
    throw error;
  }
}

export class AgentRuntime {
  private readonly clock: () => Date;
  private readonly maxQuoteAgeMs: number;
  private readonly quoteSource?: MarketQuoteSource;
  private quoteSourceErrors: string[] = [];

  constructor(private readonly store: AgentStore, private readonly ownsStore = false, options: AgentRuntimeOptions = {}) {
    this.clock = options.now ?? (() => new Date());
    this.maxQuoteAgeMs = options.maxQuoteAgeMs ?? 90_000;
    if (!Number.isSafeInteger(this.maxQuoteAgeMs) || this.maxQuoteAgeMs <= 0) throw new Error('invalid quote age limit');
    this.quoteSource = options.quoteSource;
    store.transaction(() => {
      const existing = store.getAgentState();
      if (existing) {
        // A bad stored book must fail startup rather than reset the account.
        this.policy(existing);
        return;
      }
      const now = this.instant().toISOString();
      const policy = store.insertPolicy({policy: DEFAULT_POLICY, createdAt: now});
      store.saveAgentState({
        policyId: policy.id, portfolio: initialPortfolio(), updatedAt: now,
        accounting: initialAccounting(now.slice(0, 10)),
      });
    });
  }

  close(): void {
    if (this.ownsStore) this.store.close();
  }

  state(): {policy: Policy; portfolio: PaperPortfolio; quoteSource: QuoteSourceHealth} {
    return this.withBook((current, now) => {
      const status: QuoteSourceHealth['status'] = !this.quoteSource ? 'disabled' : this.quoteSourceErrors.length ? 'error' : 'ok';
      return {
        policy: this.policy(current), portfolio: this.present(current, now),
        quoteSource: {status, errors: [...this.quoteSourceErrors]},
      };
    });
  }

  updatePolicy(value: unknown): Policy {
    const patch = object(value, 'policy');
    if (Object.keys(patch).some((key) => !POLICY_FIELDS.includes(key))) {
      throw new AgentRequestError('unknown policy field');
    }
    return this.withBook((current, now) => {
      const policy = parsePolicy({...this.policy(current), ...patch});
      const saved = this.store.insertPolicy({policy, createdAt: now.toISOString()});
      current.policyId = saved.id;
      return saved.policy;
    });
  }

  shock(value: unknown): PaperPortfolio {
    const pnl = finite(object(value, 'shock').pnl, 'pnl');
    return this.withBook((current, now) => {
      current.accounting.pnlAdjustment = finite(current.accounting.pnlAdjustment + pnl, 'pnl adjustment');
      this.revalue(current, now);
      return this.present(current, now);
    });
  }

  reset(): PaperPortfolio {
    return this.withBook((current, now) => {
      // Keep policy and order keys, so old requests cannot refill after reset.
      current.portfolio = initialPortfolio();
      current.accounting = initialAccounting(now.toISOString().slice(0, 10));
      return this.present(current, now);
    });
  }

  submitOrders(value: unknown): {cycleId: string; fills: Fill[]} {
    const body = object(value, 'orders request');
    const cycleId = text(body.cycleId, 'cycleId');
    if (!Array.isArray(body.orders)) throw new AgentRequestError('orders must be a list');
    const orders = body.orders.map((value) => {
      const order = object(value, 'order');
      return {idempotencyKey: text(order.idempotencyKey, 'idempotencyKey'), intent: parseIntent(order.intent)};
    });
    return this.withBook((current, instant) => {
      const policy = this.policy(current);
      const now = instant.toISOString();
      let changed = false;
      const fills = orders.map(({idempotencyKey, intent}) => {
        const existing = this.store.getOrder(idempotencyKey);
        if (existing) return fillOf(existing);

        if (!this.store.getRun(cycleId)) {
          this.store.insertRun({
            id: cycleId, policyId: current.policyId, startedAt: now,
            status: 'running', summary: '', ...current.portfolio,
          });
        }
        const p = current.portfolio;
        const cost = intent.size * intent.limit;
        const halt = checkHalt(policy, p);
        const resolved = this.store.getMarketResolution(intent.venue, intent.marketId);
        const reason = resolved ? 'market_resolved' : halt.halted ? halt.reasons.join('; ') : cost > p.cash ? 'insufficient_cash' : intent.reason;
        const status = resolved || halt.halted || cost > p.cash ? 'rejected' : 'filled';
        const stored = this.store.insertOrder({
          idempotencyKey, cycleId, ...intent, limitPrice: intent.limit, price: intent.limit,
          mode: 'paper', status, reason, createdAt: now,
        });
        if (stored.status === 'filled') {
          p.cash -= cost;
          p.positions.push({
            venue: intent.venue, marketId: intent.marketId, side: intent.side,
            size: intent.size, avgPrice: intent.limit,
          });
          this.revalue(current, instant);
        }
        changed = true;
        return fillOf(stored);
      });
      if (changed) {
        this.store.finishPaperRun(cycleId, current.portfolio, now);
      }
      return {cycleId, fills};
    });
  }

  updateQuotes(value: unknown): PaperPortfolio {
    const body = object(value, 'quote request');
    if (!Array.isArray(body.quotes)) throw new AgentRequestError('quotes must be a list');
    const quotes = body.quotes;
    return this.withBook((current, now) => {
      if (this.applyQuotes(quotes, now, false)) current.updatedAt = now.toISOString();
      this.revalue(current, now);
      return this.present(current, now);
    });
  }

  closePosition(value: unknown): CloseReceipt {
    const body = object(value, 'close request');
    const request = {
      idempotencyKey: text(body.idempotencyKey, 'idempotencyKey'),
      venue: venue(body.venue), marketId: text(body.marketId, 'marketId'), side: side(body.side),
      size: body.size === undefined ? null : finite(body.size, 'size'),
      minPrice: body.minPrice === undefined ? 0 : probability(body.minPrice, 'minPrice'),
    };
    if (request.size !== null && request.size <= 0) throw new AgentRequestError('size must be positive');
    return this.withBook((current, now) => {
      const replay = this.replay<CloseReceipt>(request.idempotencyKey, 'close', request);
      if (replay) return replay;
      const held = current.portfolio.positions.filter((p) =>
        p.venue === request.venue && p.marketId === request.marketId && p.side === request.side,
      ).reduce((sum, p) => sum + p.size, 0);
      let size = request.size ?? held;
      const tolerance = Number.EPSILON * Math.max(1, held) * 8;
      if (held <= 0 || size > held + tolerance) throw new AgentRequestError('close exceeds held size', 409);
      if (Math.abs(size - held) <= tolerance) size = held;
      const quote = this.store.getMarketQuote(request.venue, request.marketId);
      const age = quote ? now.getTime() - Date.parse(quote.fetchedAt) : NaN;
      if (!quote || !Number.isFinite(age) || age < 0 || age > this.maxQuoteAgeMs) {
        throw new AgentRequestError('a fresh market quote is required to close', 409);
      }
      const price = request.side === 'yes' ? quote.bestBid : 1 - quote.bestAsk;
      if (price < request.minPrice) throw new AgentRequestError('sell price is below minPrice', 409);
      const closed = closeLots(current.portfolio.positions, request.venue, request.marketId, request.side, size);
      const proceeds = finite(size * price, 'proceeds');
      const realizedPnl = finite(proceeds - closed.costBasis, 'realizedPnl');
      const result: CloseReceipt = {
        ...request, size, kind: 'close', mode: 'paper', price, proceeds,
        costBasis: closed.costBasis, realizedPnl, createdAt: now.toISOString(),
      };
      current.portfolio.positions = closed.positions;
      this.credit(current, proceeds, realizedPnl);
      this.recordEvent(request, result);
      return result;
    });
  }

  resolveMarket(value: unknown): ResolutionReceipt {
    const body = object(value, 'resolution request');
    const request = {
      idempotencyKey: text(body.idempotencyKey, 'idempotencyKey'),
      venue: venue(body.venue), marketId: text(body.marketId, 'marketId'), outcome: outcome(body.outcome),
    };
    return this.withBook((current, now) => {
      const replay = this.replay<ResolutionReceipt>(request.idempotencyKey, 'resolve', request);
      if (replay) return replay;
      if (this.store.getMarketResolution(request.venue, request.marketId)) {
        throw new AgentRequestError('market is already resolved', 409);
      }
      const settled = settleLots(current.portfolio.positions, request.venue, request.marketId, request.outcome);
      const proceeds = finite(settled.settlements.reduce((sum, p) => sum + p.proceeds, 0), 'proceeds');
      const realizedPnl = finite(settled.settlements.reduce((sum, p) => sum + p.realizedPnl, 0), 'realizedPnl');
      const result: ResolutionReceipt = {
        ...request, kind: 'resolve', mode: 'paper', settlements: settled.settlements,
        proceeds, realizedPnl, createdAt: now.toISOString(),
      };
      current.portfolio.positions = settled.positions;
      this.credit(current, proceeds, realizedPnl);
      this.recordEvent(request, result);
      this.store.insertMarketResolution({
        ...request, resolvedAt: now.toISOString(), eventKey: request.idempotencyKey,
      });
      current.updatedAt = now.toISOString();
      return result;
    });
  }

  history(): unknown[] {
    return this.store.listPositionEvents().map((event) => JSON.parse(event.resultJson));
  }

  days() {
    return this.withBook(() => this.store.listDailySummaries());
  }

  private withBook<T>(work: (current: AgentStateRecord, now: Date) => T): T {
    const now = this.instant();
    const supplied = this.readQuotes();
    return this.store.transaction(() => {
      const current = this.current();
      const before = JSON.stringify(current);
      const day = now.toISOString().slice(0, 10);
      if (day < current.accounting.tradingDay || now.getTime() < Date.parse(current.updatedAt)) {
        throw new AgentRequestError('clock precedes the stored book', 503);
      }
      if (day > current.accounting.tradingDay) {
        // Use the last observed equity before applying the new day's quotes.
        const p = current.portfolio;
        this.store.insertDailySummary({
          tradingDay: current.accounting.tradingDay, startEquity: p.startOfDayEquity,
          endEquity: p.equity, pnl: p.dailyPnl,
          realizedPnl: current.accounting.dailyRealizedPnl, recordedAt: now.toISOString(),
        });
        p.startOfDayEquity = p.equity;
        current.accounting.tradingDay = day;
        current.accounting.dailyRealizedPnl = 0;
      }
      if (this.applyQuotes(supplied, now, true)) current.updatedAt = now.toISOString();
      this.revalue(current, now);
      const result = work(current, now);
      this.revalue(current, now);
      if (JSON.stringify(current) !== before) this.store.saveAgentState({...current, updatedAt: now.toISOString()});
      return result;
    });
  }

  private readQuotes(): MarketQuote[] {
    this.quoteSourceErrors = [];
    try {
      const quotes = this.quoteSource?.() ?? [];
      this.quoteSourceErrors = this.quoteSource?.errors?.() ?? [];
      return quotes;
    } catch (error) {
      this.quoteSourceErrors.push(error instanceof Error ? error.message : String(error));
      return [];
    }
  }

  private applyQuotes(values: unknown[], now: Date, fromSource: boolean): boolean {
    const seen = new Set<string>();
    let changed = false;
    for (const value of values) {
      let quote: MarketQuote;
      try {
        quote = parseQuote(value);
      } catch (error) {
        if (!fromSource || !(error instanceof AgentRequestError)) throw error;
        this.quoteSourceErrors.push(error.message);
        continue;
      }
      const key = marketKey(quote.venue, quote.marketId);
      if (seen.has(key)) {
        if (!fromSource) throw new AgentRequestError('duplicate market quote');
        this.quoteSourceErrors.push('duplicate market quote');
        continue;
      }
      seen.add(key);
      const age = now.getTime() - Date.parse(quote.fetchedAt);
      if (age < 0 || age > this.maxQuoteAgeMs) {
        if (fromSource) continue;
        throw new AgentRequestError('quote must be recent and cannot be in the future');
      }
      if (this.store.getMarketResolution(quote.venue, quote.marketId)) {
        if (fromSource) continue;
        throw new AgentRequestError('market is already resolved', 409);
      }
      const saved = this.store.getMarketQuote(quote.venue, quote.marketId);
      if (saved && Date.parse(saved.fetchedAt) >= Date.parse(quote.fetchedAt)) {
        if (fromSource || JSON.stringify(saved) === JSON.stringify(quote)) continue;
        throw new AgentRequestError('quote cannot replace an equal or newer observation', 409);
      }
      this.store.saveMarketQuote(quote);
      changed = true;
    }
    return changed;
  }

  private revalue(current: AgentStateRecord, now: Date): void {
    const marked = markPositions(current.portfolio.positions, this.store.listMarketQuotes(), now.getTime(), this.maxQuoteAgeMs);
    const p = current.portfolio;
    p.equity = finite(p.cash + marked.reduce((sum, position) => sum + position.marketValue, 0) + current.accounting.pnlAdjustment, 'equity');
    p.dailyPnl = finite(p.equity - p.startOfDayEquity, 'dailyPnl');
    p.highWaterMark = Math.max(p.highWaterMark, p.equity);
  }

  private present(current: AgentStateRecord, now: Date): PaperPortfolio {
    const positions = markPositions(current.portfolio.positions, this.store.listMarketQuotes(), now.getTime(), this.maxQuoteAgeMs);
    return {
      ...current.portfolio, ...current.accounting, positions,
      unrealizedPnl: positions.reduce((sum, p) => sum + p.unrealizedPnl, 0),
    };
  }

  private credit(current: AgentStateRecord, proceeds: number, realizedPnl: number): void {
    current.portfolio.cash = finite(current.portfolio.cash + proceeds, 'cash');
    current.accounting.realizedPnl = finite(current.accounting.realizedPnl + realizedPnl, 'realizedPnl');
    current.accounting.dailyRealizedPnl = finite(current.accounting.dailyRealizedPnl + realizedPnl, 'dailyRealizedPnl');
  }

  private replay<T>(key: string, kind: 'close'|'resolve', request: unknown): T|undefined {
    const event = this.store.getPositionEvent(key);
    if (!event) return undefined;
    if (event.kind !== kind || event.requestHash !== requestHash(request)) {
      throw new AgentRequestError('idempotency key belongs to a different position request', 409);
    }
    return JSON.parse(event.resultJson) as T;
  }

  private recordEvent(request: unknown, result: CloseReceipt|ResolutionReceipt): void {
    this.store.insertPositionEvent({
      idempotencyKey: result.idempotencyKey, kind: result.kind, requestHash: requestHash(request),
      resultJson: JSON.stringify(result), createdAt: result.createdAt,
    });
  }

  private instant(): Date {
    const now = this.clock();
    if (!Number.isFinite(now.getTime())) throw new Error('invalid clock');
    return now;
  }

  private policy(current: AgentStateRecord): Policy {
    const saved = this.store.getPolicy(current.policyId);
    if (!saved) throw new Error('stored policy is missing');
    return parsePolicy(saved.policy);
  }

  private current(): AgentStateRecord {
    const state = this.store.getAgentState();
    if (!state) throw new Error('stored agent state is missing');
    return state;
  }
}

function initialAccounting(tradingDay: string): PaperAccounting {
  return {tradingDay, realizedPnl: 0, dailyRealizedPnl: 0, pnlAdjustment: 0};
}

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function parseQuote(value: unknown): MarketQuote {
  const q = object(value, 'quote');
  const yesPrice = probability(q.yesPrice, 'yesPrice');
  const bestBid = probability(q.bestBid, 'bestBid');
  const bestAsk = probability(q.bestAsk, 'bestAsk');
  if (bestBid > bestAsk) throw new AgentRequestError('bid must not exceed ask');
  const timestamp = text(q.fetchedAt, 'fetchedAt');
  const parsed = Date.parse(timestamp);
  const canonical = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(timestamp)
    ? timestamp.slice(0, -1) + '.000Z' : timestamp;
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== canonical) {
    throw new AgentRequestError('fetchedAt must be an ISO UTC timestamp');
  }
  return {
    venue: venue(q.venue), marketId: text(q.marketId, 'marketId'),
    yesPrice, bestBid, bestAsk, fetchedAt: new Date(parsed).toISOString(),
  };
}

function probability(value: unknown, label: string): number {
  const number = finite(value, label);
  if (number < 0 || number > 1) throw new AgentRequestError(`${label} must be between zero and one`);
  return number;
}

function side(value: unknown): Side {
  if (value !== 'yes' && value !== 'no') throw new AgentRequestError('unsupported side');
  return value;
}

function outcome(value: unknown): ResolutionOutcome {
  if (value === 'void') return value;
  return side(value);
}

function initialPortfolio(): Portfolio {
  return {
    cash: STARTING_CASH, equity: STARTING_CASH, startOfDayEquity: STARTING_CASH,
    highWaterMark: STARTING_CASH, dailyPnl: 0, positions: [],
  };
}

function fillOf(order: OrderRecord): Fill {
  const {idempotencyKey, status, mode, venue, marketId, side, size, price, reason} = order;
  return {idempotencyKey, status, mode, venue, marketId, side, size, limit: order.limitPrice, price, reason};
}

function parsePolicy(value: unknown): Policy {
  const p = object(value, 'policy');
  const maxBet = finite(p.max_bet, 'max_bet');
  const maxDailyLoss = finite(p.max_daily_loss, 'max_daily_loss');
  const stopLossPct = finite(p.stop_loss_pct, 'stop_loss_pct');
  if (maxBet < 0 || maxDailyLoss < 0 || stopLossPct < 0 || stopLossPct > 1) {
    throw new AgentRequestError('policy limits are out of range');
  }
  if (typeof p.kill_switch !== 'boolean') throw new AgentRequestError('kill_switch must be boolean');
  const venues = strings(p.venues_enabled, 'venues_enabled').map(venue);
  return {
    max_bet: maxBet, max_daily_loss: maxDailyLoss, stop_loss_pct: stopLossPct,
    category_allow: strings(p.category_allow, 'category_allow'),
    category_deny: strings(p.category_deny, 'category_deny'),
    venues_enabled: venues, kill_switch: p.kill_switch,
  };
}

function parseIntent(value: unknown): Intent {
  const intent = object(value, 'intent');
  const size = finite(intent.size, 'size');
  const limit = finite(intent.limit, 'limit');
  if (size <= 0 || limit <= 0 || limit >= 1 || !Number.isFinite(size * limit) || size * limit <= 0) {
    throw new AgentRequestError('order size and limit are out of range');
  }
  if (intent.side !== 'yes' && intent.side !== 'no') throw new AgentRequestError('unsupported side');
  if (typeof intent.reason !== 'string') throw new AgentRequestError('reason must be a string');
  return {
    venue: venue(intent.venue), marketId: text(intent.marketId, 'marketId'),
    side: intent.side, size, limit, reason: intent.reason,
  };
}

function venue(value: unknown): Venue {
  if (value !== 'polymarket' && value !== 'kalshi') throw new AgentRequestError('unsupported venue');
  return value;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AgentRequestError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AgentRequestError(`${label} must be a finite number`);
  }
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AgentRequestError(`${label} must be a nonblank string`);
  }
  return value;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new AgentRequestError(`${label} must be a list of strings`);
  }
  return value;
}
