/**
 * @fileoverview Shared control database setup for the marketplace and demos.
 */

import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {AgentStore} from '../packages/db/src';

export interface ControlStoreOptions {
  databasePath?: string;
  store?: AgentStore;
}

/** Opens the control store. The caller owns a new store, but not a supplied one. */
export function openControlStore(options: ControlStoreOptions = {}): AgentStore {
  if (options.store) return options.store;
  const databasePath = options.databasePath ?? process.env.CONTROL_DB_PATH ??
    fileURLToPath(new URL('./.data/agent.sqlite', import.meta.url));
  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), {recursive: true});
  return AgentStore.open(databasePath);
}
