// Starts the retired paper trading demo with its score provider and market feed.
import {start as startCardanoAgent} from './cardano-agent';
import {loadPaymentConfig} from './cardano-agents-ts/config';
import {start as startControlApi} from './control-api';
import {start as startMarketFeed} from './market-feed';
import {createSavedQuoteSource} from './paper-market-source';
import {start as startScoreProvider} from './score-provider';

const CONTROL_API_PORT = Number(process.env.CONTROL_API_PORT ?? 8787);
const CARDANO_AGENT_PORT = Number(process.env.CARDANO_AGENT_PORT ?? 8788);
const SCORE_PROVIDER_PORT = Number(process.env.SCORE_PROVIDER_PORT ?? 8789);
const MARKET_FEED_PORT = Number(process.env.MARKET_FEED_PORT ?? 8790);
const MARKET_POLL_SECONDS = Number(process.env.MARKET_POLL_SECONDS ?? 30);

startControlApi(CONTROL_API_PORT, {
  quoteSource: createSavedQuoteSource(new URL('./.data/markets/', import.meta.url)),
});
const paymentConfig = loadPaymentConfig();
startCardanoAgent(CARDANO_AGENT_PORT, {config: paymentConfig});
startScoreProvider(SCORE_PROVIDER_PORT, `http://localhost:${CARDANO_AGENT_PORT}`, paymentConfig);
startMarketFeed(MARKET_FEED_PORT, MARKET_POLL_SECONDS * 1000);

console.log(`control-api     http://localhost:${CONTROL_API_PORT}  (legacy paper trading demo)`);
console.log(`cardano-agent   http://localhost:${CARDANO_AGENT_PORT}  (${paymentConfig.mode}, API access ${paymentConfig.allowNetwork ? 'enabled' : 'disabled'})`);
console.log(`score-provider  http://localhost:${SCORE_PROVIDER_PORT}  (x402, 1 ADA per call)`);
console.log(`market-feed     http://localhost:${MARKET_FEED_PORT}  (Polymarket + Kalshi, every ${MARKET_POLL_SECONDS}s)`);
