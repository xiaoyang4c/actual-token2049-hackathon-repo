import {describe, expect, test} from 'bun:test';
import {atomicToUsdm, parsePaymentClaim, parseRecipientAmounts, parseTip, parseTransaction, paymentReport, TEST_USDM_UNIT, usdmToAtomic, type PaymentObservation} from './payment';
import {EVIDENCE_EXAMPLE} from './protocol';

const claim = parsePaymentClaim({...EVIDENCE_EXAMPLE, amountAtomic: '1000000'});
const observation: PaymentObservation = {
  txHash: claim.txHash, blockHash: 'a'.repeat(64), validContract: true,
  blockHeight: 100, blockTime: 1_700_000_000, observedHeight: 102,
  recipientInputAtomic: '9000000', recipientOutputAtomic: '10000000',
};
const utxo = (quantity: string, extra: Record<string, unknown> = {}) => ({address: claim.recipient, amount: [{unit: TEST_USDM_UNIT, quantity}], collateral: false, reference: false, ...extra});

describe('payment evidence', () => {
  test('matches the net increase rather than a gross change output', () => {
    expect(paymentReport(claim, observation)).toMatchObject({status: 'verified', receivedAtomic: '1000000', confirmations: 3});
    expect(paymentReport({...claim, amountAtomic: '10000000'}, observation).status).toBe('mismatch');
    expect(paymentReport(claim, {...observation, recipientOutputAtomic: '9000000'}).status).toBe('mismatch');
  });

  test('sums multiple outputs and excludes reference inputs and collateral', () => {
    const amounts = parseRecipientAmounts({hash: claim.txHash,
      inputs: [utxo('9000000'), utxo('8000000', {reference: true}), utxo('5000000', {collateral: true})],
      outputs: [utxo('6000000'), utxo('4000000'), utxo('8000000', {collateral: true}), utxo('1000000', {address: 'another-address'})],
    }, claim);
    expect(amounts).toEqual({recipientInputAtomic: '9000000', recipientOutputAtomic: '10000000'});
    expect(paymentReport(claim, {...observation, ...amounts}).status).toBe('verified');
  });

  test('requires the exact asset unit', () => {
    const amounts = parseRecipientAmounts({hash: claim.txHash, inputs: [utxo('0')], outputs: [utxo('1000000', {amount: [{unit: 'a-different-usdm-policy', quantity: '1000000'}]})]}, claim);
    expect(paymentReport(claim, {...observation, ...amounts}).status).toBe('mismatch');
  });

  test('cannot verify missing outputs, failed scripts, a wrong hash, or negative net receipts', () => {
    expect(paymentReport(claim, {...observation, recipientOutputAtomic: '0'}).checks.recipient).toBe(false);
    expect(paymentReport(claim, {...observation, validContract: false}).status).toBe('mismatch');
    expect(paymentReport(claim, {...observation, txHash: 'b'.repeat(64)}).status).toBe('mismatch');
    expect(paymentReport(claim, {...observation, recipientOutputAtomic: '8000000'}).receivedAtomic).toBe('-1000000');
  });

  test('counts the inclusion block and requires three confirmations', () => {
    expect(paymentReport(claim, {...observation, observedHeight: 100})).toMatchObject({status: 'pending', confirmations: 1});
    expect(paymentReport(claim, {...observation, observedHeight: 101})).toMatchObject({status: 'pending', confirmations: 2});
    expect(paymentReport(claim, {...observation, observedHeight: 99})).toMatchObject({status: 'mismatch', confirmations: 0});
  });

  test('a missing transaction stays unverified', () => {
    expect(paymentReport(claim, null)).toMatchObject({status: 'not_found', observation: null, checks: {transaction: false, recipient: false, amount: false, confirmations: false}});
  });

  test('rejects incomplete or inconsistent provider data', () => {
    expect(() => parseRecipientAmounts({hash: 'b'.repeat(64), inputs: [utxo('0')], outputs: [utxo('1000000')]}, claim)).toThrow();
    expect(() => parseRecipientAmounts({hash: claim.txHash, inputs: [], outputs: [utxo('1000000')]}, claim)).toThrow();
    expect(() => parseRecipientAmounts({hash: claim.txHash, inputs: [utxo('0')], outputs: [utxo('1e6')]}, claim)).toThrow();
    expect(() => parseRecipientAmounts({hash: claim.txHash, inputs: [utxo('0')], outputs: [utxo('1', {amount: [{unit: TEST_USDM_UNIT, quantity: '1'}, {unit: TEST_USDM_UNIT, quantity: '1'}]})]}, claim)).toThrow();
    expect(() => parseTransaction({hash: claim.txHash}, claim.txHash)).toThrow();
    expect(() => parseTip({height: 1.5})).toThrow();
  });

  test('keeps exact amounts above the JavaScript safe integer range', () => {
    expect(usdmToAtomic('9007199254740.123456')).toBe('9007199254740123456');
    expect(atomicToUsdm('9007199254740123456')).toBe('9007199254740.123456');
    expect(atomicToUsdm('-1234567')).toBe('-1.234567');
    expect(atomicToUsdm('1000000')).toBe('1');
    for (const value of ['0', '-1', 'NaN', '1e6', '01', '1.0000001', '1.']) expect(() => usdmToAtomic(value)).toThrow();
  });

  test('rejects a mainnet address, malformed hash, and unsafe amount', () => {
    expect(() => parsePaymentClaim({...claim, recipient: claim.recipient.replace('addr_test', 'addr')})).toThrow();
    expect(() => parsePaymentClaim({...claim, txHash: 'https://example.com'})).toThrow();
    expect(() => parsePaymentClaim({...claim, amountAtomic: '1;cat /etc/passwd'})).toThrow();
  });
});
