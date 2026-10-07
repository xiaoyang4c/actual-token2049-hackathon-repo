/** Read-only payment evidence shared by the API and the CRE workflow. */

export const TEST_USDM_UNIT = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d';
export const MINIMUM_CONFIRMATIONS = 3;

export interface PaymentClaim {
  txHash: string;
  recipient: string;
  amountAtomic: string;
}

export interface PaymentObservation {
  txHash: string;
  validContract: boolean;
  blockHash: string;
  blockHeight: number;
  blockTime: number;
  observedHeight: number;
  recipientOutputAtomic: string;
  recipientInputAtomic: string;
}

export interface PaymentReport {
  version: 1;
  network: 'preprod';
  assetUnit: string;
  claim: PaymentClaim;
  status: 'verified'|'mismatch'|'pending'|'not_found';
  checks: {transaction: boolean; recipient: boolean; amount: boolean; confirmations: boolean};
  minimumConfirmations: number;
  confirmations: number;
  receivedAtomic: string;
  observation: PaymentObservation|null;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid provider response.');
  return value as Record<string, unknown>;
}

function natural(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid provider height or time.');
  return value;
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid transaction or block hash.');
  return value;
}

/** Validate before a claim can reach the CLI or the provider. */
export function parsePaymentClaim(value: unknown): PaymentClaim {
  const input = record(value);
  const txHash = hash(input.txHash);
  const recipient = input.recipient;
  if (typeof recipient !== 'string' || !/^addr_test1[023456789acdefghjklmnpqrstuvwxyz]{50,110}$/.test(recipient)) {
    throw new Error('Enter a Cardano preprod recipient address.');
  }
  if (typeof input.amountAtomic !== 'string' || !/^[1-9][0-9]{0,18}$/.test(input.amountAtomic)) {
    throw new Error('Enter a positive test USDM amount with at most six decimal places.');
  }
  return {txHash, recipient, amountAtomic: input.amountAtomic};
}

/** Convert a decimal string without floating point arithmetic. */
export function usdmToAtomic(value: string): string {
  if (!/^(0|[1-9][0-9]{0,12})(\.[0-9]{1,6})?$/.test(value)) throw new Error('Enter a positive test USDM amount with at most six decimal places.');
  const [whole, fraction = ''] = value.split('.');
  const atomic = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (atomic <= 0n) throw new Error('The expected amount must be greater than zero.');
  return atomic.toString();
}

export function atomicToUsdm(value: string): string {
  const amount = BigInt(value);
  const absolute = amount < 0n ? -amount : amount;
  const fraction = (absolute % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${amount < 0n ? '-' : ''}${absolute / 1_000_000n}${fraction ? `.${fraction}` : ''}`;
}

export function parseTransaction(value: unknown, expectedHash: string): Omit<PaymentObservation, 'observedHeight'|'recipientOutputAtomic'|'recipientInputAtomic'> {
  const transaction = record(value);
  const txHash = hash(transaction.hash);
  if (txHash !== expectedHash || typeof transaction.valid_contract !== 'boolean') throw new Error('Provider transaction does not match the request.');
  return {
    txHash,
    validContract: transaction.valid_contract,
    blockHash: hash(transaction.block),
    blockHeight: natural(transaction.block_height),
    blockTime: natural(transaction.block_time),
  };
}

export function parseTip(value: unknown): number {
  return natural(record(value).height);
}

function sumAsset(value: unknown, recipient: string, inputs: boolean): string {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Provider returned incomplete transaction outputs.');
  let sum = 0n;
  for (const raw of value) {
    const output = record(raw);
    // Reference inputs and collateral do not move this asset in a valid transaction.
    if (output.collateral === true || (inputs && output.reference === true)) continue;
    if (typeof output.address !== 'string' || !Array.isArray(output.amount)) throw new Error('Provider returned incomplete transaction outputs.');
    const units = new Set<string>();
    for (const rawAmount of output.amount) {
      const amount = record(rawAmount);
      if (typeof amount.unit !== 'string' || units.has(amount.unit) || typeof amount.quantity !== 'string' || !/^(0|[1-9][0-9]{0,24})$/.test(amount.quantity)) {
        throw new Error('Provider returned an invalid asset quantity.');
      }
      units.add(amount.unit);
      if (output.address === recipient && amount.unit === TEST_USDM_UNIT) sum += BigInt(amount.quantity);
    }
  }
  return sum.toString();
}

export function parseRecipientAmounts(value: unknown, claim: PaymentClaim): {recipientOutputAtomic: string; recipientInputAtomic: string} {
  const utxos = record(value);
  if (hash(utxos.hash) !== claim.txHash) throw new Error('Provider outputs do not match the transaction.');
  return {
    recipientOutputAtomic: sumAsset(utxos.outputs, claim.recipient, false),
    recipientInputAtomic: sumAsset(utxos.inputs, claim.recipient, true),
  };
}

/** This result proves only the claimed net receipt in this one transaction. */
export function paymentReport(claim: PaymentClaim, observation: PaymentObservation|null): PaymentReport {
  const confirmations = observation ? Math.max(0, observation.observedHeight - observation.blockHeight + 1) : 0;
  const receivedAtomic = observation ? (BigInt(observation.recipientOutputAtomic) - BigInt(observation.recipientInputAtomic)).toString() : '0';
  const checks = {
    transaction: !!observation && observation.txHash === claim.txHash && observation.validContract && observation.observedHeight >= observation.blockHeight,
    recipient: !!observation && BigInt(observation.recipientOutputAtomic) > 0n,
    amount: !!observation && receivedAtomic === claim.amountAtomic,
    confirmations: confirmations >= MINIMUM_CONFIRMATIONS,
  };
  const status = !observation ? 'not_found' : !checks.transaction || !checks.recipient || !checks.amount ? 'mismatch' : !checks.confirmations ? 'pending' : 'verified';
  return {version: 1, network: 'preprod', assetUnit: TEST_USDM_UNIT, claim, status, checks, minimumConfirmations: MINIMUM_CONFIRMATIONS, confirmations, receivedAtomic, observation};
}
