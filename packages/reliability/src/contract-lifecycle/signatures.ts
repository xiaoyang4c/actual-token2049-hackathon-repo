/**
 * @fileoverview Ed25519 signatures for party actions, terms, inspector
 * reports, and mediator rulings. Public keys are raw 32-byte hex.
 * Signatures are 64-byte hex.
 */

import {createPublicKey, generateKeyPairSync, sign, verify, type KeyObject} from 'node:crypto';

export interface Ed25519KeyPair {
  publicKeyHex: string;
  privateKey: KeyObject;
}

/** Makes a key pair for tests and demo scripts. Real parties hold their own keys. */
export function generateEd25519(): Ed25519KeyPair {
  const {publicKey, privateKey} = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({format: 'jwk'});
  if (typeof jwk.x !== 'string') throw new Error('unexpected Ed25519 key export');
  return {publicKeyHex: Buffer.from(jwk.x, 'base64url').toString('hex'), privateKey};
}

export function isPublicKeyHex(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function toBuffer(data: Uint8Array|string): Buffer {
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
}

export function signBytes(privateKey: KeyObject, data: Uint8Array|string): string {
  return sign(null, toBuffer(data), privateKey).toString('hex');
}

/** Returns false for a malformed key, a malformed signature, or a mismatch. */
export function verifyBytes(publicKeyHex: string, data: Uint8Array|string, signatureHex: string): boolean {
  if (!isPublicKeyHex(publicKeyHex) || !/^[0-9a-f]{128}$/.test(signatureHex)) return false;
  try {
    const key = createPublicKey({
      key: {kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKeyHex, 'hex').toString('base64url')},
      format: 'jwk',
    });
    return verify(null, toBuffer(data), key, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}
