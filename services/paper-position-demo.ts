// Complete offline paper lifecycle. No servers, external requests, or wallets.
import {createAgentRuntime} from './agent-runtime';

let now = new Date('2026-10-04T23:59:00.000Z');
const runtime = createAgentRuntime({databasePath: ':memory:', now: () => now});
try {
  runtime.submitOrders({cycleId: 'paper-demo', orders: [
    {idempotencyKey: 'buy-yes', intent: {venue: 'polymarket', marketId: 'demo', side: 'yes', size: 20, limit: 0.5, reason: 'paper demo'}},
    {idempotencyKey: 'buy-no', intent: {venue: 'polymarket', marketId: 'demo', side: 'no', size: 10, limit: 0.4, reason: 'paper demo'}},
  ]});
  const marked = runtime.updateQuotes({quotes: [
    {venue: 'polymarket', marketId: 'demo', yesPrice: 0.7, bestBid: 0.68, bestAsk: 0.72, fetchedAt: now.toISOString()},
  ]});
  const closed = runtime.closePosition({idempotencyKey: 'close-yes', venue: 'polymarket', marketId: 'demo', side: 'yes', size: 5});
  const resolved = runtime.resolveMarket({idempotencyKey: 'resolve', venue: 'polymarket', marketId: 'demo', outcome: 'yes'});
  const settled = runtime.state().portfolio;
  now = new Date('2026-10-05T00:01:00.000Z');
  const nextDay = runtime.state().portfolio;
  console.log(JSON.stringify({mode: 'paper', marked, closed, resolved, settled, nextDay, days: runtime.days()}, null, 2));
} finally {
  runtime.close();
}
