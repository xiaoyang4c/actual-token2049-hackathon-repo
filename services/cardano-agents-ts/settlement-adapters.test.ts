import {describe, expect, test} from 'bun:test';
import LZString from 'lz-string';
import {AgentStore} from '../../packages/db/src';
import {PreprodCardanoAdapter, SimulatedCardanoAdapter} from './cardano';
import {loadPaymentConfig} from './config';
import {
  PreprodMasumiAdapter, SimulatedMasumiAdapter, simulatedResultTxHash, type MasumiTerms,
} from './masumi';
import {
  decodeMasumiDatum, verifySettlementEvidence, type SettlementTransactionEvidence,
  type SettlementUtxoEvidence, type SettlementVerificationRequest,
} from './settlement-evidence';
import {object, sha256, type ApiTransport} from './types';

const BUYER = 'addr_test1vz42424242424242424242424242424242424242424242s7p3w6y';
const SELLER = 'addr_test1vzamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwc48zzn4';
const OTHER = 'addr_test1vrxvenxvenxvenxvenxvenxvenxvenxvenxvenxvenxvenqy39q57';
const DEPOSIT = 'ab'.repeat(32);
const RESULT = 'cd'.repeat(32);
const PAYOUT = 'ef'.repeat(32);
const RESULT_HASH = 'fe'.repeat(32);
const constr = (index: number, fields: unknown[] = []) => ({constructor: index, fields});
const hex = (value: string) => ({bytes: value});
const int = (value: string | number) => ({int: value});
const address = (key: string) => constr(0, [constr(0, [hex(key.repeat(28))]), constr(1)]);

function protocolFixture(v2 = true) {
  const sellerNonce = '01'.repeat(32);
  const agentIdentifier = '02'.repeat(32);
  const purchaser = '03'.repeat(10);
  const signature = '04'.repeat(32);
  const key = '05'.repeat(16);
  const escrow = 'addr_test1_fixture_escrow';
  const parts = [sellerNonce + agentIdentifier, purchaser, signature, key, ...(v2 ? [escrow] : [])];
  const terms: MasumiTerms = {
    blockchainIdentifier: Buffer.from(LZString.compressToUint8Array(parts.join('.'))).toString('hex'),
    agentIdentifier, inputHash: '06'.repeat(32), identifierFromPurchaser: purchaser,
    sellerVkey: 'bb'.repeat(28), escrowAddress: escrow, amountLovelace: 1_000_000,
    paymentSourceType: v2 ? 'Web3CardanoV2' : 'Web3CardanoV1',
    payByTime: '1000', submitResultTime: '2000', unlockTime: '3000', externalDisputeUnlockTime: '4000',
    sellerReturnAddress: SELLER,
  };
  const datum = (state: number, resultHash = '', collateral = 0) => constr(0, [
    address('aa'), ...(v2 ? [constr(1)] : []), address('bb'), ...(v2 ? [constr(1)] : []),
    hex(key), hex(signature), hex(v2 ? sellerNonce : sellerNonce + agentIdentifier), hex(purchaser),
    ...(v2 ? [hex(agentIdentifier)] : []), int(collateral), hex(terms.inputHash), hex(resultHash),
    int(terms.payByTime), int(terms.submitResultTime), int(terms.unlockTime), int(terms.externalDisputeUnlockTime),
    int(0), int(0), constr(state),
  ]);
  const output = (state: number, resultHash = '', collateral = 0): SettlementUtxoEvidence => ({
    address: escrow, amountLovelace: 1_000_000, outputIndex: 0, datum: datum(state, resultHash, collateral), consumedByTx: null,
  });
  const transaction = (txHash: string, outputs: SettlementUtxoEvidence[], source?: string): SettlementTransactionEvidence => ({
    txHash, indexed: true, validContract: true, confirmations: 3, blockHash: 'aa'.repeat(32), blockHeight: 100,
    feeLovelace: 170_000, inputs: source ? [{address: escrow, txHash: source, outputIndex: 0, amountLovelace: 1_000_000}] : [], outputs,
  });
  const deposit = transaction(DEPOSIT, [output(0)]);
  const result = transaction(RESULT, [output(1, RESULT_HASH)], DEPOSIT);
  const payoutOutput = (recipient: string, amount: number, source = RESULT): SettlementUtxoEvidence => ({
    address: recipient, amountLovelace: amount, outputIndex: 0,
    ...(v2 ? {datum: constr(0, [hex(source), int(0)])} : {}),
  });
  const payout = transaction(PAYOUT, [payoutOutput(SELLER, 1_000_000)], RESULT);
  const request: SettlementVerificationRequest = {
    terms, depositTxHash: DEPOSIT, transaction: {txHash: PAYOUT, status: 'Confirmed', newOnChainState: 'Withdrawn'},
    kind: 'withdrawal', resultHash: RESULT_HASH, sellerAddress: SELLER, buyerAddress: BUYER, withdrawnForSeller: 1_000_000,
  };
  return {terms, datum, output, transaction, deposit, result, payout, payoutOutput, request};
}

describe('pinned Masumi escrow proof', () => {
  test.each([false, true])('decodes exact identifier and terms for V2=%s and rejects a mismatched receipt', (v2) => {
    const fixture = protocolFixture(v2);
    expect(decodeMasumiDatum(fixture.datum(1, RESULT_HASH), fixture.terms)).toMatchObject({
      onChainState: 'ResultSubmitted', resultHash: RESULT_HASH, buyerAddress: BUYER, sellerAddress: SELLER,
    });
    expect(decodeMasumiDatum(fixture.datum(1, RESULT_HASH), {...fixture.terms, inputHash: '07'.repeat(32)})).toBeUndefined();
    expect(decodeMasumiDatum(fixture.datum(1, RESULT_HASH), {...fixture.terms, unlockTime: '3001'})).toBeUndefined();
    expect(decodeMasumiDatum(fixture.datum(1, RESULT_HASH), {...fixture.terms, sellerVkey: 'cc'.repeat(28)})).toBeUndefined();
    expect(decodeMasumiDatum(fixture.datum(1, RESULT_HASH), {...fixture.terms, identifierFromPurchaser: '08'.repeat(10)})).toBeUndefined();
  });

  test('V1 has no withdrawal/refund authorization datum states', () => {
    const fixture = protocolFixture(false);
    expect(decodeMasumiDatum(fixture.datum(4, RESULT_HASH), fixture.terms)).toBeUndefined();
    expect(decodeMasumiDatum(fixture.datum(5), fixture.terms)).toBeUndefined();
    const v2 = protocolFixture();
    expect(decodeMasumiDatum(v2.datum(4, RESULT_HASH), v2.terms)?.onChainState).toBe('WithdrawAuthorized');
    expect(decodeMasumiDatum(v2.datum(5), v2.terms)?.onChainState).toBe('RefundAuthorized');
  });

  test('confirms a result only with the expected hash and exact deposit lineage', () => {
    const fixture = protocolFixture();
    const request: SettlementVerificationRequest = {...fixture.request, kind: 'result',
      transaction: {txHash: RESULT, status: 'Confirmed', newOnChainState: 'ResultSubmitted'}};
    expect(verifySettlementEvidence(request, [fixture.deposit, fixture.result], 3).confirmed).toBe(true);
    expect(verifySettlementEvidence({...request, resultHash: '09'.repeat(32)}, [fixture.deposit, fixture.result], 3).confirmed).toBe(false);
    fixture.result.inputs[0].txHash = '10'.repeat(32);
    expect(verifySettlementEvidence(request, [fixture.deposit, fixture.result], 3).confirmed).toBe(false);
  });

  test('an already spent or unknown current escrow cannot establish withdrawal availability', () => {
    const fixture = protocolFixture();
    const request: SettlementVerificationRequest = {...fixture.request, kind: 'result',
      transaction: {txHash: RESULT, status: 'Confirmed', newOnChainState: 'ResultSubmitted'}};
    fixture.result.outputs[0].consumedByTx = PAYOUT;
    expect(verifySettlementEvidence(request, [fixture.deposit, fixture.result], 3).confirmed).toBe(false);
    fixture.result.outputs[0].consumedByTx = undefined;
    expect(verifySettlementEvidence(request, [fixture.deposit, fixture.result], 3).confirmed).toBe(false);
  });

  test.each([false, true])('verifies a complete seller payout for V2=%s', (v2) => {
    const fixture = protocolFixture(v2);
    if (!v2) {
      fixture.deposit.outputs[0].amountLovelace = 3_000_000;
      fixture.result.inputs[0].amountLovelace = 3_000_000;
      fixture.result.outputs[0].amountLovelace = 3_000_000;
      fixture.payout.inputs[0].amountLovelace = 3_000_000;
      fixture.payout.outputs[0].amountLovelace = 1_564_770;
      fixture.payout.outputs.push({address: OTHER, outputIndex: 1, amountLovelace: 1_435_230, datum: constr(0, [hex(RESULT), int(0)])});
      fixture.request.protocolFees = {
        escrowAddress: fixture.terms.escrowAddress, feeReceiverAddress: OTHER, feeRatePermille: 10, minimumFeeLovelace: 1_435_230,
      };
    }
    fixture.request.withdrawnForSeller = 0;
    fixture.request.withdrawnForBuyer = 0;
    expect(verifySettlementEvidence(fixture.request, [fixture.deposit, fixture.result, fixture.payout], 3)).toMatchObject({
      confirmed: true, txHash: PAYOUT, confirmations: 3,
    });
  });

  test('V2 accounts for collateral return when checking the seller residual', () => {
    const fixture = protocolFixture();
    fixture.deposit.outputs[0].datum = fixture.datum(0, '', 100_000);
    fixture.result.outputs[0].datum = fixture.datum(1, RESULT_HASH, 100_000);
    fixture.payout.outputs = [fixture.payoutOutput(SELLER, 900_000), {...fixture.payoutOutput(BUYER, 100_000), outputIndex: 1}];
    fixture.request.withdrawnForSeller = 900_000;
    fixture.request.withdrawnForBuyer = 100_000;
    expect(verifySettlementEvidence(fixture.request, [fixture.deposit, fixture.result, fixture.payout], 3).confirmed).toBe(true);
  });

  test('V2 dispute resolution derives a distinct return-address payout from tagged chain evidence', () => {
    const fixture = protocolFixture();
    fixture.terms.sellerReturnAddress = OTHER;
    fixture.request.sellerAddress = OTHER;
    for (const tx of [fixture.deposit, fixture.result]) {
      const datum = tx.outputs[0].datum as {fields: unknown[]};
      datum.fields[3] = constr(0, [address('cc')]);
    }
    const disputeHash = '01'.repeat(32);
    const disputed = fixture.transaction(disputeHash, [fixture.output(3, RESULT_HASH)], RESULT);
    (disputed.outputs[0].datum as {fields: unknown[]}).fields[3] = constr(0, [address('cc')]);
    fixture.payout.inputs[0].txHash = disputeHash;
    fixture.payout.outputs = [fixture.payoutOutput(OTHER, 1_000_000, disputeHash)];
    const request: SettlementVerificationRequest = {...fixture.request, kind: 'disputed_withdrawal',
      transaction: {...fixture.request.transaction, newOnChainState: 'DisputedWithdrawn'}, withdrawnForSeller: 0, withdrawnForBuyer: 0};
    expect(verifySettlementEvidence(request, [fixture.deposit, fixture.result, disputed, fixture.payout], 3)).toMatchObject({
      confirmed: true, paidForSeller: 1_000_000, paidForBuyer: 0,
    });
  });

  test('V2 finder disposition records zero buyer and seller proceeds', () => {
    const fixture = protocolFixture();
    const disputeHash = '01'.repeat(32);
    const disputed = fixture.transaction(disputeHash, [fixture.output(3, RESULT_HASH)], RESULT);
    fixture.payout.inputs[0].txHash = disputeHash;
    fixture.payout.outputs = [fixture.payoutOutput(OTHER, 1_000_000, disputeHash)];
    const request: SettlementVerificationRequest = {...fixture.request, kind: 'disputed_withdrawal',
      transaction: {...fixture.request.transaction, newOnChainState: 'DisputedWithdrawn'}, withdrawnForSeller: 0, withdrawnForBuyer: 0};
    expect(verifySettlementEvidence(request, [fixture.deposit, fixture.result, disputed, fixture.payout], 3)).toMatchObject({
      confirmed: true, paidForSeller: 0, paidForBuyer: 0,
    });
  });

  test.each(['result hash', 'beneficiary', 'payout tag', 'escrow lineage', 'confirmation', 'rollback'] as const)(
    'rejects a payout with incorrect %s', (failure) => {
      const fixture = protocolFixture();
      if (failure === 'result hash') fixture.request.resultHash = '09'.repeat(32);
      if (failure === 'beneficiary') fixture.payout.outputs[0].address = OTHER;
      if (failure === 'payout tag') fixture.payout.outputs[0].datum = constr(0, [hex(DEPOSIT), int(0)]);
      if (failure === 'escrow lineage') fixture.payout.inputs[0].txHash = '10'.repeat(32);
      if (failure === 'confirmation') fixture.payout.confirmations = 2;
      if (failure === 'rollback') fixture.request.transaction.status = 'RolledBack';
      expect(verifySettlementEvidence(fixture.request, [fixture.deposit, fixture.result, fixture.payout], 3).confirmed).toBe(false);
    },
  );

  test('a confirmed deposit cannot stand in for payout evidence', () => {
    const fixture = protocolFixture();
    fixture.request.transaction.txHash = DEPOSIT;
    expect(verifySettlementEvidence(fixture.request, [fixture.deposit], 3).confirmed).toBe(false);
    fixture.request.transaction.txHash = RESULT;
    expect(verifySettlementEvidence(fixture.request, [fixture.deposit, fixture.result], 3).confirmed).toBe(false);
  });

  test('V1 rejects an ambiguous payout across several escrow inputs', () => {
    const fixture = protocolFixture(false);
    fixture.payout.inputs.push({...fixture.payout.inputs[0], txHash: '10'.repeat(32)});
    expect(verifySettlementEvidence(fixture.request, [fixture.deposit, fixture.result, fixture.payout], 3).confirmed).toBe(false);
  });

  test.each([false, true])('a confirmed refund must recover the principal for V2=%s', (v2) => {
    const fixture = protocolFixture(v2);
    const refund = fixture.transaction(PAYOUT, [fixture.payoutOutput(BUYER, 1_000_000, DEPOSIT)], DEPOSIT);
    const request: SettlementVerificationRequest = {...fixture.request, kind: 'refund', resultHash: undefined,
      transaction: {txHash: PAYOUT, status: 'Confirmed', newOnChainState: 'RefundWithdrawn'},
      withdrawnForSeller: 0, withdrawnForBuyer: 1_000_000};
    expect(verifySettlementEvidence(request, [fixture.deposit, refund], 3).confirmed).toBe(true);
    refund.outputs[0].amountLovelace = 1;
    request.withdrawnForBuyer = 1;
    expect(verifySettlementEvidence(request, [fixture.deposit, refund], 3)).toMatchObject({
      confirmed: false, reason: 'refund amount does not recover the payment principal',
    });
  });

  test('unverified V1 fee terms cannot turn a partial seller payout into settlement', () => {
    const fixture = protocolFixture(false);
    fixture.payout.outputs[0].amountLovelace = 950_000;
    fixture.request.withdrawnForSeller = 950_000;
    expect(verifySettlementEvidence(fixture.request, [fixture.deposit, fixture.result, fixture.payout], 3).confirmed).toBe(false);
  });

  test('a reduced V1 seller payout needs the fee paid to the configured receiver for this escrow', () => {
    const fixture = protocolFixture(false);
    fixture.deposit.outputs[0].amountLovelace = 3_000_000;
    fixture.result.inputs[0].amountLovelace = 3_000_000;
    fixture.result.outputs[0].amountLovelace = 3_000_000;
    fixture.payout.inputs[0].amountLovelace = 3_000_000;
    fixture.payout.outputs[0].amountLovelace = 1_564_770;
    fixture.payout.outputs.push({address: BUYER, outputIndex: 1, amountLovelace: 1_435_230, datum: constr(0, [hex(RESULT), int(0)])});
    fixture.request.protocolFees = {
      escrowAddress: fixture.terms.escrowAddress, feeReceiverAddress: OTHER, feeRatePermille: 10, minimumFeeLovelace: 1_435_230,
    };
    expect(verifySettlementEvidence(fixture.request, [fixture.deposit, fixture.result, fixture.payout], 3)).toMatchObject({
      confirmed: false, reason: 'protocol fee payment does not match this escrow',
    });
    fixture.payout.outputs[1].address = OTHER;
    fixture.payout.outputs[1].datum = constr(0, [hex(DEPOSIT), int(0)]);
    expect(verifySettlementEvidence(fixture.request, [fixture.deposit, fixture.result, fixture.payout], 3).confirmed).toBe(false);
  });
});

function masumiData(terms: MasumiTerms, seller: boolean): Record<string, unknown> {
  return {
    blockchainIdentifier: terms.blockchainIdentifier, agentIdentifier: terms.agentIdentifier, inputHash: terms.inputHash,
    payByTime: terms.payByTime, submitResultTime: terms.submitResultTime, unlockTime: terms.unlockTime,
    externalDisputeUnlockTime: terms.externalDisputeUnlockTime, sellerReturnAddress: SELLER, buyerReturnAddress: BUYER,
    cooldownTime: seller ? 5000 : 6000, cooldownTimeOtherParty: seller ? 6000 : 5000,
    onChainState: 'ResultSubmitted', resultHash: RESULT_HASH,
    ...Object.fromEntries([
      ['PaymentSource', {network: 'Preprod', paymentSourceType: terms.paymentSourceType, smartContractAddress: terms.escrowAddress}],
      [seller ? 'RequestedFunds' : 'PaidFunds', [{unit: '', amount: '1000000'}]],
      ['WithdrawnForSeller', [{unit: 'lovelace', amount: '950000'}]], ['WithdrawnForBuyer', []],
      ['NextAction', {requestedAction: 'WaitingForManualAction', errorType: 'Unknown', errorNote: 'fixture recovery required', resultHash: RESULT_HASH}],
      ['CurrentTransaction', {txHash: RESULT, status: 'Confirmed', previousOnChainState: 'FundsLocked', newOnChainState: 'ResultSubmitted', confirmations: 3}],
      ['TransactionHistory', [{txHash: DEPOSIT, status: 'Confirmed', newOnChainState: 'FundsLocked'}]],
      ['ActionHistory', [{requestedAction: 'SubmitResultRequested', resultHash: RESULT_HASH, submittedTxHash: RESULT}]],
    ]),
  };
}

describe('read-only Masumi lifecycle adapter', () => {
  test('keeps full history, result hashes, action errors, cooldowns, amounts and beneficiaries', async () => {
    const {terms} = protocolFixture();
    const calls: string[] = [];
    const transport: ApiTransport = {simulated: true, fetch: async (url, init) => {
      const path = new URL(url).pathname;
      calls.push(path);
      expect(object(JSON.parse(String(init.body)))).toMatchObject({includeHistory: 'true', filterSmartContractAddress: terms.escrowAddress});
      const seller = path.includes('/payment/');
      return Response.json({status: 'success', data: masumiData(terms, seller)});
    }};
    const adapter = new PreprodMasumiAdapter(loadPaymentConfig(), transport, () => 'fixture-key');
    const observation = await adapter.getSettlement(terms);
    expect(observation.payment).toMatchObject({
      onChainState: 'ResultSubmitted', resultHash: RESULT_HASH, sellerCoolDownTime: '5000', buyerCoolDownTime: '6000',
      withdrawnForSeller: 950_000, withdrawnForBuyer: 0, buyerReturnAddress: BUYER, sellerReturnAddress: SELLER,
      nextAction: {errorType: 'Unknown', errorNote: 'fixture recovery required', resultHash: RESULT_HASH},
    });
    expect(observation.purchase?.transactions.map((tx) => tx.txHash)).toEqual([RESULT, DEPOSIT]);
    expect(observation.payment?.actionHistory?.[0].submittedTxHash).toBe(RESULT);
    expect(calls.sort()).toEqual(['/api/v1/payment/resolve-blockchain-identifier', '/api/v1/purchase/resolve-blockchain-identifier'].sort());
  });

  test('a 404 keeps payment existence ambiguous and never writes an action', async () => {
    const calls: string[] = [];
    const transport: ApiTransport = {simulated: true, fetch: async (url) => {
      calls.push(new URL(url).pathname);
      return Response.json({}, {status: 404});
    }};
    const adapter = new PreprodMasumiAdapter(loadPaymentConfig(), transport, () => 'fixture-key');
    expect(await adapter.getSettlement(protocolFixture().terms)).toEqual({payment: null, purchase: null});
    expect(calls).toHaveLength(2);
    expect(calls.every((path) => path.endsWith('/resolve-blockchain-identifier'))).toBe(true);
  });

  test('loads V1 fee parameters read-only for the exact escrow when withdrawal is observed', async () => {
    const {terms} = protocolFixture(false);
    const calls: {method: string; path: string}[] = [];
    const transport: ApiTransport = {simulated: true, fetch: async (url, init) => {
      const parsed = new URL(url);
      calls.push({method: init.method!, path: parsed.pathname});
      if (parsed.pathname.endsWith('/payment-source')) {
        expect(parsed.searchParams.get('take')).toBe('100');
        return Response.json({status: 'success', data: Object.fromEntries([['PaymentSources', [{
          id: 'source-fixture', network: 'Preprod', paymentSourceType: 'Web3CardanoV1', smartContractAddress: terms.escrowAddress,
          feeRatePermille: 10, ...Object.fromEntries([['FeeReceiverNetworkWallet', {walletAddress: OTHER}]]),
        }]]])});
      }
      const data = masumiData(terms, parsed.pathname.includes('/payment/'));
      data.onChainState = 'Withdrawn';
      return Response.json({status: 'success', data});
    }};
    const adapter = new PreprodMasumiAdapter(loadPaymentConfig(), transport, () => 'fixture-key');
    const snapshot = await adapter.getSettlement(terms);
    expect(snapshot.protocolFees).toEqual({
      escrowAddress: terms.escrowAddress, feeRatePermille: 10, feeReceiverAddress: OTHER, minimumFeeLovelace: 1_435_230,
    });
    expect(calls.filter((call) => call.method === 'GET')).toEqual([{method: 'GET', path: '/api/v1/payment-source'}]);
    expect(calls.every((call) => call.method === 'GET' || call.path.endsWith('/resolve-blockchain-identifier'))).toBe(true);
  });

  test.each(['blockchainIdentifier', 'inputHash', 'agentIdentifier', 'sellerReturnAddress', 'unlockTime'] as const)(
    'rejects a mismatched %s in an observed record', async (field) => {
      const {terms} = protocolFixture();
      const transport: ApiTransport = {simulated: true, fetch: async (url) => {
        const data = masumiData(terms, new URL(url).pathname.includes('/payment/'));
        data[field] = 'different';
        return Response.json({status: 'success', data});
      }};
      const adapter = new PreprodMasumiAdapter(loadPaymentConfig(), transport, () => 'fixture-key');
      await expect(adapter.getSettlement(terms)).rejects.toThrow('does not match');
    },
  );
});

describe('Blockfrost lifecycle evidence with offline transport', () => {
  test('reads datum JSON and escrow ancestry and persists the block proof', async () => {
    const fixture = protocolFixture();
    const chain = [fixture.deposit, fixture.result, fixture.payout];
    const datums = new Map<string, unknown>();
    const wire = (output: SettlementUtxoEvidence, input: boolean) => {
      const hash = output.datum ? sha256(JSON.stringify(output.datum)) : undefined;
      if (hash) datums.set(hash, output.datum);
      return {address: output.address, output_index: output.outputIndex, amount: [{unit: 'lovelace', quantity: String(output.amountLovelace)}],
        ...(input ? {tx_hash: output.txHash} : {}), data_hash: hash, consumed_by_tx: output.consumedByTx};
    };
    const calls: string[] = [];
    const transport: ApiTransport = {simulated: true, fetch: async (url) => {
      const path = new URL(url).pathname.replace('/api/v0', '');
      calls.push(path);
      if (path === '/genesis') return Response.json({network_magic: 1});
      if (path === '/blocks/latest') return Response.json({height: 102});
      if (path.startsWith('/scripts/datum/')) return Response.json({json_value: datums.get(path.slice('/scripts/datum/'.length))});
      const tx = chain.find((entry) => path.startsWith(`/txs/${entry.txHash}`));
      if (!tx) return Response.json({}, {status: 404});
      if (path.endsWith('/utxos')) return Response.json({inputs: tx.inputs.map((output) => wire(output, true)), outputs: tx.outputs.map((output) => wire(output, false))});
      return Response.json({hash: tx.txHash, block_height: 100, block: tx.blockHash, valid_contract: true, fees: '170000'});
    }};
    const config = {...loadPaymentConfig(), blockfrostUrl: 'https://blockfrost.fixture.invalid/api/v0'};
    const adapter = new PreprodCardanoAdapter(config, transport, () => 'fixture-key');
    const verification = await adapter.verifySettlement(fixture.request);
    expect(verification.confirmed).toBe(true);
    expect(verification.evidence.map((tx) => tx.txHash)).toEqual([PAYOUT, RESULT, DEPOSIT]);
    expect(verification.evidence[0]).toMatchObject({blockHash: 'aa'.repeat(32), blockHeight: 100, feeLovelace: 170_000});
    expect(calls.some((path) => path.includes('/scripts/datum/'))).toBe(true);
    expect(calls).not.toContain('/tx/submit');
  });
});

describe('durable default simulation', () => {
  test('observes a saved result across adapter reconstruction without inventing a payout', async () => {
    const config = loadPaymentConfig(Object.fromEntries([['CARDANO_RECEIPT_DB', ':memory:']]));
    const store = AgentStore.open(':memory:');
    const terms: MasumiTerms = {...protocolFixture().terms, blockchainIdentifier: 'simulated:fixture'};
    const saved = store.insertPaymentReceipt({
      receiptId: 'receipt-fixture', idempotencyKey: 'fixture', payer: BUYER, payTo: SELLER, txHash: DEPOSIT,
      network: 'cardano-preprod', amount: 1_000_000, asset: 'lovelace', resource: 'fixture:score', status: 'delivered',
      simulated: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), resultHash: RESULT_HASH,
      responseJson: '{"signals":[]}', protocolData: JSON.stringify({terms, resultQueued: true}),
    });
    try {
      let cardano = new SimulatedCardanoAdapter(store, config);
      let masumi = new SimulatedMasumiAdapter(cardano, store);
      const snapshot = await masumi.getSettlement(terms);
      expect(snapshot.payment).toMatchObject({onChainState: 'ResultSubmitted', resultHash: RESULT_HASH});
      const transaction = snapshot.payment!.transactions[0];
      const request = {...protocolFixture().request, terms, depositTxHash: DEPOSIT, kind: 'result' as const, transaction};
      expect((await cardano.verifySettlement(request)).confirmed).toBe(true);
      cardano = new SimulatedCardanoAdapter(store, config);
      masumi = new SimulatedMasumiAdapter(cardano, store);
      expect((await masumi.getSettlement(terms)).payment?.transactions[0].txHash).toBe(simulatedResultTxHash(saved.receiptId, RESULT_HASH));
      expect((await cardano.verifySettlement({...request, kind: 'withdrawal'})).confirmed).toBe(false);
      const before = await cardano.getWalletBalance(BUYER);
      await masumi.requestRefund();
      expect(await cardano.getWalletBalance(BUYER)).toBe(before);
    } finally {
      store.close();
    }
  });
});
