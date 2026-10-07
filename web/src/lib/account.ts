/*
 * Client for wallet sign-in, the signed-in account, mock KYC, and live
 * preprod deposits (/reliability/wallets/* and /reliability/account/*).
 * The session token is a per-device convenience in localStorage. Read
 * docs/wallets.md.
 */

import {connect, signInAddress, utf8Hex, type Cip30Api} from './cip30'
import {APP_EDITION} from './edition'
import {walletFromPhrase, type BrowserWallet} from './cardano-keys'

/** The Tally server. Empty means this origin (the Vite proxy or ui/server.ts). */
const SERVER = ((import.meta.env.VITE_TALLY_SERVER_URL as string | undefined) ?? (import.meta.env.VITE_COWORKER_ASK_URL as string | undefined) ?? '').replace(/\/$/, '')
const SESSION_KEY = 'tally-session'

export interface Session {
  token: string
  expiresAt: string
  /** `cip30:<wallet id>` or `browser`. Deposits sign with the same wallet. */
  via: string
}

export interface WalletRow {
  address: string
  credentialKind: 'stake' | 'payment'
  source: 'cip30' | 'browser'
  walletName: string | null
  verifiedAt: string
}

export interface DepositRow {
  txHash: string
  outputIndex: number
  unit: string
  quantity: string
  status: 'pending' | 'confirmed' | 'unattributed' | 'rolled_back'
  blockHeight: number | null
  note: string | null
}

export interface AccountView {
  entity: {id: string; displayName: string; kind: 'person' | 'business' | null}
  wallets: WalletRow[]
  kyc: {status: string; tier: string; badge: string; countsAsVerified: boolean; checkPending: boolean; submittedChecks: string[]}
  deposits: {
    enabled: boolean
    mode: 'live'
    network: 'preprod'
    depositAddress: string | null
    confirmations: number
    balances: Array<{unit: string; label: string; decimals: number; quantity: string}>
    deposits: DepositRow[]
    submissions: Array<{txHash: string; amounts: Array<{unit: string; quantity: string}>; submittedAt: number}>
  }
  readiness: {wallet: boolean; kyc: boolean; kycMessage: string; deposit: boolean; canTrade: boolean; next: string[]}
}

export class AccountApiError extends Error {
  readonly status: number
  readonly code: string | undefined

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function call<T>(path: string, init: {method?: string; body?: unknown; token?: string} = {}): Promise<T> {
  const response = await fetch(`${SERVER}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(init.body === undefined ? {} : {'content-type': 'application/json'}),
      ...(init.token ? {authorization: `Bearer ${init.token}`} : {}),
    },
    ...(init.body === undefined ? {} : {body: JSON.stringify(init.body)}),
    cache: 'no-store',
  })
  const body = await response.json().catch(() => ({})) as {error?: string; code?: string}
  if (!response.ok) throw new AccountApiError(body.error ?? `${response.status} ${response.statusText}`, response.status, body.code)
  return body as T
}

export function savedSession(): Session | null {
  try {
    const session = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as Session | null
    return session && Date.parse(session.expiresAt) > Date.now() ? session : null
  } catch {
    return null
  }
}

function saveSession(session: Session | null) {
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session))
    else localStorage.removeItem(SESSION_KEY)
  } catch { /* storage unavailable: the session lasts until the page closes */ }
  if (APP_EDITION) window.dispatchEvent(new CustomEvent('tally-session-changed', {detail: session}))
}

export interface Profile {
  displayName?: string
  kind?: 'person' | 'business'
}

interface Verified {
  session: string
  expiresAt: string
  created: boolean
  account: AccountView
}

async function finishSignIn(address: string, sign: (message: string) => Promise<{signature: string; key: string}>, source: 'cip30' | 'browser', via: string, profile: Profile, current: Session | null, walletName?: string) {
  const challenge = await call<{challengeId: string; message: string}>('/reliability/wallets/challenge', {body: {address}})
  const signed = await sign(challenge.message)
  const verified = await call<Verified>('/reliability/wallets/verify', {
    body: {
      challengeId: challenge.challengeId, address, ...signed, source, walletName,
      ...(profile.displayName?.trim() ? {displayName: profile.displayName.trim()} : {}), ...(profile.kind ? {kind: profile.kind} : {}),
    },
    token: current?.token,
  })
  const session: Session = {token: verified.session, expiresAt: verified.expiresAt, via: current?.via ?? via}
  saveSession(session)
  return {session, account: verified.account, created: verified.created}
}

/** Signs in with a browser wallet extension, or adds it to the current account. */
export async function signInWithExtension(id: string, profile: Profile, current: Session | null) {
  const api = await connect(id)
  const address = await signInAddress(api)
  return finishSignIn(address.bech32, (message) => api.signData(address.hex, utf8Hex(message)), 'cip30', `cip30:${id}`, profile, current, id)
}

/** Signs in with a wallet that lives in this browser. */
export async function signInWithPhrase(phrase: string, profile: Profile, current: Session | null) {
  const wallet = walletFromPhrase(phrase)
  return finishSignIn(wallet.rewardAddress, async (message) => wallet.signMessage(message), 'browser', 'browser', profile, current)
}

export const readAccount = (session: Session) => call<AccountView>('/reliability/account', {token: session.token})

export const submitKyc = (session: Session, body: {kind: 'person'; documentId: string; addressChecked?: boolean} | {kind: 'business'; registrationNumber: string; beneficialOwnerDocumentId?: string}) =>
  call<AccountView>('/reliability/account/kyc', {body, token: session.token})

export async function signOut(session: Session | null) {
  saveSession(null)
  if (session) await call('/reliability/account/sign-out', {body: {}, token: session.token}).catch(() => undefined)
}

/** Converts "12.5" with 6 decimals to "12500000". Null when it is not a positive amount. */
export function toAtomic(text: string, decimals: number): string | null {
  const match = /^\s*(\d+)(?:\.(\d+))?\s*$/.exec(text)
  if (!match || (match[2]?.length ?? 0) > decimals) return null
  const atomic = BigInt(match[1]! + (match[2] ?? '').padEnd(decimals, '0'))
  return atomic > 0n ? atomic.toString() : null
}

export function fromAtomic(quantity: string, decimals: number): string {
  if (!decimals) return quantity
  const padded = quantity.padStart(decimals + 1, '0')
  const whole = padded.slice(0, -decimals)
  const fraction = padded.slice(-decimals).replace(/0+$/, '')
  return `${BigInt(whole).toLocaleString('en-US')}${fraction ? `.${fraction}` : ''}`
}

/** Sends a live deposit to the Tally deposit address and returns its transaction id. */
export async function deposit(session: Session, amounts: Array<{unit: string; quantity: string}>, signer: {kind: 'cip30'; api: Cip30Api} | {kind: 'browser'; wallet: BrowserWallet}) {
  const from = signer.kind === 'browser' ?
    {kind: 'browser', address: signer.wallet.address} :
    {kind: 'cip30', utxos: (await signer.api.getUtxos()) ?? [], changeAddress: await signer.api.getChangeAddress()}
  const built = await call<{buildId: string; txHash: string; cborHex: string}>('/reliability/account/deposits/build', {body: {amounts, from}, token: session.token})
  const witnessSet = signer.kind === 'browser' ? signer.wallet.witnessFor(built.txHash) : await signer.api.signTx(built.cborHex, true)
  return call<{txHash: string}>('/reliability/account/deposits/submit', {body: {buildId: built.buildId, witnessSet}, token: session.token})
}

export {connect}
