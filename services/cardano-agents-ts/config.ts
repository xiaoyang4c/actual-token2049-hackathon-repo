import {PaymentError} from './types';

export interface PaymentConfig {
  mode: 'simulated' | 'preprod';
  network: 'cardano-preprod';
  allowNetwork: boolean;
  databasePath: string;
  walletAddress: string;
  scorePayTo: string;
  initialBalanceLovelace: number;
  maxPaymentLovelace: number;
  minimumConfirmations: number;
  requestTimeoutMs: number;
  blockfrostUrl: string;
  blockfrostKeyRef: string;
  masumiUrl: string;
  masumiBuyerKeyRef: string;
  masumiSellerKeyRef: string;
  masumiAgentIdentifier: string;
  masumiPaymentSourceType: 'Web3CardanoV1' | 'Web3CardanoV2';
  masumiSupportedSourceIndex: number;
}

/** Reads public settings and environment variable names. Does not read keys. */
export function loadPaymentConfig(env: Record<string, string | undefined> = process.env): PaymentConfig {
  const mode = env.CARDANO_MODE ?? 'simulated';
  if (mode !== 'simulated' && mode !== 'preprod') throw new PaymentError('unsupported CARDANO_MODE');
  if ((env.CARDANO_NETWORK ?? 'cardano-preprod') !== 'cardano-preprod') {
    throw new PaymentError('only cardano-preprod is supported');
  }
  const allowNetwork = env.CARDANO_ALLOW_NETWORK ?? 'false';
  if (allowNetwork !== 'false' && allowNetwork !== 'true') throw new PaymentError('invalid CARDANO_ALLOW_NETWORK');
  const source = env.MASUMI_PAYMENT_SOURCE_TYPE ?? 'Web3CardanoV1';
  if (source !== 'Web3CardanoV1' && source !== 'Web3CardanoV2') throw new PaymentError('invalid Masumi payment source');
  const integer = (name: string, fallback: number, minimum = 1): number => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < minimum) throw new PaymentError(`invalid ${name}`);
    return value;
  };
  const reference = (name: string, fallback: string): string => {
    const value = env[name] ?? fallback;
    if (!/^[A-Z][A-Z0-9_]*$/.test(value)) throw new PaymentError(`${name} must name an environment variable`);
    return value;
  };
  const endpoint = (value: string): string => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new PaymentError('invalid payment endpoint');
    }
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new PaymentError('payment endpoints require HTTPS outside localhost');
    }
    return value.replace(/\/$/, '');
  };
  const index = integer('MASUMI_SUPPORTED_SOURCE_INDEX', 0, 0);
  if (index > 24) throw new PaymentError('Masumi source index must be in [0, 24]');
  return {
    mode, network: 'cardano-preprod', allowNetwork: allowNetwork === 'true',
    databasePath: env.CARDANO_RECEIPT_DB ?? 'services/.data/cardano.sqlite',
    walletAddress: env.CARDANO_WALLET_ADDRESS ?? 'addr_test1qz_demo_agent_wallet',
    scorePayTo: env.SCORE_PAY_TO ?? 'addr_test1qz_demo_score_provider',
    initialBalanceLovelace: integer('CARDANO_SIMULATED_BALANCE_LOVELACE', 100_000_000),
    maxPaymentLovelace: integer('CARDANO_MAX_PAYMENT_LOVELACE', 2_000_000),
    minimumConfirmations: integer('CARDANO_MIN_CONFIRMATIONS', 3),
    requestTimeoutMs: integer('CARDANO_REQUEST_TIMEOUT_MS', 10_000),
    blockfrostUrl: endpoint(env.CARDANO_BLOCKFROST_URL ?? 'https://cardano-preprod.blockfrost.io/api/v0'),
    blockfrostKeyRef: reference('CARDANO_BLOCKFROST_KEY_REF', 'BLOCKFROST_PROJECT_ID_PREPROD'),
    masumiUrl: endpoint(env.MASUMI_PAYMENT_URL ?? 'http://localhost:3001/api/v1'),
    masumiBuyerKeyRef: reference('MASUMI_BUYER_KEY_REF', 'MASUMI_BUYER_API_KEY'),
    masumiSellerKeyRef: reference('MASUMI_SELLER_KEY_REF', 'MASUMI_SELLER_API_KEY'),
    masumiAgentIdentifier: env.MASUMI_AGENT_IDENTIFIER ?? 'simulated-score-agent',
    masumiPaymentSourceType: source, masumiSupportedSourceIndex: index,
  };
}
