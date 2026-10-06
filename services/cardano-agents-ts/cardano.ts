import {BlockfrostServerError, type BlockFrostAPI} from '@blockfrost/blockfrost-js';
import type {AgentStore} from '../../packages/db/src';
import {createBlockfrostSdk} from './blockfrost-sdk';
import type {PaymentConfig} from './config';
import {simulatedResultTxHash} from './masumi';
import {
  verifySettlementEvidence, type SettlementChainVerification, type SettlementTransactionEvidence,
  type SettlementUtxoEvidence, type SettlementVerificationRequest,
} from './settlement-evidence';
import {object, PaymentError, sha256, type ApiTransport, type CredentialResolver} from './types';

export interface PaymentEvidence {
  txHash: string;
  payTo: string;
  amountLovelace: number;
}

export interface ChainVerification {
  confirmed: boolean;
  confirmations: number;
  reason?: string;
}

export interface CardanoAdapter {
  readonly simulated: boolean;
  getWalletBalance(address: string): Promise<number>;
  submitTransaction(signedCborHex: string): Promise<string>;
  verifyPayment(payment: PaymentEvidence): Promise<ChainVerification>;
  observeSettlementTransaction(txHash: string): Promise<SettlementTransactionEvidence>;
  verifySettlement(request: SettlementVerificationRequest): Promise<SettlementChainVerification>;
}

/** Balance comes from durable reservations, so a restart cannot reset it. */
export class SimulatedCardanoAdapter implements CardanoAdapter {
  readonly simulated = true;

  constructor(private readonly store: AgentStore, private readonly config: PaymentConfig) {}

  async getWalletBalance(address: string): Promise<number> {
    const spent = this.store.listPaymentReceipts()
      .filter((receipt) => {
        if (receipt.payer !== address || !receipt.simulated || receipt.status === 'refunded') return false;
        const settlement = this.store.getPaymentSettlement(receipt.receiptId);
        return !(settlement?.status === 'expired_unfunded' && settlement.lastVerifiedStatus === 'expired_unfunded');
      })
      .reduce((sum, receipt) => sum + receipt.amount, 0);
    return this.config.initialBalanceLovelace - spent;
  }

  async submitTransaction(signedCborHex: string): Promise<string> {
    return sha256(`simulated:${signedCborHex}`);
  }

  async verifyPayment(payment: PaymentEvidence): Promise<ChainVerification> {
    const exists = this.store.listPaymentReceipts().some((receipt) =>
      receipt.simulated && receipt.txHash === payment.txHash &&
      receipt.amount === payment.amountLovelace && receipt.status !== 'refunded');
    return {confirmed: exists, confirmations: exists ? this.config.minimumConfirmations : 0};
  }

  async observeSettlementTransaction(txHash: string): Promise<SettlementTransactionEvidence> {
    const receipt = this.store.listPaymentReceipts().find((record) => record.simulated &&
      (record.txHash === txHash || record.resultHash && simulatedResultTxHash(record.receiptId, record.resultHash) === txHash));
    return {
      txHash, indexed: Boolean(receipt), validContract: Boolean(receipt),
      confirmations: receipt ? this.config.minimumConfirmations : 0, simulated: true,
      inputs: [], outputs: [], reason: receipt ? 'durable simulated receipt' : 'simulated transaction not found',
    };
  }

  async verifySettlement(request: SettlementVerificationRequest): Promise<SettlementChainVerification> {
    const evidence = request.transaction.txHash ? [await this.observeSettlementTransaction(request.transaction.txHash)] : [];
    const receipt = this.store.listPaymentReceipts().find((record) => record.simulated && record.txHash === request.depositTxHash);
    let termsMatch = false;
    let queued = false;
    try {
      const state = object(JSON.parse(receipt?.protocolData ?? '{}'));
      const savedTerms = object(state.terms);
      termsMatch = ['blockchainIdentifier', 'agentIdentifier', 'inputHash', 'escrowAddress', 'paymentSourceType',
        'amountLovelace', 'payByTime', 'submitResultTime', 'unlockTime', 'externalDisputeUnlockTime']
        .every((name) => savedTerms[name] === request.terms[name as keyof typeof request.terms]) &&
        receipt?.payer === request.buyerAddress && receipt?.payTo === request.sellerAddress;
      queued = state.resultQueued === true;
    } catch {
      // A missing durable session cannot establish simulated evidence.
    }
    const resultConfirmed = Boolean(receipt && termsMatch && queued && request.kind === 'result' &&
      request.resultHash && request.resultHash === receipt.resultHash && request.transaction.status === 'Confirmed' &&
      request.transaction.newOnChainState === 'ResultSubmitted' &&
      request.transaction.txHash === simulatedResultTxHash(receipt.receiptId, request.resultHash));
    const fundsConfirmed = Boolean(receipt && termsMatch && request.kind === 'state' &&
      request.transaction.newOnChainState === 'FundsLocked' && request.transaction.status === 'Confirmed' &&
      request.transaction.txHash === receipt.txHash);
    return {
      confirmed: resultConfirmed || fundsConfirmed,
      confirmations: evidence[0]?.confirmations ?? 0, txHash: request.transaction.txHash, evidence,
      reason: resultConfirmed || fundsConfirmed ? undefined : 'simulation has no confirmed payout evidence',
      onChainState: resultConfirmed ? 'ResultSubmitted' : fundsConfirmed ? 'FundsLocked' : undefined,
      resultHash: resultConfirmed ? request.resultHash : fundsConfirmed ? null : undefined,
    };
  }
}

/** Official Blockfrost SDK. Transaction construction/signing is external. */
export class PreprodCardanoAdapter implements CardanoAdapter {
  readonly simulated: boolean;
  private readonly sdk: BlockFrostAPI;
  private networkCheck?: Promise<void>;

  constructor(private readonly config: PaymentConfig, private readonly transport?: ApiTransport, resolver?: CredentialResolver) {
    this.sdk = createBlockfrostSdk(config, transport, resolver);
    this.simulated = transport?.simulated ?? false;
  }

  private async callSdk<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.transport && !this.config.allowNetwork) {
      throw new PaymentError('preprod API access is disabled; use simulated mode or an offline fixture transport', 503);
    }
    try {
      return await operation();
    } catch (error) {
      if (error instanceof BlockfrostServerError && error.status_code === 404) {
        throw new PaymentError('Blockfrost resource not found', 404);
      }
      throw new PaymentError('Blockfrost SDK request failed; retry with the same idempotency key', 503);
    }
  }

  private async ensurePreprod(): Promise<void> {
    this.networkCheck ??= (async () => {
      const genesis = await this.callSdk(() => this.sdk.genesis());
      if (genesis.network_magic !== 1) {
        throw new PaymentError('Cardano endpoint is not preprod (network magic 1)', 502);
      }
    })();
    try {
      await this.networkCheck;
    } catch (error) {
      this.networkCheck = undefined;
      throw error;
    }
  }

  async getWalletBalance(address: string): Promise<number> {
    if (!address.startsWith('addr_test1')) throw new PaymentError('a preprod wallet address is required');
    await this.ensurePreprod();
    try {
      return amountAt((await this.callSdk(() => this.sdk.addresses(address))).amount);
    } catch (error) {
      if (error instanceof PaymentError && error.status === 404) return 0;
      throw error;
    }
  }

  async submitTransaction(signedCborHex: string): Promise<string> {
    if (!/^(?:[a-fA-F0-9]{2})+$/.test(signedCborHex)) throw new PaymentError('signed transaction must be CBOR hex');
    await this.ensurePreprod();
    const txHash = await this.callSdk(() => this.sdk.txSubmit(signedCborHex));
    if (typeof txHash !== 'string' || !/^[a-f0-9]{64}$/.test(txHash)) throw new PaymentError('invalid transaction hash from Blockfrost', 502);
    return txHash;
  }

  async verifyPayment(payment: PaymentEvidence): Promise<ChainVerification> {
    if (!/^[a-f0-9]{64}$/.test(payment.txHash) || !payment.payTo.startsWith('addr_test1') ||
        !Number.isSafeInteger(payment.amountLovelace) || payment.amountLovelace <= 0) {
      throw new PaymentError('invalid preprod payment evidence');
    }
    await this.ensurePreprod();
    let tx: Awaited<ReturnType<BlockFrostAPI['txs']>>;
    try {
      tx = await this.callSdk(() => this.sdk.txs(payment.txHash));
    } catch (error) {
      if (error instanceof PaymentError && error.status === 404) return {confirmed: false, confirmations: 0, reason: 'transaction not indexed'};
      throw error;
    }
    const height = tx.block_height;
    if (tx.hash !== payment.txHash || tx.valid_contract !== true || typeof height !== 'number') {
      return {confirmed: false, confirmations: 0, reason: 'invalid transaction'};
    }
    const tip = (await this.callSdk(() => this.sdk.blocksLatest())).height;
    if (!Number.isSafeInteger(height) || typeof tip !== 'number' || !Number.isSafeInteger(tip)) {
      throw new PaymentError('invalid block heights from Blockfrost', 502);
    }
    const confirmations = Math.max(0, tip - height + 1);
    const outputs = (await this.callSdk(() => this.sdk.txsUtxos(payment.txHash))).outputs;
    if (!Array.isArray(outputs)) throw new PaymentError('invalid transaction outputs', 502);
    const paid = outputs.some((value: unknown) => {
      const output = object(value);
      return output.address === payment.payTo && amountAt(output.amount) >= payment.amountLovelace;
    });
    return {
      confirmed: paid && confirmations >= this.config.minimumConfirmations,
      confirmations, reason: paid ? 'waiting for confirmations' : 'amount or escrow address mismatch',
    };
  }

  async observeSettlementTransaction(txHash: string): Promise<SettlementTransactionEvidence> {
    if (!/^[a-f0-9]{64}$/.test(txHash)) throw new PaymentError('invalid settlement transaction hash');
    await this.ensurePreprod();
    let tx: Awaited<ReturnType<BlockFrostAPI['txs']>>;
    try {
      tx = await this.callSdk(() => this.sdk.txs(txHash));
    } catch (error) {
      if (error instanceof PaymentError && error.status === 404) return {
        txHash, indexed: false, validContract: false, confirmations: 0, inputs: [], outputs: [], reason: 'transaction not indexed',
      };
      throw error;
    }
    const tip = (await this.callSdk(() => this.sdk.blocksLatest())).height;
    if (typeof tip !== 'number' || !Number.isSafeInteger(tip) ||
        typeof tx.block_height !== 'number' || !Number.isSafeInteger(tx.block_height)) {
      throw new PaymentError('invalid block heights from Blockfrost', 502);
    }
    const utxos = await this.callSdk(() => this.sdk.txsUtxos(txHash));
    const readOutput = async (value: unknown, input: boolean): Promise<SettlementUtxoEvidence> => {
      const output = object(value);
      if (typeof output.address !== 'string' || typeof output.output_index !== 'number' ||
          !Number.isSafeInteger(output.output_index) || output.output_index < 0) {
        throw new PaymentError('invalid settlement UTxO from Blockfrost', 502);
      }
      const datumHash = typeof output.data_hash === 'string' ? output.data_hash : undefined;
      let datum: unknown;
      if (datumHash) {
        try {
          datum = (await this.callSdk(() => this.sdk.scriptsDatum(datumHash))).json_value;
        } catch (error) {
          // An unavailable/unsupported datum remains evidence, but cannot verify settlement.
          if (!(error instanceof PaymentError) || error.status !== 404) throw error;
        }
      }
      return {
        address: output.address, outputIndex: output.output_index, amountLovelace: amountAt(output.amount),
        txHash: input && typeof output.tx_hash === 'string' ? output.tx_hash : undefined,
        collateral: output.collateral === true, reference: output.reference === true,
        datumHash, datum, inlineDatum: typeof output.inline_datum === 'string' ? output.inline_datum : undefined,
        consumedByTx: output.consumed_by_tx === null ? null : typeof output.consumed_by_tx === 'string' ? output.consumed_by_tx : undefined,
      };
    };
    if (!Array.isArray(utxos.inputs) || !Array.isArray(utxos.outputs)) throw new PaymentError('invalid settlement transaction UTxOs', 502);
    const [inputs, outputs] = await Promise.all([
      Promise.all(utxos.inputs.map((value) => readOutput(value, true))),
      Promise.all(utxos.outputs.map((value) => readOutput(value, false))),
    ]);
    const fee = typeof tx.fees === 'string' && /^[0-9]+$/.test(tx.fees) ? Number(tx.fees) : undefined;
    const blockTime = blockTimeIso(tx.block_time);
    return {
      txHash, indexed: tx.hash === txHash, validContract: tx.valid_contract === true,
      confirmations: Math.max(0, tip - tx.block_height + 1), blockHash: tx.block,
      blockHeight: tx.block_height, feeLovelace: Number.isSafeInteger(fee) ? fee : undefined,
      ...(blockTime ? {blockTime} : {}),
      inputs, outputs,
    };
  }

  async verifySettlement(request: SettlementVerificationRequest): Promise<SettlementChainVerification> {
    const evidence = new Map<string, SettlementTransactionEvidence>();
    const visit = async (txHash: string, depth: number): Promise<void> => {
      if (evidence.has(txHash) || depth > 12 || evidence.size >= 32) return;
      const observation = await this.observeSettlementTransaction(txHash);
      evidence.set(txHash, observation);
      if (txHash === request.depositTxHash) return;
      for (const input of observation.inputs) {
        if (!input.collateral && !input.reference && input.txHash && input.address === request.terms.escrowAddress) {
          await visit(input.txHash, depth + 1);
        }
      }
    };
    if (request.transaction.txHash) await visit(request.transaction.txHash, 0);
    return verifySettlementEvidence(request, [...evidence.values()], this.config.minimumConfirmations);
  }
}

function blockTimeIso(value: unknown): string|undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined;
  return new Date(value * 1000).toISOString();
}

function amountAt(value: unknown): number {
  if (!Array.isArray(value)) throw new PaymentError('invalid Cardano asset amounts', 502);
  const amount = value.map((entry: unknown) => object(entry)).find((entry) => entry.unit === 'lovelace');
  if (!amount) return 0;
  if (typeof amount.quantity !== 'string' || !/^[0-9]+$/.test(amount.quantity) ||
      !Number.isSafeInteger(Number(amount.quantity))) throw new PaymentError('invalid lovelace quantity', 502);
  return Number(amount.quantity);
}
