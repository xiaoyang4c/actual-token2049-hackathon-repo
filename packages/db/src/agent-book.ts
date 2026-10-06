/**
 * @fileoverview Queries for the current book, quotes, and position accounting.
 */

import type {Database} from 'bun:sqlite';
import type {Venue} from '../../core/src/types';
import type {MarketQuote} from '../../core/src/portfolio';
import type {
  AgentStateRecord, DailySummaryRecord, MarketResolutionRecord, PositionEventRecord,
} from './records';
import {
  copyPositions, jsonText, parsePositions, requireFinite, requireOneOf,
  requireText, requiredRow, VENUES,
} from './codecs';

interface AgentStateRow {
  policyId: number;
  cash: number;
  equity: number;
  startOfDayEquity: number;
  highWaterMark: number;
  dailyPnl: number;
  positionsJson: string;
  updatedAt: string;
  tradingDay: string;
  realizedPnl: number;
  dailyRealizedPnl: number;
  pnlAdjustment: number;
}

/** Reads the current book. Historical runs do not replace this snapshot. */
export function getAgentState(db: Database): AgentStateRecord|undefined {
  const row = db.query<AgentStateRow, []>(`SELECT
      policy_id AS policyId, cash, equity,
      start_of_day_equity AS startOfDayEquity,
      high_water_mark AS highWaterMark, daily_pnl AS dailyPnl,
      positions_json AS positionsJson, updated_at AS updatedAt,
      trading_day AS tradingDay, realized_pnl AS realizedPnl,
      daily_realized_pnl AS dailyRealizedPnl, pnl_adjustment AS pnlAdjustment
      FROM agent_state WHERE id = 1`).get();
  if (!row) return undefined;
  return {
    policyId: row.policyId,
    portfolio: {
      cash: requireFinite(row.cash, 'cash'),
      equity: requireFinite(row.equity, 'equity'),
      startOfDayEquity: requireFinite(row.startOfDayEquity, 'startOfDayEquity'),
      highWaterMark: requireFinite(row.highWaterMark, 'highWaterMark'),
      dailyPnl: requireFinite(row.dailyPnl, 'dailyPnl'),
      positions: parsePositions(row.positionsJson),
    },
    updatedAt: row.updatedAt,
    accounting: {
      tradingDay: requireText(row.tradingDay, 'tradingDay'),
      realizedPnl: requireFinite(row.realizedPnl, 'realizedPnl'),
      dailyRealizedPnl: requireFinite(row.dailyRealizedPnl, 'dailyRealizedPnl'),
      pnlAdjustment: requireFinite(row.pnlAdjustment, 'pnlAdjustment'),
    },
  };
}

/** Saves the complete book. Use a transaction when also storing a fill. */
export function saveAgentState(
  db: Database,
  record: AgentStateRecord,
): AgentStateRecord {
  const p = record.portfolio;
  db.query(`INSERT INTO agent_state (
      id, policy_id, cash, equity, start_of_day_equity, high_water_mark,
      daily_pnl, positions_json, updated_at,
      trading_day, realized_pnl, daily_realized_pnl, pnl_adjustment
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      policy_id = excluded.policy_id, cash = excluded.cash,
      equity = excluded.equity, start_of_day_equity = excluded.start_of_day_equity,
      high_water_mark = excluded.high_water_mark, daily_pnl = excluded.daily_pnl,
      positions_json = excluded.positions_json, updated_at = excluded.updated_at,
      trading_day = excluded.trading_day, realized_pnl = excluded.realized_pnl,
      daily_realized_pnl = excluded.daily_realized_pnl, pnl_adjustment = excluded.pnl_adjustment`).run(
    record.policyId,
    requireFinite(p.cash, 'cash'),
    requireFinite(p.equity, 'equity'),
    requireFinite(p.startOfDayEquity, 'startOfDayEquity'),
    requireFinite(p.highWaterMark, 'highWaterMark'),
    requireFinite(p.dailyPnl, 'dailyPnl'),
    jsonText(copyPositions(p.positions)),
    requireText(record.updatedAt, 'updatedAt'),
    requireText(record.accounting.tradingDay, 'tradingDay'),
    requireFinite(record.accounting.realizedPnl, 'realizedPnl'),
    requireFinite(record.accounting.dailyRealizedPnl, 'dailyRealizedPnl'),
    requireFinite(record.accounting.pnlAdjustment, 'pnlAdjustment'),
  );
  return requiredRow(getAgentState(db), 'agent state');
}

export function getMarketQuote(
  db: Database,
  venue: Venue,
  marketId: string,
): MarketQuote|undefined {
  return db.query<MarketQuote, [string, string]>(`SELECT venue, market_id AS marketId,
      yes_price AS yesPrice, best_bid AS bestBid, best_ask AS bestAsk, fetched_at AS fetchedAt
      FROM market_quotes WHERE venue = ? AND market_id = ?`).get(venue, marketId) ?? undefined;
}

export function listMarketQuotes(db: Database): MarketQuote[] {
  return db.query<MarketQuote, []>(`SELECT venue, market_id AS marketId,
      yes_price AS yesPrice, best_bid AS bestBid, best_ask AS bestAsk, fetched_at AS fetchedAt
      FROM market_quotes ORDER BY venue, market_id`).all();
}

export function saveMarketQuote(db: Database, quote: MarketQuote): void {
  db.query(`INSERT INTO market_quotes (venue, market_id, yes_price, best_bid, best_ask, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (venue, market_id) DO UPDATE SET
      yes_price = excluded.yes_price, best_bid = excluded.best_bid,
      best_ask = excluded.best_ask, fetched_at = excluded.fetched_at`).run(
    requireOneOf(quote.venue, VENUES, 'venue'), requireText(quote.marketId, 'marketId'),
    requireFinite(quote.yesPrice, 'yesPrice'), requireFinite(quote.bestBid, 'bestBid'),
    requireFinite(quote.bestAsk, 'bestAsk'), requireText(quote.fetchedAt, 'fetchedAt'),
  );
}

export function getPositionEvent(
  db: Database,
  key: string,
): PositionEventRecord|undefined {
  return db.query<PositionEventRecord, [string]>(`SELECT idempotency_key AS idempotencyKey,
      kind, request_hash AS requestHash, result_json AS resultJson, created_at AS createdAt
      FROM position_events WHERE idempotency_key = ?`).get(key) ?? undefined;
}

export function listPositionEvents(db: Database): PositionEventRecord[] {
  return db.query<PositionEventRecord, []>(`SELECT idempotency_key AS idempotencyKey,
      kind, request_hash AS requestHash, result_json AS resultJson, created_at AS createdAt
      FROM position_events ORDER BY created_at, rowid`).all();
}

export function insertPositionEvent(
  db: Database,
  record: PositionEventRecord,
): void {
  db.query(`INSERT INTO position_events
      (idempotency_key, kind, request_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    requireText(record.idempotencyKey, 'idempotencyKey'), requireOneOf(record.kind, ['close', 'resolve'], 'event kind'),
    requireText(record.requestHash, 'requestHash'), requireText(record.resultJson, 'resultJson'),
    requireText(record.createdAt, 'createdAt'),
  );
}

export function getMarketResolution(
  db: Database,
  venue: Venue,
  marketId: string,
): MarketResolutionRecord|undefined {
  return db.query<MarketResolutionRecord, [string, string]>(`SELECT venue, market_id AS marketId,
      outcome, resolved_at AS resolvedAt, event_key AS eventKey
      FROM market_resolutions WHERE venue = ? AND market_id = ?`).get(venue, marketId) ?? undefined;
}

export function insertMarketResolution(
  db: Database,
  record: MarketResolutionRecord,
): void {
  db.query(`INSERT INTO market_resolutions
      (venue, market_id, outcome, resolved_at, event_key) VALUES (?, ?, ?, ?, ?)`).run(
    requireOneOf(record.venue, VENUES, 'venue'), requireText(record.marketId, 'marketId'),
    requireOneOf(record.outcome, ['yes', 'no', 'void'], 'outcome'),
    requireText(record.resolvedAt, 'resolvedAt'), requireText(record.eventKey, 'eventKey'),
  );
}

export function insertDailySummary(
  db: Database,
  record: DailySummaryRecord,
): void {
  db.query(`INSERT INTO daily_summaries
      (trading_day, start_equity, end_equity, pnl, realized_pnl, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
    requireText(record.tradingDay, 'tradingDay'), requireFinite(record.startEquity, 'startEquity'),
    requireFinite(record.endEquity, 'endEquity'), requireFinite(record.pnl, 'pnl'),
    requireFinite(record.realizedPnl, 'realizedPnl'), requireText(record.recordedAt, 'recordedAt'),
  );
}

export function listDailySummaries(db: Database): DailySummaryRecord[] {
  return db.query<DailySummaryRecord, []>(`SELECT trading_day AS tradingDay,
      start_equity AS startEquity, end_equity AS endEquity, pnl, realized_pnl AS realizedPnl,
      recorded_at AS recordedAt FROM daily_summaries ORDER BY trading_day`).all();
}
