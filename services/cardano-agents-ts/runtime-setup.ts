import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {AgentStore} from '../../packages/db/src';
import {PreprodCardanoAdapter, SimulatedCardanoAdapter, type CardanoAdapter} from './cardano';
import {loadPaymentConfig, type PaymentConfig} from './config';
import {PreprodMasumiAdapter, SimulatedMasumiAdapter, type MasumiAdapter} from './masumi';
import type {ReconciliationScheduleOptions} from './reconciliation';
import {PaymentError, sha256, type ApiTransport, type CredentialResolver} from './types';

export interface RuntimeOptions {
  config?: PaymentConfig;
  store?: AgentStore;
  cardanoTransport?: ApiTransport;
  masumiTransport?: ApiTransport;
  resolveCredential?: CredentialResolver;
  reconciliation?: ReconciliationScheduleOptions;
}

interface RuntimeDependencies {
  config: PaymentConfig;
  store: AgentStore;
  cardano: CardanoAdapter;
  masumi: MasumiAdapter;
  ownsStore: boolean;
}

export function createRuntimeDependencies(options: RuntimeOptions): RuntimeDependencies {
  const config = options.config ?? loadPaymentConfig();
  if (!options.store && config.databasePath !== ':memory:') mkdirSync(dirname(config.databasePath), {recursive: true});
  const store = options.store ?? AgentStore.open(config.databasePath);
  const cardano = config.mode === 'simulated'
    ? new SimulatedCardanoAdapter(store, config)
    : new PreprodCardanoAdapter(config, options.cardanoTransport, options.resolveCredential);
  const masumi = config.mode === 'simulated'
    ? new SimulatedMasumiAdapter(cardano, store)
    : new PreprodMasumiAdapter(config, options.masumiTransport, options.resolveCredential);
  if (cardano.simulated !== masumi.simulated) {
    if (!options.store) store.close();
    throw new PaymentError('Cardano and Masumi transports must use the same simulation mode');
  }
  return {config, store, cardano, masumi, ownsStore: !options.store};
}

export function paymentConfigurationHash(config: PaymentConfig): string {
  return sha256(JSON.stringify({
    mode: config.mode, network: config.network, walletAddress: config.walletAddress,
    agentIdentifier: config.masumiAgentIdentifier, sourceType: config.masumiPaymentSourceType,
    sourceIndex: config.masumiSupportedSourceIndex,
    ...(config.mode === 'preprod' ? {
      blockfrostUrl: config.blockfrostUrl, masumiUrl: config.masumiUrl,
      buyerKeyRef: config.masumiBuyerKeyRef, sellerKeyRef: config.masumiSellerKeyRef,
    } : {}),
  }));
}
