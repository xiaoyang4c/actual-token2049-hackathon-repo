/**
 * @fileoverview SHA-256 and MIP-004 hashes for Masumi escrows.
 * MIP-004: https://www.masumi.network/dev/masumi/mips/_mip-004
 * A plain SHA-256 of the payload is not a MIP-004 hash.
 */

import {createHash, randomBytes} from 'node:crypto';
import {canonicalize} from './canonical-json';

export function sha256Hex(data: Uint8Array|string): string {
  return createHash('sha256').update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).digest('hex');
}

// MPS accepts identifierFromPurchaser with 14 to 26 hex characters
// (masumi-payment-service src/routes/api/payments/schemas.ts, rev d569a33).
const PURCHASER_ID_MIN_HEX = 14;
const PURCHASER_ID_MAX_HEX = 26;
// 10 random bytes give 20 hex characters: inside the MPS range, 80 bits of entropy.
const PURCHASER_ID_BYTES = 10;

/** A fresh buyer nonce for one escrow. */
export function newIdentifierFromPurchaser(): string {
  return randomBytes(PURCHASER_ID_BYTES).toString('hex');
}

export function isIdentifierFromPurchaser(value: string): boolean {
  return /^[0-9a-f]+$/.test(value) && value.length >= PURCHASER_ID_MIN_HEX &&
    value.length <= PURCHASER_ID_MAX_HEX;
}

function requireIdentifier(value: string): void {
  if (!isIdentifierFromPurchaser(value)) {
    throw new Error(`identifierFromPurchaser must be ${PURCHASER_ID_MIN_HEX} to ${PURCHASER_ID_MAX_HEX} lowercase hex characters`);
  }
}

/** MIP-004 input hash: SHA-256(identifierFromPurchaser + ";" + JCS(inputData)). */
export function mip004InputHash(identifierFromPurchaser: string, inputData: {[key: string]: unknown}): string {
  requireIdentifier(identifierFromPurchaser);
  return sha256Hex(`${identifierFromPurchaser};${canonicalize(inputData)}`);
}

/** MIP-004 result hash: SHA-256(identifierFromPurchaser + ";" + output). The output is raw UTF-8. */
export function mip004ResultHash(identifierFromPurchaser: string, output: string): string {
  requireIdentifier(identifierFromPurchaser);
  return sha256Hex(`${identifierFromPurchaser};${output}`);
}
