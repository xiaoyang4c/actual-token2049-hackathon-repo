/**
 * @fileoverview Validation and JSON conversion for stored agent records.
 */

import type {Changes} from 'bun:sqlite';
import type {Policy, Position, Side, Venue} from '../../core/src/types';

export const VENUES: readonly Venue[] = ['polymarket', 'kalshi'];

export const SIDES: readonly Side[] = ['yes', 'no'];

export function copyPolicy(policy: Policy): Policy {
  return {
    max_bet: requireFinite(policy.max_bet, 'max_bet'),
    max_daily_loss: requireFinite(policy.max_daily_loss, 'max_daily_loss'),
    category_allow: copyStringArray(
      policy.category_allow,
      'category_allow',
    ),
    category_deny: copyStringArray(policy.category_deny, 'category_deny'),
    venues_enabled: copyVenues(policy.venues_enabled),
    stop_loss_pct: requireFinite(policy.stop_loss_pct, 'stop_loss_pct'),
    kill_switch: policy.kill_switch,
  };
}

function copyStringArray(values: unknown, label: string): string[] {
  if (!isUnknownArray(values)) {
    throw new Error(`${label} must be a list of strings`);
  }
  const copy: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') {
      throw new Error(`${label} must be a list of strings`);
    }
    copy.push(value);
  }
  return copy;
}

function copyVenues(values: unknown): Venue[] {
  if (!isUnknownArray(values)) {
    throw new Error('venues_enabled must be a list of venues');
  }
  const venues: Venue[] = [];
  for (const value of values) {
    if (typeof value !== 'string') {
      throw new Error('venues_enabled must be a list of venues');
    }
    venues.push(requireOneOf(value, VENUES, 'venue'));
  }
  return venues;
}

export function copyPositions(values: unknown): Position[] {
  if (!isUnknownArray(values)) {
    throw new Error('positions must be a list');
  }
  const positions: Position[] = [];
  for (const value of values) {
    if (!isPosition(value)) {
      throw new Error('positions contain a non-position');
    }
    positions.push({
      venue: value.venue,
      marketId: value.marketId,
      side: value.side,
      size: value.size,
      avgPrice: value.avgPrice,
    });
  }
  return positions;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export function parseStringArray(raw: string, label: string): string[] {
  return copyStringArray(parseJson(raw), label);
}

export function parseVenues(raw: string): Venue[] {
  return copyVenues(parseJson(raw));
}

export function parsePositions(raw: string): Position[] {
  return copyPositions(parseJson(raw));
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'invalid JSON';
    throw new Error(message, {cause: error});
  }
}

function isPosition(value: unknown): value is Position {
  if (!isObject(value)) {
    return false;
  }
  return typeof value.venue === 'string' &&
    includes(VENUES, value.venue) &&
    typeof value.marketId === 'string' &&
    typeof value.side === 'string' &&
    includes(SIDES, value.side) &&
    // JSON stores NaN and Infinity as null, so the row would not read back.
    Number.isFinite(value.size) &&
    Number.isFinite(value.avgPrice);
}

function isObject(value: unknown): value is {[field: string]: unknown} {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function jsonText(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) {
    throw new Error('value cannot be stored as JSON');
  }
  return text;
}

export function insertedId(changes: Changes): number {
  const id = changes.lastInsertRowid;
  if (typeof id !== 'number' || !Number.isSafeInteger(id)) {
    throw new Error('SQLite did not return an integer row id');
  }
  return id;
}

export function requiredRow<T>(row: T|undefined, label: string): T {
  if (row === undefined) {
    throw new Error(`${label} was not stored`);
  }
  return row;
}

export function requireOneOf<T extends string>(
  value: string,
  allowed: readonly T[],
  label: string,
): T {
  if (includes(allowed, value)) {
    return value;
  }
  throw new Error(`unknown ${label}`);
}

function includes<T extends string>(
  allowed: readonly T[],
  value: string,
): value is T {
  for (const candidate of allowed) {
    if (candidate === value) {
      return true;
    }
  }
  return false;
}

export function requireFinite(value: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

export function requireAmount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('amount must be a non-negative integer');
  }
  return value;
}

export function requireText(value: string, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function requireString(value: string, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

export function bindOptionalNumber(value?: number): number|null {
  if (value === undefined) {
    return null;
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error('expected an integer');
  }
  return value;
}

export function bindOptionalText(value?: string): string|null {
  if (value === undefined) {
    return null;
  }
  return requireText(value, 'optional text');
}

export function flag(value: boolean): number {
  if (typeof value !== 'boolean') {
    throw new Error('expected a boolean');
  }
  return value ? 1 : 0;
}

export function readFlag(value: number, label: string): boolean {
  if (value === 1) {
    return true;
  }
  if (value === 0) {
    return false;
  }
  throw new Error(`${label} is not 0 or 1`);
}
