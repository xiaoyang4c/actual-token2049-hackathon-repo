import type {PaymentConfig} from './config';
import type {CardanoAdapter} from './cardano';
import type {AgentStore} from '../../packages/db/src';
import {PaymentApiClient} from './http-client';
import {lovelace, object, PaymentError, sha256, textField, type ApiTransport, type CredentialResolver} from './types';

/** Wire fields verified against the pinned Masumi payment-service REST schema. */
export interface MasumiPaymentRequest {
  network: 'Preprod';
  inputHash: string;
  agentIdentifier: string;
  identifierFromPurchaser: string;
  paymentSourceType: 'Web3CardanoV1' | 'Web3CardanoV2';
  supportedPaymentSourceIndex?: number;
  payByTime: string;
  submitResultTime: string;
  unlockTime: string;
  externalDisputeUnlockTime: string;
  sellerReturnAddress: string;
  forceLayer: 'L1';
}

export interface MasumiTerms {
  blockchainIdentifier: string;
  agentIdentifier: string;
  inputHash: string;
  identifierFromPurchaser: string;
  sellerVkey: string;
  escrowAddress: string;
  amountLovelace: number;
  paymentSourceType: 'Web3CardanoV1' | 'Web3CardanoV2';
  supportedPaymentSourceIndex?: number;
  payByTime: string;
  submitResultTime: string;
  unlockTime: string;
  externalDisputeUnlockTime: string;
  sellerReturnAddress?: string;
}

export interface MasumiPurchase {
  onChainState: string | null;
  txHash?: string;
  transactionStatus?: string;
  nextAction?: string;
}

export interface MasumiSettlementTransaction {
  txHash?: string;
  status: string;
  newOnChainState?: string;
  previousOnChainState?: string;
  confirmations?: number;
  blockHeight?: number;
  fees?: string;
}

export interface MasumiSettlementAction {
  requestedAction?: string;
  resultHash?: string;
  submittedTxHash?: string;
  errorType?: string;
  errorNote?: string;
}

/** Protocol observations are distinct from independently verified settlement. */
export interface MasumiSettlementView {
  onChainState: string | null;
  resultHash?: string;
  nextAction?: MasumiSettlementAction;
  actionHistory?: MasumiSettlementAction[];
  transactions: MasumiSettlementTransaction[];
  sellerCoolDownTime?: string;
  buyerCoolDownTime?: string;
  withdrawnForSeller?: number;
  withdrawnForBuyer?: number;
  buyerReturnAddress?: string;
  sellerReturnAddress?: string;
}

export interface MasumiSettlementSnapshot {
  payment: MasumiSettlementView | null;
  purchase: MasumiSettlementView | null;
  protocolFees?: MasumiProtocolFeeTerms;
  protocolFeeError?: string;
}

export interface MasumiProtocolFeeTerms {
  escrowAddress: string;
  feeRatePermille: number;
  feeReceiverAddress: string;
  minimumFeeLovelace: number;
}

export interface MasumiAdapter {
  readonly simulated: boolean;
  createPayment(request: MasumiPaymentRequest, expectedAmount: number): Promise<MasumiTerms>;
  createPurchase(terms: MasumiTerms): Promise<MasumiPurchase>;
  getPurchase(terms: MasumiTerms): Promise<MasumiPurchase>;
  getSettlement(terms: MasumiTerms): Promise<MasumiSettlementSnapshot>;
  submitResult(terms: MasumiTerms, resultHash: string): Promise<void>;
  requestRefund(terms: MasumiTerms): Promise<void>;
}

/** Simulates a funds lock and queued result/refund actions. Never releases escrow. */
export class SimulatedMasumiAdapter implements MasumiAdapter {
  readonly simulated = true;

  constructor(private readonly cardano: CardanoAdapter, private readonly store?: AgentStore) {}

  async createPayment(request: MasumiPaymentRequest, expectedAmount: number): Promise<MasumiTerms> {
    const milliseconds = (value: string) => String(Date.parse(value));
    return {
      ...request, blockchainIdentifier: `simulated:${request.identifierFromPurchaser}`,
      sellerVkey: 'simulated-seller-vkey', escrowAddress: 'addr_test1_simulated_escrow',
      amountLovelace: expectedAmount,
      payByTime: milliseconds(request.payByTime), submitResultTime: milliseconds(request.submitResultTime),
      unlockTime: milliseconds(request.unlockTime), externalDisputeUnlockTime: milliseconds(request.externalDisputeUnlockTime),
    };
  }

  async createPurchase(terms: MasumiTerms): Promise<MasumiPurchase> {
    return this.getPurchase(terms);
  }

  async getPurchase(terms: MasumiTerms): Promise<MasumiPurchase> {
    const txHash = await this.cardano.submitTransaction(Buffer.from(terms.blockchainIdentifier).toString('hex'));
    return {onChainState: 'FundsLocked', txHash, transactionStatus: 'Confirmed'};
  }

  async submitResult(): Promise<void> {
    // The runtime persists the simulated queued action and result hash.
  }

  async requestRefund(): Promise<void> {
    // A refund request is not a completed refund or a balance credit.
  }

  async getSettlement(terms: MasumiTerms): Promise<MasumiSettlementSnapshot> {
    const receipt = this.store?.listPaymentReceipts().find((record) => {
      try {
        return object(object(JSON.parse(record.protocolData ?? '{}')).terms).blockchainIdentifier === terms.blockchainIdentifier;
      } catch {
        return false;
      }
    });
    if (!receipt || !receipt.txHash) return {payment: {onChainState: null, transactions: []}, purchase: null};
    const queued = object(JSON.parse(receipt.protocolData!)).resultQueued === true;
    const refunded = receipt.status === 'refund_requested';
    const hasResult = queued && Boolean(receipt.resultHash);
    const view: MasumiSettlementView = {
      onChainState: refunded ? 'FundsLocked' : hasResult ? 'ResultSubmitted' : 'FundsLocked',
      resultHash: hasResult ? receipt.resultHash : undefined,
      nextAction: refunded ? {requestedAction: 'SetRefundRequestedRequested'} : {requestedAction: 'WaitingForExternalAction'},
      transactions: [{txHash: receipt.txHash, status: 'Confirmed', newOnChainState: 'FundsLocked'}],
      sellerCoolDownTime: '0', buyerCoolDownTime: '0',
      buyerReturnAddress: receipt.payer, sellerReturnAddress: receipt.payTo,
    };
    if (hasResult) view.transactions.unshift({
      txHash: simulatedResultTxHash(receipt.receiptId, receipt.resultHash!), status: 'Confirmed',
      previousOnChainState: 'FundsLocked', newOnChainState: 'ResultSubmitted',
    });
    return {payment: view, purchase: {...view}};
  }
}

/** Masumi owns purchase signing/submission. Do not also submit a direct ADA transfer. */
export class PreprodMasumiAdapter implements MasumiAdapter {
  readonly simulated: boolean;
  private readonly client: PaymentApiClient;

  constructor(private readonly config: PaymentConfig, transport?: ApiTransport, resolver?: CredentialResolver) {
    this.client = new PaymentApiClient(config, config.masumiUrl, transport, resolver);
    this.simulated = this.client.simulated;
  }

  private async post(path: string, role: 'buyer' | 'seller', body: unknown, acceptExisting = false): Promise<Record<string, unknown>> {
    const response = await this.client.request(path,
      role === 'buyer' ? this.config.masumiBuyerKeyRef : this.config.masumiSellerKeyRef, 'token', {
        method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body),
      });
    // Upstream HttpExistsError returns the existing record under `object`.
    if (response.status === 409 && acceptExisting) return object(object(await response.json()).object);
    if (!response.ok) throw new PaymentError(`Masumi ${path} failed (${response.status})`, response.status === 404 ? 404 : 503);
    const result = object(await response.json());
    if (typeof result.status !== 'string' || result.status.toLowerCase() !== 'success') {
      throw new PaymentError('invalid Masumi response envelope', 502);
    }
    return object(result.data);
  }

  async createPayment(request: MasumiPaymentRequest, expectedAmount: number): Promise<MasumiTerms> {
    if (request.agentIdentifier.length < 57 || !/^[a-f0-9]{64}$/.test(request.inputHash)) {
      throw new PaymentError('a registered Masumi agent and input hash are required for preprod');
    }
    const data = await this.post('/payment', 'seller', request, true);
    const source = object(data.PaymentSource);
    const seller = object(data.SmartContractWallet);
    if (source.network !== 'Preprod' || source.paymentSourceType !== request.paymentSourceType ||
        data.agentIdentifier !== request.agentIdentifier || data.inputHash !== request.inputHash ||
        data.sellerReturnAddress !== request.sellerReturnAddress || funds(data.RequestedFunds) !== expectedAmount) {
      throw new PaymentError('Masumi payment terms do not match the quote', 502);
    }
    const timestamp = (name: string): string => {
      const value = textField(data[name], name);
      if (!/^[0-9]+$/.test(value) || Number(value) !== Date.parse(request[name as keyof MasumiPaymentRequest] as string)) {
        throw new PaymentError(`Masumi ${name} does not match the request`, 502);
      }
      return value;
    };
    const escrowAddress = textField(source.smartContractAddress, 'smartContractAddress');
    if (!escrowAddress.startsWith('addr_test1')) throw new PaymentError('Masumi escrow must use preprod', 502);
    return {
      blockchainIdentifier: textField(data.blockchainIdentifier, 'blockchainIdentifier'),
      agentIdentifier: request.agentIdentifier, inputHash: request.inputHash,
      identifierFromPurchaser: request.identifierFromPurchaser,
      sellerVkey: textField(seller.walletVkey, 'sellerVkey'), escrowAddress, amountLovelace: expectedAmount,
      paymentSourceType: request.paymentSourceType, supportedPaymentSourceIndex: request.supportedPaymentSourceIndex,
      payByTime: timestamp('payByTime'), submitResultTime: timestamp('submitResultTime'),
      unlockTime: timestamp('unlockTime'), externalDisputeUnlockTime: timestamp('externalDisputeUnlockTime'),
      sellerReturnAddress: request.sellerReturnAddress,
    };
  }

  async createPurchase(terms: MasumiTerms): Promise<MasumiPurchase> {
    // Recover a purchase whose POST succeeded before the local process stopped.
    try {
      return await this.getPurchase(terms);
    } catch (error) {
      if (!(error instanceof PaymentError) || error.status !== 404) throw error;
    }
    const data = await this.post('/purchase', 'buyer', {
      network: 'Preprod', blockchainIdentifier: terms.blockchainIdentifier,
      inputHash: terms.inputHash, sellerVkey: terms.sellerVkey, agentIdentifier: terms.agentIdentifier,
      identifierFromPurchaser: terms.identifierFromPurchaser,
      paymentSourceType: terms.paymentSourceType, supportedPaymentSourceIndex: terms.supportedPaymentSourceIndex,
      smartContractAddress: terms.escrowAddress, Amounts: [{unit: '', amount: String(terms.amountLovelace)}],
      payByTime: terms.payByTime, submitResultTime: terms.submitResultTime,
      unlockTime: terms.unlockTime, externalDisputeUnlockTime: terms.externalDisputeUnlockTime,
      forceLayer: 'L1', paymentForceLayer: 'L1',
    }, true);
    return this.purchase(data, terms);
  }

  async getPurchase(terms: MasumiTerms): Promise<MasumiPurchase> {
    return this.purchase(await this.post('/purchase/resolve-blockchain-identifier', 'buyer', {
      network: 'Preprod', blockchainIdentifier: terms.blockchainIdentifier,
      filterSmartContractAddress: terms.escrowAddress, includeHistory: 'true',
    }), terms);
  }

  async getSettlement(terms: MasumiTerms): Promise<MasumiSettlementSnapshot> {
    const read = async (role: 'buyer' | 'seller'): Promise<MasumiSettlementView | null> => {
      const path = role === 'buyer' ? '/purchase/resolve-blockchain-identifier' : '/payment/resolve-blockchain-identifier';
      try {
        return this.settlement(await this.post(path, role, {
          network: 'Preprod', blockchainIdentifier: terms.blockchainIdentifier,
          filterSmartContractAddress: terms.escrowAddress, includeHistory: 'true',
        }), terms, role);
      } catch (error) {
        // Absence from an API does not establish that no funds were locked.
        if (error instanceof PaymentError && error.status === 404) return null;
        throw error;
      }
    };
    const [payment, purchase] = await Promise.all([read('seller'), read('buyer')]);
    const snapshot: MasumiSettlementSnapshot = {payment, purchase};
    if (terms.paymentSourceType === 'Web3CardanoV1' && [payment, purchase].some((view) => view?.onChainState === 'Withdrawn')) {
      try {
        snapshot.protocolFees = await this.protocolFees(terms);
      } catch (error) {
        snapshot.protocolFeeError = error instanceof Error ? error.message : 'Masumi protocol fee terms are unavailable';
      }
    }
    return snapshot;
  }

  private async protocolFees(terms: MasumiTerms): Promise<MasumiProtocolFeeTerms> {
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const path = `/payment-source?take=100${cursor ? `&cursorId=${encodeURIComponent(cursor)}` : ''}`;
      const response = await this.client.request(path, this.config.masumiSellerKeyRef, 'token', {method: 'GET'});
      if (!response.ok) throw new PaymentError(`Masumi protocol fee lookup failed (${response.status})`, 503);
      const envelope = object(await response.json());
      if (typeof envelope.status !== 'string' || envelope.status.toLowerCase() !== 'success') {
        throw new PaymentError('invalid Masumi fee response envelope', 502);
      }
      const sources = object(envelope.data).PaymentSources;
      if (!Array.isArray(sources)) throw new PaymentError('invalid Masumi payment sources', 502);
      const matches = sources.map(object).filter((source) => source.network === 'Preprod' &&
        source.paymentSourceType === terms.paymentSourceType && source.smartContractAddress === terms.escrowAddress);
      if (matches.length > 1) throw new PaymentError('ambiguous Masumi protocol fee terms', 502);
      if (matches.length === 1) {
        const source = matches[0];
        const rate = source.feeRatePermille;
        const receiver = object(source.FeeReceiverNetworkWallet).walletAddress;
        if (typeof rate !== 'number' || !Number.isSafeInteger(rate) || rate < 0 || rate > 1000 ||
            typeof receiver !== 'string' || !receiver.startsWith('addr_test1')) {
          throw new PaymentError('invalid Masumi protocol fee terms', 502);
        }
        return {
          escrowAddress: terms.escrowAddress, feeRatePermille: rate, feeReceiverAddress: receiver,
          // Pinned payment-core/config.ts MIN_COLLATERAL_LOVELACE used by V1 collection.
          minimumFeeLovelace: 1_435_230,
        };
      }
      if (sources.length < 100) break;
      const next = optionalText(object(sources[sources.length - 1]).id);
      if (!next || next === cursor) break;
      cursor = next;
    }
    throw new PaymentError('Masumi protocol fee terms for this escrow are unavailable', 503);
  }

  private settlement(data: Record<string, unknown>, terms: MasumiTerms, role: 'buyer' | 'seller'): MasumiSettlementView {
    const source = object(data.PaymentSource);
    if (data.blockchainIdentifier !== terms.blockchainIdentifier || data.inputHash !== terms.inputHash ||
        data.agentIdentifier !== terms.agentIdentifier || source.network !== 'Preprod' ||
        source.smartContractAddress !== terms.escrowAddress || source.paymentSourceType !== terms.paymentSourceType ||
        funds(role === 'buyer' ? data.PaidFunds : data.RequestedFunds) !== terms.amountLovelace ||
        (terms.sellerReturnAddress && data.sellerReturnAddress && data.sellerReturnAddress !== terms.sellerReturnAddress)) {
      throw new PaymentError('Masumi settlement does not match the payment terms', 502);
    }
    for (const name of ['payByTime', 'submitResultTime', 'unlockTime', 'externalDisputeUnlockTime'] as const) {
      if (data[name] !== undefined && data[name] !== null && data[name] !== terms[name]) {
        throw new PaymentError(`Masumi settlement ${name} does not match the payment terms`, 502);
      }
    }
    const transactions = [data.CurrentTransaction,
      ...(Array.isArray(data.TransactionHistory) ? data.TransactionHistory : [])]
      .filter((entry) => entry !== null && entry !== undefined).map((entry): MasumiSettlementTransaction => {
        const tx = object(entry);
        return {
          txHash: optionalText(tx.txHash), status: optionalText(tx.status) ?? 'Unknown',
          newOnChainState: optionalText(tx.newOnChainState), previousOnChainState: optionalText(tx.previousOnChainState),
          confirmations: optionalInteger(tx.confirmations), blockHeight: optionalInteger(tx.blockHeight), fees: optionalText(tx.fees),
        };
      });
    return {
      onChainState: optionalText(data.onChainState) ?? null, resultHash: optionalText(data.resultHash),
      nextAction: data.NextAction ? settlementAction(data.NextAction) : undefined,
      actionHistory: Array.isArray(data.ActionHistory) ? data.ActionHistory.map(settlementAction) : undefined,
      transactions,
      sellerCoolDownTime: optionalTime(data.sellerCoolDownTime ?? (role === 'seller' ? data.cooldownTime : data.cooldownTimeOtherParty)),
      buyerCoolDownTime: optionalTime(data.buyerCoolDownTime ?? (role === 'buyer' ? data.cooldownTime : data.cooldownTimeOtherParty)),
      withdrawnForSeller: withdrawnFunds(data.WithdrawnForSeller), withdrawnForBuyer: withdrawnFunds(data.WithdrawnForBuyer),
      buyerReturnAddress: optionalText(data.buyerReturnAddress), sellerReturnAddress: optionalText(data.sellerReturnAddress),
    };
  }

  private purchase(data: Record<string, unknown>, terms: MasumiTerms): MasumiPurchase {
    const source = object(data.PaymentSource);
    if (data.blockchainIdentifier !== terms.blockchainIdentifier || data.inputHash !== terms.inputHash ||
        data.agentIdentifier !== terms.agentIdentifier || source.network !== 'Preprod' ||
        source.smartContractAddress !== terms.escrowAddress || source.paymentSourceType !== terms.paymentSourceType ||
        funds(data.PaidFunds) !== terms.amountLovelace) {
      throw new PaymentError('Masumi purchase does not match the payment terms', 502);
    }
    const transactions = [data.CurrentTransaction,
      ...(Array.isArray(data.TransactionHistory) ? data.TransactionHistory : [])]
      .filter((entry) => entry !== null && entry !== undefined).map(object);
    const deposit = transactions.find((tx) => tx.newOnChainState === 'FundsLocked' &&
      (tx.status === 'Confirmed' || tx.status === 'Pending'));
    const action = object(data.NextAction);
    if (action.errorType) throw new PaymentError('Masumi purchase requires recovery', 503);
    return {
      onChainState: typeof data.onChainState === 'string' ? data.onChainState : null,
      txHash: typeof deposit?.txHash === 'string' ? deposit.txHash : undefined,
      transactionStatus: typeof deposit?.status === 'string' ? deposit.status : undefined,
      nextAction: typeof action.requestedAction === 'string' ? action.requestedAction : undefined,
    };
  }

  async submitResult(terms: MasumiTerms, resultHash: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(resultHash)) throw new PaymentError('invalid result hash');
    const data = await this.post('/payment/resolve-blockchain-identifier', 'seller', {
      network: 'Preprod', blockchainIdentifier: terms.blockchainIdentifier,
    });
    if (data.blockchainIdentifier !== terms.blockchainIdentifier || data.inputHash !== terms.inputHash) {
      throw new PaymentError('Masumi result payment mismatch', 502);
    }
    const queuedHash = object(data.NextAction).resultHash ?? data.resultHash;
    if (queuedHash === resultHash) return;
    if (queuedHash) throw new PaymentError('a different result is already queued', 409);
    await this.post('/payment/submit-result', 'seller', {
      network: 'Preprod', blockchainIdentifier: terms.blockchainIdentifier, submitResultHash: resultHash,
    });
  }

  async requestRefund(terms: MasumiTerms): Promise<void> {
    const purchase = await this.getPurchase(terms);
    if (['RefundRequested', 'RefundAuthorized', 'RefundWithdrawn'].includes(purchase.onChainState ?? '') ||
        ['SetRefundRequestedRequested', 'SetRefundRequestedInitiated'].includes(purchase.nextAction ?? '')) return;
    await this.post('/purchase/request-refund', 'buyer', {network: 'Preprod', blockchainIdentifier: terms.blockchainIdentifier});
  }
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function optionalTime(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^[0-9]+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new PaymentError('invalid Masumi cooldown timestamp', 502);
  }
  return String(value);
}

function settlementAction(value: unknown): MasumiSettlementAction {
  const action = object(value);
  return {
    requestedAction: optionalText(action.requestedAction), resultHash: optionalText(action.resultHash),
    submittedTxHash: optionalText(action.submittedTxHash), errorType: optionalText(action.errorType), errorNote: optionalText(action.errorNote),
  };
}

function withdrawnFunds(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new PaymentError('invalid Masumi withdrawn funds', 502);
  let total = 0;
  for (const entry of value) {
    const fund = object(entry);
    if ((fund.unit !== '' && fund.unit !== 'lovelace') || typeof fund.amount !== 'string' || !/^[0-9]+$/.test(fund.amount)) {
      throw new PaymentError('only ADA settlement amounts are supported', 502);
    }
    total += Number(fund.amount);
    if (!Number.isSafeInteger(total)) throw new PaymentError('invalid Masumi withdrawn amount', 502);
  }
  return total;
}

export function simulatedResultTxHash(receiptId: string, resultHash: string): string {
  return sha256(`simulated:result:${receiptId}:${resultHash}`);
}

function funds(value: unknown): number {
  if (!Array.isArray(value) || value.length !== 1) throw new PaymentError('only a single ADA payment asset is supported', 502);
  const fund = object(value[0]);
  if (fund.unit !== '') throw new PaymentError('Masumi ADA uses an empty asset unit', 502);
  return lovelace(fund.amount);
}
