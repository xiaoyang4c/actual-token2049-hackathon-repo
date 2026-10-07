import {describe, expect, test} from 'bun:test'
import {ed25519} from '@noble/curves/ed25519.js'
import {sha256} from '@noble/hashes/sha2.js'
import {canonicalize as serverCanonicalize} from '../../packages/reliability/src/contract-lifecycle/canonical-json'
import {partyActionBytes as serverPartyActionBytes} from '../../packages/reliability/src/contract-lifecycle/engine'
import {verifyBytes} from '../../packages/reliability/src/contract-lifecycle/signatures'
import {hex, walletFromPhrase} from '../src/lib/cardano-keys'
import {canonicalize, dealKeyMessage, deriveDealKey, partyActionBytes, seedFromCose, signTerms, type AppMe, type PartyAction} from '../src/lib/deals'

const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art'
const me: AppMe = {
  entityId: 'alice', displayName: 'Alice', signInDomain: 'app.example', party: null, mode: 'paper',
  readiness: {wallet: true, kyc: true, kycMessage: 'mock KYC', dealKey: false, deposit: false, depositRequired: false, canTrade: false, next: []},
}
const session = {token: 'test-session', via: 'browser', expiresAt: '2100-01-01T00:00:00Z'}

describe('client signing matches the engine', () => {
  test('JCS gives identical UTF-8 bytes and identical failures', () => {
    for (const value of [null, true, -0, 1e-8, [1, undefined, 'a'], {z: '☕\n', a: {y: 1e30, x: false}, optional: undefined}, {'😀': 1, '\uE000': 2}, Object.assign(Object.create(null), {b: 2, a: 1})]) {
      expect(new TextEncoder().encode(canonicalize(value))).toEqual(new TextEncoder().encode(serverCanonicalize(value)))
    }
    for (const value of [NaN, Infinity, 1n, new Date(), '\ud800', undefined]) {
      expect(() => canonicalize(value)).toThrow()
      expect(() => serverCanonicalize(value)).toThrow()
    }
  })

  test('action evidence, defaults, binary content, and Unicode are bound identically', () => {
    const basic: PartyAction = {actionId: '123', contractId: 'deal', milestoneId: null, partyId: 'alice', action: 'submit_for_acceptance'}
    const actions: PartyAction[] = [basic,
      {...basic, action: 'deliver', milestoneId: 'milestone', evidence: [{type: 'content_file', content: 'café\n☕'}]},
      {...basic, action: 'dispute', reason: 'Wrong file', evidence: [{type: 'note', content: new Uint8Array([0, 255, 128]), mediaType: 'text/plain', signer: {id: 'inspector', signatureHex: 'aa'}}]},
    ]
    const seed = new Uint8Array(32).fill(7)
    const publicKeyHex = hex(ed25519.getPublicKey(seed))
    for (const action of actions) {
      const bytes = partyActionBytes(action)
      expect(new TextEncoder().encode(bytes)).toEqual(new TextEncoder().encode(serverPartyActionBytes(action)))
      const signature = hex(ed25519.sign(new TextEncoder().encode(bytes), seed))
      expect(verifyBytes(publicKeyHex, serverPartyActionBytes(action), signature)).toBe(true)
      expect(verifyBytes(publicKeyHex, bytes + ' ', signature)).toBe(false)
    }
  })

  test('the wallet deterministically derives a site and account bound deal key, signs terms, and destroys its seed', async () => {
    const wallet = walletFromPhrase(phrase)
    expect(dealKeyMessage('alice', 'app.example')).toBe('Tally deal key v1\nAccount: alice\nSite: app.example\nThis creates your Tally deal signing key. It moves no funds. Sign this only on app.example.')
    const key = await deriveDealKey(session, me, wallet)
    const again = await deriveDealKey(session, me, walletFromPhrase(phrase))
    const otherSite = await deriveDealKey(session, {...me, signInDomain: 'other.example'}, wallet)
    const otherAccount = await deriveDealKey(session, {...me, entityId: 'bob'}, wallet)
    try {
      expect(key.publicKeyHex).toBe(again.publicKeyHex)
      expect(key.publicKeyHex).not.toBe(otherSite.publicKeyHex)
      expect(key.publicKeyHex).not.toBe(otherAccount.publicKeyHex)
      const termsBytes = canonicalize({buyer: 'alice', seller: 'bob', testFunds: true})
      const terms = {termsBytes, termsSha256: hex(sha256(new TextEncoder().encode(termsBytes)))}
      expect(verifyBytes(key.publicKeyHex, termsBytes, signTerms(key, terms))).toBe(true)
      expect(() => signTerms(key, {...terms, termsBytes: termsBytes + ' '})).toThrow('displayed hash')
      const signed = wallet.signMessage(dealKeyMessage(me.entityId, me.signInDomain)).signature
      const rawSignature = Uint8Array.from(signed.slice(-128).match(/../g)!, (pair) => parseInt(pair, 16))
      expect(seedFromCose(signed)).toEqual(sha256(rawSignature))
      await expect(deriveDealKey(session, {...me, party: {publicKeyHex: '00'.repeat(32), cardanoAddress: wallet.address}}, wallet)).rejects.toThrow('original wallet')
    } finally {
      key.destroy(); again.destroy(); otherSite.destroy(); otherAccount.destroy()
    }
    expect(() => key.sign('after destruction')).toThrow('again')
    expect(() => seedFromCose('5840' + '00'.repeat(64))).toThrow()
    expect(() => seedFromCose('84' + '5840' + 'zz'.repeat(64))).toThrow()
  })
})
