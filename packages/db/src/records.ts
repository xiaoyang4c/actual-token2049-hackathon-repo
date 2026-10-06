/**
 * @fileoverview Stored agent records and lifecycle types.
 */

import type {Policy, Portfolio, Position, Side, Venue} from '../../core/src/types';
import type {PaperAccounting, ResolutionOutcome} from '../../core/src/portfolio';

/** Lifecycle of one agent cycle. */
export type RunStatus = 'running'|'completed'|'halted'|'failed';

/** Paper or live execution, matching the control API fill. */
export type OrderMode = 'paper'|'live';

/** Fill outcome stored for one order. */
export type OrderStatus = 'filled'|'rejected';

/** Local payment lifecycle. The three legacy escrow states remain readable. */
export type ReceiptStatus = 'requested'|'submitted'|'confirmed'|'delivered'|
  'refund_requested'|'escrowed'|'released'|'refunded';

/** A policy snapshot plus the time it was stored. */
export interface NewPolicyRecord {
  createdAt: string;
  policy: Policy;
}

/** A row in the policy table. */
export interface PolicyRecord extends NewPolicyRecord {
  id: number;
}

/** The active policy and paper book, including risk-limit accounting. */
export interface AgentStateRecord {
  policyId: number;
  portfolio: Portfolio;
  updatedAt: string;
  accounting: PaperAccounting;
}

export interface PositionEventRecord {
  idempotencyKey: string;
  kind: 'close'|'resolve';
  requestHash: string;
  resultJson: string;
  createdAt: string;
}

export interface MarketResolutionRecord {
  venue: Venue;
  marketId: string;
  outcome: ResolutionOutcome;
  resolvedAt: string;
  eventKey: string;
}

export interface DailySummaryRecord {
  tradingDay: string;
  startEquity: number;
  endEquity: number;
  pnl: number;
  realizedPnl: number;
  recordedAt: string;
}

/**
 * One cycle. Portfolio fields match the in-memory book: cash, equity,
 * start-of-day equity, high-water mark, daily PnL, and positions.
 */
export interface RunRecord {
  id: string;
  policyId?: number;
  startedAt: string;
  finishedAt?: string;
  status: RunStatus;
  summary: string;
  cash: number;
  equity: number;
  startOfDayEquity: number;
  highWaterMark: number;
  dailyPnl: number;
  positions: Position[];
}

/**
 * One order and its fill. Keys are the control API idempotency key.
 * `limitPrice` is the intent limit; `price` is the fill price.
 */
export interface OrderRecord {
  idempotencyKey: string;
  cycleId: string;
  venue: Venue;
  marketId: string;
  side: Side;
  size: number;
  limitPrice: number;
  price: number;
  status: OrderStatus;
  mode: OrderMode;
  reason: string;
  createdAt: string;
}

/** One audit event from a cycle, as posted to the control API. */
export interface NewAuditEvent {
  cycleId: string;
  receivedAt: string;
  type: string;
  detail: string;
}

/** A row in audit_events. */
export interface AuditEventRecord extends NewAuditEvent {
  id: number;
}

/**
 * A Cardano x402 / Masumi receipt stored locally. `cycleId` and
 * `orderKey` optionally relate the receipt to a run or an order.
 * Nothing in this type is fetched from a chain.
 */
export interface PaymentReceiptRecord {
  receiptId: string;
  idempotencyKey: string;
  payer: string;
  txHash: string;
  network: string;
  amount: number;
  asset: string;
  payTo: string;
  resource: string;
  status: ReceiptStatus;
  simulated: boolean;
  cycleId?: string;
  orderKey?: string;
  createdAt: string;
  inputHash?: string;
  protocolData?: string;
  responseJson?: string;
  resultHash?: string;
  confirmedAt?: string;
  deliveredAt?: string;
  updatedAt?: string;
}
