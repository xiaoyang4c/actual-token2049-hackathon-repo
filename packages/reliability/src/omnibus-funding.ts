/**
 * @fileoverview Paper omnibus funding contracts.
 * Business ownership stays in the internal ledger. A transfer view only
 * contains the pool and deal addresses. Paper addresses are not wallets.
 */

export interface PaperOmnibusPool {
  poolId: string;
  poolAddress: string;
}

/** Trusted simulation input. This is not proof of an on-chain deposit. */
export interface PaperPoolDeposit {
  idempotencyKey: string;
  poolId: string;
  businessId: string;
  sourceAddress: string;
  depositTxHash: string;
  outputIndex: number;
  amountLovelace: number;
  at: string;
}

export interface DealFundingRequest {
  idempotencyKey: string;
  businessId: string;
  transactionId: string;
  amountLovelace: number;
  at: string;
}

/** Private accounting record. Do not publish this as chain metadata. */
export interface PaperDealFundingRecord extends DealFundingRequest {
  poolId: string;
  poolAddress: string;
  dealAddress: string;
  txHash: string;
}

export interface OmnibusBalance {
  depositedLovelace: number;
  allocatedLovelace: number;
  availableLovelace: number;
}

/** Transfer projection. It contains no business or deposit reference. */
export interface PaperPoolTransfer {
  simulated: true;
  mode: 'paper';
  fromAddress: string;
  toAddress: string;
  amountLovelace: number;
  txHash: string;
}

/** Storage operations must commit each credit or allocation atomically. */
export interface OmnibusFundingStore {
  ensurePaperOmnibusPool(pool: PaperOmnibusPool): PaperOmnibusPool;
  recordPaperPoolDeposit(deposit: PaperPoolDeposit): PaperPoolDeposit;
  fundPaperDeal(
    request: DealFundingRequest & {poolId: string},
  ): PaperDealFundingRecord;
  getOmnibusBalance(poolId: string, businessId: string): OmnibusBalance;
}

/** Paper seam for future escrow integration. It does not settle escrow. */
export interface PaperDealFundingPort {
  readonly simulated: true;
  readonly broadcast: false;
  fund(request: DealFundingRequest): Promise<PaperPoolTransfer>;
}
