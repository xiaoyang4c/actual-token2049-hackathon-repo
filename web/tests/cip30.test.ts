/*
 * The Account page shows an extension's receive address only when it belongs
 * to the wallet that signed in.
 */

import {describe, expect, test} from 'bun:test'
import {phraseFromEntropy, walletFromPhrase} from '../src/lib/cardano-keys'
import {sharesStakeKey} from '../src/lib/cip30'

describe('sharesStakeKey', () => {
  const wallet = walletFromPhrase(phraseFromEntropy(new Uint8Array(32).fill(5)))
  const other = walletFromPhrase(phraseFromEntropy(new Uint8Array(32).fill(6)))

  test('matches the receive address and the stake address of one wallet', () => {
    expect(sharesStakeKey(wallet.address, wallet.rewardAddress)).toBe(true)
  })

  test('rejects another wallet', () => {
    expect(sharesStakeKey(wallet.address, other.rewardAddress)).toBe(false)
    expect(sharesStakeKey(other.address, wallet.rewardAddress)).toBe(false)
  })

  test('rejects a stake address in place of a receive address, and bad text', () => {
    expect(sharesStakeKey(wallet.rewardAddress, wallet.rewardAddress)).toBe(false)
    expect(sharesStakeKey('addr_test1notanaddress', wallet.rewardAddress)).toBe(false)
  })
})
