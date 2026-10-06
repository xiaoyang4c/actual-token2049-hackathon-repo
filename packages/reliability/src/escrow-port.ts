/**
 * @fileoverview Escrow port for the lifecycle.
 * The lifecycle calls this seam for funding, release, and refund.
 * The simulated Masumi adapter is the default implementation. It lives
 * in services/reliability/masumi-escrow.ts. This file does not open a
 * network connection.
 */

/** Inputs for one paper escrow funding. */
export interface EscrowFundRequest {
  transactionId: string;
  purchaserId: string;
  amountLovelace: number;
  sellerReturnAddress: string;
  payByTime: string;
  submitResultTime: string;
  unlockTime: string;
  externalDisputeUnlockTime: string;
  inputHash: string;
}

/**
 * Paper escrow session returned by funding.
 * Release and refund send this session back to the same port.
 * `mode` is paper. A live broadcast is rejected by the lifecycle.
 */
export interface EscrowSession {
  simulated: boolean;
  mode: 'paper';
  blockchainIdentifier: string;
  txHash: string;
  escrowAddress: string;
  amountLovelace: number;
  onChainState: string;
  inputHash: string;
  agentIdentifier: string;
  /** Buyer entity id. This is not the Masumi purchaser token. */
  purchaserId: string;
  /** Token sent to Masumi. The lifecycle sends the transaction id. */
  identifierFromPurchaser: string;
  sellerVkey: string;
  paymentSourceType: string;
  payByTime: string;
  submitResultTime: string;
  unlockTime: string;
  externalDisputeUnlockTime: string;
  sellerReturnAddress: string;
}

/** Result of queueing a Masumi result hash. This is not a chain payout. */
export interface EscrowReleaseResult {
  simulated: boolean;
  mode: 'paper';
  action: 'submit_result';
  resultHash: string;
  blockchainIdentifier: string;
}

/**
 * Result of queueing a Masumi refund request.
 * A request is not a completed on-chain refund.
 */
export interface EscrowRefundResult {
  simulated: boolean;
  mode: 'paper';
  action: 'request_refund';
  blockchainIdentifier: string;
}

/**
 * Funding, release, and refund.
 * `simulated` must stay true. The lifecycle rejects a live port.
 */
export interface EscrowPort {
  readonly simulated: boolean;
  fund(request: EscrowFundRequest): Promise<EscrowSession>;
  release(session: EscrowSession, resultHash: string): Promise<EscrowReleaseResult>;
  refund(session: EscrowSession): Promise<EscrowRefundResult>;
}
