/**
 * @fileoverview Converts escrow sessions to durable scalar evidence and back.
 */

import type {EscrowSession} from '../escrow-port';
import {LifecycleError, type LifecycleTransition} from './contracts';

type Evidence = LifecycleTransition['evidence'];

export function sessionEvidence(
  session: EscrowSession, extra: Evidence,
): Evidence {
  return {
    simulated: session.simulated,
    mode: session.mode,
    blockchainIdentifier: session.blockchainIdentifier,
    txHash: session.txHash,
    escrowAddress: session.escrowAddress,
    amountLovelace: session.amountLovelace,
    onChainState: session.onChainState,
    inputHash: session.inputHash,
    agentIdentifier: session.agentIdentifier,
    purchaserId: session.purchaserId,
    identifierFromPurchaser: session.identifierFromPurchaser,
    sellerVkey: session.sellerVkey,
    paymentSourceType: session.paymentSourceType,
    payByTime: session.payByTime,
    submitResultTime: session.submitResultTime,
    unlockTime: session.unlockTime,
    externalDisputeUnlockTime: session.externalDisputeUnlockTime,
    sellerReturnAddress: session.sellerReturnAddress,
    ...extra,
  };
}

export function sessionFromEvidence(evidence: Evidence): EscrowSession {
  const text = (key: string): string => {
    const value = evidence[key];
    if (typeof value !== 'string' || value === '') {
      throw new LifecycleError('escrow session evidence is incomplete');
    }
    return value;
  };
  const amount = evidence.amountLovelace;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) {
    throw new LifecycleError('escrow session evidence is incomplete');
  }
  const simulated = evidence.simulated === true;
  const live = evidence.simulated === false && evidence.mode === 'live';
  if (!simulated && !live) {
    throw new LifecycleError('escrow session evidence is incomplete');
  }
  if (simulated && evidence.mode !== 'paper') {
    throw new LifecycleError('escrow must stay simulated; live broadcast is disabled');
  }
  return {
    simulated,
    mode: simulated ? 'paper' : 'live',
    blockchainIdentifier: text('blockchainIdentifier'),
    txHash: text('txHash'),
    escrowAddress: text('escrowAddress'),
    amountLovelace: amount,
    onChainState: text('onChainState'),
    inputHash: text('inputHash'),
    agentIdentifier: text('agentIdentifier'),
    purchaserId: text('purchaserId'),
    identifierFromPurchaser: text('identifierFromPurchaser'),
    sellerVkey: text('sellerVkey'),
    paymentSourceType: text('paymentSourceType'),
    payByTime: text('payByTime'),
    submitResultTime: text('submitResultTime'),
    unlockTime: text('unlockTime'),
    externalDisputeUnlockTime: text('externalDisputeUnlockTime'),
    sellerReturnAddress: text('sellerReturnAddress'),
  };
}
