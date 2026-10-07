/** @fileoverview Tests live escrow proof selection and agreement binding offline. */
import {expect, test} from 'bun:test';
import {AgentStore} from '../../packages/db/src/index';
import {SimulatedCardanoAdapter} from '../cardano-agents-ts/cardano';
import {loadPaymentConfig} from '../cardano-agents-ts/config';
import {SimulatedMasumiAdapter, type MasumiSettlementSnapshot} from '../cardano-agents-ts/masumi';
import type {SettlementVerificationRequest} from '../cardano-agents-ts/settlement-evidence';
import {ChainEscrow, createSimulatedMasumiEscrow} from './masumi-escrow';

const AT = '2026-10-07T00:00:00.000Z';
const END = '2026-10-09T00:00:00.000Z';

test('live escrow verifies the matching chain action and binds the original agreement', async () => {
  const store = AgentStore.open();
  try {
    const env: Record<string, string> = {};
    env.CARDANO_WALLET_ADDRESS = 'addr_test1_buyer';
    const config = loadPaymentConfig(env);
    const cardano = new SimulatedCardanoAdapter(store, config);
    const masumi = new SimulatedMasumiAdapter(cardano);
    const port = new ChainEscrow(masumi, cardano, config, 'live', true);
    const session = await createSimulatedMasumiEscrow(store).fund({transactionId: 'deal', purchaserId: 'buyer',
      amountLovelace: 1_000_000, sellerReturnAddress: 'addr_test1_seller',
      inputHash: 'a'.repeat(64), payByTime: AT, submitResultTime: END,
      unlockTime: END, externalDisputeUnlockTime: END});
    const calls: SettlementVerificationRequest[] = [];
    let confirmed = false;
    let decodedState = 'FundsLocked';
    cardano.verifySettlement = async (request) => {
      calls.push(request);
      return {confirmed, confirmations: confirmed ? 3 : 0,
        txHash: request.transaction.txHash, onChainState: decodedState, evidence: []};
    };
    const snapshot: MasumiSettlementSnapshot = {payment: null, purchase: {
      onChainState: 'ResultSubmitted', transactions: [{status: 'Confirmed',
        txHash: 'b'.repeat(64), newOnChainState: 'ResultSubmitted'}],
    }};
    masumi.getSettlement = async () => snapshot;
    expect((await port.verify(session, 'release', 'c'.repeat(64))).verified).toBe(false);
    expect(calls).toHaveLength(0);

    snapshot.purchase!.transactions = [{status: 'Confirmed', txHash: session.txHash,
      newOnChainState: 'FundsLocked'}];
    expect((await port.verify(session, 'fund')).verified).toBe(false);
    confirmed = true;
    decodedState = 'ResultSubmitted';
    expect((await port.verify(session, 'fund')).verified).toBe(false);
    decodedState = 'FundsLocked';
    expect((await port.verify(session, 'fund')).verified).toBe(true);
    expect(calls[calls.length - 1]).toMatchObject({kind: 'state',
      depositTxHash: session.txHash, sellerAddress: 'addr_test1_seller',
      buyerAddress: 'addr_test1_buyer', terms: {inputHash: session.inputHash,
        amountLovelace: session.amountLovelace, blockchainIdentifier: session.blockchainIdentifier}});

    const feeTerms = {escrowAddress: session.escrowAddress,
      feeRatePermille: 50, feeReceiverAddress: 'addr_test1_fee', minimumFeeLovelace: 0};
    snapshot.protocolFees = feeTerms;
    for (const action of ['release', 'refund'] as const) {
      snapshot.purchase!.transactions = [{status: 'Confirmed', txHash: 'd'.repeat(64),
        newOnChainState: action === 'release' ? 'Withdrawn' : 'RefundWithdrawn'}];
      snapshot.purchase!.withdrawnForSeller = action === 'release' ? 950_000 : 0;
      snapshot.purchase!.withdrawnForBuyer = action === 'refund' ? 1_000_000 : 0;
      confirmed = false;
      expect((await port.verify(session, action, 'c'.repeat(64))).verified).toBe(false);
      confirmed = true;
      expect((await port.verify(session, action, 'c'.repeat(64))).verified).toBe(true);
      expect(calls[calls.length - 1]).toMatchObject({kind: action === 'release' ? 'withdrawal' : 'refund',
        resultHash: 'c'.repeat(64), protocolFees: feeTerms,
        withdrawnForSeller: action === 'release' ? 950_000 : 0,
        withdrawnForBuyer: action === 'refund' ? 1_000_000 : 0});
    }
  } finally { store.close(); }
});
