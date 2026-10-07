/**
 * @fileoverview Wallet sign-in, the signed-in account, its mock KYC, and live
 * preprod deposits. Every account route except the two sign-in routes needs
 * `Authorization: Bearer <session token>` from POST /reliability/wallets/verify.
 * Read docs/wallets.md.
 */

import type {AgentStore} from '../../packages/db/src/index';
import {json, readJson} from '../lib/http';
import {depositSettingsFromEnv, type DepositSettings} from './deposit-chain';
import type {ReliabilityRoute} from './routes-plumbing';
import {RateLimiter} from './rate-limit';
import {AccountError, WalletAccounts} from './wallet-accounts';
import {WalletDeposits, type DepositSource} from './wallet-deposits';

interface AccountServices {
  accounts: WalletAccounts;
  deposits: WalletDeposits;
}

const services = new WeakMap<AgentStore, AccountServices>();
let settings: DepositSettings|null = null;

/** Replaces the deposit settings. Tests use it before the first request. */
export function setDepositSettings(next: DepositSettings): void {
  settings = next;
}

function servicesFor(store: AgentStore): AccountServices {
  const existing = services.get(store);
  if (existing) return existing;
  settings ??= depositSettingsFromEnv(process.env);
  const created = {
    accounts: new WalletAccounts(store, {domain: process.env.TALLY_SIGN_IN_DOMAIN?.trim() || undefined}),
    deposits: new WalletDeposits(store, settings),
  };
  services.set(store, created);
  return created;
}

/** Limits per visitor in 10 minutes. ui/server.ts sets x-tally-visitor to the visitor's address. */
const WINDOW_MS = 10 * 60_000;
const LIMITS = {
  signIn: new RateLimiter(20, WINDOW_MS),
  read: new RateLimiter(300, WINDOW_MS),
  kyc: new RateLimiter(10, WINDOW_MS),
  deposit: new RateLimiter(20, WINDOW_MS),
};

function limit(request: Request, limiter: RateLimiter): void {
  const visitor = request.headers.get('x-tally-visitor')?.slice(0, 100) || 'direct';
  const wait = limiter.take(visitor);
  if (wait) throw new AccountError('rate_limited', `Too many requests. Try again in ${wait} seconds.`, 429);
}

const bearer = (request: Request) => /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? null;

async function body(request: Request): Promise<{[key: string]: unknown}> {
  let value: unknown;
  try {
    value = await readJson<unknown>(request);
  } catch {
    throw new AccountError('bad_input', 'Send a JSON object.');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new AccountError('bad_input', 'Send a JSON object.');
  return value as {[key: string]: unknown};
}

function text(input: {[key: string]: unknown}, key: string, required = true): string|undefined {
  const value = input[key];
  // A blank optional field counts as missing.
  if (!required && (value === undefined || value === null || (typeof value === 'string' && !value.trim()))) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new AccountError('bad_input', `${key} must be a non-empty string`);
  return value.trim();
}

async function handle(work: () => unknown): Promise<Response> {
  try {
    return json(await work());
  } catch (error) {
    if (error instanceof AccountError) return json({error: error.message, code: error.code}, error.status);
    // Chain errors name the path and status only, never a key.
    if (error instanceof Error && error.message.startsWith('Blockfrost')) return json({error: error.message, code: 'chain_unavailable'}, 502);
    throw error;
  }
}

function account(store: AgentStore, entityId: string) {
  const {accounts, deposits} = servicesFor(store);
  const entity = store.getEntity(entityId);
  const kyc = accounts.kyc.view(entityId);
  return {
    entity: {id: entityId, displayName: entity?.displayName ?? entityId, kind: kyc.subjectKind},
    wallets: accounts.wallets(entityId),
    kyc,
    deposits: deposits.view(entityId),
    readiness: accounts.readiness(entityId, deposits.hasConfirmedDeposit(entityId)),
  };
}

export const accountRoutes: ReliabilityRoute[] = [
  {
    method: 'POST',
    path: '/reliability/wallets/challenge',
    handler: async (request, url, store) => handle(async () => {
      limit(request, LIMITS.signIn);
      const input = await body(request);
      return servicesFor(store).accounts.challenge(text(input, 'address') as string);
    }),
  },
  {
    method: 'POST',
    path: '/reliability/wallets/verify',
    handler: async (request, url, store) => handle(async () => {
      limit(request, LIMITS.signIn);
      const input = await body(request);
      const {accounts} = servicesFor(store);
      const token = bearer(request);
      const sessionEntityId = token ? accounts.sessionEntity(token) : undefined;
      const source = input.source === 'browser' ? 'browser' : input.source === 'cip30' ? 'cip30' : null;
      if (!source) throw new AccountError('bad_input', 'source must be cip30 or browser');
      const signedIn = accounts.verify({
        challengeId: text(input, 'challengeId') as string,
        address: text(input, 'address') as string,
        signature: text(input, 'signature') as string,
        key: text(input, 'key') as string,
        source,
        walletName: text(input, 'walletName', false),
        displayName: text(input, 'displayName', false),
        kind: input.kind === 'business' ? 'business' : 'person',
      }, sessionEntityId);
      return {session: signedIn.token, expiresAt: signedIn.expiresAt, created: signedIn.created, account: account(store, signedIn.entityId)};
    }),
  },
  {
    method: 'GET',
    path: '/reliability/account',
    handler: async (request, url, store) => handle(() => {
      limit(request, LIMITS.read);
      return account(store, servicesFor(store).accounts.sessionEntity(bearer(request)));
    }),
  },
  {
    method: 'POST',
    path: '/reliability/account/kyc',
    handler: async (request, url, store) => handle(async () => {
      limit(request, LIMITS.kyc);
      const {accounts} = servicesFor(store);
      const entityId = accounts.sessionEntity(bearer(request));
      const input = await body(request);
      if (input.kind === 'business') {
        accounts.submitKyc(entityId, {
          kind: 'business', registrationNumber: text(input, 'registrationNumber') as string,
          beneficialOwnerDocumentId: text(input, 'beneficialOwnerDocumentId', false),
        });
      } else {
        accounts.submitKyc(entityId, {kind: 'person', documentId: text(input, 'documentId') as string, addressChecked: input.addressChecked === true});
      }
      return account(store, entityId);
    }),
  },
  {
    method: 'POST',
    path: '/reliability/account/sign-out',
    handler: async (request, url, store) => handle(() => {
      const token = bearer(request);
      if (token) servicesFor(store).accounts.signOut(token);
      return {signedOut: true};
    }),
  },
  {
    method: 'POST',
    path: '/reliability/account/deposits/build',
    handler: async (request, url, store) => handle(async () => {
      limit(request, LIMITS.deposit);
      const {accounts, deposits} = servicesFor(store);
      const entityId = accounts.sessionEntity(bearer(request));
      const input = await body(request);
      const from = input.from as {[key: string]: unknown}|undefined;
      const source: DepositSource = from?.kind === 'browser' ?
        {kind: 'browser', address: String(from.address ?? '')} :
        {kind: 'cip30', utxos: from?.utxos as string[], changeAddress: String(from?.changeAddress ?? '')};
      return deposits.build(entityId, input.amounts, source);
    }),
  },
  {
    method: 'POST',
    path: '/reliability/account/deposits/submit',
    handler: async (request, url, store) => handle(async () => {
      limit(request, LIMITS.deposit);
      const {accounts, deposits} = servicesFor(store);
      const entityId = accounts.sessionEntity(bearer(request));
      const input = await body(request);
      return deposits.submit(entityId, input.buildId, input.witnessSet);
    }),
  },
];
