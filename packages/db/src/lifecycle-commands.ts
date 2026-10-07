/** @fileoverview Stored lifecycle command identities and external-call checkpoints. */
import type {Database} from 'bun:sqlite';
import type {LifecycleCommandRecord} from '../../reliability/src/lifecycle/commands';

const SELECT_COMMAND = `SELECT id, transaction_id AS transactionId, action,
  input_hash AS inputHash, input_json AS inputJson, effects_json AS effectsJson,
  result_json AS resultJson, status FROM reliability_lifecycle_commands`;

export function getLifecycleCommand(db: Database, id: string): LifecycleCommandRecord|undefined {
  return db.query<LifecycleCommandRecord, [string]>(`${SELECT_COMMAND} WHERE id = ?`).get(id) ?? undefined;
}

export function getPendingLifecycleCommand(db: Database, transactionId: string): LifecycleCommandRecord|undefined {
  return db.query<LifecycleCommandRecord, [string]>(
    `${SELECT_COMMAND} WHERE transaction_id = ? AND status = 'pending'`,
  ).get(transactionId) ?? undefined;
}

export function saveLifecycleCommand(db: Database, record: LifecycleCommandRecord): void {
  db.query(`INSERT INTO reliability_lifecycle_commands
    (id, transaction_id, action, input_hash, input_json, effects_json, result_json, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
    effects_json = excluded.effects_json, result_json = excluded.result_json,
    status = excluded.status`).run(record.id, record.transactionId, record.action,
    record.inputHash, record.inputJson, record.effectsJson, record.resultJson, record.status);
}

export function deleteLifecycleCommand(db: Database, id: string): void {
  db.query('DELETE FROM reliability_lifecycle_commands WHERE id = ?').run(id);
}
