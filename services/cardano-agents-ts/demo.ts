import {loadPaymentConfig} from './config';
import {createPaymentRuntime} from './runtime';
import {scoreInputHash, type PaymentRequirement} from './types';
import {scoreMarkets} from '../score-provider';

// Force offline simulation even if a preprod configuration exists in the shell.
const demoEnvironment = {...process.env};
demoEnvironment.CARDANO_MODE = 'simulated';
demoEnvironment.CARDANO_ALLOW_NETWORK = 'false';
const config = loadPaymentConfig(demoEnvironment);
const runtime = createPaymentRuntime({config});
try {
  const request = {markets: [{venue: 'polymarket' as const, marketId: 'offline-demo', yesPrice: 0.5}]};
  const requirement: PaymentRequirement = {
    scheme: 'exact', network: config.network, maxAmountRequired: '1000000', asset: 'lovelace',
    payTo: config.scorePayTo, resource: 'http://localhost:8789/score', description: 'Offline score demo',
    maxTimeoutSeconds: 60, inputHash: scoreInputHash(request),
  };
  const paid = await runtime.pay({idempotencyKey: 'offline-score-demo:v1', requirement});
  const confirmed = await runtime.confirm(paid.receipt.receiptId);
  const delivered = await runtime.deliver({
    xPayment: confirmed.xPayment, resource: requirement.resource, amount: paid.receipt.amount,
    payTo: requirement.payTo, inputHash: requirement.inputHash, response: scoreMarkets(request),
  });
  await runtime.reconcile();
  console.log(JSON.stringify({
    simulated: true, receiptId: delivered.receipt.receiptId, status: delivered.receipt.status,
    txHash: delivered.receipt.txHash, database: config.databasePath, response: delivered.response,
    settlement: runtime.settlement(delivered.receipt.receiptId).settlement,
  }, null, 2));
} finally {
  await runtime.close();
}
