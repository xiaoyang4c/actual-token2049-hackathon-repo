/**
 * @fileoverview Build step for the Vercel demo: seeds .demo-data/demo.sqlite
 * once, so every function instance serves the same contracts and ids. The
 * file is a paper database: the showcase contracts and their settlement
 * fingerprints, with nothing sent to a chain. Vercel does not treat files
 * that start with an underscore as functions.
 *
 *   bun run api/_seed.ts
 */

import {mkdirSync, rmSync} from 'node:fs';
import {Database} from 'bun:sqlite';
import {AgentStore} from '../packages/db/src/index';
import {AnchorWorker} from '../services/reliability/anchors';
import {seedShowcase} from '../services/reliability/contract-showcase';

process.env.CARDANO_MODE = 'simulated';
process.env.CARDANO_ALLOW_NETWORK = 'false';

const DIRECTORY = new URL('../.demo-data/', import.meta.url).pathname;
const DATABASE = `${DIRECTORY}demo.sqlite`;

rmSync(DIRECTORY, {recursive: true, force: true});
mkdirSync(DIRECTORY, {recursive: true});
await seedShowcase(DATABASE);
const store = AgentStore.open(DATABASE);
new AnchorWorker({store, chain: null, submit: false, now: () => Date.now(), log: () => {}}).collect();
store.close();

// One self-contained file: fold the write-ahead log in and drop it.
const db = new Database(DATABASE);
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.exec('PRAGMA journal_mode=DELETE');
db.close();
console.log(`seeded ${DATABASE}`);
