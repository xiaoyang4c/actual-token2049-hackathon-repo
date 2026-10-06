import type {Portfolio, Position, Side, Venue} from './types';

export interface MarketQuote {
  venue: Venue;
  marketId: string;
  yesPrice: number;
  bestBid: number;
  bestAsk: number;
  fetchedAt: string;
}

export interface PaperAccounting {
  tradingDay: string;
  realizedPnl: number;
  dailyRealizedPnl: number;
  pnlAdjustment: number;
}

export type MarkedPosition = Position & {
  markPrice: number;
  marketValue: number;
  unrealizedPnl: number;
  markStatus: 'entry'|'current'|'stale';
  markedAt: string;
};

export type PaperPortfolio = Omit<Portfolio, 'positions'> & {
  positions: MarkedPosition[];
  tradingDay: string;
  realizedPnl: number;
  dailyRealizedPnl: number;
  unrealizedPnl: number;
  pnlAdjustment: number;
};

export type ResolutionOutcome = Side|'void';

export interface Settlement {
  side: Side;
  size: number;
  price: number;
  costBasis: number;
  proceeds: number;
  realizedPnl: number;
}

/** Venue is part of market identity, including when IDs contain separators. */
export const marketKey = (venue: Venue, marketId: string): string => JSON.stringify([venue, marketId]);

/** Last known quotes remain usable for valuation, with explicit freshness. */
export function markPositions(
  positions: Position[], quotes: MarketQuote[], now: number, maxAgeMs: number,
): MarkedPosition[] {
  const byMarket = new Map(quotes.map((quote) => [marketKey(quote.venue, quote.marketId), quote]));
  return positions.map((position) => {
    const quote = byMarket.get(marketKey(position.venue, position.marketId));
    const markPrice = quote ? position.side === 'yes' ? quote.yesPrice : 1 - quote.yesPrice : position.avgPrice;
    return {
      ...position, markPrice, marketValue: position.size * markPrice,
      unrealizedPnl: position.size * (markPrice - position.avgPrice),
      markStatus: quote ? now >= Date.parse(quote.fetchedAt) && now - Date.parse(quote.fetchedAt) <= maxAgeMs ? 'current' : 'stale' : 'entry',
      markedAt: quote?.fetchedAt ?? '',
    };
  });
}

/** Removes size from matching lots in fill order and retains their cost basis. */
export function closeLots(
  positions: Position[], venue: Venue, marketId: string, side: Side, size: number,
): {positions: Position[]; costBasis: number} {
  let remaining = size;
  let costBasis = 0;
  const result: Position[] = [];
  for (const position of positions) {
    if (position.venue !== venue || position.marketId !== marketId || position.side !== side || remaining <= 0) {
      result.push({...position});
      continue;
    }
    const removed = Math.min(remaining, position.size);
    costBasis += removed * position.avgPrice;
    remaining -= removed;
    const retained = position.size - removed;
    if (retained > Number.EPSILON * Math.max(1, position.size) * 8) result.push({...position, size: retained});
  }
  if (remaining > Number.EPSILON * Math.max(1, size) * 8) throw new Error('close exceeds held size');
  return {positions: result, costBasis};
}

/** Binary paper payouts are $1/$0. A void paper market returns entry cost. */
export function settleLots(
  positions: Position[], venue: Venue, marketId: string, outcome: ResolutionOutcome,
): {positions: Position[]; settlements: Settlement[]} {
  const retained: Position[] = [];
  const settlements: Settlement[] = [];
  for (const position of positions) {
    if (position.venue !== venue || position.marketId !== marketId) {
      retained.push({...position});
      continue;
    }
    const price = outcome === 'void' ? position.avgPrice : position.side === outcome ? 1 : 0;
    const costBasis = position.size * position.avgPrice;
    const proceeds = position.size * price;
    settlements.push({side: position.side, size: position.size, price, costBasis, proceeds, realizedPnl: proceeds - costBasis});
  }
  return {positions: retained, settlements};
}
