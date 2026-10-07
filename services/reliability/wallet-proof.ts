/**
 * @fileoverview Checks a signed sign-in message from a Cardano wallet.
 *
 * Browser wallets sign with CIP-30 `signData`, which returns a CIP-8
 * COSE_Sign1 structure and a COSE_Key. The Tally website signs the same
 * structure for a wallet that it created in the browser. A valid proof
 * shows control of the key behind one preprod address:
 * - a stake (reward) address proves the stake key, which covers every
 *   address of that wallet;
 * - a base or enterprise address proves the payment key of that address.
 *
 * Read https://cips.cardano.org/cip/CIP-0030 and https://cips.cardano.org/cip/CIP-0008.
 */

import * as C from '@emurgo/cardano-serialization-lib-nodejs';
import {CborMap, CborTag, decodeCbor, encodeCbor, type CborValue} from './cbor';

/** COSE algorithm id for EdDSA. */
const ALG_EDDSA = -8;

export type CredentialKind = 'stake'|'payment';

export interface WalletProof {
  address: string;
  credentialKind: CredentialKind;
  /** Blake2b-224 hash of the public key, as hex. */
  credentialHash: string;
  publicKeyHex: string;
}

export class WalletProofError extends Error {
  constructor(readonly code: 'invalid_address'|'invalid_signature'|'wrong_message'|'wrong_key', message: string) {
    super(message);
    this.name = 'WalletProofError';
  }
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

function fromHex(value: string, what: string): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(value) || value.length > 8192) {
    throw new WalletProofError('invalid_signature', `${what} must be hex`);
  }
  return Uint8Array.from(Buffer.from(value, 'hex'));
}

function decode(bytes: Uint8Array, what: string): CborValue {
  try {
    return decodeCbor(bytes);
  } catch (error) {
    throw new WalletProofError('invalid_signature', `${what} is not valid CBOR (${(error as Error).message})`);
  }
}

const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);

/** The key credential that a preprod address names, or an error. */
export function addressCredential(address: string): {kind: CredentialKind; keyHash: string; bytes: Uint8Array} {
  let parsed: C.Address;
  try {
    parsed = C.Address.from_bech32(address);
  } catch {
    throw new WalletProofError('invalid_address', 'the address is not a Cardano bech32 address');
  }
  if (parsed.network_id() !== 0) throw new WalletProofError('invalid_address', 'use a preprod (test network) address');
  const reward = C.RewardAddress.from_address(parsed);
  const base = C.BaseAddress.from_address(parsed);
  const enterprise = C.EnterpriseAddress.from_address(parsed);
  const credential = reward?.payment_cred() ?? base?.payment_cred() ?? enterprise?.payment_cred();
  const keyHash = credential?.to_keyhash();
  if (!credential || !keyHash) {
    throw new WalletProofError('invalid_address', 'use a stake, base, or enterprise address with a key credential');
  }
  return {kind: reward ? 'stake' : 'payment', keyHash: keyHash.to_hex(), bytes: parsed.to_bytes()};
}

/**
 * Verifies a COSE_Sign1 signature (hex) and COSE_Key (hex) over `message`
 * for `address`. Returns the proven credential.
 */
export function verifyWalletSignature(input: {address: string; signatureHex: string; keyHex: string; message: string}): WalletProof {
  const credential = addressCredential(input.address);
  let sign1 = decode(fromHex(input.signatureHex, 'signature'), 'signature');
  if (sign1 instanceof CborTag && sign1.tag === 18) sign1 = sign1.value;
  if (!Array.isArray(sign1) || sign1.length !== 4) throw new WalletProofError('invalid_signature', 'the signature is not a COSE_Sign1 array');
  const [protectedBytes, unprotected, payload, signature] = sign1;
  if (!(protectedBytes instanceof Uint8Array) || !(signature instanceof Uint8Array) || signature.length !== 64) {
    throw new WalletProofError('invalid_signature', 'the COSE_Sign1 fields have the wrong types');
  }
  const headers = decode(protectedBytes, 'protected header');
  if (!(headers instanceof CborMap) || headers.get(1) !== ALG_EDDSA) {
    throw new WalletProofError('invalid_signature', 'the signature must use EdDSA');
  }
  const signedAddress = headers.get('address');
  if (!(signedAddress instanceof Uint8Array) || !equal(signedAddress, credential.bytes)) {
    throw new WalletProofError('wrong_key', 'the signature names a different address');
  }
  if (unprotected instanceof CborMap && unprotected.get('hashed') === true) {
    throw new WalletProofError('invalid_signature', 'sign the message itself, not its hash');
  }
  if (!(payload instanceof Uint8Array) || !equal(payload, new TextEncoder().encode(input.message))) {
    throw new WalletProofError('wrong_message', 'the wallet signed a different message');
  }
  const key = decode(fromHex(input.keyHex, 'key'), 'key');
  const x = key instanceof CborMap ? key.get(-2) : undefined;
  if (!(key instanceof CborMap) || key.get(1) !== 1 || key.get(-1) !== 6 || !(x instanceof Uint8Array) || x.length !== 32) {
    throw new WalletProofError('invalid_signature', 'the key is not an Ed25519 COSE_Key');
  }
  const publicKey = C.PublicKey.from_bytes(x);
  if (publicKey.hash().to_hex() !== credential.keyHash) {
    throw new WalletProofError('wrong_key', 'the key does not belong to this address');
  }
  // CIP-8 Sig_structure: ["Signature1", protected, external_aad, payload].
  const signed = encodeCbor(['Signature1', protectedBytes, new Uint8Array(), payload]);
  if (!publicKey.verify(signed, C.Ed25519Signature.from_bytes(signature))) {
    throw new WalletProofError('invalid_signature', 'the signature does not verify');
  }
  return {address: input.address, credentialKind: credential.kind, credentialHash: credential.keyHash, publicKeyHex: hex(x)};
}
