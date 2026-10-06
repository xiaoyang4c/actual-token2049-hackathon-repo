/**
 * @fileoverview Queries for policy snapshots, runs, orders, and audit events.
 */

import type {Database} from 'bun:sqlite';
import type {Policy, Portfolio} from '../../core/src/types';
import type {
  AuditEventRecord, NewAuditEvent, NewPolicyRecord, OrderMode, OrderRecord,
  OrderStatus, PolicyRecord, RunRecord, RunStatus,
} from './records';
import {
  bindOptionalNumber, bindOptionalText, copyPolicy, copyPositions, flag, insertedId,
  jsonText, parsePositions, parseStringArray, parseVenues, readFlag, requireFinite,
  requireOneOf, requiredRow, requireString, requireText, SIDES, VENUES,
} from './codecs';

const RUN_STATUSES: readonly RunStatus[] = [
  'running',
  'completed',
  'halted',
  'failed',
];

const ORDER_MODES: readonly OrderMode[] = ['paper', 'live'];

const ORDER_STATUSES: readonly OrderStatus[] = ['filled', 'rejected'];

const INSERT_POLICY = `
  INSERT INTO policy (
    max_bet,
    max_daily_loss,
    category_allow,
    category_deny,
    venues_enabled,
    stop_loss_pct,
    kill_switch,
    created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

const SELECT_POLICY = `
  SELECT
    id,
    max_bet AS maxBet,
    max_daily_loss AS maxDailyLoss,
    category_allow AS categoryAllow,
    category_deny AS categoryDeny,
    venues_enabled AS venuesEnabled,
    stop_loss_pct AS stopLossPct,
    kill_switch AS killSwitch,
    created_at AS createdAt
  FROM policy
  WHERE id = ?`;

const INSERT_RUN = `
  INSERT INTO runs (
    id,
    policy_id,
    started_at,
    finished_at,
    status,
    summary,
    cash,
    equity,
    start_of_day_equity,
    high_water_mark,
    daily_pnl,
    positions_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const SELECT_RUN = `
  SELECT
    id,
    policy_id AS policyId,
    started_at AS startedAt,
    finished_at AS finishedAt,
    status,
    summary,
    cash,
    equity,
    start_of_day_equity AS startOfDayEquity,
    high_water_mark AS highWaterMark,
    daily_pnl AS dailyPnl,
    positions_json AS positionsJson
  FROM runs
  WHERE id = ?`;

const INSERT_ORDER = `
  INSERT INTO orders (
    idempotency_key,
    cycle_id,
    venue,
    market_id,
    side,
    size,
    limit_price,
    price,
    status,
    mode,
    reason,
    created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const SELECT_ORDER = `
  SELECT
    idempotency_key AS idempotencyKey,
    cycle_id AS cycleId,
    venue,
    market_id AS marketId,
    side,
    size,
    limit_price AS limitPrice,
    price,
    status,
    mode,
    reason,
    created_at AS createdAt
  FROM orders
  WHERE idempotency_key = ?`;

const INSERT_AUDIT = `
  INSERT INTO audit_events (
    cycle_id,
    received_at,
    "type",
    detail
  ) VALUES (?, ?, ?, ?)`;

const SELECT_AUDIT = `
  SELECT
    id,
    cycle_id AS cycleId,
    received_at AS receivedAt,
    "type" AS eventType,
    detail
  FROM audit_events
  WHERE id = ?`;

interface PolicyRow {
  id: number;
  maxBet: number;
  maxDailyLoss: number;
  categoryAllow: string;
  categoryDeny: string;
  venuesEnabled: string;
  stopLossPct: number;
  killSwitch: number;
  createdAt: string;
}

interface RunRow {
  id: string;
  policyId: number|null;
  startedAt: string;
  finishedAt: string|null;
  status: string;
  summary: string;
  cash: number;
  equity: number;
  startOfDayEquity: number;
  highWaterMark: number;
  dailyPnl: number;
  positionsJson: string;
}

interface OrderRow {
  idempotencyKey: string;
  cycleId: string;
  venue: string;
  marketId: string;
  side: string;
  size: number;
  limitPrice: number;
  price: number;
  status: string;
  mode: string;
  reason: string;
  createdAt: string;
}

interface AuditRow {
  id: number;
  cycleId: string;
  receivedAt: string;
  eventType: string;
  detail: string;
}

/** Inserts a policy snapshot and returns the stored row. */
export function insertPolicy(
  db: Database,
  record: NewPolicyRecord,
): PolicyRecord {
  const policy = copyPolicy(record.policy);
  const id = insertedId(db.query(INSERT_POLICY).run(
    policy.max_bet,
    policy.max_daily_loss,
    jsonText(policy.category_allow),
    jsonText(policy.category_deny),
    jsonText(policy.venues_enabled),
    policy.stop_loss_pct,
    flag(policy.kill_switch),
    requireText(record.createdAt, 'createdAt'),
  ));
  return requiredRow(selectPolicy(db, id), `policy ${id}`);
}

/** Returns the policy row, or undefined when `id` is absent. */
export function getPolicy(db: Database, id: number): PolicyRecord|undefined {
  return selectPolicy(db, id);
}

/** Inserts a cycle run and returns the stored row. */
export function insertRun(db: Database, record: RunRecord): RunRecord {
  const positions = copyPositions(record.positions);
  const id = requireText(record.id, 'id');
  db.query(INSERT_RUN).run(
    id,
    bindOptionalNumber(record.policyId),
    requireText(record.startedAt, 'startedAt'),
    bindOptionalText(record.finishedAt),
    requireOneOf(record.status, RUN_STATUSES, 'run status'),
    requireString(record.summary, 'summary'),
    requireFinite(record.cash, 'cash'),
    requireFinite(record.equity, 'equity'),
    requireFinite(record.startOfDayEquity, 'startOfDayEquity'),
    requireFinite(record.highWaterMark, 'highWaterMark'),
    requireFinite(record.dailyPnl, 'dailyPnl'),
    jsonText(positions),
  );
  return requiredRow(selectRun(db, id), `run ${id}`);
}

/** Returns the run, or undefined when `id` is absent. */
export function getRun(db: Database, id: string): RunRecord|undefined {
  return selectRun(db, id);
}

/** Commits the portfolio after a paper order batch completes. */
export function finishPaperRun(
  db: Database,
  id: string,
  portfolio: Portfolio,
  finishedAt: string,
): void {
  db.query(`UPDATE runs SET status = 'completed',
      summary = 'paper order batch completed', finished_at = ?, cash = ?,
      equity = ?, start_of_day_equity = ?, high_water_mark = ?, daily_pnl = ?,
      positions_json = ? WHERE id = ?`).run(
    requireText(finishedAt, 'finishedAt'),
    requireFinite(portfolio.cash, 'cash'),
    requireFinite(portfolio.equity, 'equity'),
    requireFinite(portfolio.startOfDayEquity, 'startOfDayEquity'),
    requireFinite(portfolio.highWaterMark, 'highWaterMark'),
    requireFinite(portfolio.dailyPnl, 'dailyPnl'),
    jsonText(copyPositions(portfolio.positions)),
    requireText(id, 'id'),
  );
}

/**
 * Inserts an order fill and returns the stored row. A repeated idempotency
 * key writes nothing and returns the row stored first, the same way the
 * control API answers a repeated order.
 */
export function insertOrder(db: Database, record: OrderRecord): OrderRecord {
  const key = requireText(record.idempotencyKey, 'idempotencyKey');
  const existing = selectOrder(db, key);
  if (existing !== undefined) {
    return existing;
  }
  db.query(INSERT_ORDER).run(
    key,
    requireText(record.cycleId, 'cycleId'),
    requireOneOf(record.venue, VENUES, 'venue'),
    requireText(record.marketId, 'marketId'),
    requireOneOf(record.side, SIDES, 'side'),
    requireFinite(record.size, 'size'),
    requireFinite(record.limitPrice, 'limitPrice'),
    requireFinite(record.price, 'price'),
    requireOneOf(record.status, ORDER_STATUSES, 'order status'),
    requireOneOf(record.mode, ORDER_MODES, 'order mode'),
    requireString(record.reason, 'reason'),
    requireText(record.createdAt, 'createdAt'),
  );
  return requiredRow(selectOrder(db, key), `order ${key}`);
}

/** Returns the order, or undefined when the key is absent. */
export function getOrder(
  db: Database,
  idempotencyKey: string,
): OrderRecord|undefined {
  return selectOrder(db, idempotencyKey);
}

/** Inserts one audit event and returns the stored row. */
export function insertAuditEvent(
  db: Database,
  record: NewAuditEvent,
): AuditEventRecord {
  const id = insertedId(db.query(INSERT_AUDIT).run(
    requireText(record.cycleId, 'cycleId'),
    requireText(record.receivedAt, 'receivedAt'),
    requireText(record.type, 'type'),
    requireString(record.detail, 'detail'),
  ));
  return requiredRow(selectAudit(db, id), `audit event ${id}`);
}

/** Returns the audit event, or undefined when `id` is absent. */
export function getAuditEvent(
  db: Database,
  id: number,
): AuditEventRecord|undefined {
  return selectAudit(db, id);
}

function selectPolicy(db: Database, id: number): PolicyRecord|undefined {
  const row = db.query<PolicyRow, [number]>(SELECT_POLICY).get(id);
  if (row === null) {
    return undefined;
  }
  const policy: Policy = {
    max_bet: row.maxBet,
    max_daily_loss: row.maxDailyLoss,
    category_allow: parseStringArray(row.categoryAllow, 'category_allow'),
    category_deny: parseStringArray(row.categoryDeny, 'category_deny'),
    venues_enabled: parseVenues(row.venuesEnabled),
    stop_loss_pct: row.stopLossPct,
    kill_switch: readFlag(row.killSwitch, 'kill_switch'),
  };
  return {id: row.id, createdAt: row.createdAt, policy};
}

function selectRun(db: Database, id: string): RunRecord|undefined {
  const row = db.query<RunRow, [string]>(SELECT_RUN).get(id);
  if (row === null) {
    return undefined;
  }
  const record: RunRecord = {
    id: row.id,
    startedAt: row.startedAt,
    status: requireOneOf(row.status, RUN_STATUSES, 'run status'),
    summary: row.summary,
    cash: row.cash,
    equity: row.equity,
    startOfDayEquity: row.startOfDayEquity,
    highWaterMark: row.highWaterMark,
    dailyPnl: row.dailyPnl,
    positions: parsePositions(row.positionsJson),
  };
  if (row.policyId !== null) {
    record.policyId = row.policyId;
  }
  if (row.finishedAt !== null) {
    record.finishedAt = row.finishedAt;
  }
  return record;
}

function selectOrder(db: Database, key: string): OrderRecord|undefined {
  const row = db.query<OrderRow, [string]>(SELECT_ORDER).get(key);
  if (row === null) {
    return undefined;
  }
  return {
    idempotencyKey: row.idempotencyKey,
    cycleId: row.cycleId,
    venue: requireOneOf(row.venue, VENUES, 'venue'),
    marketId: row.marketId,
    side: requireOneOf(row.side, SIDES, 'side'),
    size: row.size,
    limitPrice: row.limitPrice,
    price: row.price,
    status: requireOneOf(row.status, ORDER_STATUSES, 'order status'),
    mode: requireOneOf(row.mode, ORDER_MODES, 'order mode'),
    reason: row.reason,
    createdAt: row.createdAt,
  };
}

function selectAudit(db: Database, id: number): AuditEventRecord|undefined {
  const row = db.query<AuditRow, [number]>(SELECT_AUDIT).get(id);
  if (row === null) {
    return undefined;
  }
  return {
    id: row.id,
    cycleId: row.cycleId,
    receivedAt: row.receivedAt,
    type: row.eventType,
    detail: row.detail,
  };
}
