/*
 * Browser wallet extensions (Lace, Eternl, Typhon and others) through CIP-30.
 * https://cips.cardano.org/cip/CIP-0030
 */

import {bech32} from '@scure/base'

export interface Cip30Api {
  getNetworkId(): Promise<number>
  getUtxos(): Promise<string[] | null | undefined>
  getChangeAddress(): Promise<string>
  getRewardAddresses(): Promise<string[]>
  getUsedAddresses(): Promise<string[]>
  signData(address: string, payloadHex: string): Promise<{signature: string; key: string}>
  signTx(txHex: string, partialSign?: boolean): Promise<string>
}

interface Cip30Wallet {
  name: string
  icon: string
  apiVersion?: string
  enable(): Promise<Cip30Api>
}

declare global {
  interface Window {
    cardano?: Record<string, Cip30Wallet | undefined>
  }
}

export interface InstalledWallet {
  id: string
  name: string
  icon: string
}

/** Wallet extensions in this browser. */
export function installedWallets(): InstalledWallet[] {
  const all = typeof window === 'undefined' ? undefined : window.cardano
  if (!all) return []
  return Object.entries(all)
    .filter(([, wallet]) => wallet && typeof wallet.enable === 'function' && typeof wallet.name === 'string')
    .map(([id, wallet]) => ({id, name: (wallet as Cip30Wallet).name, icon: (wallet as Cip30Wallet).icon}))
    .filter((wallet, index, list) => list.findIndex((other) => other.name === wallet.name) === index)
}

const fromHex = (value: string) => Uint8Array.from(value.match(/../g) ?? [], (pair) => parseInt(pair, 16))
export const utf8Hex = (text: string) => Array.from(new TextEncoder().encode(text), (byte) => byte.toString(16).padStart(2, '0')).join('')

/** A CIP-30 address (hex bytes) as bech32. Header bit 0xe0 marks a reward address. */
export function addressToBech32(addressHex: string): string {
  const bytes = fromHex(addressHex)
  const reward = (bytes[0]! & 0xf0) === 0xe0 || (bytes[0]! & 0xf0) === 0xf0
  const testnet = (bytes[0]! & 0x0f) === 0
  const prefix = reward ? (testnet ? 'stake_test' : 'stake') : (testnet ? 'addr_test' : 'addr')
  return bech32.encode(prefix, bech32.toWords(bytes), 1000)
}

/**
 * True when a base address carries the stake credential of `stakeAddress`, so
 * both belong to one wallet. A base address holds the payment part in bytes
 * 1-28 and the stake part in bytes 29-56 (CIP-19).
 */
export function sharesStakeKey(baseAddress: string, stakeAddress: string): boolean {
  try {
    const base = bech32.fromWords(bech32.decode(baseAddress as `${string}1${string}`, 1000).words)
    const stake = bech32.fromWords(bech32.decode(stakeAddress as `${string}1${string}`, 1000).words)
    const baseType = base[0]! >> 4
    const stakeType = stake[0]! >> 4
    if (base.length !== 57 || stake.length !== 29 || baseType > 3 || (stakeType !== 0xe && stakeType !== 0xf)) return false
    // Base types 2 and 3 have a script stake part, as does reward type 0xf.
    if ((baseType >= 2) !== (stakeType === 0xf)) return false
    return base.slice(29).every((byte, index) => byte === stake[index + 1])
  } catch {
    return false
  }
}

/** Connects and checks the network. Preprod and preview report network id 0. */
export async function connect(id: string): Promise<Cip30Api> {
  const wallet = window.cardano?.[id]
  if (!wallet) throw new Error('This wallet is not installed in this browser.')
  const api = await wallet.enable()
  if ((await api.getNetworkId()) !== 0) throw new Error('Switch the wallet to the Preprod test network, then try again.')
  return api
}

/**
 * The address that signs in: the stake address, which covers the whole
 * wallet. A wallet without one signs with its change address.
 */
export async function signInAddress(api: Cip30Api): Promise<{hex: string; bech32: string}> {
  const [reward] = await api.getRewardAddresses()
  const chosen = reward ?? await api.getChangeAddress()
  return {hex: chosen, bech32: addressToBech32(chosen)}
}
