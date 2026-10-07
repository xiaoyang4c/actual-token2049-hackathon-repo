/**
 * @fileoverview Cardano preprod reads and the deposit transaction for live
 * deposits. Tally builds an unsigned transaction that pays the Tally deposit
 * address. The user's wallet signs it in the browser. Tally adds the
 * signature and sends the transaction. Tally never holds a user key.
 *
 * Blockfrost errors name the path and status only, never the project key.
 */

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import * as C from '@emurgo/cardano-serialization-lib-nodejs';
import {BLOCKFROST_PREPROD, type ProtocolParams} from './anchor-chain';

const REQUEST_TIMEOUT_MS = 20_000;
/** A built deposit stays valid for about two hours of slots. */
const TTL_SLOTS = 7_200;

export interface Amount {
  unit: string;
  quantity: string;
}

export interface ChainUtxo {
  txHash: string;
  index: number;
  address: string;
  amounts: Amount[];
}

export interface ChainTx {
  txHash: string;
  blockHeight: number;
  blockTime: number;
}

export interface TxUtxos {
  inputs: Array<{address: string; amounts: Amount[]}>;
  outputs: Array<{address: string; index: number; amounts: Amount[]}>;
}

/** The chain reads that live deposits need. Tests pass a fake. */
export interface DepositChain {
  tip(): Promise<{height: number; slot: number}>;
  /** Newest first. */
  addressTransactions(address: string, count: number): Promise<ChainTx[]>;
  /** Null when the transaction is not on the chain. */
  transactionUtxos(txHash: string): Promise<TxUtxos|null>;
  /** The block of a transaction. Null when it is not on the chain. */
  transactionBlock(txHash: string): Promise<ChainTx|null>;
  addressUtxos(address: string): Promise<ChainUtxo[]>;
  params(): Promise<ProtocolParams>;
  submit(cborHex: string): Promise<string>;
}

type Json = {[key: string]: unknown};
type BlockfrostAmount = Array<{unit: string; quantity: string}>;

export class BlockfrostDepositChain implements DepositChain {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly projectId: string, options: {baseUrl?: string; fetch?: typeof fetch} = {}) {
    if (!/^preprod[A-Za-z0-9]+$/.test(projectId)) throw new Error('the Blockfrost key must be a preprod project key');
    this.baseUrl = options.baseUrl ?? BLOCKFROST_PREPROD;
    this.fetcher = options.fetch ?? fetch;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown|null> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init, headers: {...(init.headers as {[key: string]: string}|undefined), project_id: this.projectId}, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Error(`Blockfrost ${path.split('?')[0]} got no response`);
    }
    if (response.status === 404 && init.method !== 'POST') return null;
    if (!response.ok) {
      const body = await response.json().catch(() => null) as Json|null;
      const reason = typeof body?.message === 'string' ? `: ${body.message.slice(0, 200)}` : '';
      throw new Error(`Blockfrost ${path.split('?')[0]} returned ${response.status}${reason}`);
    }
    return response.json();
  }

  async tip(): Promise<{height: number; slot: number}> {
    const block = await this.request('/blocks/latest') as Json|null;
    if (typeof block?.slot !== 'number' || typeof block.height !== 'number') throw new Error('Blockfrost returned no chain tip');
    return {height: block.height, slot: block.slot};
  }

  async addressTransactions(address: string, count: number): Promise<ChainTx[]> {
    const rows = await this.request(`/addresses/${address}/transactions?order=desc&count=${count}`) as Array<{tx_hash: string; block_height: number; block_time: number}>|null;
    return (rows ?? []).map((row) => ({txHash: row.tx_hash, blockHeight: row.block_height, blockTime: row.block_time}));
  }

  async transactionUtxos(txHash: string): Promise<TxUtxos|null> {
    const body = await this.request(`/txs/${txHash}/utxos`) as {
      inputs: Array<{address: string; amount: BlockfrostAmount; collateral?: boolean; reference?: boolean}>;
      outputs: Array<{address: string; amount: BlockfrostAmount; output_index: number; collateral?: boolean}>;
    }|null;
    if (!body) return null;
    return {
      // Collateral and reference inputs are not spent by a valid transaction.
      inputs: body.inputs.filter((input) => !input.collateral && !input.reference).map((input) => ({address: input.address, amounts: input.amount})),
      outputs: body.outputs.filter((output) => !output.collateral).map((output) => ({address: output.address, index: output.output_index, amounts: output.amount})),
    };
  }

  async transactionBlock(txHash: string): Promise<ChainTx|null> {
    const tx = await this.request(`/txs/${txHash}`) as Json|null;
    if (!tx) return null;
    if (typeof tx.block_height !== 'number' || typeof tx.block_time !== 'number') throw new Error('Blockfrost returned a transaction without a block');
    return {txHash, blockHeight: tx.block_height, blockTime: tx.block_time};
  }

  async addressUtxos(address: string): Promise<ChainUtxo[]> {
    const rows = await this.request(`/addresses/${address}/utxos?count=100`) as Array<{tx_hash: string; output_index: number; amount: BlockfrostAmount}>|null;
    return (rows ?? []).map((row) => ({txHash: row.tx_hash, index: row.output_index, address, amounts: row.amount}));
  }

  async params(): Promise<ProtocolParams> {
    const p = await this.request('/epochs/latest/parameters') as Json|null;
    if (!p) throw new Error('Blockfrost returned no protocol parameters');
    return {
      minFeeA: String(p.min_fee_a), minFeeB: String(p.min_fee_b), maxTxSize: Number(p.max_tx_size), maxValueSize: Number(p.max_val_size),
      coinsPerUtxoByte: String(p.coins_per_utxo_size), keyDeposit: String(p.key_deposit), poolDeposit: String(p.pool_deposit),
    };
  }

  async submit(cborHex: string): Promise<string> {
    const reported = await this.request('/tx/submit', {method: 'POST', headers: {'content-type': 'application/cbor'}, body: Buffer.from(cborHex, 'hex')});
    if (typeof reported !== 'string') throw new Error('Blockfrost returned no transaction id');
    return reported;
  }
}

/** Live deposit settings from the environment. Null values turn the feature off. */
export interface DepositSettings {
  chain: DepositChain|null;
  depositAddress: string|null;
  confirmations: number;
}

/**
 * BLOCKFROST_PROJECT_ID, or the blockfrost_preprod file in TALLY_SECRETS_DIR.
 * TALLY_DEPOSIT_ADDRESS is the public preprod address that receives deposits.
 */
export function depositSettingsFromEnv(env: {[key: string]: string|undefined}): DepositSettings {
  let key = env.BLOCKFROST_PROJECT_ID?.trim();
  if (!key && env.TALLY_SECRETS_DIR) {
    try {
      key = readFileSync(join(env.TALLY_SECRETS_DIR, 'blockfrost_preprod'), 'utf8').trim();
    } catch {
      key = undefined;
    }
  }
  const address = env.TALLY_DEPOSIT_ADDRESS?.trim() || null;
  if (address && !address.startsWith('addr_test1')) throw new Error('TALLY_DEPOSIT_ADDRESS must be a preprod address (addr_test1...)');
  const confirmations = Number(env.TALLY_DEPOSIT_CONFIRMATIONS ?? 3);
  if (!Number.isInteger(confirmations) || confirmations < 1) throw new Error('TALLY_DEPOSIT_CONFIRMATIONS must be a whole number of at least 1');
  return {chain: key ? new BlockfrostDepositChain(key) : null, depositAddress: address, confirmations};
}

/** A bech32 address from bech32 or CIP-30 hex. Throws for anything else. */
export function toBech32Address(value: string): string {
  const parsed = /^[0-9a-fA-F]+$/.test(value) ? C.Address.from_hex(value) : C.Address.from_bech32(value);
  return parsed.to_bech32(parsed.network_id() === 0 ? 'addr_test' : 'addr');
}

/** Payment and stake key hashes in an address, as hex. Script and Byron credentials give nothing. */
export function addressKeyHashes(address: string): {payment?: string; stake?: string} {
  let parsed: C.Address;
  try {
    parsed = C.Address.from_bech32(address);
  } catch {
    return {};
  }
  const base = C.BaseAddress.from_address(parsed);
  if (base) return {payment: base.payment_cred().to_keyhash()?.to_hex(), stake: base.stake_cred().to_keyhash()?.to_hex()};
  const enterprise = C.EnterpriseAddress.from_address(parsed);
  if (enterprise) return {payment: enterprise.payment_cred().to_keyhash()?.to_hex()};
  const pointer = C.PointerAddress.from_address(parsed);
  if (pointer) return {payment: pointer.payment_cred().to_keyhash()?.to_hex()};
  return {};
}

const big = (value: string|number) => C.BigNum.from_str(String(value));

function valueOf(amounts: Amount[]): C.Value {
  const lovelace = amounts.find((amount) => amount.unit === 'lovelace')?.quantity ?? '0';
  const value = C.Value.new(big(lovelace));
  const tokens = amounts.filter((amount) => amount.unit !== 'lovelace' && BigInt(amount.quantity) > 0n);
  if (tokens.length) {
    const multiasset = C.MultiAsset.new();
    for (const token of tokens) {
      if (!/^[0-9a-f]{56}(?:[0-9a-f]{2}){0,32}$/.test(token.unit)) throw new Error(`invalid asset unit ${token.unit}`);
      const assets = multiasset.get(C.ScriptHash.from_hex(token.unit.slice(0, 56))) ?? C.Assets.new();
      assets.insert(C.AssetName.new(Buffer.from(token.unit.slice(56), 'hex')), big(token.quantity));
      multiasset.insert(C.ScriptHash.from_hex(token.unit.slice(0, 56)), assets);
    }
    value.set_multiasset(multiasset);
  }
  return value;
}

export interface BuiltDeposit {
  txHash: string;
  /** The unsigned transaction. A CIP-30 wallet signs this with signTx. */
  cborHex: string;
  /** The ADA that the output carries. A token output needs a minimum amount of ADA. */
  lovelace: string;
}

/**
 * Builds an unsigned transaction that pays `amounts` to `depositAddress` from
 * `utxos` and returns the change to `changeAddress`. Inputs are picked
 * largest first. A token deposit carries the minimum ADA that it needs.
 */
export function buildDepositTx(input: {
  utxos: ChainUtxo[]; changeAddress: string; depositAddress: string; amounts: Amount[]; params: ProtocolParams; slot: number;
}): BuiltDeposit {
  if (!input.utxos.length) throw new Error('the wallet has no funds on preprod');
  const {params} = input;
  const builder = C.TransactionBuilder.new(C.TransactionBuilderConfigBuilder.new()
    .fee_algo(C.LinearFee.new(big(params.minFeeA), big(params.minFeeB)))
    .pool_deposit(big(params.poolDeposit))
    .key_deposit(big(params.keyDeposit))
    .max_value_size(params.maxValueSize)
    .max_tx_size(params.maxTxSize)
    .coins_per_utxo_byte(big(params.coinsPerUtxoByte))
    .build());
  const output = C.TransactionOutput.new(C.Address.from_bech32(input.depositAddress), valueOf(input.amounts));
  const minimum = C.min_ada_for_output(output, C.DataCost.new_coins_per_byte(big(params.coinsPerUtxoByte)));
  if (output.amount().coin().less_than(minimum)) {
    const value = output.amount();
    value.set_coin(minimum);
    builder.add_output(C.TransactionOutput.new(output.address(), value));
  } else {
    builder.add_output(output);
  }
  const available = C.TransactionUnspentOutputs.new();
  for (const utxo of input.utxos) {
    available.add(C.TransactionUnspentOutput.new(
      C.TransactionInput.new(C.TransactionHash.from_hex(utxo.txHash), utxo.index),
      C.TransactionOutput.new(C.Address.from_bech32(utxo.address), valueOf(utxo.amounts)),
    ));
  }
  try {
    builder.add_inputs_from(available, C.CoinSelectionStrategyCIP2.LargestFirstMultiAsset);
  } catch {
    throw new Error('the wallet does not hold enough funds for this deposit and its fee');
  }
  builder.set_ttl_bignum(big(input.slot + TTL_SLOTS));
  builder.add_change_if_needed(C.Address.from_bech32(input.changeAddress));
  const tx = builder.build_tx();
  const fixed = C.FixedTransaction.from_bytes(tx.to_bytes());
  const sent = tx.body().outputs().get(0).amount().coin().to_str();
  return {txHash: fixed.transaction_hash().to_hex(), cborHex: Buffer.from(tx.to_bytes()).toString('hex'), lovelace: sent};
}

/** UTxOs that a CIP-30 wallet reports (getUtxos), as TransactionUnspentOutput CBOR hex. */
export function utxosFromCip30(hexes: string[]): ChainUtxo[] {
  return hexes.map((value) => {
    const utxo = C.TransactionUnspentOutput.from_hex(value);
    const output = utxo.output();
    const amounts: Amount[] = [{unit: 'lovelace', quantity: output.amount().coin().to_str()}];
    const multiasset = output.amount().multiasset();
    const policies = multiasset?.keys();
    for (let i = 0; policies && multiasset && i < policies.len(); i++) {
      const policy = policies.get(i);
      const assets = multiasset.get(policy);
      const names = assets?.keys();
      for (let j = 0; names && assets && j < names.len(); j++) {
        const name = names.get(j);
        amounts.push({unit: `${policy.to_hex()}${Buffer.from(name.name()).toString('hex')}`, quantity: assets.get(name)?.to_str() ?? '0'});
      }
    }
    return {txHash: utxo.input().transaction_id().to_hex(), index: utxo.input().index(), address: output.address().to_bech32('addr_test'), amounts};
  });
}

/**
 * Adds the wallet's witness set (CIP-30 signTx result, CBOR hex) to the
 * unsigned transaction. Every vkey witness must verify against the body.
 */
export function attachWitnesses(unsignedHex: string, witnessSetHex: string): {txHash: string; cborHex: string; signers: string[]} {
  const fixed = C.FixedTransaction.from_hex(unsignedHex);
  const witnesses = C.TransactionWitnessSet.from_hex(witnessSetHex);
  const vkeys = witnesses.vkeys();
  if (!vkeys || vkeys.len() === 0) throw new Error('the wallet returned no signature');
  const body = Buffer.from(fixed.transaction_hash().to_bytes());
  const signers: string[] = [];
  for (let i = 0; i < vkeys.len(); i++) {
    const witness = vkeys.get(i);
    const key = witness.vkey().public_key();
    if (!key.verify(body, witness.signature())) throw new Error('a wallet signature does not match this transaction');
    signers.push(key.hash().to_hex());
  }
  fixed.set_witness_set(witnesses.to_bytes());
  return {txHash: fixed.transaction_hash().to_hex(), cborHex: Buffer.from(fixed.to_bytes()).toString('hex'), signers};
}
