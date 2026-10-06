import LZString from 'lz-string';
import type {MasumiProtocolFeeTerms, MasumiSettlementTransaction, MasumiTerms} from './masumi';

export interface SettlementUtxoEvidence {
  address: string;
  amountLovelace: number;
  outputIndex: number;
  /** On an input, the transaction that created the spent output. */
  txHash?: string;
  collateral?: boolean;
  reference?: boolean;
  datumHash?: string;
  datum?: unknown;
  inlineDatum?: string;
  /** Explicit null proves the indexed output has no consuming transaction. */
  consumedByTx?: string | null;
}

/** The persisted proof includes the block and decoded UTxOs used for the decision. */
export interface SettlementTransactionEvidence {
  txHash: string;
  indexed: boolean;
  validContract: boolean;
  confirmations: number;
  blockHash?: string;
  blockHeight?: number;
  /** ISO time from the block. Absent when the chain response has no block time. */
  blockTime?: string;
  feeLovelace?: number;
  inputs: SettlementUtxoEvidence[];
  outputs: SettlementUtxoEvidence[];
  simulated?: boolean;
  reason?: string;
}

export interface SettlementVerificationRequest {
  terms: MasumiTerms;
  depositTxHash: string;
  transaction: MasumiSettlementTransaction;
  kind: 'state' | 'result' | 'withdrawal' | 'refund' | 'disputed_withdrawal';
  resultHash?: string;
  sellerAddress: string;
  buyerAddress: string;
  /** Net payout amounts reported by Masumi, already excluding protocol fees. */
  withdrawnForSeller?: number;
  withdrawnForBuyer?: number;
  protocolFees?: MasumiProtocolFeeTerms;
}

export interface SettlementChainVerification {
  confirmed: boolean;
  confirmations: number;
  txHash?: string;
  reason?: string;
  evidence: SettlementTransactionEvidence[];
  paidForSeller?: number;
  paidForBuyer?: number;
  protocolFeeLovelace?: number;
  onChainState?: string;
  /** Null means the verified datum has an empty result hash. */
  resultHash?: string | null;
}

export interface MasumiDatumEvidence {
  onChainState: string;
  resultHash?: string;
  buyerAddress: string;
  sellerAddress: string;
  buyerReturnAddress?: string;
  sellerReturnAddress?: string;
  collateralReturnLovelace: number;
}

const CHAIN_STATES = ['FundsLocked', 'ResultSubmitted', 'RefundRequested', 'Disputed', 'WithdrawAuthorized', 'RefundAuthorized'];
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const fields = (value: unknown): unknown[] | undefined => {
  const data = record(value);
  return data && Array.isArray(data.fields) ? data.fields : undefined;
};
const bytes = (value: unknown): string | undefined => {
  const valueBytes = record(value)?.bytes;
  return typeof valueBytes === 'string' && /^(?:[a-f0-9]{2})*$/.test(valueBytes) ? valueBytes : undefined;
};
const integer = (value: unknown): string | undefined => {
  const valueInt = record(value)?.int;
  if (typeof valueInt !== 'string' && typeof valueInt !== 'number') return undefined;
  const text = String(valueInt);
  return /^[0-9]+$/.test(text) && Number.isSafeInteger(Number(text)) ? text : undefined;
};
const constructor = (value: unknown): number | undefined => {
  const data = record(value);
  if (!data || !Object.hasOwn(data, 'constructor')) return undefined;
  return typeof data.constructor === 'number' ? data.constructor : undefined;
};

/** Field positions match the V1/V2 datum decoders at the pinned protocol commit. */
export function decodeMasumiDatum(value: unknown, terms: MasumiTerms): MasumiDatumEvidence | undefined {
  const list = fields(value);
  const v2 = terms.paymentSourceType === 'Web3CardanoV2';
  if (constructor(value) !== 0 || list?.length !== (v2 ? 19 : 16)) return undefined;
  let identifiers: string[];
  try {
    const decoded = LZString.decompressFromUint8Array(Buffer.from(terms.blockchainIdentifier, 'hex'));
    if (typeof decoded !== 'string') return undefined;
    identifiers = decoded.split('.');
  } catch {
    return undefined;
  }
  if ((identifiers.length !== 4 && identifiers.length !== 5) ||
      (identifiers.length === 5 && identifiers[4] !== terms.escrowAddress) ||
      identifiers[1] !== terms.identifierFromPurchaser || !identifiers[0].endsWith(terms.agentIdentifier)) return undefined;
  const offset = v2 ? 2 : 0;
  const sellerNonce = v2 ? identifiers[0].slice(0, 64) : identifiers[0];
  if (bytes(list[2 + offset]) !== identifiers[3] || bytes(list[3 + offset]) !== identifiers[2] ||
      bytes(list[4 + offset]) !== sellerNonce || bytes(list[5 + offset]) !== identifiers[1] ||
      (v2 && bytes(list[8]) !== terms.agentIdentifier)) return undefined;
  const inputOffset = v2 ? 3 : 0;
  if (bytes(list[7 + inputOffset]) !== terms.inputHash ||
      integer(list[9 + inputOffset]) !== terms.payByTime ||
      integer(list[10 + inputOffset]) !== terms.submitResultTime ||
      integer(list[11 + inputOffset]) !== terms.unlockTime ||
      integer(list[12 + inputOffset]) !== terms.externalDisputeUnlockTime ||
      integer(list[6 + inputOffset]) === undefined || integer(list[13 + inputOffset]) === undefined ||
      integer(list[14 + inputOffset]) === undefined) return undefined;
  const stateDatum = list[15 + inputOffset];
  const state = constructor(stateDatum);
  if (state === undefined || state < 0 || state >= (v2 ? 6 : 4) || fields(stateDatum)?.length !== 0) return undefined;
  const buyerAddress = plutusAddress(list[0]);
  const sellerAddress = plutusAddress(list[v2 ? 2 : 1]);
  const sellerCredential = bytes(fields(fields(list[v2 ? 2 : 1])?.[0])?.[0]);
  if (!buyerAddress || !sellerAddress || sellerCredential !== terms.sellerVkey) return undefined;
  const resultHash = bytes(list[8 + inputOffset]);
  if (resultHash === undefined) return undefined;
  const buyerReturn = v2 ? optionalAddress(list[1]) : {valid: true};
  const sellerReturn = v2 ? optionalAddress(list[3]) : {valid: true};
  if (!buyerReturn.valid || !sellerReturn.valid ||
      (sellerReturn.address && terms.sellerReturnAddress && sellerReturn.address !== terms.sellerReturnAddress)) return undefined;
  return {
    onChainState: CHAIN_STATES[state], resultHash: resultHash || undefined, buyerAddress, sellerAddress,
    buyerReturnAddress: buyerReturn.address, sellerReturnAddress: sellerReturn.address,
    collateralReturnLovelace: Number(integer(list[6 + inputOffset])),
  };
}

function optionalAddress(value: unknown): {valid: boolean; address?: string} {
  const list = fields(value);
  if (constructor(value) === 1 && list?.length === 0) return {valid: true};
  if (constructor(value) !== 0 || list?.length !== 1) return {valid: false};
  const address = plutusAddress(list[0]);
  return {valid: Boolean(address), address};
}

/** Supports preprod base and enterprise key participant addresses, including script stake credentials. */
function plutusAddress(value: unknown): string | undefined {
  const address = fields(value);
  const payment = fields(address?.[0]);
  const paymentKey = bytes(payment?.[0]);
  if (constructor(value) !== 0 || address?.length !== 2 || constructor(address[0]) !== 0 ||
      payment?.length !== 1 || paymentKey?.length !== 56) return undefined;
  const stakeOption = address[1];
  if (constructor(stakeOption) === 1 && fields(stakeOption)?.length === 0) {
    return bech32Address(Buffer.from(`60${paymentKey}`, 'hex'));
  }
  const stakeHash = fields(stakeOption)?.[0];
  const stakeCredential = fields(stakeHash)?.[0];
  const stakeKey = bytes(fields(stakeCredential)?.[0]);
  const stakeType = constructor(stakeCredential);
  if (constructor(stakeOption) !== 0 || fields(stakeOption)?.length !== 1 || constructor(stakeHash) !== 0 ||
      fields(stakeHash)?.length !== 1 || fields(stakeCredential)?.length !== 1 ||
      (stakeType !== 0 && stakeType !== 1) || stakeKey?.length !== 56) return undefined;
  return bech32Address(Buffer.from(`${stakeType === 0 ? '00' : '20'}${paymentKey}${stakeKey}`, 'hex'));
}

function bech32Address(data: Uint8Array): string {
  const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const hrp = 'addr_test';
  const words: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const byte of data) {
    accumulator = ((accumulator << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((accumulator >>> bits) & 31);
    }
  }
  if (bits) words.push((accumulator << (5 - bits)) & 31);
  const expanded = [...hrp].map((c) => c.charCodeAt(0) >>> 5).concat(0, [...hrp].map((c) => c.charCodeAt(0) & 31));
  let checksum = 1;
  for (const word of [...expanded, ...words, 0, 0, 0, 0, 0, 0]) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ word;
    const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    for (let index = 0; index < 5; index++) if ((top >>> index) & 1) checksum ^= generators[index];
  }
  checksum ^= 1;
  for (let index = 0; index < 6; index++) words.push((checksum >>> (5 * (5 - index))) & 31);
  return `${hrp}1${words.map((word) => alphabet[word]).join('')}`;
}

/** Pure verifier: a protocol state or an escrow address alone cannot prove a payout. */
export function verifySettlementEvidence(
  request: SettlementVerificationRequest, evidence: SettlementTransactionEvidence[], minimumConfirmations: number,
): SettlementChainVerification {
  const target = evidence.find((entry) => entry.txHash === request.transaction.txHash);
  const result = (confirmed: boolean, reason?: string): SettlementChainVerification => ({
    confirmed, confirmations: target?.confirmations ?? 0, txHash: request.transaction.txHash, reason, evidence,
  });
  if (!target || !target.indexed || !target.validContract) return result(false, 'settlement transaction is not valid or indexed');
  if (request.transaction.status !== 'Confirmed' || target.confirmations < minimumConfirmations) {
    return result(false, 'waiting for settlement confirmations');
  }
  const terminal = request.kind !== 'state' && request.kind !== 'result';
  if (terminal && target.txHash === request.depositTxHash) return result(false, 'deposit transaction is not settlement evidence');
  const byHash = new Map(evidence.map((entry) => [entry.txHash, entry]));
  const bound = (output: SettlementUtxoEvidence): MasumiDatumEvidence | undefined =>
    output.address === request.terms.escrowAddress ? decodeMasumiDatum(output.datum, request.terms) : undefined;
  const followsDeposit = (txHash: string, outputIndex: number, seen = new Set<string>()): boolean => {
    const tx = byHash.get(txHash);
    const output = tx?.outputs.find((entry) => entry.outputIndex === outputIndex);
    const outputDatum = output && bound(output);
    if (!tx?.indexed || !tx.validContract || tx.confirmations < minimumConfirmations || !output || !outputDatum) return false;
    if (txHash === request.depositTxHash) return output.amountLovelace >= request.terms.amountLovelace;
    if (seen.has(txHash) || seen.size >= 12) return false;
    const next = new Set(seen).add(txHash);
    return tx.inputs.some((input) => {
      if (input.collateral || input.reference || !input.txHash || input.address !== request.terms.escrowAddress) return false;
      const priorOutput = byHash.get(input.txHash)?.outputs.find((entry) => entry.outputIndex === input.outputIndex);
      const priorDatum = priorOutput && bound(priorOutput);
      return priorDatum && priorOutput && output.amountLovelace >= priorOutput.amountLovelace &&
        outputDatum.collateralReturnLovelace === priorDatum.collateralReturnLovelace &&
        outputDatum.buyerAddress === priorDatum.buyerAddress && outputDatum.sellerAddress === priorDatum.sellerAddress &&
        outputDatum.buyerReturnAddress === priorDatum.buyerReturnAddress && outputDatum.sellerReturnAddress === priorDatum.sellerReturnAddress &&
        followsDeposit(input.txHash, input.outputIndex, next);
    });
  };
  const spent = target.inputs.filter((input) => !input.collateral && !input.reference && input.txHash &&
    input.address === request.terms.escrowAddress && followsDeposit(input.txHash, input.outputIndex));
  if (!terminal) {
    const matching = target.outputs.filter((output) => {
      const datum = bound(output);
      return datum && output.consumedByTx === null && datum.onChainState === request.transaction.newOnChainState &&
        (request.kind !== 'result' || Boolean(request.resultHash) && datum.resultHash === request.resultHash) &&
        followsDeposit(target.txHash, output.outputIndex);
    });
    if (matching.length !== 1) return result(false, 'expected current unspent payment datum, state or result hash is not confirmed');
    const datum = bound(matching[0])!;
    return {...result(true), onChainState: datum.onChainState, resultHash: datum.resultHash ?? null};
  }
  if (spent.length !== 1) return result(false, 'settlement does not spend exactly one escrow from this receipt');
  const v2 = request.terms.paymentSourceType === 'Web3CardanoV2';
  if (!v2 && target.inputs.filter((input) => !input.collateral && !input.reference &&
      input.address === request.terms.escrowAddress).length !== 1) {
    return result(false, 'V1 payout cannot be attributed across multiple escrow inputs');
  }
  const input = spent[0];
  const source = byHash.get(input.txHash!)?.outputs.find((output) => output.outputIndex === input.outputIndex);
  const datum = source && bound(source);
  if (!datum) return result(false, 'escrow datum is unavailable');
  if (typeof source!.consumedByTx === 'string' && source!.consumedByTx !== target.txHash) {
    return result(false, 'escrow output was consumed by a different transaction');
  }
  if (target.outputs.some((output) => bound(output))) return result(false, 'payment escrow continues after the proposed payout');
  if (request.kind !== 'refund' && (!request.resultHash || datum.resultHash !== request.resultHash)) {
    return result(false, 'settlement result hash does not match delivered scores');
  }
  const states = request.kind === 'refund' ? ['FundsLocked', 'RefundRequested', 'RefundAuthorized'] :
    request.kind === 'disputed_withdrawal' ? ['Disputed'] : ['ResultSubmitted', 'WithdrawAuthorized'];
  if (!states.includes(datum.onChainState)) return result(false, 'escrow state is incompatible with settlement');
  const expectedSeller = datum.sellerReturnAddress ?? request.terms.sellerReturnAddress ?? datum.sellerAddress;
  const expectedBuyer = datum.buyerReturnAddress ?? datum.buyerAddress;
  if (expectedSeller !== request.sellerAddress || expectedBuyer !== request.buyerAddress) {
    return result(false, 'escrow beneficiary does not match the receipt');
  }
  const reportedSeller = request.withdrawnForSeller;
  const reportedBuyer = request.withdrawnForBuyer;
  const paid = (address: string, tagged = v2): number => target.outputs.filter((output) =>
    output.address === address && (!tagged || outputReferenceMatches(output.datum, input.txHash!, input.outputIndex)))
    .reduce((sum, output) => sum + output.amountLovelace, 0);
  const sellerPaid = paid(expectedSeller);
  const buyerPaid = paid(expectedBuyer);
  if (!safeAmount(sellerPaid) || !safeAmount(buyerPaid)) return result(false, 'invalid beneficiary payout amount');
  if (request.kind === 'refund') {
    if (buyerPaid < source!.amountLovelace) return result(false, 'refund amount does not recover the payment principal');
    return {...result(true), paidForBuyer: buyerPaid};
  }
  if (request.kind === 'disputed_withdrawal') {
    if (v2) {
      // Upstream reports participant-key deltas, which can omit distinct return
      // addresses. The tagged chain outputs establish the actual split instead.
      // A confirmed terminal spend of a Disputed datum is the admin resolution
      // path in the pinned V2 contract. A finder can receive the residual.
      return {...result(true), paidForSeller: sellerPaid, paidForBuyer: buyerPaid};
    }
    if (!safeAmount(reportedSeller) || !safeAmount(reportedBuyer) || reportedSeller + reportedBuyer === 0 ||
        !safeAmount(reportedSeller + reportedBuyer) || reportedSeller + reportedBuyer > source!.amountLovelace) {
      return result(false, 'dispute payout amounts are not established');
    }
    if (sellerPaid < reportedSeller || buyerPaid < reportedBuyer) return result(false, 'beneficiary payout is below the reported net amount');
    return {...result(true), paidForSeller: sellerPaid, paidForBuyer: buyerPaid};
  }
  let expectedSellerAmount = source!.amountLovelace - datum.collateralReturnLovelace;
  let protocolFeeLovelace = 0;
  if (!v2) {
    const fees = request.protocolFees;
    if (!fees || fees.escrowAddress !== request.terms.escrowAddress || !safeAmount(fees.feeRatePermille) || fees.feeRatePermille > 1000 ||
        fees.minimumFeeLovelace !== 1_435_230 || !fees.feeReceiverAddress.startsWith('addr_test1')) {
      return result(false, 'V1 protocol fee terms are required to verify the seller payout');
    }
    const proportionalFee = Number(BigInt(source!.amountLovelace) * BigInt(fees.feeRatePermille) / 1000n);
    protocolFeeLovelace = Math.max(fees.minimumFeeLovelace, proportionalFee);
    if (paid(fees.feeReceiverAddress, true) < protocolFeeLovelace) return result(false, 'protocol fee payment does not match this escrow');
    // The pinned V1 builder pays collateral separately from its funding wallet.
    expectedSellerAmount = source!.amountLovelace - protocolFeeLovelace;
  }
  if (expectedSellerAmount <= 0 || sellerPaid < expectedSellerAmount) return result(false, 'seller payout does not recover the escrow residual');
  if (paid(expectedBuyer, true) < datum.collateralReturnLovelace) return result(false, 'buyer collateral return is below the escrow datum amount');
  return {...result(true), paidForSeller: sellerPaid, paidForBuyer: buyerPaid, protocolFeeLovelace};
}

function safeAmount(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function outputReferenceMatches(value: unknown, txHash: string, outputIndex: number): boolean {
  const list = fields(value);
  if (constructor(value) !== 0 || list?.length !== 2 || integer(list[1]) !== String(outputIndex)) return false;
  // Aiken/SDK versions represent TransactionId as bytes or a one-field wrapper.
  return bytes(list[0]) === txHash || constructor(list[0]) === 0 && fields(list[0])?.length === 1 && bytes(fields(list[0])?.[0]) === txHash;
}
