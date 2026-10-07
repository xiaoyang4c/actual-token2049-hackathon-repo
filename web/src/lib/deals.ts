/** Session-gated deals and wallet-derived, memory-only Ed25519 signing. */

import {ed25519} from '@noble/curves/ed25519.js'
import {sha256} from '@noble/hashes/sha2.js'
import {AccountApiError, savedSession, signOut, type Session} from './account'
import type {AuditRow, ContractAnchors, ContractSummary, ContractView, DisputeCase, Role} from './api'
import {hex, type BrowserWallet} from './cardano-keys'
import {addressToBech32, connect, signInAddress, utf8Hex} from './cip30'

const SERVER = ((import.meta.env.VITE_TALLY_SERVER_URL as string | undefined) ?? (import.meta.env.VITE_COWORKER_ASK_URL as string | undefined) ?? '').replace(/\/$/, '')

export interface AppMe {
  entityId: string
  displayName: string
  signInDomain: string
  party: {publicKeyHex: string; cardanoAddress: string | null} | null
  mode: 'paper' | 'live'
  readiness: {wallet: boolean; kyc: boolean; kycMessage: string; dealKey: boolean; deposit: boolean; depositRequired: boolean; canTrade: boolean; next: string[]}
}

export type PartyActionType = 'submit_for_acceptance' | 'cancel' | 'deliver' | 'accept' | 'dispute' | 'concede_refund' | 'escalate' | 'submit_judge_report' | 'comply_with_ruling' | 'record_return_shipment' | 'confirm_return_received' | 'redeliver' | 'accept_redo' | 'reject_redo'
export interface EvidenceInput {
  type: string
  content: string | Uint8Array
  mediaType?: string
  signer?: {id: string; signatureHex: string}
}
export interface PartyAction {
  actionId: string
  contractId: string
  milestoneId: string | null
  partyId: string
  action: PartyActionType
  evidence?: EvidenceInput[]
  reason?: string
}
export interface CreateDeal {
  templateId: string
  role: Role
  counterpartyId: string
  milestones: Array<{title: string; amountAtomic: string; deliverable: Record<string, unknown>}>
  remedy?: {type: string; sellerShareBps?: number}
}

async function call<T>(session: Session, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${SERVER}/reliability/app/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {authorization: `Bearer ${session.token}`, ...(body === undefined ? {} : {'content-type': 'application/json'})},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    cache: 'no-store',
  })
  const result = await response.json().catch(() => ({})) as {error?: string; code?: string}
  if (!response.ok) {
    // A bad deal signature also returns 401. Only an expired session signs out.
    if (result.code === 'unauthorized' && savedSession()?.token === session.token) await signOut(null)
    throw new AccountApiError(result.error ?? `${response.status} ${response.statusText}`, response.status, result.code)
  }
  return result as T
}

const idQuery = (id: string) => new URLSearchParams({id}).toString()

export const deals = {
  me: (session: Session) => call<AppMe>(session, 'me'),
  register: (session: Session, key: {publicKeyHex: string; cardanoAddress: string}) => call(session, 'party', key),
  contracts: (session: Session) => call<ContractSummary[]>(session, 'contracts'),
  contract: (session: Session, id: string) => call<ContractView>(session, `contract?${idQuery(id)}`),
  terms: (session: Session, id: string) => call<{termsSha256: string; termsBytes: string}>(session, `contract/terms?${idQuery(id)}`),
  audit: (session: Session, id: string) => call<{rows: AuditRow[]; chainIntact: boolean}>(session, `contract/audit?${idQuery(id)}`),
  disputeCase: (session: Session, id: string, milestone: number) => call<DisputeCase>(session, `contract/case?${new URLSearchParams({id, milestone: String(milestone)})}`),
  anchors: (session: Session, id: string) => call<ContractAnchors>(session, `contract/anchors?${idQuery(id)}`),
  create: (session: Session, request: CreateDeal) => call<ContractView>(session, 'contracts', request),
  sign: (session: Session, contractId: string, signatureHex: string) => call<ContractView>(session, 'sign', {contractId, signatureHex}),
  action: (session: Session, action: PartyAction, signatureHex: string) => call<ContractView>(session, 'action', {
    action: {...action, evidence: action.evidence?.map(({content, ...item}) => ({
      ...item, ...(typeof content === 'string' ? {contentText: content} : {contentBase64: base64(content)}),
    }))}, signatureHex,
  }),
}

function base64(bytes: Uint8Array): string {
  let text = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return btoa(text)
}

const sha256Hex = (content: string | Uint8Array) => hex(sha256(typeof content === 'string' ? new TextEncoder().encode(content) : content))

/** Serializes a JSON value in canonical form. Rejects values JCS cannot represent. */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('JCS rejects non-finite numbers');
      // ECMAScript Number-to-String is the RFC 8785 section 3.2.2.3 serialization.
      return JSON.stringify(value);
    case 'string':
      return serializeString(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => (item === undefined ? 'null' : canonicalize(item))).join(',')}]`;
      }
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('JCS accepts plain objects only; convert dates and bigints to strings');
      }
      const record = value as {[key: string]: unknown};
      // The default sort compares UTF-16 code units, as RFC 8785 section 3.2.3 requires.
      const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
      return `{${keys.map((key) => `${serializeString(key)}:${canonicalize(record[key])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`JCS rejects the type ${typeof value}`);
  }
}

function serializeString(text: string): string {
  if (!text.isWellFormed()) throw new TypeError('JCS rejects a lone surrogate');
  // JSON.stringify escapes the RFC 8785 section 3.2.2.2 characters with lowercase hex.
  return JSON.stringify(text);
}

/** Exact port of the engine's contract-party-action.v1 signing bytes. */
export function partyActionBytes(action: PartyAction): string {
  return canonicalize({
    schema: 'contract-party-action.v1',
    actionId: action.actionId,
    contractId: action.contractId,
    milestoneId: action.milestoneId,
    partyId: action.partyId,
    action: action.action,
    reason: action.reason ?? null,
    evidence: (action.evidence ?? []).map((item) => ({
      type: item.type,
      mediaType: item.mediaType ?? 'application/octet-stream',
      sha256: sha256Hex(item.content),
      signerId: item.signer?.id ?? null,
      signerSignatureHex: item.signer?.signatureHex ?? null,
    })),
  });
}

export function dealKeyMessage(entityId: string, domain: string): string {
  return `Tally deal key v1\nAccount: ${entityId}\nSite: ${domain}\nThis creates your Tally deal signing key. It moves no funds. Sign this only on ${domain}.`
}

/** CIP-8 COSE_Sign1 ends with the 64-byte Ed25519 signature (58 40). */
export function seedFromCose(signatureHex: string): Uint8Array {
  if (!/^(?:84|d284)[0-9a-f]+$/i.test(signatureHex) || signatureHex.length % 2) throw new Error('The wallet returned an invalid COSE_Sign1 signature.')
  const signature = /5840([0-9a-f]{128})$/i.exec(signatureHex)?.[1]
  if (!signature) throw new Error('The wallet must return a 64-byte Ed25519 signature.')
  return sha256(Uint8Array.from(signature.match(/../g)!, (pair) => parseInt(pair, 16)))
}

export interface DealKey {
  publicKeyHex: string
  cardanoAddress: string
  sign: (bytes: string) => string
  destroy: () => void
}

/** Derives for one action. The caller destroys the seed in a finally block. */
export async function deriveDealKey(session: Session, me: AppMe, browserWallet?: BrowserWallet): Promise<DealKey> {
  const message = dealKeyMessage(me.entityId, me.signInDomain)
  let signature: string
  let cardanoAddress: string
  if (session.via === 'browser') {
    if (!browserWallet) throw new Error('Unlock this device’s wallet to sign.')
    signature = browserWallet.signMessage(message).signature
    cardanoAddress = browserWallet.address
  } else {
    const api = await connect(session.via.replace(/^cip30:/, ''))
    const address = await signInAddress(api)
    signature = (await api.signData(address.hex, utf8Hex(message))).signature
    cardanoAddress = addressToBech32(await api.getChangeAddress())
  }
  if (!cardanoAddress.startsWith('addr_test1')) throw new Error('Use a Cardano preprod payout address (addr_test1…).')
  const seed = seedFromCose(signature)
  const publicKeyHex = hex(ed25519.getPublicKey(seed))
  if (me.party && (me.party.publicKeyHex !== publicKeyHex || me.party.cardanoAddress !== cardanoAddress)) {
    seed.fill(0)
    throw new Error('A different deal key or payout address is registered for this account. Use the original wallet and payout address. Deal keys cannot be replaced.')
  }
  let destroyed = false
  return {
    publicKeyHex, cardanoAddress,
    sign: (bytes) => {
      if (destroyed) throw new Error('Unlock deal signing again.')
      return hex(ed25519.sign(new TextEncoder().encode(bytes), seed))
    },
    destroy: () => { seed.fill(0); destroyed = true },
  }
}

/** Verifies the displayed hash before signing the server's UTF-8 canonical terms. */
export function signTerms(key: DealKey, terms: {termsSha256: string; termsBytes: string}): string {
  if (sha256Hex(terms.termsBytes) !== terms.termsSha256) throw new Error('The terms do not match their displayed hash. Reload the deal.')
  return key.sign(terms.termsBytes)
}
