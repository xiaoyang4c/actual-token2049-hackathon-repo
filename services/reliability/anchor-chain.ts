/**
 * @fileoverview Cardano preprod access for settlement anchors: the anchor
 * wallet key, the metadata transaction, and Blockfrost reads and sends.
 *
 * The anchor wallet is a platform key used only for anchors. It holds a few
 * test ADA for fees and never holds customer money. Its key lives in
 * ~/tally-secrets and never appears in logs, errors, or answers.
 */

import * as C from '@emurgo/cardano-serialization-lib-nodejs';
import {ANCHOR_METADATA_LABEL, type AnchorChain, type ChainTip} from './anchors';

export const BLOCKFROST_PREPROD = 'https://cardano-preprod.blockfrost.io/api/v0';
/** CIP-20 limits each message line to 64 bytes. A fingerprint is 64 hex characters. */
const MAX_LINE_BYTES = 64;
const REQUEST_TIMEOUT_MS = 20_000;

export interface ProtocolParams {
  minFeeA: string;
  minFeeB: string;
  maxTxSize: number;
  maxValueSize: number;
  coinsPerUtxoByte: string;
  keyDeposit: string;
  poolDeposit: string;
}

export interface AdaUtxo {
  txHash: string;
  index: number;
  lovelace: string;
}

const big = (value: string|number) => C.BigNum.from_str(String(value));

function privateKey(skeyHex: string): C.PrivateKey {
  if (!/^[0-9a-f]{64}$/.test(skeyHex)) throw new Error('the anchor key must be 64 hex characters');
  return C.PrivateKey.from_normal_bytes(Buffer.from(skeyHex, 'hex'));
}

function addressOf(key: C.PrivateKey): C.Address {
  return C.EnterpriseAddress.new(0, C.Credential.from_keyhash(key.to_public().hash())).to_address();
}

/** A new anchor key, as 64 hex characters. */
export function generateAnchorKey(): string {
  return Buffer.from(C.PrivateKey.generate_ed25519().as_bytes()).toString('hex');
}

/** The preprod enterprise address of an anchor key. */
export function anchorAddress(skeyHex: string): string {
  return addressOf(privateKey(skeyHex)).to_bech32('addr_test');
}

/** Builds and signs a transaction that pays the change back to the wallet and carries the message. */
export function buildAnchorTx(input: {skeyHex: string; utxos: AdaUtxo[]; params: ProtocolParams; message: string[]; invalidHereafter: number}): {txHash: string; cborHex: string} {
  if (!input.utxos.length) throw new Error('the anchor wallet has no ADA-only outputs');
  for (const line of input.message) {
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) throw new Error('an anchor message line is longer than 64 bytes');
  }
  const key = privateKey(input.skeyHex);
  const address = addressOf(key);
  const {params} = input;
  const builder = C.TransactionBuilder.new(C.TransactionBuilderConfigBuilder.new()
    .fee_algo(C.LinearFee.new(big(params.minFeeA), big(params.minFeeB)))
    .pool_deposit(big(params.poolDeposit))
    .key_deposit(big(params.keyDeposit))
    .max_value_size(params.maxValueSize)
    .max_tx_size(params.maxTxSize)
    .coins_per_utxo_byte(big(params.coinsPerUtxoByte))
    .build());
  for (const utxo of input.utxos) {
    builder.add_regular_input(address, C.TransactionInput.new(C.TransactionHash.from_hex(utxo.txHash), utxo.index), C.Value.new(big(utxo.lovelace)));
  }
  builder.set_ttl_bignum(big(input.invalidHereafter));
  const lines = C.MetadataList.new();
  for (const line of input.message) lines.add(C.TransactionMetadatum.new_text(line));
  const message = C.MetadataMap.new();
  message.insert(C.TransactionMetadatum.new_text('msg'), C.TransactionMetadatum.new_list(lines));
  const metadata = C.GeneralTransactionMetadata.new();
  metadata.insert(big(ANCHOR_METADATA_LABEL), C.TransactionMetadatum.new_map(message));
  const auxiliary = C.AuxiliaryData.new();
  auxiliary.set_metadata(metadata);
  builder.set_auxiliary_data(auxiliary);
  builder.add_change_if_needed(address);
  const signed = C.FixedTransaction.from_bytes(builder.build_tx().to_bytes());
  signed.sign_and_add_vkey_signature(key);
  return {txHash: signed.transaction_hash().to_hex(), cborHex: Buffer.from(signed.to_bytes()).toString('hex')};
}

type Json = {[key: string]: unknown};

/** Blockfrost preprod. Errors name the path and status only, never the project key. */
export class BlockfrostAnchorChain implements AnchorChain {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  readonly address: string;

  constructor(private readonly projectId: string, private readonly skeyHex: string, options: {baseUrl?: string; fetch?: typeof fetch} = {}) {
    if (!/^preprod[A-Za-z0-9]+$/.test(projectId)) throw new Error('the Blockfrost key must be a preprod project key');
    this.baseUrl = options.baseUrl ?? BLOCKFROST_PREPROD;
    this.fetcher = options.fetch ?? fetch;
    this.address = anchorAddress(skeyHex);
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

  async tip(): Promise<ChainTip> {
    const block = await this.request('/blocks/latest') as Json|null;
    if (typeof block?.slot !== 'number' || typeof block.height !== 'number') throw new Error('Blockfrost returned no chain tip');
    return {slot: block.slot, height: block.height};
  }

  async transaction(txHash: string): Promise<{blockHeight: number; blockTime: number}|null> {
    const tx = await this.request(`/txs/${txHash}`) as Json|null;
    if (!tx) return null;
    if (typeof tx.block_height !== 'number' || typeof tx.block_time !== 'number') throw new Error('Blockfrost returned a transaction without a block');
    return {blockHeight: tx.block_height, blockTime: tx.block_time};
  }

  async anchorMessage(txHash: string): Promise<string[]|null> {
    const rows = await this.request(`/txs/${txHash}/metadata`) as Array<{label?: unknown; json_metadata?: unknown}>|null;
    const row = rows?.find((item) => String(item.label) === String(ANCHOR_METADATA_LABEL));
    const lines = (row?.json_metadata as Json|undefined)?.msg;
    return Array.isArray(lines) && lines.every((line) => typeof line === 'string') ? lines as string[] : null;
  }

  async utxos(): Promise<AdaUtxo[]> {
    const rows = await this.request(`/addresses/${this.address}/utxos?count=100`) as Array<{tx_hash: string; output_index: number; amount: Array<{unit: string; quantity: string}>}>|null;
    // Outputs that also hold tokens stay untouched: the builder would have to carry the tokens on.
    return (rows ?? []).filter((row) => row.amount.every((asset) => asset.unit === 'lovelace'))
      .map((row) => ({txHash: row.tx_hash, index: row.output_index, lovelace: row.amount[0]?.quantity ?? '0'}));
  }

  async params(): Promise<ProtocolParams> {
    const p = await this.request('/epochs/latest/parameters') as Json|null;
    if (!p) throw new Error('Blockfrost returned no protocol parameters');
    return {
      minFeeA: String(p.min_fee_a), minFeeB: String(p.min_fee_b), maxTxSize: Number(p.max_tx_size), maxValueSize: Number(p.max_val_size),
      coinsPerUtxoByte: String(p.coins_per_utxo_size), keyDeposit: String(p.key_deposit), poolDeposit: String(p.pool_deposit),
    };
  }

  async build(message: string[], invalidHereafter: number): Promise<{txHash: string; cborHex: string}|{unfunded: true}> {
    const utxos = await this.utxos();
    if (!utxos.length) return {unfunded: true};
    return buildAnchorTx({skeyHex: this.skeyHex, utxos: utxos.slice(0, 20), params: await this.params(), message, invalidHereafter});
  }

  async submit(cborHex: string): Promise<string> {
    const reported = await this.request('/tx/submit', {method: 'POST', headers: {'content-type': 'application/cbor'}, body: Buffer.from(cborHex, 'hex')});
    if (typeof reported !== 'string') throw new Error('Blockfrost returned no transaction id');
    return reported;
  }
}
