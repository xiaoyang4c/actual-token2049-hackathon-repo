/**
 * @fileoverview Restart and timeout recovery for the contract lifecycle.
 * State survives a restart. An uncertain write is inspected before a
 * retry. A second worker never sends a write that another worker holds.
 */

import {describe, expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  EscrowRetryableError, type ContractEscrow, type EscrowRequest, type EscrowResult,
} from '../../packages/reliability/src/contract-lifecycle/ports';
import {loadContractConfig} from './contract-config';
import {acceptTerms, act, createKit, envOf, KIT_ENV, ManualClock, milestone, runUntil, settleTicks, type Kit} from './contract-kit';
import {PaperContractEscrow} from './contract-paper-escrow';
import {ContractService} from './contract-service';

const sha = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const FILE = 'id,price\n1,100\n';

function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'contract-recovery-'));
  return run(directory).finally(() => rmSync(directory, {recursive: true, force: true}));
}

/** Simulates a process restart: close the store and open the same file again. */
function restart(kit: Kit, databasePath: string): Kit {
  kit.close();
  return createKit({databasePath, clock: kit.clock, keys: kit.keys, reuseParties: true});
}

function newContract(kit: Kit): string {
  return kit.service.lifecycle.createContract({
    templateId: 'digital-machine-checkable',
    buyerId: kit.buyerId,
    sellerId: kit.sellerId,
    milestones: [{title: 'file', amountAtomic: '5000000', deliverable: {expectedSha256: sha(FILE)}}],
  }, kit.buyerId).id;
}

/** A second service on the same store, with its own escrow wrapper and worker id. */
function serviceWith(kit: Kit, escrow: ContractEscrow, workerId: string): ContractService {
  const config = loadContractConfig(envOf([['CONTRACT_MEDIATOR_PUBLIC_KEY_HEX', kit.keys.mediator.publicKeyHex], ['CONTRACT_WORKER_ID', workerId]], KIT_ENV));
  return new ContractService(kit.store, {config, clock: kit.clock, escrow});
}

/** The write succeeds on the rail, then the call "times out". The caller never learns the result. */
class TimeoutAfterSuccess implements ContractEscrow {
  readonly mode = 'paper' as const;
  tripped = false;
  constructor(private readonly inner: PaperContractEscrow, private readonly kind: string) {}
  async execute(request: EscrowRequest): Promise<EscrowResult> {
    const result = await this.inner.execute(request);
    if (request.kind === this.kind && !this.tripped) {
      this.tripped = true;
      throw new EscrowRetryableError('socket timeout after 30 s');
    }
    return result;
  }
  inspect(request: EscrowRequest) {
    return this.inner.inspect(request);
  }
  status(ref: string) {
    return this.inner.status(ref);
  }
}

/** Holds every write until released, to model a slow rail call. */
class SlowEscrow implements ContractEscrow {
  readonly mode = 'paper' as const;
  calls = 0;
  private release: (() => void)|null = null;
  constructor(private readonly inner: PaperContractEscrow) {}
  async execute(request: EscrowRequest): Promise<EscrowResult> {
    this.calls++;
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    return this.inner.execute(request);
  }
  inspect(request: EscrowRequest) {
    return this.inner.inspect(request);
  }
  status(ref: string) {
    return this.inner.status(ref);
  }
  finish(): void {
    this.release?.();
  }
}

function paperEscrow(kit: Kit): PaperContractEscrow {
  return new PaperContractEscrow(kit.store, kit.clock, kit.service.config.paperEscrow);
}

describe('contract restart recovery', () => {
  test('survives restarts mid-lifecycle and finishes with one settlement', async () => {
    await withDirectory(async (directory) => {
      const databasePath = join(directory, 'agent.sqlite');
      let kit = createKit({databasePath, clock: new ManualClock(Date.UTC(2026, 9, 6, 9))});
      const id = newContract(kit);
      acceptTerms(kit, id);
      await runUntil(kit, id, 'funded');
      act(kit, id, kit.sellerId, 'deliver', {milestoneId: milestone(kit, id).id, evidence: [{type: 'content_file', content: FILE}]});
      expect(kit.service.lifecycle.operations(id).some((item) => item.kind === 'submit_result' && item.status === 'pending')).toBe(true);

      kit = restart(kit, databasePath);
      expect(milestone(kit, id).pending?.kind).toBe('delivery');
      await runUntil(kit, id, 'in_inspection');

      kit = restart(kit, databasePath);
      kit.clock.set(milestone(kit, id).inspectionCutoffAt!);
      await runUntil(kit, id, 'auto_released');
      kit = restart(kit, databasePath);
      kit.clock.set(milestone(kit, id).deadlines!.unlockTime + kit.service.config.paperEscrow.autoWithdrawDelayMs);
      await runUntil(kit, id, 'settled');
      expect(kit.store.getOutcome(`${id}/m0`)?.state).toBe('successful');
      expect(kit.store.verifyContractAuditChain()).toBeNull();
      kit.close();
    });
  });

  test('a timeout after a successful lock: the retry inspects first and never sends a second lock', async () => {
    const kit = createKit();
    const id = newContract(kit);
    acceptTerms(kit, id);
    const flaky = new TimeoutAfterSuccess(paperEscrow(kit), 'lock_funds');
    const first = serviceWith(kit, flaky, 'worker-a');
    await first.tick();
    expect(flaky.tripped).toBe(true);
    const lock = first.lifecycle.operations(id).find((item) => item.kind === 'lock_funds')!;
    expect([lock.status, lock.attempts]).toEqual(['pending', 1]);
    expect(lock.lastError).toContain('timeout');

    const second = serviceWith(kit, paperEscrow(kit), 'worker-b'); // the restarted process
    await second.tick();
    kit.clock.advance(kit.service.config.paperEscrow.confirmationDelayMs + 1);
    await second.tick();
    const after = second.lifecycle.operations(id).find((item) => item.kind === 'lock_funds')!;
    expect([after.status, after.attempts]).toEqual(['done', 2]);
    const ref = milestone(kit, id).tranches[0]!.escrowRef!;
    expect(paperEscrow(kit).transactionLog(ref).filter((tx) => tx.kind === 'Lock').length).toBe(1);
    expect(milestone(kit, id).state).toBe('funded');
    expect(second.lifecycle.audit(id).some((row) => row.event === 'escrow_operation_sent' && String(row.details.note).includes('recovered'))).toBe(true);
    kit.close();
  });

  test('a crash after the attempt was recorded but before the write: inspect, then send once', async () => {
    const kit = createKit();
    const id = newContract(kit);
    acceptTerms(kit, id);
    await runUntil(kit, id, 'funded');
    act(kit, id, kit.sellerId, 'deliver', {milestoneId: milestone(kit, id).id, evidence: [{type: 'content_file', content: FILE}]});
    const op = kit.service.lifecycle.operations(id).find((item) => item.kind === 'submit_result')!;
    // The process claimed the operation and died before the call. Its lease expires.
    kit.store.claimOperation(op.id, 'dead-worker', kit.clock.now(), kit.clock.now() + 1);
    kit.clock.advance(2);
    await runUntil(kit, id, 'in_inspection');
    const after = kit.service.lifecycle.operations(id).find((item) => item.id === op.id)!;
    expect([after.status, after.attempts]).toEqual(['done', 2]);
    kit.close();
  });

  test('two workers on one store: the lease stops the second from sending the same write', async () => {
    const kit = createKit();
    const id = newContract(kit);
    acceptTerms(kit, id);
    const slow = new SlowEscrow(paperEscrow(kit));
    const workerA = serviceWith(kit, slow, 'worker-a');
    const workerB = serviceWith(kit, paperEscrow(kit), 'worker-b');
    const pending = workerA.lifecycle.processOperations(); // claims create_terms and waits on the rail
    await new Promise((resolve) => setTimeout(resolve, 10));
    await workerB.lifecycle.processOperations(); // the lease is held: worker B must not send
    const terms = kit.service.lifecycle.operations(id).find((item) => item.kind === 'create_terms')!;
    expect([terms.status, terms.attempts, terms.leaseOwner]).toEqual(['pending', 1, 'worker-a']);
    slow.finish();
    await pending;
    expect(slow.calls).toBe(1);
    expect(kit.service.lifecycle.operations(id).find((item) => item.kind === 'create_terms')!.status).toBe('done');
    kit.close();
  });

  test('a restart across a tier deadline escalates on the first tick', async () => {
    await withDirectory(async (directory) => {
      const databasePath = join(directory, 'agent.sqlite');
      let kit = createKit({databasePath, clock: new ManualClock(Date.UTC(2026, 9, 6, 9))});
      const id = newContract(kit);
      acceptTerms(kit, id);
      await runUntil(kit, id, 'funded');
      const mId = milestone(kit, id).id;
      act(kit, id, kit.sellerId, 'deliver', {milestoneId: mId, evidence: [{type: 'content_file', content: 'wrong'}]});
      await runUntil(kit, id, 'in_inspection');
      act(kit, id, kit.buyerId, 'dispute', {milestoneId: mId, evidence: [{type: 'note', content: 'wrong file'}]});
      await settleTicks(kit, 2);
      expect(milestone(kit, id).state).toBe('resolved'); // the code judge ruled at once
      const dueAt = milestone(kit, id).dispute.obligations[0]!.dueAt;
      kit.clock.set(dueAt + 1); // the process is down across the compliance deadline
      kit = restart(kit, databasePath);
      await kit.service.tick();
      expect(kit.service.lifecycle.audit(id).some((row) => row.event === 'ruling_ignored')).toBe(true);
      kit.close();
    });
  });

  test('publishing is idempotent: a repeated publish adds no events', async () => {
    const kit = createKit();
    const id = newContract(kit);
    acceptTerms(kit, id);
    await runUntil(kit, id, 'funded');
    act(kit, id, kit.sellerId, 'concede_refund', {milestoneId: milestone(kit, id).id});
    await runUntil(kit, id, 'refunded');
    const count = kit.store.listReliabilityEventsForTransaction(`${id}/m0`).length;
    expect(kit.service.publish()).toBe(0);
    expect(kit.store.listReliabilityEventsForTransaction(`${id}/m0`).length).toBe(count);
    kit.close();
  });
});
