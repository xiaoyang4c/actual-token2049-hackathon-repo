import type {
  AgentStore, PaymentReceiptRecord, PaymentSettlementRecord, SettlementObservationRecord,
} from '../../packages/db/src';
import type {CardanoAdapter} from './cardano';
import type {PaymentConfig} from './config';
import type {MasumiAdapter} from './masumi';
import {PaymentReconciler, type ReconciliationScheduleOptions} from './reconciliation';
import {
  createPaymentRequest, encodePaymentHeader, paymentRequirement, session, verifyRequest,
  type PaymentSession, type VerifyRequest,
} from './runtime-protocol';
import {createRuntimeDependencies, paymentConfigurationHash, type RuntimeOptions} from './runtime-setup';
import {lovelace, object, PaymentError, sha256, textField} from './types';

export {encodePaymentHeader} from './runtime-protocol';
export type {RuntimeOptions} from './runtime-setup';

export function createPaymentRuntime(options: RuntimeOptions = {}): PaymentRuntime {
  const {config, store, cardano, masumi, ownsStore} = createRuntimeDependencies(options);
  try {
    return new PaymentRuntime(config, store, cardano, masumi, ownsStore, options.reconciliation);
  } catch (error) {
    if (ownsStore) store.close();
    throw error;
  }
}

/** One local service writer. All network effects have a durable retry boundary. */
export class PaymentRuntime {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly configurationHash: string;
  private readonly reconciler: PaymentReconciler;
  private readonly now: () => number;
  private closing?: Promise<void>;

  constructor(
    readonly config: PaymentConfig,
    readonly store: AgentStore,
    private readonly cardano: CardanoAdapter,
    private readonly masumi: MasumiAdapter,
    private readonly ownsStore = false,
    reconciliation: ReconciliationScheduleOptions = {},
  ) {
    this.configurationHash = paymentConfigurationHash(config);
    this.now = reconciliation.now ?? Date.now;
    this.reconciler = new PaymentReconciler({
      ...reconciliation, store, config, cardano, masumi,
      runExclusive: (receiptId, run) => this.serial(receiptId, run),
    });
  }

  /** Stops polling and drains receipt operations before closing the database. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      try {
        await this.stopReconciliation();
      } finally {
        await Promise.all(this.inFlight.values());
        if (this.ownsStore) this.store.close();
      }
    })();
    return this.closing;
  }

  startReconciliation(): void {
    this.reconciler.start();
  }

  stopReconciliation(): Promise<void> {
    return this.reconciler.stop();
  }

  /** Checks due receipts. The schedule and evidence are committed in SQLite. */
  reconcile(): Promise<number> {
    return this.reconciler.tick();
  }

  receipts(): (PaymentReceiptRecord & {settlement?: PaymentSettlementRecord})[] {
    return this.store.listPaymentReceipts().map((receipt) => ({
      ...receipt, settlement: this.store.getPaymentSettlement(receipt.receiptId),
    }));
  }

  settlement(receiptId: string): {settlement?: PaymentSettlementRecord; observations: SettlementObservationRecord[]} {
    this.receipt(receiptId);
    return {
      settlement: this.store.getPaymentSettlement(receiptId),
      observations: this.store.listPaymentSettlementObservations(receiptId),
    };
  }

  async wallet(): Promise<object> {
    return {
      agentId: this.config.masumiAgentIdentifier, network: this.config.network,
      address: this.config.walletAddress, balanceLovelace: await this.cardano.getWalletBalance(this.config.walletAddress),
      simulated: this.cardano.simulated, mode: this.config.mode,
    };
  }

  async pay(value: unknown): Promise<{receipt: PaymentReceiptRecord; xPayment: string}> {
    const body = object(value);
    const key = textField(body.idempotencyKey, 'idempotencyKey');
    if (key.length > 256) throw new PaymentError('idempotencyKey is too long');
    const requirement = paymentRequirement(body.requirement, this.config);
    const fingerprint = sha256(JSON.stringify(requirement));
    return this.serial('wallet', async () => {
      let receipt = this.store.getPaymentReceiptByKey(key);
      if (receipt) {
        const saved = session(receipt);
        if (saved.fingerprint !== fingerprint || saved.configurationHash !== this.configurationHash || saved.mode !== this.config.mode ||
            receipt.payer !== this.config.walletAddress || receipt.simulated !== this.cardano.simulated) {
          throw new PaymentError('idempotency key is already bound to another payment', 409);
        }
      } else {
        const amount = lovelace(requirement.maxAmountRequired);
        const pending = this.config.mode === 'preprod' ? this.store.listPaymentReceipts()
          .filter((saved) => {
            if (saved.payer !== this.config.walletAddress || saved.network !== this.config.network ||
                !['requested', 'submitted'].includes(saved.status)) return false;
            const settlement = this.store.getPaymentSettlement(saved.receiptId);
            return !(settlement?.status === 'expired_unfunded' && settlement.lastVerifiedStatus === 'expired_unfunded');
          })
          .reduce((total, saved) => total + saved.amount, 0) : 0;
        if (amount > await this.cardano.getWalletBalance(this.config.walletAddress) - pending) {
          throw new PaymentError('insufficient balance', 402);
        }
        const createdAt = new Date(this.now()).toISOString();
        const request = createPaymentRequest(key, requirement, this.config, createdAt);
        // Commit the reservation and stable nonce/times before any Masumi mutation.
        receipt = this.store.transaction(() => {
          const inserted = this.store.insertPaymentReceipt({
            receiptId: `rcpt_${sha256(key)}`, idempotencyKey: key, payer: this.config.walletAddress,
            txHash: '', network: requirement.network, amount, asset: requirement.asset,
            payTo: requirement.payTo, resource: requirement.resource, status: 'requested',
            simulated: this.cardano.simulated, createdAt, updatedAt: createdAt, inputHash: request.inputHash,
            protocolData: JSON.stringify({
              mode: this.config.mode, configurationHash: this.configurationHash, fingerprint, request,
              bindInput: Boolean(requirement.inputHash), purchaseAttempted: false,
            } satisfies PaymentSession),
            ...(body.cycleId === undefined ? {} : {cycleId: textField(body.cycleId, 'cycleId')}),
            ...(body.orderKey === undefined ? {} : {orderKey: textField(body.orderKey, 'orderKey')}),
          });
          this.store.ensurePaymentSettlement(inserted.receiptId, createdAt);
          return inserted;
        });
      }
      const receiptId = receipt.receiptId;
      return this.serial(receiptId, async () => {
        let current = this.receipt(receiptId);
        const state = session(current);
        if (!state.terms) {
          state.terms = await this.masumi.createPayment(state.request, current.amount);
          current = this.save(current, state);
        }
        if (!state.purchaseRequested) {
          const expired = this.now() > Number(state.terms.payByTime);
          if (expired && state.purchaseAttempted === false) throw new PaymentError('payment quote expired before purchase submission', 402);
          if (!state.purchaseAttempted) {
            state.purchaseAttempted = true;
            current = this.save(current, state);
          }
          // Resolve an ambiguous earlier purchase after expiry without submitting a new one.
          const purchase = expired
            ? await this.masumi.getPurchase(state.terms)
            : await this.masumi.createPurchase(state.terms);
          state.purchaseRequested = true;
          if (purchase.txHash) current.txHash = purchase.txHash;
          current.status = 'submitted';
          current = this.save(current, state);
        }
        return {receipt: current, xPayment: encodePaymentHeader(current)};
      });
    });
  }

  async confirm(receiptId: string): Promise<{receipt: PaymentReceiptRecord; xPayment: string}> {
    return this.serial(receiptId, async () => {
      const receipt = await this.confirmReceipt(this.receipt(receiptId));
      return {receipt, xPayment: encodePaymentHeader(receipt)};
    });
  }

  async verify(value: unknown): Promise<object> {
    const request = verifyRequest(value);
    const receipt = this.fromProof(request);
    return this.serial(receipt.receiptId, async () => {
      const saved = this.fromProof(request);
      const confirmed = saved.status === 'delivered' && saved.responseJson
        ? saved : await this.confirmReceipt(saved);
      return {
        valid: true, receiptId: confirmed.receiptId, txHash: confirmed.txHash, status: confirmed.status,
        simulated: confirmed.simulated,
        ...(confirmed.status === 'delivered' && confirmed.responseJson ? {response: JSON.parse(confirmed.responseJson)} : {}),
      };
    });
  }

  async deliver(value: unknown): Promise<{receipt: PaymentReceiptRecord; response: unknown}> {
    const body = object(value);
    const request = verifyRequest(body);
    const initial = this.fromProof(request);
    const responseJson = JSON.stringify(object(body.response));
    if (responseJson.length > 100_000) throw new PaymentError('score response is too large');
    return this.serial(initial.receiptId, async () => {
      let receipt = this.fromProof(request);
      if (receipt.responseJson && receipt.responseJson !== responseJson) {
        throw new PaymentError('receipt already has a different score response', 409);
      }
      if (receipt.status === 'delivered') return {receipt, response: JSON.parse(receipt.responseJson!)};
      receipt = await this.confirmReceipt(receipt);
      const state = session(receipt);
      // Persist the exact response before the result submission can take effect.
      receipt.responseJson = responseJson;
      receipt.resultHash = sha256(responseJson);
      receipt = this.save(receipt, state);
      if (!state.resultQueued) {
        await this.masumi.submitResult(state.terms!, receipt.resultHash!);
        state.resultQueued = true;
      }
      receipt.status = 'delivered';
      receipt.deliveredAt = new Date(this.now()).toISOString();
      receipt = this.save(receipt, state);
      return {receipt, response: JSON.parse(responseJson)};
    });
  }

  async refund(receiptId: string): Promise<PaymentReceiptRecord> {
    return this.serial(receiptId, async () => {
      const receipt = this.receipt(receiptId);
      if (receipt.status === 'refund_requested') return receipt;
      if (!['submitted', 'confirmed'].includes(receipt.status) || receipt.responseJson) {
        throw new PaymentError('receipt is not refundable', 409);
      }
      const state = session(receipt);
      this.checkConfiguration(receipt, state);
      await this.masumi.requestRefund(state.terms!);
      receipt.status = 'refund_requested';
      return this.save(receipt, state);
    });
  }

  private receipt(receiptId: string): PaymentReceiptRecord {
    const receipt = this.store.getPaymentReceipt(receiptId);
    if (!receipt) throw new PaymentError('unknown receipt', 402);
    return receipt;
  }

  private fromProof(request: VerifyRequest): PaymentReceiptRecord {
    let envelope: Record<string, unknown>;
    try {
      if (request.xPayment.length > 4096) throw new Error('oversized proof');
      envelope = object(JSON.parse(Buffer.from(request.xPayment, 'base64').toString('utf8')));
    } catch {
      throw new PaymentError('invalid payment proof', 402);
    }
    const payload = object(envelope.payload);
    const receipt = this.receipt(textField(payload.receiptId, 'receiptId'));
    const state = session(receipt);
    if (envelope.x402Version !== 1 || envelope.scheme !== 'exact' || envelope.network !== receipt.network ||
        (payload.txHash && payload.txHash !== receipt.txHash) || receipt.resource !== request.resource ||
        receipt.payTo !== request.payTo || receipt.amount !== request.amount ||
        (state.bindInput && receipt.inputHash !== request.inputHash) ||
        state.configurationHash !== this.configurationHash || state.mode !== this.config.mode ||
        receipt.simulated !== this.cardano.simulated) {
      throw new PaymentError('payment proof does not match the request', 402);
    }
    return receipt;
  }

  private async confirmReceipt(receipt: PaymentReceiptRecord): Promise<PaymentReceiptRecord> {
    this.checkConfiguration(receipt, session(receipt));
    if (!['submitted', 'confirmed', 'delivered'].includes(receipt.status)) {
      throw new PaymentError('payment is not available for delivery', 402);
    }
    const state = session(receipt);
    if (!state.terms || !state.purchaseRequested) throw new PaymentError('payment submission is pending', 402);
    const purchase = await this.masumi.getPurchase(state.terms);
    if (!['FundsLocked', 'ResultSubmitted', 'WithdrawAuthorized', 'Withdrawn'].includes(purchase.onChainState ?? '') ||
        purchase.transactionStatus !== 'Confirmed' || !purchase.txHash) {
      throw new PaymentError('Masumi funds lock is not confirmed or payment is disputed/refunded', 402);
    }
    if (receipt.txHash && purchase.txHash !== receipt.txHash) throw new PaymentError('funds-lock transaction changed', 402);
    const chain = await this.cardano.verifyPayment({
      txHash: purchase.txHash, payTo: state.terms.escrowAddress, amountLovelace: receipt.amount,
    });
    if (!chain.confirmed) throw new PaymentError(chain.reason ?? 'waiting for on-chain confirmation', 402);
    receipt.txHash = purchase.txHash;
    receipt.confirmedAt ??= new Date(this.now()).toISOString();
    if (receipt.status === 'submitted') receipt.status = 'confirmed';
    state.confirmations = chain.confirmations;
    return this.save(receipt, state);
  }

  private save(receipt: PaymentReceiptRecord, state: PaymentSession): PaymentReceiptRecord {
    const at = new Date(this.now()).toISOString();
    return this.store.transaction(() => {
      const saved = this.store.updatePaymentReceipt({
        ...receipt, protocolData: JSON.stringify(state), updatedAt: at,
      });
      this.store.schedulePaymentSettlement(receipt.receiptId, at);
      return saved;
    });
  }

  private checkConfiguration(receipt: PaymentReceiptRecord, state: PaymentSession): void {
    if (state.configurationHash !== this.configurationHash || state.mode !== this.config.mode ||
        receipt.simulated !== this.cardano.simulated || receipt.payer !== this.config.walletAddress) {
      throw new PaymentError('receipt belongs to another payment configuration', 409);
    }
  }

  private async serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    const pending = (this.inFlight.get(key) ?? Promise.resolve()).then(run);
    const tail = pending.then(() => {}, () => {});
    this.inFlight.set(key, tail);
    try {
      return await pending;
    } finally {
      if (this.inFlight.get(key) === tail) this.inFlight.delete(key);
    }
  }
}
