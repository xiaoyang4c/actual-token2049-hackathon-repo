/*
 * The browser wallet must match a standard Cardano wallet. This test derives
 * the same phrase with the Cardano serialization library (the reference that
 * Lace and Eternl agree with) and checks the addresses, the keys, the sign-in
 * signature that the Tally server verifies, and the deposit witness.
 */

import {describe, expect, test} from 'bun:test'
import * as C from '@emurgo/cardano-serialization-lib-nodejs'
import {verifyWalletSignature} from '../../services/reliability/wallet-proof'
import {hex, isRecoveryPhrase, newRecoveryPhrase, phraseFromEntropy, walletFromPhrase} from '../src/lib/cardano-keys'

const harden = (n: number) => 0x80000000 + n

function reference(entropy: Uint8Array) {
  const account = C.Bip32PrivateKey.from_bip39_entropy(entropy, new Uint8Array()).derive(harden(1852)).derive(harden(1815)).derive(harden(0))
  const payment = account.derive(0).derive(0).to_raw_key()
  const stake = account.derive(2).derive(0).to_raw_key()
  return {
    payment, stake,
    base: C.BaseAddress.new(0, C.Credential.from_keyhash(payment.to_public().hash()), C.Credential.from_keyhash(stake.to_public().hash())).to_address().to_bech32('addr_test'),
    reward: C.RewardAddress.new(0, C.Credential.from_keyhash(stake.to_public().hash())).to_address().to_bech32('stake_test'),
  }
}

describe('browser wallet keys', () => {
  for (const seed of [0, 7, 255]) {
    test(`match the reference wallet (entropy filled with ${seed})`, () => {
      const entropy = new Uint8Array(32).fill(seed)
      const wallet = walletFromPhrase(phraseFromEntropy(entropy))
      const expected = reference(entropy)
      expect(wallet.address).toBe(expected.base)
      expect(wallet.rewardAddress).toBe(expected.reward)
      expect(hex(wallet.paymentPublicKey)).toBe(hex(expected.payment.to_public().as_bytes()))
      expect(hex(wallet.stakePublicKey)).toBe(hex(expected.stake.to_public().as_bytes()))
    })
  }

  test('the sign-in signature passes the server check', () => {
    const wallet = walletFromPhrase(newRecoveryPhrase())
    const message = 'Sign in to Tally.\nNonce: 0a0b'
    const signed = wallet.signMessage(message)
    expect(verifyWalletSignature({address: wallet.rewardAddress, signatureHex: signed.signature, keyHex: signed.key, message}))
      .toMatchObject({credentialKind: 'stake'})
  })

  test('the deposit witness signs the transaction body with the payment key', () => {
    const entropy = new Uint8Array(32).fill(9)
    const wallet = walletFromPhrase(phraseFromEntropy(entropy))
    const body = 'ab'.repeat(32)
    const witnesses = C.TransactionWitnessSet.from_hex(wallet.witnessFor(body))
    const witness = witnesses.vkeys()!.get(0)
    expect(witness.vkey().public_key().hash().to_hex()).toBe(reference(entropy).payment.to_public().hash().to_hex())
    expect(witness.vkey().public_key().verify(Buffer.from(body, 'hex'), witness.signature())).toBe(true)
    // The same signature as the reference signer: Ed25519 with an extended key is deterministic.
    expect(witness.signature().to_hex()).toBe(C.make_vkey_witness(C.TransactionHash.from_hex(body), reference(entropy).payment).signature().to_hex())
  })

  test('a phrase is checked before use', () => {
    expect(newRecoveryPhrase().split(' ')).toHaveLength(24)
    expect(isRecoveryPhrase(` ${newRecoveryPhrase().toUpperCase()} `)).toBe(true)
    expect(isRecoveryPhrase('abandon abandon abandon')).toBe(false)
  })
})
