/**
 * @fileoverview Durable escrow commands. External calls run outside SQL locks.
 * Unknown external responses block automatic resubmission until reconciliation.
 */
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {LifecycleError, type LifecycleTransition} from './contracts';

export interface LifecycleCommandRecord {
  id: string;
  transactionId: string;
  action: string;
  inputHash: string;
  inputJson: string;
  effectsJson: string;
  resultJson: string|null;
  status: 'pending'|'completed';
}

export interface LifecycleCommandStore {
  getLifecycleCommand(id: string): LifecycleCommandRecord|undefined;
  getPendingLifecycleCommand(transactionId: string): LifecycleCommandRecord|undefined;
  saveLifecycleCommand(record: LifecycleCommandRecord): void;
  deleteLifecycleCommand(id: string): void;
  transaction?<T>(work: () => T): T;
}

/** A safe command conflict or unknown external response. */
export class LifecycleCommandError extends LifecycleError {}

/** A submitted action still lacks the required confirmed chain evidence. */
export class LifecyclePendingError extends LifecycleError {}

interface Effect {
  status: 'started'|'done';
  value?: unknown;
}

/** One journal per lifecycle. SQL also prevents another writer from claiming it. */
export class LifecycleCommands {
  private readonly memory = new Map<string, LifecycleCommandRecord>();
  private readonly context = new AsyncLocalStorage<LifecycleCommandRecord>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly store?: LifecycleCommandStore) {}

  assertAvailable(transactionId: string): void {
    const pending = this.store?.getPendingLifecycleCommand(transactionId) ??
      [...this.memory.values()].find((row) =>
        row.transactionId === transactionId && row.status === 'pending');
    if (pending && pending.id !== this.context.getStore()?.id) {
      throw new LifecycleCommandError('an escrow command is pending; retry that command first');
    }
  }

  async run<T extends {transactionId: string; at: string; commandId?: string}>(
    action: string, input: T, generation: number,
    work: (saved: T) => Promise<LifecycleTransition>,
  ): Promise<LifecycleTransition> {
    const previous = this.queues.get(input.transactionId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      const id = input.commandId ?? JSON.stringify([input.transactionId, action, generation]);
      const binding = Object.fromEntries(Object.entries(input).filter(
        ([key]) => key !== 'at' && key !== 'commandId',
      ));
      // Time is fixed by the first request. A later retry cannot change it.
      const inputHash = createHash('sha256').update(canonical(binding)).digest('hex');
      const claim = () => {
        const existing = this.read(id);
        if (existing) {
          if (existing.inputHash !== inputHash || existing.action !== action ||
              existing.transactionId !== input.transactionId) {
            throw new LifecycleCommandError('command identity conflicts with the original request');
          }
          return existing;
        }
        this.assertAvailable(input.transactionId);
        const record: LifecycleCommandRecord = {
          id, transactionId: input.transactionId, action, inputHash,
          inputJson: JSON.stringify(input), effectsJson: '{}', resultJson: null,
          status: 'pending',
        };
        this.save(record);
        return record;
      };
      const record = this.store?.transaction ? this.store.transaction(claim) : claim();
      if (record.resultJson) return JSON.parse(record.resultJson) as LifecycleTransition;
      return this.context.run(record, async () => {
        try {
          const result = await work(JSON.parse(record.inputJson) as T);
          this.complete(result);
          return result;
        } catch (error) {
          // A validation failure before any external call is safe to correct.
          const release = () => {
            if (this.read(record.id)?.effectsJson === '{}') this.remove(record.id);
          };
          if (this.store?.transaction) this.store.transaction(release);
          else release();
          throw error;
        }
      });
    });
    this.queues.set(input.transactionId, operation);
    try {
      return await operation;
    } finally {
      if (this.queues.get(input.transactionId) === operation) this.queues.delete(input.transactionId);
    }
  }

  async effect<T>(name: string, work: () => Promise<T>): Promise<T> {
    const record = this.context.getStore();
    if (!record) throw new Error('external effect requires a lifecycle command');
    const reserve = () => {
      const latest = this.read(record.id) ?? record;
      const effects = JSON.parse(latest.effectsJson) as Record<string, Effect>;
      const previous = effects[name];
      if (previous?.status === 'done') return {effects, previous};
      if (previous) {
        throw new LifecycleCommandError('external response is unknown; reconciliation is required before retry');
      }
      effects[name] = {status: 'started'};
      record.effectsJson = JSON.stringify(effects);
      this.save(record);
      return {effects, previous};
    };
    const {effects, previous} = this.store?.transaction ? this.store.transaction(reserve) : reserve();
    if (previous) return previous.value as T;
    const value = await work();
    effects[name] = {status: 'done', value};
    record.effectsJson = JSON.stringify(effects);
    this.save(record);
    return value;
  }

  complete(result: LifecycleTransition): void {
    const record = this.context.getStore();
    if (!record) return;
    // Do not alter the in-memory record until the SQL transaction commits.
    this.save({...record, status: 'completed', resultJson: JSON.stringify(result)});
  }

  private read(id: string): LifecycleCommandRecord|undefined {
    return this.store?.getLifecycleCommand(id) ?? this.memory.get(id);
  }

  private save(record: LifecycleCommandRecord): void {
    if (this.store) this.store.saveLifecycleCommand(record);
    else this.memory.set(record.id, {...record});
  }

  private remove(id: string): void {
    if (this.store) this.store.deleteLifecycleCommand(id);
    else this.memory.delete(id);
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
