/*
 * A Cardano wallet that lives in the browser. Tally never sees its keys.
 *
 * - The recovery phrase is 24 BIP-39 words. Any Cardano wallet (Lace, Eternl)
 *   can restore it, because the keys follow CIP-1852 (m/1852'/1815'/0').
 * - The root key comes from the phrase entropy (CIP-3 Icarus). Child keys use
 *   BIP32-Ed25519 (V2). Signing uses the extended key, as Cardano wallets do.
 * - Sign-in signs a CIP-8 message with the stake key. Deposits sign the
 *   transaction body hash with the payment key.
 *
 * https://cips.cardano.org/cip/CIP-1852 · https://cips.cardano.org/cip/CIP-0003 · https://cips.cardano.org/cip/CIP-0008
 */

import {ed25519} from '@noble/curves/ed25519.js'
import {blake2b} from '@noble/hashes/blake2.js'
import {hmac} from '@noble/hashes/hmac.js'
import {pbkdf2} from '@noble/hashes/pbkdf2.js'
import {sha512} from '@noble/hashes/sha2.js'
import {bech32} from '@scure/base'
import {entropyToMnemonic, generateMnemonic, mnemonicToEntropy, validateMnemonic} from '@scure/bip39'
import {wordlist} from '@scure/bip39/wordlists/english.js'
import {cborMap, encodeCbor} from './cbor'

const HARDENED = 0x80000000
const ORDER = ed25519.Point.Fn.ORDER
const TWO_256 = 1n << 256n

interface ExtendedKey {
  kL: Uint8Array
  kR: Uint8Array
  chainCode: Uint8Array
}

const le = (bytes: Uint8Array) => bytes.reduceRight((value, byte) => (value << 8n) | BigInt(byte), 0n)

function toLe(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) { out[i] = Number(value & 0xffn); value >>= 8n }
  return out
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let at = 0
  for (const part of parts) { out.set(part, at); at += part.length }
  return out
}

/** The public key of an extended key: kL times the base point. */
function publicOf(kL: Uint8Array): Uint8Array {
  return ed25519.Point.BASE.multiply(le(kL) % ORDER).toBytes()
}

/** CIP-3 Icarus root key from BIP-39 entropy and an empty passphrase. */
function rootKey(entropy: Uint8Array): ExtendedKey {
  const xprv = pbkdf2(sha512, new Uint8Array(), entropy, {c: 4096, dkLen: 96})
  xprv[0] &= 0b11111000
  xprv[31] &= 0b00011111
  xprv[31] |= 0b01000000
  return {kL: xprv.slice(0, 32), kR: xprv.slice(32, 64), chainCode: xprv.slice(64, 96)}
}

/** BIP32-Ed25519 child derivation, V2 scheme. */
function derive(parent: ExtendedKey, index: number): ExtendedKey {
  const indexBytes = toLe(BigInt(index), 4)
  const hardened = index >= HARDENED
  const data = hardened ? concat(parent.kL, parent.kR, indexBytes) : concat(publicOf(parent.kL), indexBytes)
  const z = hmac(sha512, parent.chainCode, concat(Uint8Array.of(hardened ? 0x00 : 0x02), data))
  const chain = hmac(sha512, parent.chainCode, concat(Uint8Array.of(hardened ? 0x01 : 0x03), data))
  const kL = (le(z.slice(0, 28)) * 8n + le(parent.kL)) % TWO_256
  const kR = (le(z.slice(32, 64)) + le(parent.kR)) % TWO_256
  return {kL: toLe(kL, 32), kR: toLe(kR, 32), chainCode: chain.slice(32, 64)}
}

/** Ed25519 signature with an extended key (no seed hashing). */
function signWith(key: ExtendedKey, message: Uint8Array): Uint8Array {
  const publicKey = publicOf(key.kL)
  const r = le(sha512(concat(key.kR, message))) % ORDER
  const R = (r === 0n ? ed25519.Point.ZERO : ed25519.Point.BASE.multiply(r)).toBytes()
  const h = le(sha512(concat(R, publicKey, message))) % ORDER
  const s = (r + h * le(key.kL)) % ORDER
  return concat(R, toLe(s, 32))
}

const keyHash = (publicKey: Uint8Array) => blake2b(publicKey, {dkLen: 28})
const toBech32 = (prefix: string, bytes: Uint8Array) => bech32.encode(prefix, bech32.toWords(bytes), 1000)

export interface BrowserWallet {
  /** The base address that holds funds (payment key 0, stake key 0). */
  address: string
  /** The stake (reward) address that signs in. */
  rewardAddress: string
  paymentPublicKey: Uint8Array
  stakePublicKey: Uint8Array
  /** CIP-8 signature of `message` with the stake key, as CIP-30 signData returns it. */
  signMessage(message: string): {signature: string; key: string}
  /** A CIP-30 style witness set (CBOR hex) for a transaction body hash. */
  witnessFor(txHashHex: string): string
}

export const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
const fromHex = (value: string) => Uint8Array.from(value.match(/../g) ?? [], (pair) => parseInt(pair, 16))

/** A new 24-word recovery phrase. */
export const newRecoveryPhrase = () => generateMnemonic(wordlist, 256)

export const isRecoveryPhrase = (phrase: string) => validateMnemonic(normalizePhrase(phrase), wordlist)

export const normalizePhrase = (phrase: string) => phrase.trim().toLowerCase().split(/\s+/).join(' ')

/** The preprod wallet of a recovery phrase. */
export function walletFromPhrase(phrase: string): BrowserWallet {
  const entropy = mnemonicToEntropy(normalizePhrase(phrase), wordlist)
  const account = [1852 + HARDENED, 1815 + HARDENED, HARDENED].reduce(derive, rootKey(entropy))
  const payment = derive(derive(account, 0), 0)
  const stake = derive(derive(account, 2), 0)
  const paymentPublicKey = publicOf(payment.kL)
  const stakePublicKey = publicOf(stake.kL)
  // Header 0x00: base address, key payment and key stake credentials, test network.
  const address = toBech32('addr_test', concat(Uint8Array.of(0x00), keyHash(paymentPublicKey), keyHash(stakePublicKey)))
  // Header 0xe0: reward address, key credential, test network.
  const rewardBytes = concat(Uint8Array.of(0xe0), keyHash(stakePublicKey))
  return {
    address,
    rewardAddress: toBech32('stake_test', rewardBytes),
    paymentPublicKey,
    stakePublicKey,
    signMessage(message) {
      const protectedBytes = encodeCbor(cborMap([[1, -8], ['address', rewardBytes]]))
      const payload = new TextEncoder().encode(message)
      const signature = signWith(stake, encodeCbor(['Signature1', protectedBytes, new Uint8Array(), payload]))
      return {
        signature: hex(encodeCbor([protectedBytes, cborMap([['hashed', false]]), payload, signature])),
        key: hex(encodeCbor(cborMap([[1, 1], [3, -8], [-1, 6], [-2, stakePublicKey]]))),
      }
    },
    witnessFor(txHashHex) {
      return hex(encodeCbor(cborMap([[0, [[paymentPublicKey, signWith(payment, fromHex(txHashHex))]]]])))
    },
  }
}

/** For tests: the phrase of fixed entropy. */
export const phraseFromEntropy = (entropy: Uint8Array) => entropyToMnemonic(entropy, wordlist)
