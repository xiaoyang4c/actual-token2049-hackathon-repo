/** Runs the read-only Chainlink CRE payment workflow. */

import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {
  parsePaymentClaim, paymentReport, usdmToAtomic,
  type PaymentClaim, type PaymentObservation, type PaymentReport,
} from '../../packages/evidence/src/payment';
import {EVIDENCE_EXECUTION, EVIDENCE_EXAMPLE, type EvidenceResult} from '../../packages/evidence/src/protocol';

export class EvidenceError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export type EvidenceRunner = (claim: PaymentClaim) => Promise<PaymentReport>;

/** Do not forward CLI logs or secrets to the browser. Validate only the marker. */
export function parseCreReport(output: string, claim: PaymentClaim): PaymentReport {
  const markers = output.split('\n').filter((line) => line.includes('TALLY_EVIDENCE_REPORT:'));
  if (markers.length !== 1) throw new Error('CRE did not return one evidence report.');
  const report = JSON.parse(markers[0].split('TALLY_EVIDENCE_REPORT:')[1]) as PaymentReport;
  if (report.observation) {
    const observation: PaymentObservation = report.observation;
    if (observation.txHash !== claim.txHash || typeof observation.validContract !== 'boolean' ||
        !/^[a-f0-9]{64}$/.test(observation.blockHash) ||
        ![observation.blockHeight, observation.blockTime, observation.observedHeight].every((n) => Number.isSafeInteger(n) && n >= 0) ||
        ![observation.recipientInputAtomic, observation.recipientOutputAtomic].every((n) => typeof n === 'string' && /^(0|[1-9][0-9]{0,24})$/.test(n))) {
      throw new Error('CRE returned an invalid observation.');
    }
  }
  const expected = paymentReport(claim, report.observation ?? null);
  if (JSON.stringify(report) !== JSON.stringify(expected)) throw new Error('CRE returned an inconsistent evidence report.');
  return expected;
}

export function createCreRunner(env: NodeJS.ProcessEnv = process.env): EvidenceRunner|null {
  const binary = env.CHAINLINK_CRE_BINARY;
  const workflow = env.CHAINLINK_EVIDENCE_PROJECT;
  const wasm = env.CHAINLINK_EVIDENCE_WASM;
  const keyFile = env.CHAINLINK_BLOCKFROST_KEY_FILE;
  if (!binary || !workflow || !wasm || !existsSync(binary) || !existsSync(wasm) || (!env.BLOCKFROST_API_KEY_PREPROD && (!keyFile || !existsSync(keyFile)))) return null;
  const key = env.BLOCKFROST_API_KEY_PREPROD ?? readFileSync(keyFile!, 'utf8').trim();
  if (!/^preprod[a-zA-Z0-9]{20,80}$/.test(key)) return null;
  return async (claim) => {
    const childEnv = {...env};
    childEnv.BLOCKFROST_API_KEY_PREPROD = key;
    // Fixed argv, one pre-built workflow, no shell, no broadcast or wallet key.
    const child = Bun.spawn([
      resolve(binary), 'workflow', 'simulate', '.', '--project-root', resolve(workflow),
      '--target', 'demo-settings', '--non-interactive', '--trigger-index', '0',
      '--wasm', resolve(wasm), '--http-payload', JSON.stringify(claim),
    ], {
      cwd: workflow, stdout: 'pipe', stderr: 'pipe',
      env: childEnv,
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 20_000);
    try {
      const [output, , code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      if (timedOut || code !== 0 || output.length > 100_000) throw new EvidenceError('The Chainlink check could not finish. Try again later.', 503);
      return parseCreReport(output, claim);
    } finally {
      clearTimeout(timer);
    }
  };
}

export function claimFromUrl(url: URL): PaymentClaim {
  const allowed = new Set(['txHash', 'recipient', 'amount']);
  if (url.search.length > 1024 || [...url.searchParams.keys()].some((key) => !allowed.has(key) || url.searchParams.getAll(key).length !== 1)) {
    throw new EvidenceError('Use one transaction hash, recipient, and amount.', 400);
  }
  try {
    return parsePaymentClaim({
      txHash: url.searchParams.get('txHash')?.trim().toLowerCase(),
      recipient: url.searchParams.get('recipient')?.trim(),
      amountAtomic: usdmToAtomic(url.searchParams.get('amount')?.trim() ?? ''),
    });
  } catch (error) {
    throw new EvidenceError(error instanceof Error ? error.message : 'Check the payment details.', 400);
  }
}

/** One process at a time. Bound both the visitor table and the report cache. */
export class EvidenceChecker {
  private readonly visitors = new Map<string, {start: number; count: number}>();
  private readonly cache = new Map<string, {until: number; result: EvidenceResult}>();
  private active: {key: string; promise: Promise<EvidenceResult>}|null = null;
  private executions: number[] = [];

  constructor(private readonly run: EvidenceRunner|null, private readonly now = () => Date.now()) {}

  info() {
    return {available: this.run !== null, execution: EVIDENCE_EXECUTION, network: 'preprod', asset: 'test USDM', minimumConfirmations: 3, example: EVIDENCE_EXAMPLE};
  }

  async check(input: PaymentClaim, visitor: string): Promise<EvidenceResult> {
    const claim = parsePaymentClaim(input);
    if (!this.run) throw new EvidenceError('The evidence checker is offline. Try again later.', 503);
    const now = this.now();
    for (const [id, entry] of this.visitors) if (now - entry.start >= 600_000) this.visitors.delete(id);
    const usage = this.visitors.get(visitor) ?? {start: now, count: 0};
    if (usage.count >= 5 || (!this.visitors.has(visitor) && this.visitors.size >= 1000)) throw new EvidenceError('The demo allows five checks every ten minutes. Try again later.', 429);
    usage.count++;
    this.visitors.set(visitor, usage);
    const key = JSON.stringify(claim);
    const cached = this.cache.get(key);
    if (cached && cached.until > now) return cached.result;
    if (this.active?.key === key) return this.active.promise;
    if (this.active) throw new EvidenceError('Another receipt is being checked. Try again in a few seconds.', 429);
    this.executions = this.executions.filter((time) => now - time < 60_000);
    if (this.executions.length >= 10) throw new EvidenceError('The demo is busy. Try again in a minute.', 429);
    this.executions.push(now);
    const promise = this.execute(claim, key);
    this.active = {key, promise};
    try {
      return await promise;
    } finally {
      this.active = null;
    }
  }

  private async execute(claim: PaymentClaim, key: string): Promise<EvidenceResult> {
    try {
      const report = await this.run!(claim);
      const result: EvidenceResult = {
        report, execution: EVIDENCE_EXECUTION, source: 'Blockfrost',
        checkedAt: new Date(this.now()).toISOString(),
        reportHash: createHash('sha256').update(JSON.stringify(report)).digest('hex'),
        explorerUrl: `https://preprod.cardanoscan.io/transaction/${claim.txHash}`,
      };
      if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, {until: this.now() + (report.status === 'verified' ? 60_000 : 10_000), result});
      return result;
    } catch (error) {
      if (error instanceof EvidenceError) throw error;
      throw new EvidenceError('The evidence provider did not return a usable result. Try again later.', 503);
    }
  }
}
