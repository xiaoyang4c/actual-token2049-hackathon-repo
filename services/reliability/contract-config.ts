/**
 * @fileoverview Configuration for the contract lifecycle. One loader.
 *
 * The network gates come from the shared payment config: a contract is
 * live only when CARDANO_MODE=preprod and CARDANO_ALLOW_NETWORK=true.
 * Every other combination runs the paper escrow and labels contracts
 * `paper`. Settings are documented in services/reliability/.env.contracts.example.
 * The loader reads names and public values. It does not read keys.
 */

import {hostname} from 'node:os';
import {loadPaymentConfig, type PaymentConfig} from '../cardano-agents-ts/config';
import {isPublicKeyHex} from '../../packages/reliability/src/contract-lifecycle/signatures';
import type {ContractSettings} from '../../packages/reliability/src/contract-lifecycle/engine';
import type {WindowSet} from '../../packages/reliability/src/contract-lifecycle/types';

export interface ContractConfig {
  payment: PaymentConfig;
  settings: ContractSettings;
  paperEscrow: {confirmationDelayMs: number; autoWithdrawDelayMs: number};
  masumi: {
    agentIdentifier: string;
    supportedPaymentSourceIndex: number;
    sellerPayout: 'custodial_wallet'|'seller_return_address';
  };
  workerIntervalMs: number;
}

/** Test USDM on Cardano preprod (policy id + asset name), from the Masumi TOKEN2049 guide. */
export const TEST_USDM_UNIT = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d';
/** USDM has 6 decimals: 1 USDM = 1000000 atomic units (Masumi TOKEN2049 guide). */
const TEST_USDM_DECIMALS = 6;
/** Core plus holdback. A third escrow per milestone has no remedy that uses it. */
const DEFAULT_MAX_TRANCHES = 2;
/** Time for a dispute transaction to confirm before unlockTime. A preprod estimate; measure it in the live run. */
const DEFAULT_DISPUTE_MARGIN_MS = 120_000;
/** Evidence above 1 MiB belongs in object storage, not in the SQLite store. */
const DEFAULT_MAX_EVIDENCE_BYTES = 1_048_576;
/** MPS waits 10 minutes after unlockTime before it withdraws (rev d569a33). */
export const MPS_AUTO_WITHDRAW_DELAY_MS = 600_000;
/** A paper confirmation feels like a short block wait. */
const DEFAULT_PAPER_CONFIRMATION_MS = 3_000;
/** The worker polls MPS no faster than this. MPS itself batches jobs on a similar cadence. */
const DEFAULT_WORKER_INTERVAL_MS = 15_000;

const DEMO_WINDOW_KEYS: ReadonlyArray<[string, Array<keyof WindowSet>]> = [
  ['CONTRACT_DEMO_FUNDING_WINDOW_MS', ['fundingWindowMs']],
  ['CONTRACT_DEMO_DELIVERY_WINDOW_MS', ['deliveryWindowMs']],
  ['CONTRACT_DEMO_INSPECTION_WINDOW_MS', ['inspectionWindowMs']],
  ['CONTRACT_DEMO_DISPUTE_RESOLUTION_WINDOW_MS', ['disputeResolutionWindowMs']],
  ['CONTRACT_DEMO_DISPUTE_STEP_WINDOW_MS', [
    'tier1WindowMs', 'tier2WindowMs', 'tier3WindowMs', 'returnWindowMs', 'redoWindowMs',
    'redoInspectionWindowMs', 'rulingComplianceWindowMs',
  ]],
];

export function loadContractConfig(env: Record<string, string|undefined> = process.env): ContractConfig {
  const payment = loadPaymentConfig(env);
  const mode = payment.mode === 'preprod' && payment.allowNetwork ? 'live' : 'paper';
  const integer = (name: string, fallback: number, minimum: number): number => {
    const raw = env[name];
    const value = raw === undefined || raw.trim() === '' ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
    return value;
  };
  const custody = env.CONTRACT_CUSTODY_MODEL ?? 'platform_custodial_test_only';
  if (custody !== 'platform_custodial_test_only') {
    throw new Error('CONTRACT_CUSTODY_MODEL must be platform_custodial_test_only; the non-custodial 2-of-3 escrow is not built');
  }
  const assetUnit = env.CONTRACT_ASSET_UNIT ?? TEST_USDM_UNIT;
  if (!/^[0-9a-f]{56,120}$/.test(assetUnit)) {
    throw new Error('CONTRACT_ASSET_UNIT must be a policy id plus asset name in hex; ADA is never the deal asset');
  }
  const mediatorKey = env.CONTRACT_MEDIATOR_PUBLIC_KEY_HEX;
  if (mediatorKey !== undefined && mediatorKey !== '' && !isPublicKeyHex(mediatorKey)) {
    throw new Error('CONTRACT_MEDIATOR_PUBLIC_KEY_HEX must be a raw Ed25519 public key in hex');
  }
  const windowOverrides: Partial<WindowSet> = {};
  for (const [name, keys] of DEMO_WINDOW_KEYS) {
    if (env[name] === undefined || env[name] === '') continue;
    const value = integer(name, 0, 1);
    for (const key of keys) windowOverrides[key] = value;
  }
  const payout = env.CONTRACT_SELLER_PAYOUT ?? 'custodial_wallet';
  if (payout !== 'custodial_wallet' && payout !== 'seller_return_address') {
    throw new Error('CONTRACT_SELLER_PAYOUT must be custodial_wallet or seller_return_address');
  }
  return {
    payment,
    settings: {
      allowAppTier1Concession: env.TALLY_EDITION === 'app',
      mode,
      custodyModel: 'platform_custodial_test_only',
      assetUnit,
      assetDecimals: integer('CONTRACT_ASSET_DECIMALS', TEST_USDM_DECIMALS, 0),
      maxTranchesPerMilestone: integer('CONTRACT_MAX_TRANCHES_PER_MILESTONE', DEFAULT_MAX_TRANCHES, 1),
      disputeSubmitSafetyMarginMs: integer('CONTRACT_DISPUTE_MARGIN_MS', DEFAULT_DISPUTE_MARGIN_MS, 0),
      windowOverrides,
      mediator: mediatorKey ? {id: env.CONTRACT_MEDIATOR_ID ?? 'platform-mediator', publicKeyHex: mediatorKey} : null,
      // Six request timeouts: a slow but alive request keeps its lease.
      operationLeaseMs: integer('CONTRACT_OPERATION_LEASE_MS', payment.requestTimeoutMs * 6, payment.requestTimeoutMs + 1),
      maxEvidenceBytes: integer('CONTRACT_MAX_EVIDENCE_BYTES', DEFAULT_MAX_EVIDENCE_BYTES, 1),
      workerId: env.CONTRACT_WORKER_ID ?? `${hostname()}:${process.pid}`,
    },
    paperEscrow: {
      confirmationDelayMs: integer('CONTRACT_PAPER_CONFIRMATION_MS', DEFAULT_PAPER_CONFIRMATION_MS, 0),
      autoWithdrawDelayMs: integer('CONTRACT_PAPER_AUTO_WITHDRAW_DELAY_MS', MPS_AUTO_WITHDRAW_DELAY_MS, 0),
    },
    masumi: {
      agentIdentifier: env.CONTRACT_MASUMI_AGENT_IDENTIFIER ?? payment.masumiAgentIdentifier,
      supportedPaymentSourceIndex: payment.masumiSupportedSourceIndex,
      sellerPayout: payout,
    },
    workerIntervalMs: integer('CONTRACT_WORKER_INTERVAL_MS', DEFAULT_WORKER_INTERVAL_MS, 1_000),
  };
}
