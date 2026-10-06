/**
 * @fileoverview Paper omnibus funding adapter.
 * It uses the shared store. It reads no keys and calls no network API.
 * It does not change the existing Masumi escrow adapter.
 */

import type {
  DealFundingRequest, OmnibusBalance, OmnibusFundingStore,
  PaperDealFundingPort, PaperOmnibusPool, PaperPoolDeposit, PaperPoolTransfer,
} from '../../packages/reliability/src/omnibus-funding';

const DEFAULT_POOL: PaperOmnibusPool = {
  poolId: 'paper-cardano-pool',
  poolAddress: 'paper:pool:platform',
};

export class PaperOmnibusFunding implements PaperDealFundingPort {
  readonly simulated = true;
  readonly broadcast = false;
  private readonly pool: PaperOmnibusPool;

  constructor(
    private readonly store: OmnibusFundingStore,
    pool: PaperOmnibusPool = DEFAULT_POOL,
  ) {
    this.pool = {...store.ensurePaperOmnibusPool({...pool})};
  }

  /** Credits a trusted paper fixture. It cannot confirm a real deposit. */
  recordDeposit(deposit: Omit<PaperPoolDeposit, 'poolId'>): PaperPoolDeposit {
    return this.store.recordPaperPoolDeposit({...deposit, poolId: this.pool.poolId});
  }

  balance(businessId: string): OmnibusBalance {
    return this.store.getOmnibusBalance(this.pool.poolId, businessId);
  }

  /** Only the transfer projection leaves this boundary. */
  async fund(request: DealFundingRequest): Promise<PaperPoolTransfer> {
    const saved = this.store.fundPaperDeal({...request, poolId: this.pool.poolId});
    return {
      simulated: true,
      mode: 'paper',
      fromAddress: saved.poolAddress,
      toAddress: saved.dealAddress,
      amountLovelace: saved.amountLovelace,
      txHash: saved.txHash,
    };
  }
}
