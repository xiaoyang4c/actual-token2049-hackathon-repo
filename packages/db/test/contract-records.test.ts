/**
 * @fileoverview Contract lifecycle records (migration 012).
 */

import {describe, expect, test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {AgentStore} from '../src/index';
import {applyMigrations} from '../src/migrate';
import * as contractRecords from '../src/contract-records';
import {ContractConflictError, type ContractCommit} from '../../reliability/src/contract-lifecycle/ports';
import type {Contract} from '../../reliability/src/contract-lifecycle/types';

function contract(id: string): Contract {
  return {id, version: 0, mode: 'paper', milestones: []} as unknown as Contract;
}

function change(record: Contract, isNew: boolean, event: string): ContractCommit {
  return {
    contract: record,
    isNew,
    open: true,
    now: 1,
    audits: [{at: 1, contractId: record.id, milestoneId: null, event, fromState: null, toState: null, actor: 'test', mode: 'paper', details: {n: 1}}],
    newOperations: isNew ? [{id: `op-${record.id}`, contractId: record.id, milestoneId: 'm', trancheId: 't', kind: 'create_terms', idempotencyKey: `key-${record.id}`, payload: {}, createdAt: 1}] : [],
    operationUpdates: [],
    evidence: [],
    publications: [],
    action: null,
  };
}

describe('contract records', () => {
  test('the audit log is append-only and its hash chain detects edits', () => {
    const db = new Database(':memory:');
    try {
      applyMigrations(db);
      db.transaction(() => contractRecords.commitContract(db, change(contract('c1'), true, 'created')))();
      db.transaction(() => contractRecords.commitContract(db, change(contractRecords.getContract(db, 'c1')!, false, 'next')))();
      expect(contractRecords.verifyContractAuditChain(db)).toBeNull();
      expect(() => db.run("UPDATE contract_audit SET actor = 'mallory'")).toThrow(/append-only/);
      expect(() => db.run('DELETE FROM contract_audit')).toThrow(/append-only/);
      db.run('DROP TRIGGER contract_audit_no_update');
      db.run("UPDATE contract_audit SET actor = 'mallory' WHERE seq = 2");
      expect(contractRecords.verifyContractAuditChain(db)).toBe(2);
    } finally {
      db.close();
    }
  });

  test('a stale version is a conflict and changes nothing', () => {
    const store = AgentStore.open();
    try {
      store.commitContract(change(contract('c1'), true, 'created'));
      const first = store.getContract('c1')!;
      const second = store.getContract('c1')!;
      store.commitContract(change(first, false, 'a'));
      expect(() => store.commitContract(change(second, false, 'b'))).toThrow(ContractConflictError);
      expect(store.getContract('c1')?.version).toBe(2);
      expect(store.listContractAudit('c1').map((row) => row.event)).toEqual(['created', 'a']);
    } finally {
      store.close();
    }
  });

  test('a lease blocks a second worker until it expires, and each claim counts an attempt', () => {
    const store = AgentStore.open();
    try {
      store.commitContract(change(contract('c1'), true, 'created'));
      const first = store.claimOperation('op-c1', 'worker-a', 100, 200);
      expect(first?.attempts).toBe(0);
      expect(store.claimOperation('op-c1', 'worker-b', 150, 250)).toBeUndefined();
      const second = store.claimOperation('op-c1', 'worker-b', 200, 300);
      expect(second?.attempts).toBe(1);
      store.releaseOperation('op-c1', 'timeout', 210);
      const released = store.listOperations('c1')[0];
      expect([released?.attempts, released?.leaseOwner, released?.lastError]).toEqual([2, null, 'timeout']);
    } finally {
      store.close();
    }
  });

  test('the paper clock offset only grows', () => {
    const store = AgentStore.open();
    try {
      expect(store.getPaperClockOffset()).toBe(0);
      store.raisePaperClockOffset(5_000);
      store.raisePaperClockOffset(1_000);
      expect(store.getPaperClockOffset()).toBe(5_000);
    } finally {
      store.close();
    }
  });
});
