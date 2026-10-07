/**
 * @fileoverview Live preprod deposits for signed-in accounts.
 *
 * A deposit is an ordinary Cardano payment from the user's own wallet to the
 * Tally deposit address. The user can send it from any wallet app, or from
 * the Tally website: Tally builds the unsigned transaction, the wallet signs
 * it in the browser, and Tally adds the signature and sends it. The deposit
 * watcher credits it after the confirmations. Every deposit here is live:
 * it moves test assets on Cardano preprod. Read docs/wallets.md.
 */

import {randomBytes} from 'node:crypto';
import type {AgentStore, DepositSubmissionRow, LiveDepositRow} from '../../packages/db/src/index';
import {TEST_USDM_UNIT} from './contract-config';
import {
  attachWitnesses, BlockfrostError, buildDepositTx, proofsCoverAddress, toBech32Address, utxosFromCip30,
  type Amount, type ChainUtxo, type DepositSettings,
} from './deposit-chain';
import {AccountError} from './wallet-accounts';

/** Assets that the deposit flow accepts, with display labels. */
export const DEPOSIT_ASSETS: ReadonlyMap<string, {label: string; decimals: number}> = new Map([
  ['lovelace', {label: 'test ADA', decimals: 6}],
  [TEST_USDM_UNIT, {label: 'test USDM', decimals: 6}],
]);

const BUILD_TTL_MS = 15 * 60_000;
const MAX_OPEN_BUILDS = 1_000;
const MAX_QUANTITY = 10n ** 15n;

export interface BalanceView {
  unit: string;
  label: string;
  decimals: number;
  quantity: string;
}

export interface DepositsView {
  enabled: boolean;
  mode: 'live';
  network: 'preprod';
  depositAddress: string|null;
  confirmations: number;
  balances: BalanceView[];
  deposits: LiveDepositRow[];
  submissions: DepositSubmissionRow[];
}

export type DepositSource =
  {kind: 'browser'; address: string}|
  {kind: 'cip30'; utxos: string[]; changeAddress: string};

interface OpenBuild {
  entityId: string;
  cborHex: string;
  fromAddress: string;
  amounts: Amount[];
  expiresAt: number;
}

export class WalletDeposits {
  private readonly builds = new Map<string, OpenBuild>();

  constructor(
    private readonly store: AgentStore,
    private readonly settings: DepositSettings,
    private readonly now: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return Boolean(this.settings.chain && this.settings.depositAddress);
  }

  view(entityId: string): DepositsView {
    const balances = this.store.confirmedDepositTotals(entityId).map(({unit, quantity}) => {
      const asset = DEPOSIT_ASSETS.get(unit);
      return {unit, quantity, label: asset?.label ?? unit, decimals: asset?.decimals ?? 0};
    });
    return {
      enabled: this.enabled, mode: 'live', network: 'preprod', depositAddress: this.settings.depositAddress,
      confirmations: this.settings.confirmations, balances,
      deposits: this.store.listLiveDeposits({entityId, limit: 20}),
      submissions: this.store.listDepositSubmissions(entityId),
    };
  }

  hasConfirmedDeposit(entityId: string): boolean {
    return this.store.confirmedDepositTotals(entityId).some((total) => BigInt(total.quantity) > 0n);
  }

  /** True when the address carries a key that this entity proved. */
  private owns(entityId: string, address: string): boolean {
    return proofsCoverAddress(this.store.listWalletProofs(entityId), address);
  }

  /** Builds an unsigned deposit transaction from the user's wallet. */
  async build(entityId: string, amounts: unknown, source: DepositSource): Promise<{buildId: string; txHash: string; cborHex: string; lovelace: string}> {
    const {chain, depositAddress} = this.settings;
    if (!chain || !depositAddress) throw new AccountError('bad_input', 'Live deposits are not set up on this server.', 503);
    const wanted = readAmounts(amounts);
    let utxos: ChainUtxo[];
    let changeAddress: string;
    if (source.kind === 'browser') {
      if (!this.owns(entityId, source.address)) throw new AccountError('wrong_key', 'Send from a wallet that you signed in with.');
      utxos = await chain.addressUtxos(source.address);
      changeAddress = source.address;
    } else {
      if (!Array.isArray(source.utxos) || source.utxos.length > 300 || !source.utxos.every((item) => typeof item === 'string')) {
        throw new AccountError('bad_input', 'utxos must be the wallet getUtxos() list');
      }
      try {
        utxos = utxosFromCip30(source.utxos);
      } catch {
        throw new AccountError('bad_input', 'the wallet returned UTxOs that Tally cannot read');
      }
      try {
        changeAddress = toBech32Address(String(source.changeAddress));
      } catch {
        throw new AccountError('bad_input', 'changeAddress must be the wallet getChangeAddress() value');
      }
      if (!this.owns(entityId, changeAddress)) throw new AccountError('wrong_key', 'The wallet change address is not a wallet that you signed in with.');
    }
    const [params, tip] = await Promise.all([chain.params(), chain.tip()]);
    let built;
    try {
      built = buildDepositTx({utxos, changeAddress, depositAddress, amounts: wanted, params, slot: tip.slot});
    } catch (error) {
      throw new AccountError('bad_input', (error as Error).message);
    }
    this.prune();
    if (this.builds.size >= MAX_OPEN_BUILDS) throw new AccountError('busy', 'Too many deposits are waiting. Try again in a few minutes.', 503);
    const buildId = randomBytes(16).toString('hex');
    this.builds.set(buildId, {entityId, cborHex: built.cborHex, fromAddress: changeAddress, amounts: wanted, expiresAt: this.now() + BUILD_TTL_MS});
    return {buildId, txHash: built.txHash, cborHex: built.cborHex, lovelace: built.lovelace};
  }

  /** Adds the wallet's witness set and sends the transaction. */
  async submit(entityId: string, buildId: unknown, witnessSet: unknown): Promise<{txHash: string}> {
    const {chain} = this.settings;
    if (!chain) throw new AccountError('bad_input', 'Live deposits are not set up on this server.', 503);
    const build = typeof buildId === 'string' ? this.builds.get(buildId) : undefined;
    if (!build || build.entityId !== entityId || build.expiresAt < this.now()) {
      throw new AccountError('bad_input', 'This deposit expired. Start it again.');
    }
    if (typeof witnessSet !== 'string' || !/^[0-9a-fA-F]+$/.test(witnessSet)) throw new AccountError('bad_input', 'witnessSet must be CBOR hex');
    let signed;
    try {
      signed = attachWitnesses(build.cborHex, witnessSet);
    } catch (error) {
      throw new AccountError('invalid_signature', (error as Error).message);
    }
    let txHash: string;
    try {
      txHash = await chain.submit(signed.cborHex);
    } catch (error) {
      // A 4xx reply means the chain rejected this transaction, for example
      // because its inputs are spent or its time limit passed. Sending it
      // again cannot work, so the build ends. Other errors keep it for a retry.
      if (error instanceof BlockfrostError && error.status >= 400 && error.status < 500) {
        this.builds.delete(buildId as string);
        throw new AccountError('deposit_rejected', `The chain rejected this deposit (${error.message}). Start it again.`, 400);
      }
      throw error;
    }
    this.builds.delete(buildId as string);
    this.store.insertDepositSubmission({txHash, entityId, fromAddress: build.fromAddress, amounts: build.amounts, submittedAt: this.now()});
    return {txHash};
  }

  private prune(): void {
    const now = this.now();
    for (const [id, build] of this.builds) if (build.expiresAt < now) this.builds.delete(id);
  }
}

/** Positive whole amounts of accepted assets, one entry per asset. */
function readAmounts(value: unknown): Amount[] {
  if (!Array.isArray(value) || !value.length || value.length > DEPOSIT_ASSETS.size) {
    throw new AccountError('bad_input', 'amounts must list test ADA or test USDM in atomic units');
  }
  const seen = new Set<string>();
  return value.map((item) => {
    const entry = item as {unit?: unknown; quantity?: unknown}|null;
    const unit = entry?.unit;
    const quantity = entry?.quantity;
    if (typeof unit !== 'string' || !DEPOSIT_ASSETS.has(unit) || seen.has(unit)) {
      throw new AccountError('bad_input', 'deposit test ADA (lovelace) or test USDM, each once');
    }
    if (typeof quantity !== 'string' || !/^[1-9][0-9]*$/.test(quantity) || BigInt(quantity) > MAX_QUANTITY) {
      throw new AccountError('bad_input', 'quantity must be a positive whole number of atomic units');
    }
    seen.add(unit);
    return {unit, quantity};
  });
}
