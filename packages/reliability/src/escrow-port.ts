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
 * Escrow session returned by funding.
 * Release, refund, status, and mutual termination send this session back.
 * `mode` is paper for a simulated order and live for an enabled preprod order.
 */
export interface EscrowSession {
  simulated: boolean;
  mode: 'paper'|'live';
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
  mode: 'paper'|'live';
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
  mode: 'paper'|'live';
  action: 'request_refund';
  blockchainIdentifier: string;
}

/** On-chain or simulated observation for one escrow session. */
export interface EscrowStatus {
  /** True only after the adapter verifies the bound chain transaction and outputs. */
  verified?: boolean;
  simulated: boolean;
  mode: 'paper'|'live';
  onChainState: string|null;
  txHash?: string;
  /** ISO time of the observed block. Absent when the chain has no block yet. */
  blockTime?: string;
  escrowAddress?: string;
}

/** Both parties agree to end the contract before `contractEnds`. */
export interface EscrowConsent {
  buyerConsentAt: string;
  sellerConsentAt: string;
  contractEnds: string;
  terminatedAt: string;
}

/**
 * Escrow return for a mutual termination.
 * The current Masumi call is a refund request. The consent fields are
 * recorded so a later on-chain contract can require both parties.
 */
export interface EscrowMutualTerminationResult {
  simulated: boolean;
  mode: 'paper'|'live';
  action: 'mutual_termination';
  blockchainIdentifier: string;
  txHash: string;
  onChainState: string;
  blockTime?: string;
  buyerConsentAt: string;
  sellerConsentAt: string;
  contractEnds: string;
}

/**
 * Funding, release, refund, status, and mutual termination.
 * `broadcast` is true only when CARDANO_MODE is preprod and
 * CARDANO_ALLOW_NETWORK is true. The lifecycle rejects every other
 * non-simulated port.
 */
export interface EscrowPort {
  readonly simulated: boolean;
  readonly broadcast: boolean;
  fund(request: EscrowFundRequest): Promise<EscrowSession>;
  release(session: EscrowSession, resultHash: string): Promise<EscrowReleaseResult>;
  refund(session: EscrowSession): Promise<EscrowRefundResult>;
  status(session: EscrowSession): Promise<EscrowStatus>;
  verify?(
    session: EscrowSession, action: 'fund'|'release'|'refund', resultHash?: string,
  ): Promise<EscrowStatus>;
  mutualTerminate(
    session: EscrowSession, consent: EscrowConsent,
  ): Promise<EscrowMutualTerminationResult>;
}
