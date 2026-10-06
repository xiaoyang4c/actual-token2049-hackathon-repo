// Reads the existing market feed's saved snapshots. This reader has no network client.
import {readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  normalizeGammaMarkets, normalizeKalshiEvents,
  type GammaMarket, type KalshiEventsResponse, type KalshiMarket, type MarketQuote, type NormalizedMarket,
} from '../packages/core/src';

export interface MarketQuoteSource {
  (): MarketQuote[];
  errors?: () => string[];
}

export function createSavedQuoteSource(directory: string | URL): MarketQuoteSource {
  const path = typeof directory === 'string' ? directory : fileURLToPath(directory);
  let errors: string[] = [];
  const readQuotes = () => {
    errors = [];
    const quotes: MarketQuote[] = [];
    for (const venue of ['polymarket', 'kalshi'] as const) {
      const file = join(path, `${venue}.latest.json`);
      try {
        const fetchedAt = statSync(file).mtime.toISOString();
        const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
        // Normalizers default absent prices to zero. Those defaults cannot execute an exit.
        const markets: NormalizedMarket[] = venue === 'polymarket'
          ? normalizeGammaMarkets((raw as GammaMarket[]).filter(hasGammaQuote))
          : normalizeKalshiEvents({events: (raw as KalshiEventsResponse).events.map((event) => ({
            ...event, markets: event.markets?.filter(hasKalshiQuote),
          }))});
        quotes.push(...markets.map(({venue, marketId, yesPrice, bestBid, bestAsk}) =>
          ({venue, marketId, yesPrice, bestBid, bestAsk, fetchedAt}),
        ));
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') continue;
        errors.push(`${venue}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return quotes;
  };
  return Object.assign(readQuotes, {errors: () => [...errors]});
}

function hasGammaQuote(market: GammaMarket): boolean {
  return Boolean(market) && isProbability(market.bestBid) && isProbability(market.bestAsk) &&
    market.bestBid <= market.bestAsk;
}

function hasKalshiQuote(market: KalshiMarket): boolean {
  if (!market || typeof market.yes_bid_dollars !== 'string' || market.yes_bid_dollars.trim() === '' ||
      typeof market.yes_ask_dollars !== 'string' || market.yes_ask_dollars.trim() === '') return false;
  const bid = Number(market.yes_bid_dollars);
  const ask = Number(market.yes_ask_dollars);
  return isProbability(bid) && isProbability(ask) && bid <= ask;
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
