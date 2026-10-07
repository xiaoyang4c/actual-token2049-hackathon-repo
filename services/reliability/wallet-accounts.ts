/**
 * @fileoverview Wallet accounts. A person signs in with a Cardano wallet:
 * Tally sends a one-time message, the wallet signs it, and Tally checks the
 * signature. The first sign-in creates a marketplace entity for that wallet.
 * Later sign-ins with any proven wallet of the entity open the same account.
 *
 * Tally never holds a wallet key. A browser wallet (Lace, Eternl) keeps its
 * own keys. A wallet that the Tally website creates keeps its keys in the
 * user's browser and recovery phrase. Read docs/wallets.md.
 */

import {createHash, randomBytes} from 'node:crypto';
import type {AgentStore, WalletProofRow} from '../../packages/db/src/index';
import {checkKyc, type KycGateResult} from '../../packages/reliability/src/kyc-gate';
import {KycFlowError, MockKycProvider, type KycCheckInput, type KycView} from '../../packages/reliability/src/index';
import {addressKeyHashes} from './deposit-chain';
import {addressCredential, verifyWalletSignature, WalletProofError} from './wallet-proof';

export const CHALLENGE_TTL_MS = 10 * 60_000;
export const SESSION_TTL_MS = 24 * 3_600_000;
/** The website that asks for a signature. Wallet users can compare it with the site they are on. */
export const DEFAULT_SIGN_IN_DOMAIN = 'tally-origins.vercel.app';
/** Open challenges above this count are refused, so a flood cannot fill the table. */
const MAX_OPEN_CHALLENGES = 5_000;

export type AccountErrorCode =
  'bad_input'|'invalid_address'|'invalid_signature'|'wrong_message'|'wrong_key'|'challenge_unknown'|
  'challenge_expired'|'challenge_used'|'wallet_in_use'|'unauthorized'|'busy'|'kyc_failed'|'rate_limited'|
  'deposit_rejected';

export class AccountError extends Error {
  constructor(readonly code: AccountErrorCode, message: string, readonly status = 400) {
    super(message);
    this.name = 'AccountError';
  }
}

export interface WalletView {
  address: string;
  credentialKind: 'stake'|'payment';
  source: 'cip30'|'browser';
  walletName: string|null;
  verifiedAt: string;
}

/** What still stops this account from trading, in order. */
export interface Readiness {
  wallet: boolean;
  kyc: boolean;
  kycMessage: string;
  deposit: boolean;
  canTrade: boolean;
  next: string[];
}

export interface AccountOptions {
  now?: () => number;
  /** The website domain named in the sign-in message. */
  domain?: string;
  /** Seeded ids and tokens for tests. */
  random?: (bytes: number) => Buffer;
}

export interface VerifyInput {
  challengeId: string;
  address: string;
  signature: string;
  key: string;
  source: 'cip30'|'browser';
  walletName?: string;
  displayName?: string;
  kind?: 'person'|'business';
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function walletView(row: WalletProofRow): WalletView {
  return {address: row.address, credentialKind: row.credentialKind, source: row.source, walletName: row.walletName, verifiedAt: row.verifiedAt};
}

export class WalletAccounts {
  readonly kyc: MockKycProvider;
  private readonly now: () => number;
  private readonly random: (bytes: number) => Buffer;
  private readonly domain: string;

  constructor(private readonly store: AgentStore, options: AccountOptions = {}) {
    this.kyc = new MockKycProvider(new Map(), {store});
    this.now = options.now ?? Date.now;
    this.random = options.random ?? randomBytes;
    this.domain = options.domain ?? DEFAULT_SIGN_IN_DOMAIN;
  }

  /** A one-time message for `address` to sign. */
  challenge(address: string): {challengeId: string; message: string; expiresAt: string} {
    addressCredentialOrThrow(address);
    const now = this.now();
    if (this.store.pruneWalletChallenges(now) >= MAX_OPEN_CHALLENGES) {
      throw new AccountError('busy', 'Too many sign-ins are waiting. Try again in a few minutes.', 503);
    }
    const id = this.random(16).toString('hex');
    const expiresAt = now + CHALLENGE_TTL_MS;
    // Like Sign-In with Ethereum (EIP-4361): the message names the site, so a
    // signature asked for by another site is easy to notice.
    const message = [
      `${this.domain} asks you to sign in to Tally.`,
      'This proves that you control this wallet. It does not move funds or approve a payment.',
      `Sign it only on https://${this.domain}.`,
      '',
      `Address: ${address}`,
      `Nonce: ${id}`,
      `Issued: ${new Date(now).toISOString()}`,
      `Expires: ${new Date(expiresAt).toISOString()}`,
    ].join('\n');
    this.store.insertWalletChallenge({id, address, message, createdAt: now, expiresAt});
    return {challengeId: id, message, expiresAt: new Date(expiresAt).toISOString()};
  }

  /**
   * Checks the signed challenge. A known wallet signs in to its entity. A
   * new payment key can join an account with a proven stake key only with
   * that account's session. A new wallet with a session joins its entity.
   * Otherwise a new entity is created. Returns a session token. Only its hash
   * is stored.
   */
  verify(input: VerifyInput, sessionEntityId?: string): {token: string; expiresAt: string; entityId: string; created: boolean} {
    const now = this.now();
    const challenge = this.store.getWalletChallenge(input.challengeId);
    if (!challenge || challenge.address !== input.address) throw new AccountError('challenge_unknown', 'Ask for a new sign-in message.');
    if (challenge.usedAt !== null) throw new AccountError('challenge_used', 'This sign-in message was already used. Ask for a new one.');
    if (challenge.expiresAt < now) throw new AccountError('challenge_expired', 'This sign-in message expired. Ask for a new one.');
    let proof;
    try {
      proof = verifyWalletSignature({address: input.address, signatureHex: input.signature, keyHex: input.key, message: challenge.message});
    } catch (error) {
      if (error instanceof WalletProofError) throw new AccountError(error.code, error.message);
      throw error;
    }
    const at = new Date(now).toISOString();
    return this.store.transaction(() => {
      if (!this.store.useWalletChallenge(challenge.id, now)) throw new AccountError('challenge_used', 'This sign-in message was already used. Ask for a new one.');
      const known = this.store.getWalletProofByCredential(proof.credentialHash);
      // A base address can contain any public stake hash. Its payment-key
      // signature does not prove control of that stake key.
      const stakeHash = !known && proof.credentialKind === 'payment' ? addressKeyHashes(input.address).stake : undefined;
      const stakeProof = stakeHash ? this.store.getWalletProofByCredential(stakeHash) : undefined;
      const coveredBy = stakeProof?.credentialKind === 'stake' ? stakeProof : undefined;
      let entityId: string;
      let created = false;
      if (known) {
        if (sessionEntityId && sessionEntityId !== known.entityId) {
          throw new AccountError('wallet_in_use', 'This wallet belongs to another Tally account.', 409);
        }
        entityId = known.entityId;
      } else if (coveredBy) {
        if (!sessionEntityId) {
          throw new AccountError('unauthorized', 'Sign in with the stake key before you add this payment key.', 401);
        }
        const owner = this.store.getWalletEntityId(input.address);
        if ((sessionEntityId && sessionEntityId !== coveredBy.entityId) || (owner && owner !== coveredBy.entityId)) {
          throw new AccountError('wallet_in_use', 'This wallet belongs to another Tally account.', 409);
        }
        entityId = coveredBy.entityId;
        if (!owner) this.store.addWallet(entityId, input.address, at);
        this.store.insertWalletProof({
          address: input.address, entityId, credentialKind: proof.credentialKind, credentialHash: proof.credentialHash,
          publicKeyHex: proof.publicKeyHex, source: input.source, walletName: cleanName(input.walletName) ?? null,
          challengeId: challenge.id, verifiedAt: at,
        });
      } else {
        const owner = this.store.getWalletEntityId(input.address);
        if (owner && owner !== sessionEntityId) {
          throw new AccountError('wallet_in_use', 'This address is attached to another Tally account. Ask an operator to release it.', 409);
        }
        if (sessionEntityId) {
          entityId = sessionEntityId;
          if (!owner) this.store.addWallet(entityId, input.address, at);
        } else {
          entityId = `acct-${this.random(6).toString('hex')}`;
          const displayName = cleanName(input.displayName) ?? 'New Tally account';
          const base = {id: entityId, displayName, roles: ['buyer', 'seller'], wallets: [input.address], at};
          this.kyc.registerEntity(input.kind === 'business' ? {...base, kind: 'business'} : {...base, kind: 'person'});
          created = true;
        }
        this.store.insertWalletProof({
          address: input.address, entityId, credentialKind: proof.credentialKind, credentialHash: proof.credentialHash,
          publicKeyHex: proof.publicKeyHex, source: input.source, walletName: cleanName(input.walletName) ?? null,
          challengeId: challenge.id, verifiedAt: at,
        });
      }
      const token = this.random(32).toString('base64url');
      const expiresAt = now + SESSION_TTL_MS;
      this.store.insertSession({tokenHash: hashToken(token), entityId, address: input.address, createdAt: now, expiresAt});
      return {token, expiresAt: new Date(expiresAt).toISOString(), entityId, created};
    });
  }

  /** The entity of a live session, or an error. */
  sessionEntity(token: string|null): string {
    if (!token) throw new AccountError('unauthorized', 'Sign in with your wallet first.', 401);
    const session = this.store.getSession(hashToken(token));
    if (!session || session.revokedAt !== null || session.expiresAt < this.now()) {
      throw new AccountError('unauthorized', 'Your session ended. Sign in with your wallet again.', 401);
    }
    return session.entityId;
  }

  signOut(token: string): void {
    this.store.revokeSession(hashToken(token), this.now());
  }

  /**
   * Mock KYC for the signed-in entity. The mock vendor answers at once, so
   * the check is submitted and resolved in one step. Read docs/kyc.md.
   */
  submitKyc(entityId: string, input: {kind: 'person'; documentId: string; addressChecked?: boolean}|{kind: 'business'; registrationNumber: string; beneficialOwnerDocumentId?: string}): KycView {
    const at = new Date(this.now()).toISOString();
    try {
      this.kyc.submitCheck({...input, entityId, at} as KycCheckInput);
      return this.kyc.resolveCheck(entityId, at);
    } catch (error) {
      if (error instanceof KycFlowError) throw new AccountError('kyc_failed', error.message);
      throw error;
    }
  }

  wallets(entityId: string): WalletView[] {
    return this.store.listWalletProofs(entityId).map(walletView);
  }

  /** The KYC gate result that every sale and contract also reads. */
  kycGate(entityId: string): KycGateResult {
    const entity = this.store.getEntity(entityId);
    const profile = entity ? this.store.getKycProfile(entityId) : undefined;
    const reRegisteredFrom = profile?.reRegistrationOf ? this.store.getEntity(profile.reRegistrationOf) : undefined;
    return checkKyc({entityId, entity, profile, reRegisteredFrom}, new Date(this.now()).toISOString());
  }

  readiness(entityId: string, hasDeposit: boolean): Readiness {
    const wallet = this.store.listWalletProofs(entityId).length > 0;
    const gate = this.kycGate(entityId);
    const next: string[] = [];
    if (!wallet) next.push('Connect or create a wallet.');
    if (!gate.passed) next.push('Finish identity checks (KYC).');
    if (!hasDeposit) next.push('Deposit test USDM or test ADA to fund a live deal.');
    return {wallet, kyc: gate.passed, kycMessage: gate.message, deposit: hasDeposit, canTrade: wallet && gate.passed, next};
  }
}

function addressCredentialOrThrow(address: unknown): void {
  if (typeof address !== 'string' || address.length > 200) throw new AccountError('bad_input', 'address must be a bech32 string');
  try {
    addressCredential(address);
  } catch (error) {
    if (error instanceof WalletProofError) throw new AccountError(error.code, error.message);
    throw error;
  }
}

function cleanName(value: string|undefined): string|undefined {
  const name = value?.replace(/\s+/g, ' ').trim().slice(0, 80);
  return name ? name : undefined;
}
