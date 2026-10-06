/**
 * @fileoverview Simulated Masumi escrow port for the lifecycle.
 * Funding, release, and refund call the existing Masumi adapter.
 * This file constructs only the simulated adapter. It does not
 * broadcast a live order.
 */

import {AgentStore} from '../../packages/db/src/index';
import type {
  EscrowFundRequest, EscrowPort, EscrowRefundResult, EscrowReleaseResult,
  EscrowSession,
} from '../../packages/reliability/src/escrow-port';
import {SimulatedCardanoAdapter} from '../cardano-agents-ts/cardano';
import {loadPaymentConfig} from '../cardano-agents-ts/config';
import {
  SimulatedMasumiAdapter,
  type MasumiAdapter,
  type MasumiPaymentRequest,
  type MasumiTerms,
} from '../cardano-agents-ts/masumi';

const AGENT_IDENTIFIER = 'simulated-reliability-agent';

/** Paper escrow port. `simulated` stays true. */
export class SimulatedMasumiEscrow implements EscrowPort {
  readonly simulated: boolean;

  constructor(private readonly masumi: MasumiAdapter) {
    this.simulated = masumi.simulated;
    if (!this.simulated) {
      throw new Error('escrow must stay simulated; live broadcast is disabled');
    }
  }

  async fund(request: EscrowFundRequest): Promise<EscrowSession> {
    const payment: MasumiPaymentRequest = {
      network: 'Preprod',
      inputHash: request.inputHash,
      agentIdentifier: AGENT_IDENTIFIER,
      identifierFromPurchaser: request.transactionId,
      paymentSourceType: 'Web3CardanoV1',
      payByTime: request.payByTime,
      submitResultTime: request.submitResultTime,
      unlockTime: request.unlockTime,
      externalDisputeUnlockTime: request.externalDisputeUnlockTime,
      sellerReturnAddress: request.sellerReturnAddress,
      forceLayer: 'L1',
    };
    const terms = await this.masumi.createPayment(payment, request.amountLovelace);
    const purchase = await this.masumi.createPurchase(terms);
    if (!purchase.txHash) {
      throw new Error('Masumi purchase did not return a transaction hash');
    }
    return {
      simulated: true,
      mode: 'paper',
      blockchainIdentifier: terms.blockchainIdentifier,
      txHash: purchase.txHash,
      escrowAddress: terms.escrowAddress,
      amountLovelace: terms.amountLovelace,
      onChainState: purchase.onChainState ?? 'FundsLocked',
      inputHash: terms.inputHash,
      agentIdentifier: terms.agentIdentifier,
      purchaserId: request.purchaserId,
      identifierFromPurchaser: request.transactionId,
      sellerVkey: terms.sellerVkey,
      paymentSourceType: terms.paymentSourceType,
      payByTime: terms.payByTime,
      submitResultTime: terms.submitResultTime,
      unlockTime: terms.unlockTime,
      externalDisputeUnlockTime: terms.externalDisputeUnlockTime,
      sellerReturnAddress: terms.sellerReturnAddress ?? request.sellerReturnAddress,
    };
  }

  async release(
    session: EscrowSession, resultHash: string,
  ): Promise<EscrowReleaseResult> {
    await this.masumi.submitResult(toTerms(session), resultHash);
    return {
      simulated: true,
      mode: 'paper',
      action: 'submit_result',
      resultHash,
      blockchainIdentifier: session.blockchainIdentifier,
    };
  }

  async refund(session: EscrowSession): Promise<EscrowRefundResult> {
    await this.masumi.requestRefund(toTerms(session));
    return {
      simulated: true,
      mode: 'paper',
      action: 'request_refund',
      blockchainIdentifier: session.blockchainIdentifier,
    };
  }
}

/** Builds the default paper port. It does not read wallet secrets. */
export function createSimulatedMasumiEscrow(): EscrowPort {
  const config = loadPaymentConfig(simulatedPaymentEnv());
  const store = AgentStore.open(':memory:');
  const cardano = new SimulatedCardanoAdapter(store, config);
  return new SimulatedMasumiEscrow(new SimulatedMasumiAdapter(cardano, store));
}

function toTerms(session: EscrowSession): MasumiTerms {
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

function simulatedPaymentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  env.CARDANO_MODE = 'simulated';
  env.CARDANO_ALLOW_NETWORK = 'false';
  env.CARDANO_RECEIPT_DB = ':memory:';
  return env;
}

function paymentSource(value: string): 'Web3CardanoV1'|'Web3CardanoV2' {
  if (value === 'Web3CardanoV1' || value === 'Web3CardanoV2') return value;
  throw new Error('unsupported Masumi payment source');
}
