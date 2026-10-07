import {describe, expect, test} from 'bun:test';
import {parsePaymentClaim, paymentReport, type PaymentObservation} from '../../packages/evidence/src/payment';
import {EVIDENCE_EXAMPLE} from '../../packages/evidence/src/protocol';
import {claimFromUrl, createCreRunner, EvidenceChecker, parseCreReport} from './evidence-checker';
import {createEvidenceProxyRoutes, createEvidenceRoutes} from './routes-evidence';

const claim = parsePaymentClaim({...EVIDENCE_EXAMPLE, amountAtomic: '1000000'});
const observation: PaymentObservation = {txHash: claim.txHash, blockHash: 'a'.repeat(64), validContract: true, blockHeight: 100, blockTime: 1_700_000_000, observedHeight: 103, recipientInputAtomic: '0', recipientOutputAtomic: '1000000'};
const report = paymentReport(claim, observation);
const checkUrl = () => new URL(`http://localhost/reliability/evidence/check?${new URLSearchParams(EVIDENCE_EXAMPLE)}`);

describe('Chainlink evidence API', () => {
  test('accepts only one bounded claim and converts decimal amounts exactly', () => {
    expect(claimFromUrl(checkUrl())).toEqual(claim);
    const duplicate = checkUrl(); duplicate.searchParams.append('amount', '10');
    expect(() => claimFromUrl(duplicate)).toThrow();
    const extra = checkUrl(); extra.searchParams.set('url', 'http://169.254.169.254');
    expect(() => claimFromUrl(extra)).toThrow();
  });

  test('requires one valid CLI report marker and matching report semantics', () => {
    const output = `CLI logs\n[USER LOG] TALLY_EVIDENCE_REPORT:${JSON.stringify(report)}\nDone`;
    expect(parseCreReport(output, claim)).toEqual(report);
    expect(() => parseCreReport(`${output}\n${output}`, claim)).toThrow();
    expect(() => parseCreReport('Workflow failed', claim)).toThrow();
    expect(() => parseCreReport(`TALLY_EVIDENCE_REPORT:${JSON.stringify({...report, status: 'mismatch'})}`, claim)).toThrow();
    expect(() => parseCreReport(output, {...claim, amountAtomic: '2000000'})).toThrow();
  });

  test('reports simulation honestly and never treats missing credentials as success', async () => {
    const checker = new EvidenceChecker(createCreRunner({}));
    expect(checker.info()).toMatchObject({available: false, execution: {mode: 'simulation', donConsensus: false}});
    await expect(checker.check(claim, 'v')).rejects.toMatchObject({status: 503});
  });

  test('returns a report fingerprint, with no payment or database write', async () => {
    const checker = new EvidenceChecker(async () => report, () => 1_700_000_000_000);
    const result = await checker.check(claim, 'v');
    expect(result).toMatchObject({report, source: 'Blockfrost', execution: {engine: 'chainlink-cre', mode: 'simulation', donConsensus: false}, checkedAt: '2023-11-14T22:13:20.000Z'});
    expect(result.reportHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('caches briefly and limits each visitor even on cached requests', async () => {
    let now = 0; let calls = 0;
    const checker = new EvidenceChecker(async () => { calls++; return report; }, () => now);
    for (let i = 0; i < 5; i++) await checker.check(claim, 'v');
    expect(calls).toBe(1);
    await expect(checker.check(claim, 'v')).rejects.toMatchObject({status: 429});
    now = 600_000;
    await checker.check(claim, 'v');
    expect(calls).toBe(2);
  });

  test('coalesces identical work and rejects another claim while busy', async () => {
    let finish: () => void = () => {};
    let calls = 0;
    const checker = new EvidenceChecker(async () => { calls++; await new Promise<void>((resolve) => { finish = resolve; }); return report; });
    const first = checker.check(claim, 'v1');
    const second = checker.check(claim, 'v2');
    await expect(checker.check({...claim, amountAtomic: '2000000'}, 'v3')).rejects.toMatchObject({status: 429});
    finish();
    expect(await second).toEqual(await first);
    expect(calls).toBe(1);
  });

  test('a failed provider returns a sanitized error and releases the slot', async () => {
    let calls = 0;
    const checker = new EvidenceChecker(async () => { if (++calls === 1) throw new Error('secret-credential'); return report; });
    await expect(checker.check(claim, 'v')).rejects.toMatchObject({status: 503, message: 'The evidence provider did not return a usable result. Try again later.'});
    expect((await checker.check(claim, 'v')).report.status).toBe('verified');
  });

  test('the read routes return 400 for invalid input and no cache headers', async () => {
    const routes = createEvidenceRoutes(new EvidenceChecker(async () => report));
    const url = checkUrl();
    const response = await routes[1].handler(new Request(url, {headers: {'x-forwarded-for': 'visitor'}}), url);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    url.searchParams.set('amount', '-1');
    const invalid = await routes[1].handler(new Request(url), url);
    expect(invalid.status).toBe(400);
    expect(routes.every((route) => route.method === 'GET')).toBe(true);
    expect(() => createEvidenceProxyRoutes('http://169.254.169.254')).toThrow();
  });
});
