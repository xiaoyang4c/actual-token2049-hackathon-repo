import {describe, expect, test} from 'bun:test';
import {buildView} from './model.js';
import {deskTitle, renderDesk} from './render.js';
import {
  actionFor, dealsView, exampleFor, mediationQueue, partiesOf, readable, relative, signerText, stageOf, stateText, viewerRole,
} from './tally.js';
import {anchorStatus, atomic, renderAsk, renderCompanies, renderDeals, renderMediation} from './tally-views.js';

const NOW = Date.UTC(2026, 9, 7, 6, 0, 0);
const HOUR = 3_600_000;
const at = (ms: number) => ({ms, utc: new Date(ms).toISOString(), singapore: 'test SGT'});
const money = (display: string) => ({atomic: '1', display});

function milestone(state: string, next: {actor: string; action: string; dueAt: ReturnType<typeof at>|null}) {
  return {
    id: `m-${state}`, index: 0, title: `Lot <b>${state}</b>`, amount: money('4,000 test USDM'), state,
    terminal: ['settled', 'cancelled', 'expired', 'refunded'].includes(state),
    inDispute: state.startsWith('tier_'), tierReached: state.startsWith('tier_') ? Number(state[5]) : 0,
    outcome: null, closedReason: null, next,
  };
}

function contract(id: string, buyer: string, seller: string, milestones: unknown[]) {
  return {
    id, label: 'SIMULATED', mode: 'paper', templateId: 'physical-objective-spec', title: `<script>alert(1)</script>${id}`,
    buyer: {id: buyer, displayName: `${buyer} Ltd`}, seller: {id: seller, displayName: `${seller} Co`},
    total: money('4,000 test USDM'), createdAt: at(NOW), remedy: 'partial_release', milestones,
  };
}

const CONTRACTS = [
  contract('c1', 'kopi', 'highland', [milestone('in_inspection', {actor: 'buyer', action: 'Accept the delivery or dispute it', dueAt: at(NOW + 3 * HOUR)})]),
  contract('c2', 'kopi', 'highland', [milestone('tier_3_mediation', {actor: 'mediator', action: 'Rule: name the winner', dueAt: at(NOW + 50 * HOUR)})]),
  contract('c3', 'northwind', 'datacrate', [milestone('tier_1_negotiation', {actor: 'both', action: 'Sign one fixed outcome, or escalate', dueAt: at(NOW + 20 * HOUR)})]),
  contract('c4', 'northwind', 'datacrate', [milestone('settled', {actor: 'none', action: 'Closed: ACCEPTED', dueAt: null})]),
];

function tally(extra = {}) {
  return {
    area: 'deals', operatorTab: 'transactions', contracts: CONTRACTS, contractsError: '', party: 'kopi', selected: '', detail: null, detailError: '',
    mediation: {selected: null, caseFile: null, caseError: '', options: null, winner: 'buyer', reason: '', payload: null, busy: false, error: ''},
    companies: {query: '', results: [], selectedId: '', profile: null, busy: false, error: ''},
    ask: {coworker: 'deal-desk', text: '', job: null, busy: false, error: ''},
    ...extra,
  };
}

describe('tally display models', () => {
  test('stages, roles, and the next action from the viewer side', () => {
    expect(stageOf('funded')).toEqual({step: 2, dispute: false});
    expect(stageOf('tier_3_mediation')).toEqual({step: 3, dispute: true});
    expect(stateText('accepted_pending_release')).toBe('Accepted, releases at unlock');
    expect(viewerRole(CONTRACTS[0], 'kopi')).toBe('buyer');
    expect(viewerRole(CONTRACTS[0], 'highland')).toBe('seller');
    expect(viewerRole(CONTRACTS[0], 'someone')).toBeNull();
    const next = {actor: 'buyer', action: 'Accept', dueAt: null};
    expect(actionFor(next, 'buyer')).toEqual({mine: true, who: 'You', text: 'Accept'});
    expect(actionFor(next, 'seller')).toEqual({mine: false, who: 'the buyer', text: 'Accept'});
    expect(actionFor({actor: 'both', action: 'Agree', dueAt: null}, 'seller').mine).toBe(true);
    expect(actionFor({actor: 'both', action: 'Agree', dueAt: null}, null).mine).toBe(false);
  });

  test('relative times and signer labels', () => {
    expect(relative(NOW + 2 * 86_400_000 + 3 * HOUR, NOW)).toBe('in 2 d 3 h');
    expect(relative(NOW - 5 * HOUR, NOW)).toBe('5 h ago');
    expect(relative(NOW + 30_000, NOW)).toBe('now');
    expect(relative(Number.NaN, NOW)).toBe('');
    expect(signerText({signer: {namedJudge: true, whitelisted: true}})).toBe('Signed by the named judge');
    expect(signerText({signer: null})).toBe('Unsigned');
  });

  test('deals per party, the mediation queue, and exact atomic amounts', () => {
    expect(partiesOf(CONTRACTS).map((party) => party.id)).toEqual(['datacrate', 'highland', 'kopi', 'northwind']);
    const kopi = dealsView(CONTRACTS, 'kopi', NOW);
    expect(kopi.rows.map((row) => row.id)).toEqual(['c1', 'c2']);
    expect(kopi.metrics).toEqual({open: 2, yourMove: 1, disputes: 1, settled: 0});
    expect(kopi.dueSoon).toBe(1);
    expect(dealsView(CONTRACTS, '', NOW).metrics.settled).toBe(1);
    // Without a party: every milestone that waits on a party (the buyer in c1, both parties in c3).
    expect(dealsView(CONTRACTS, '', NOW).metrics.yourMove).toBe(2);
    expect(readable('{"verdict":"FAIL"}')).toBe('{\n  "verdict": "FAIL"\n}');
    expect(readable('SEAL 42')).toBe('SEAL 42');
    expect(mediationQueue(CONTRACTS).map((item) => item.contract.id)).toEqual(['c3', 'c2']);
    expect(atomic('2275000000', 6)).toBe('2,275 test USDM');
    expect(atomic('1', 6)).toBe('0.000001 test USDM');
  });
});

describe('tally views render safely', () => {
  test('my deals escape party text and mark the viewer move', () => {
    const html = renderDeals(tally(), NOW);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<b>');
    expect(html).toContain('Your move');
    expect(html).toContain('SIMULATED');
  });

  test('the mediation desk lists disputes, most urgent first, and says it is a lens', () => {
    const html = renderMediation(tally(), NOW);
    expect(html).toContain('Mediator lens');
    expect(html.indexOf('data-case="c3"')).toBeLessThan(html.indexOf('data-case="c2"'));
    expect(html).toContain('Select a case');
  });

  test('companies and the desk shell use the Tally brand', () => {
    expect(renderCompanies(tally())).toContain('Try “kopi”');
    const view = buildView({}, {source: 'connected'}, {});
    for (const area of ['deals', 'mediation', 'companies', 'operator']) {
      const html = renderDesk(view, {}, 'light', {}, tally({area}));
      expect(html).toContain('aria-label="Tally home"');
      expect(html).not.toContain('Reliability home');
    }
    expect(deskTitle(view, 'mediation')).toBe('Mediation desk · Tally');
    expect(deskTitle(view, 'operator', 'contracts')).toBe('Contracts · Tally');
    expect(deskTitle(view, 'ask')).toBe('Ask a Coworker · Tally');
  });
});

describe('Ask a Coworker', () => {
  const job = (extra: Record<string, unknown>) => ({id: 'j1', coworker: 'mediator', status: 'done', position: 0, mode: 'fill-in', error: null, answer: null, ...extra});

  test('the form keeps the request, and the answer is escaped before it becomes Markdown', () => {
    const html = renderAsk(tally({ask: {coworker: 'mediator', text: '<b>x</b>', busy: false, error: '',
      job: job({answer: '## Case\n<script>alert(1)</script>\n| A | B |\n| --- | --- |\n| 1 | 2 |'})}}));
    expect(html).toContain('value="mediator" checked');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;</textarea>');
    expect(html).toContain('Ask Mediator');
    expect(html).toContain('<h3>Case</h3>');
    expect(html).toContain('<td>1</td><td>2</td>');
    expect(html).toContain('Answered without AI');
    expect(html).not.toContain('<script>');
  });

  test('waiting, failed, and empty states', () => {
    expect(renderAsk(tally({ask: {coworker: 'deal-desk', text: 'x', busy: true, error: '', job: job({status: 'queued', position: 2})}})))
      .toContain('Tally Mediator is working (2 ahead of you)…');
    expect(renderAsk(tally({ask: {coworker: 'deal-desk', text: 'x', busy: false, error: '', job: job({status: 'failed', error: 'The Coworkers are busy.'})}})))
      .toContain('The Coworkers are busy.');
    const empty = renderAsk(tally());
    expect(empty).toContain('Your answer appears here');
    expect(empty).toContain('Free preview: no payment, and nothing is saved.');
  });

  test('the Mediator example names a real dispute waiting for a ruling', () => {
    expect(exampleFor('mediator', CONTRACTS)).toBe('contract: c2\nmilestone: 0');
    expect(exampleFor('mediator', [])).toBe('contract: <contract id>\nmilestone: 0');
    expect(exampleFor('deal-desk', CONTRACTS)).toContain('1,200 kg');
  });
});

describe('settlement anchors on the website', () => {
  const HASH = 'ab'.repeat(32);
  const confirmed = {status: 'confirmed', txHashes: [HASH], explorerUrls: [`https://preprod.cardanoscan.io/transaction/${HASH}`], blockHeight: 42, anchoredAt: '2026-10-07T06:00:00Z'};

  test('a confirmed anchor links to Cardanoscan, and only for a real transaction hash', () => {
    const html = anchorStatus(confirmed);
    expect(html).toContain('Fingerprint on Cardano');
    expect(html).toContain(`href="https://preprod.cardanoscan.io/transaction/${HASH}"`);
    expect(html).toContain('rel="noopener noreferrer"');
    expect(anchorStatus({...confirmed, explorerUrls: ['javascript:alert(1)']})).not.toContain('href');
    expect(anchorStatus({...confirmed, explorerUrls: ['https://preprod.cardanoscan.io/transaction/x" onclick="y']})).not.toContain('href');
    expect(anchorStatus({status: 'waiting', txHashes: [], explorerUrls: [], blockHeight: null, anchoredAt: null})).toContain('next anchor batch');
  });

  test('a company shows its chain: anchored entries, and a broken chain says so', () => {
    const profile = {
      entity: {id: 'kopi', displayName: 'Kopi', kycStatus: 'verified', kycTier: 'basic', createdAt: '2026-10-01'},
      contractSummary: {live: {}, simulated: {}}, scores: [], scoringPolicy: {version: 'v0', provisional: false}, deals: [],
    };
    const anchors = {entityId: 'kopi', chain: {intact: true, problems: [], length: 2, anchored: 1, head: HASH}, entries: [
      {seq: 1, entryHash: HASH, recordHash: HASH, contractId: 'c1', milestoneId: 'm1', anchor: confirmed},
      {seq: 2, entryHash: HASH, recordHash: HASH, contractId: 'c2', milestoneId: 'm2', anchor: {status: 'waiting', txHashes: [], explorerUrls: [], blockHeight: null, anchoredAt: null}},
    ]};
    const html = renderCompanies(tally({area: 'companies', companies: {query: '', results: [], selectedId: 'kopi', profile, anchors, busy: false, error: ''}}));
    expect(html).toContain('2 settled records fingerprinted · 1 on Cardano · chain <strong>intact</strong>');
    expect(html).toContain('#2 · waiting for the next batch');
    const broken = renderCompanies(tally({area: 'companies', companies: {query: '', results: [], selectedId: 'kopi', profile, busy: false, error: '',
      anchors: {...anchors, chain: {...anchors.chain, intact: false, problems: ['entry 2 does not link to the entry before it']}}}}));
    expect(broken).toContain('broken');
    expect(broken).toContain('entry 2 does not link to the entry before it');
  });
});
