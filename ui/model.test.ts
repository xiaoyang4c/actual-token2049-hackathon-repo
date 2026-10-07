import {describe, expect, test} from 'bun:test';
import {FIXTURE} from './fixture.js';
import {formatFee, formatPct, formatValue, label} from './format.js';
import {buildView, escrowOf, evidenceRows, executionOf, fillMode} from './model.js';
import {deskTitle, renderDesk} from './render.js';

const sample = () => structuredClone(FIXTURE);

test('preserves the trading-audit exports used by the existing control API', () => {
  expect(fillMode({type: 'fill_filled', detail: '[PAPER] yes 1'})).toBe('paper');
  expect(fillMode({type: 'note', mode: 'live'})).toBeNull();
  expect(executionOf([{events: [
    {type: 'fill_filled', mode: 'paper'}, {type: 'fill_filled', fill: {mode: 'live'}},
    {type: 'fill_filled'},
  ]}])).toEqual({kind: 'mixed', paper: 1, live: 1, unmarked: 1});
});

describe('marketplace read model', () => {
  test('keeps roles, categories, lower bounds, and confidence separate', () => {
    const view = buildView(sample());
    const entity = view.entities.find((entry: {id: string}) => entry.id === 'entity-established');
    expect(entity.scores).toHaveLength(2);
    expect(entity.scores.find((score: {role: string}) => score.role === 'buyer').category).toBe('payment');
    expect(entity.scores.find((score: {role: string}) => score.role === 'seller').category).toBe('fulfillment');
    const html = renderDesk(buildView(sample(), {}, {tab: 'participants'}));
    expect(html).toContain('Buyer reliability');
    expect(html).toContain('Seller reliability');
    expect(html).toContain('Lower bound');
    expect(html).toContain('Confidence');
    expect(html).not.toContain('Overall score');
  });

  test('does not infer completed outcomes from completion dates or missing receipts', () => {
    const snapshot = sample();
    delete snapshot.receipts['tx-service-1'];
    snapshot.receipts['tx-invoice-1'].outcome.state = 'disputed';
    const view = buildView(snapshot);
    expect(view.metrics.completed).toBe(1);
    expect(view.metrics.attention).toBe(1);
    expect(view.metrics.unknown).toBe(1);
    expect(view.transactions[0].outcome).toBe('unknown');
  });

  test.each(['pending', 'cancelled', 'disputed', 'unresolved', 'failed'])(
    'does not treat %s as success', (state) => {
      const snapshot = sample();
      snapshot.receipts['tx-service-1'].outcome.state = state;
      expect(buildView(snapshot).metrics.completed).toBe(2);
    },
  );

  test('filters by counterparty, type, and outcome without changing total metrics', () => {
    const view = buildView(sample(), {}, {query: 'meridian', type: 'invoice', outcome: 'successful'});
    expect(view.rows.map((entry: {id: string}) => entry.id)).toEqual(['tx-invoice-1']);
    expect(view.selected.id).toBe('tx-invoice-1');
    expect(view.metrics.total).toBe(3);
    const empty = buildView(sample(), {}, {query: 'missing'});
    expect(empty.selected).toBeUndefined();
    expect(renderDesk(empty)).toContain('No matching transactions');
  });

  test('pagination chooses a receipt from the displayed page and clamps deleted pages', () => {
    const snapshot = sample();
    snapshot.transactions = Array.from({length: 12}, (value, index) => ({
      ...snapshot.transactions[0], id: `page-${index}`,
    }));
    const view = buildView(snapshot, {}, {page: 1});
    expect(view.rows).toHaveLength(4);
    expect(view.selected.id).toBe('page-8');
    expect(buildView(snapshot, {}, {page: 20}).page).toBe(1);
  });

  test('expired and pending renewal badges come from the mock KYC view', () => {
    const snapshot = {
      ...sample(),
      kycById: {'entity-established': {
        badge: 'expired', status: 'unverified', tier: 'none', checkPending: true,
        reRegistration: {ofEntityId: 'old-entity', signal: 'document'}, history: [],
      }},
    };
    const view = buildView(snapshot, {}, {tab: 'participants'});
    const entity = view.entities.find((entry: {id: string}) => entry.id === 'entity-established');
    expect(entity.kycBadge).toBe('expired');
    expect(entity.kycTier).toBe('none');
    const html = renderDesk(view);
    expect(html).toContain('Expired');
    expect(html).toContain('New check pending');
    expect(html).toContain('Re-registration flag: old-entity');
    expect(html).toContain('reliability record of the earlier entity does not transfer');
  });

  test('does not replace an unavailable KYC read with a verified seed badge', () => {
    const snapshot = {...sample(), kycErrors: {'entity-established': 'KYC returned 503'}};
    const entity = buildView(snapshot).entities.find((entry: {id: string}) => entry.id === 'entity-established');
    expect(entity.kycBadge).toBe('unknown');
    expect(entity.kycSource).toBe('Mock KYC unavailable');
  });
});

describe('receipt evidence', () => {
  test('paper sales and escrow evidence have independent modes', () => {
    expect(escrowOf(sample().receipts['tx-service-1']).mode).toBe('paper');
    expect(escrowOf(sample().receipts['tx-invoice-1']).mode).toBe('unknown');
    const snapshot = sample();
    snapshot.receipts['tx-service-1'].outcome.evidence.mode = 'live';
    const transaction = buildView(snapshot).transactions[0];
    expect(transaction.orderMode).toBe('paper');
    expect(transaction.escrow.mode).toBe('live');
    expect(renderDesk(buildView(snapshot))).toContain('LIVE escrow');
    expect(escrowOf({outcome: {evidence: {txHash: 'dry-run'}}}).text).toContain('No chain settlement proof');
  });

  test('timeline shows recorded facts without inventing escrow or delivery steps', () => {
    const rows = evidenceRows(sample().receipts['tx-invoice-1']);
    expect(rows.map((row: {title: string}) => row.title)).toEqual([
      'Agreement recorded', 'Settlement timestamp recorded',
    ]);
    expect(rows.map((row: {title: string}) => row.title)).not.toContain('Escrow funded');
  });

  test('shows fault, decisions, and their scope, and escapes source text', () => {
    const snapshot = sample();
    const receipt = snapshot.receipts['tx-service-1'];
    receipt.outcome.state = 'failed';
    Object.assign(receipt.outcome, {fault: 'seller'});
    receipt.outcome.evidence.producer = '<img src=x onerror="alert(1)">';
    snapshot.entities[0].displayName = '<script>alert(1)</script>';
    const html = renderDesk(buildView(snapshot, {source: 'connected'}));
    expect(html).toContain('At-fault role');
    expect(html).toContain('Seller');
    expect(html).toContain('Buyer fee offer');
    expect(html).toContain('Seller fee offer');
    expect(html).toContain('Decision for Meridian Services');
    expect(html).toContain('not recorded charges to both parties');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('Polymarket');
    expect(html).not.toContain('Portfolio');
    expect(html).not.toContain('Kill switch');
  });

  test('labels offline sample and last response independently', () => {
    const fixture = buildView(sample(), {source: 'fixture'});
    const stale = buildView(sample(), {source: 'stale', updatedAt: '2026-10-06T12:00:00Z'});
    expect(renderDesk(fixture)).toContain('Saved demo snapshot');
    expect(renderDesk(stale)).toContain('Showing the last response');
    expect(deskTitle(fixture)).toBe('Offline sample · Transactions · Tally');
    expect(deskTitle(stale)).toBe('Stale · Transactions · Tally');
  });
});

describe('display formatting', () => {
  test('does not turn missing numbers into zero or assume a currency', () => {
    for (const value of [null, undefined, '', '10', NaN, Infinity]) {
      expect(formatValue(value)).toBe('—');
      expect(formatPct(value)).toBe('—');
    }
    expect(formatValue(250)).toBe('250');
    expect(formatValue(1200, 'USD')).toBe('1,200 USD');
    expect(formatPct(0)).toBe('0%');
    expect(formatFee(80)).toBe('0.80%');
    expect(label('STRONG_HISTORY')).toBe('Strong history');
  });
});
