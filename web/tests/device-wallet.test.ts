/*
 * The Account page shows a browser wallet's receive address beside its
 * sign-in address. The sign-in address is a stake address, which cannot
 * receive funds.
 */

import {beforeEach, describe, expect, test} from 'bun:test'
import {phraseFromEntropy, walletFromPhrase} from '../src/lib/cardano-keys'
import {receiveAddressFor, saveDeviceWallet} from '../src/lib/device-wallet'

const items = new Map<string, string>()
globalThis.localStorage = {
  getItem: (key: string) => items.get(key) ?? null,
  setItem: (key: string, value: string) => { items.set(key, value) },
  removeItem: (key: string) => { items.delete(key) },
} as Storage

describe('receive address of the device wallet', () => {
  const phrase = phraseFromEntropy(new Uint8Array(32).fill(3))
  const wallet = walletFromPhrase(phrase)

  beforeEach(() => items.clear())

  test('is the base address of the wallet that signed in', async () => {
    await saveDeviceWallet(phrase, 'password1', {address: wallet.address, rewardAddress: wallet.rewardAddress})
    expect(wallet.rewardAddress.startsWith('stake_test1')).toBe(true)
    expect(receiveAddressFor(wallet.rewardAddress)).toBe(wallet.address)
    expect(wallet.address.startsWith('addr_test1')).toBe(true)
  })

  test('is absent for another wallet or with no device wallet', async () => {
    const other = walletFromPhrase(phraseFromEntropy(new Uint8Array(32).fill(4)))
    expect(receiveAddressFor(wallet.rewardAddress)).toBeNull()
    await saveDeviceWallet(phrase, 'password1', {address: wallet.address, rewardAddress: wallet.rewardAddress})
    expect(receiveAddressFor(other.rewardAddress)).toBeNull()
  })
})
