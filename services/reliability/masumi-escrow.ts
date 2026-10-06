/**
 * @fileoverview Masumi and Cardano escrow port for the lifecycle.
 * Simulated mode is the default. A live preprod order is sent only when
 * CARDANO_MODE is preprod and CARDANO_ALLOW_NETWORK is true. Keys are
 * read through the existing *_KEY_REF names. This file does not store
 * key values.
 */

import {AgentStore} from '../../packages/db/src/index';
import type {
  EscrowConsent, EscrowFundRequest, EscrowMutualTerminationResult,
  EscrowPort, EscrowRefundResult, EscrowReleaseResult, EscrowSession,
  EscrowStatus,
} from '../../packages/reliability/src/escrow-port';
import {
  PreprodCardanoAdapter, SimulatedCardanoAdapter, type CardanoAdapter,
} from '../cardano-agents-ts/cardano';
import {loadPaymentConfig, type PaymentConfig} from '../cardano-agents-ts/config';
import {
  PreprodMasumiAdapter, SimulatedMasumiAdapter,
  type MasumiAdapter, type MasumiPaymentRequest, type MasumiTerms,
} from '../cardano-agents-ts/masumi';
import type {ApiTransport, CredentialResolver} from '../cardano-agents-ts/types';

const SIMULATED_AGENT = 'simulated-reliability-agent';

/** Options for the escrow factory. Omit them for the simulated default. */
export interface EscrowPortOptions {
  env?: Record<string, string|undefined>;
  store?: AgentStore;
  masumiTransport?: ApiTransport;
  cardanoTransport?: ApiTransport;
  resolveCredential?: CredentialResolver;
}

/**
 * Builds the escrow port.
 * Simulation does not call the network. Preprod with network access off
 * and no fixture transport is a dry run. Fixture transports stay paper.
 */
export function createEscrowPort(options: EscrowPortOptions = {}): EscrowPort {
  const config = loadPaymentConfig(options.env);
  const broadcast = config.mode === 'preprod' && config.allowNetwork;
  if (config.mode === 'simulated') {
    return simulatedPort(config, options.store);
  }
  if (!options.masumiTransport && !options.cardanoTransport && !broadcast) {
    return new DryRunEscrow(config);
  }
  const cardano = new PreprodCardanoAdapter(
    config, options.cardanoTransport, options.resolveCredential,
  );
  const masumi = new PreprodMasumiAdapter(
    config, options.masumiTransport, options.resolveCredential,
  );
  if (cardano.simulated !== masumi.simulated) {
    throw new Error('Cardano and Masumi transports must use the same simulation mode');
  }
  if (broadcast && (cardano.simulated || masumi.simulated)) {
    throw new Error('preprod broadcast requires a live transport');
  }
  if (!broadcast && !masumi.simulated) {
    throw new Error('escrow must stay simulated; live broadcast is disabled');
  }
  return new ChainEscrow(
    masumi, cardano, config, masumi.simulated ? 'paper' : 'live', broadcast,
  );
}

/** Simulated port. It does not read wallet secrets. */
export function createSimulatedMasumiEscrow(store?: AgentStore): EscrowPort {
  return simulatedPort(loadPaymentConfig(simulatedPaymentEnv()), store);
}

/** Paper escrow over the simulated Masumi adapter. */
export class SimulatedMasumiEscrow implements EscrowPort {
  readonly simulated = true;
  readonly broadcast = false;

  constructor(
    private readonly masumi: MasumiAdapter,
    private readonly cardano: CardanoAdapter,
  ) {
    if (!masumi.simulated || !cardano.simulated) {
      throw new Error('escrow must stay simulated; live broadcast is disabled');
    }
  }

  async fund(request: EscrowFundRequest): Promise<EscrowSession> {
    const terms = await this.masumi.createPayment(
      paymentRequest(request, simulatedConfig()), request.amountLovelace,
    );
    const purchase = await this.masumi.createPurchase(terms);
    if (!purchase.txHash) {
      throw new Error('Masumi purchase did not return a transaction hash');
    }
    return sessionFrom(terms, request, {
      simulated: true,
      mode: 'paper',
      txHash: purchase.txHash,
      onChainState: purchase.onChainState ?? 'FundsLocked',
      identifierFromPurchaser: request.transactionId,
    });
  }

  async release(
    session: EscrowSession, resultHash: string,
  ): Promise<EscrowReleaseResult> {
    await this.masumi.submitResult(toTerms(session), resultHash);
    return {
      simulated: true, mode: 'paper', action: 'submit_result', resultHash,
      blockchainIdentifier: session.blockchainIdentifier,
    };
  }

  async refund(session: EscrowSession): Promise<EscrowRefundResult> {
    await this.masumi.requestRefund(toTerms(session));
    return {
      simulated: true, mode: 'paper', action: 'request_refund',
      blockchainIdentifier: session.blockchainIdentifier,
    };
  }

  status(session: EscrowSession): Promise<EscrowStatus> {
    return observeStatus(this.masumi, this.cardano, session, true, 'paper');
  }

  async mutualTerminate(
    session: EscrowSession, consent: EscrowConsent,
  ): Promise<EscrowMutualTerminationResult> {
    await this.masumi.requestRefund(toTerms(session));
    const status = await this.status(session);
    return mutualResult(session, consent, status, true, 'paper');
  }
}

/**
 * Preprod escrow. `broadcast` is true only for a live transport that
 * was opened with both network gates on.
 */
export class ChainEscrow implements EscrowPort {
  readonly simulated: boolean;
  readonly broadcast: boolean;

  constructor(
    private readonly masumi: MasumiAdapter,
    private readonly cardano: CardanoAdapter,
    private readonly config: PaymentConfig,
    private readonly orderMode: 'paper'|'live',
    broadcast: boolean,
  ) {
    this.simulated = orderMode === 'paper';
    this.broadcast = broadcast;
  }

  async fund(request: EscrowFundRequest): Promise<EscrowSession> {
    const terms = await this.masumi.createPayment(
      paymentRequest(request, this.config), request.amountLovelace,
    );
    const purchase = await this.masumi.createPurchase(terms);
    if (!purchase.txHash) {
      throw new Error('Masumi purchase did not return a transaction hash');
    }
    return sessionFrom(terms, request, {
      simulated: this.simulated,
      mode: this.orderMode,
      txHash: purchase.txHash,
      onChainState: purchase.onChainState ?? 'FundsLocked',
      identifierFromPurchaser: request.transactionId,
    });
  }

  async release(
    session: EscrowSession, resultHash: string,
  ): Promise<EscrowReleaseResult> {
    await this.masumi.submitResult(toTerms(session), resultHash);
    return {
      simulated: this.simulated, mode: this.orderMode, action: 'submit_result',
      resultHash, blockchainIdentifier: session.blockchainIdentifier,
    };
  }

  async refund(session: EscrowSession): Promise<EscrowRefundResult> {
    await this.masumi.requestRefund(toTerms(session));
    return {
      simulated: this.simulated, mode: this.orderMode, action: 'request_refund',
      blockchainIdentifier: session.blockchainIdentifier,
    };
  }

  status(session: EscrowSession): Promise<EscrowStatus> {
    return observeStatus(
      this.masumi, this.cardano, session, this.simulated, this.orderMode,
    );
  }

  async mutualTerminate(
    session: EscrowSession, consent: EscrowConsent,
  ): Promise<EscrowMutualTerminationResult> {
    await this.masumi.requestRefund(toTerms(session));
    const status = await this.status(session);
    return mutualResult(session, consent, status, this.simulated, this.orderMode);
  }
}

/**
 * Preprod plan with network access off. It returns the escrow terms
 * it would submit and does not call Masumi or Blockfrost.
 */
export class DryRunEscrow implements EscrowPort {
  readonly simulated = true;
  readonly broadcast = false;

  constructor(private readonly config: PaymentConfig) {}

  fund(request: EscrowFundRequest): Promise<EscrowSession> {
    const agentIdentifier = this.config.masumiAgentIdentifier;
    return Promise.resolve({
      simulated: true,
      mode: 'paper',
      blockchainIdentifier: `dry-run:${request.transactionId}`,
      txHash: 'dry-run',
      escrowAddress: 'dry-run',
      amountLovelace: request.amountLovelace,
      onChainState: 'DryRun',
      inputHash: request.inputHash,
      agentIdentifier,
      purchaserId: request.purchaserId,
      identifierFromPurchaser: request.transactionId,
      sellerVkey: 'dry-run',
      paymentSourceType: this.config.masumiPaymentSourceType,
      payByTime: request.payByTime,
      submitResultTime: request.submitResultTime,
      unlockTime: request.unlockTime,
      externalDisputeUnlockTime: request.externalDisputeUnlockTime,
      sellerReturnAddress: request.sellerReturnAddress,
    });
  }

  release(session: EscrowSession, resultHash: string): Promise<EscrowReleaseResult> {
    return Promise.resolve({
      simulated: true, mode: 'paper', action: 'submit_result', resultHash,
      blockchainIdentifier: session.blockchainIdentifier,
    });
  }

  refund(session: EscrowSession): Promise<EscrowRefundResult> {
    return Promise.resolve({
      simulated: true, mode: 'paper', action: 'request_refund',
      blockchainIdentifier: session.blockchainIdentifier,
    });
  }

  status(session: EscrowSession): Promise<EscrowStatus> {
    return Promise.resolve({
      simulated: true,
      mode: 'paper',
      onChainState: 'DryRun',
      txHash: session.txHash,
      escrowAddress: session.escrowAddress,
    });
  }

  mutualTerminate(
    session: EscrowSession, consent: EscrowConsent,
  ): Promise<EscrowMutualTerminationResult> {
    return Promise.resolve(mutualResult(session, consent, {
      simulated: true, mode: 'paper', onChainState: 'DryRun', txHash: 'dry-run',
      escrowAddress: session.escrowAddress,
    }, true, 'paper'));
  }
}

function simulatedPort(config: PaymentConfig, store?: AgentStore): EscrowPort {
  const cardanoStore = store ?? AgentStore.open(':memory:');
  const cardano = new SimulatedCardanoAdapter(cardanoStore, config);
  const masumi = new SimulatedMasumiAdapter(cardano, cardanoStore);
  return new SimulatedMasumiEscrow(masumi, cardano);
}

function paymentRequest(
  request: EscrowFundRequest, config: PaymentConfig,
): MasumiPaymentRequest {
  return {
    network: 'Preprod',
    inputHash: request.inputHash,
    agentIdentifier: config.masumiAgentIdentifier,
    identifierFromPurchaser: request.transactionId,
    paymentSourceType: config.masumiPaymentSourceType,
    ...(config.masumiPaymentSourceType === 'Web3CardanoV2' ?
      {supportedPaymentSourceIndex: config.masumiSupportedSourceIndex} :
      {}),
    payByTime: request.payByTime,
    submitResultTime: request.submitResultTime,
    unlockTime: request.unlockTime,
    externalDisputeUnlockTime: request.externalDisputeUnlockTime,
    sellerReturnAddress: request.sellerReturnAddress,
    forceLayer: 'L1',
  };
}

function simulatedConfig(): PaymentConfig {
  return {...loadPaymentConfig(simulatedPaymentEnv()), masumiAgentIdentifier: SIMULATED_AGENT};
}

function sessionFrom(
  terms: MasumiTerms,
  request: EscrowFundRequest,
  fields: {
    simulated: boolean;
    mode: 'paper'|'live';
    txHash: string;
    onChainState: string;
    identifierFromPurchaser: string;
  },
): EscrowSession {
  return {
    simulated: fields.simulated,
    mode: fields.mode,
    blockchainIdentifier: terms.blockchainIdentifier,
    txHash: fields.txHash,
    escrowAddress: terms.escrowAddress,
    amountLovelace: terms.amountLovelace,
    onChainState: fields.onChainState,
    inputHash: terms.inputHash,
    agentIdentifier: terms.agentIdentifier,
    purchaserId: request.purchaserId,
    identifierFromPurchaser: fields.identifierFromPurchaser,
    sellerVkey: terms.sellerVkey,
    paymentSourceType: terms.paymentSourceType,
    payByTime: terms.payByTime,
    submitResultTime: terms.submitResultTime,
    unlockTime: terms.unlockTime,
    externalDisputeUnlockTime: terms.externalDisputeUnlockTime,
    sellerReturnAddress: terms.sellerReturnAddress ?? request.sellerReturnAddress,
  };
}

async function observeStatus(
  masumi: MasumiAdapter,
  cardano: CardanoAdapter,
  session: EscrowSession,
  simulated: boolean,
  mode: 'paper'|'live',
): Promise<EscrowStatus> {
  let onChainState: string|null = session.onChainState;
  let txHash = session.txHash;
  const snapshot = await masumi.getSettlement(toTerms(session));
  const view = snapshot.purchase ?? snapshot.payment;
  if (view?.onChainState) onChainState = view.onChainState;
  const latest = view?.transactions.find((tx) => tx.txHash);
  if (latest?.txHash) txHash = latest.txHash;
  let blockTime: string|undefined;
  if (/^[a-f0-9]{64}$/.test(txHash)) {
    const observed = await cardano.observeSettlementTransaction(txHash);
    blockTime = observed.blockTime;
  }
  return {
    simulated, mode, onChainState, txHash, blockTime,
    escrowAddress: session.escrowAddress,
  };
}

function mutualResult(
  session: EscrowSession,
  consent: EscrowConsent,
  status: EscrowStatus,
  simulated: boolean,
  mode: 'paper'|'live',
): EscrowMutualTerminationResult {
  return {
    simulated,
    mode,
    action: 'mutual_termination',
    blockchainIdentifier: session.blockchainIdentifier,
    txHash: status.txHash ?? session.txHash,
    onChainState: status.onChainState ?? 'RefundRequested',
    ...(status.blockTime ? {blockTime: status.blockTime} : {}),
    buyerConsentAt: consent.buyerConsentAt,
    sellerConsentAt: consent.sellerConsentAt,
    contractEnds: consent.contractEnds,
  };
}

export function toTerms(session: EscrowSession): MasumiTerms {
  return {
    blockchainIdentifier: session.blockchainIdentifier,
    agentIdentifier: session.agentIdentifier,
    inputHash: session.inputHash,
    identifierFromPurchaser: session.identifierFromPurchaser,
    sellerVkey: session.sellerVkey,
    escrowAddress: session.escrowAddress,
    amountLovelace: session.amountLovelace,
    paymentSourceType: paymentSource(session.paymentSourceType),
    payByTime: session.payByTime,
    submitResultTime: session.submitResultTime,
    unlockTime: session.unlockTime,
    externalDisputeUnlockTime: session.externalDisputeUnlockTime,
    sellerReturnAddress: session.sellerReturnAddress,
  };
}

function paymentSource(value: string): 'Web3CardanoV1'|'Web3CardanoV2' {
  if (value === 'Web3CardanoV1' || value === 'Web3CardanoV2') return value;
  throw new Error('unsupported Masumi payment source');
}

function simulatedPaymentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  env.CARDANO_MODE = 'simulated';
  env.CARDANO_ALLOW_NETWORK = 'false';
  env.CARDANO_RECEIPT_DB = ':memory:';
  return env;
}
