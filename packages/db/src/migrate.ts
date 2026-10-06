/**
 * @fileoverview Applies versioned SQL files under packages/db/migrations.
 */

import type {Database} from 'bun:sqlite';
import {readdirSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS_DIRECTORY = join(
  dirname(fileURLToPath(import.meta.url)),
  '../migrations',
);

const MIGRATION_FILE = /^(\d+)_[a-z0-9_]+\.sql$/;

/**
 * Enables foreign keys and applies any migration that is not yet recorded
 * in schema_migrations. Safe to call again on an already-migrated database.
 */
export function applyMigrations(db: Database): void {
  db.run('PRAGMA foreign_keys = ON');
  db.run(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`,
  );

  const applied = appliedVersions(db);
  for (const migration of loadMigrations()) {
    if (applied.has(migration.version)) {
      continue;
    }
    const apply = db.transaction(() => {
      db.run(migration.sql);
      db.run(
        `INSERT INTO schema_migrations (version, name, applied_at)
         VALUES (?, ?, ?)`,
        [
          migration.version,
          migration.name,
          new Date().toISOString(),
        ],
      );
    });
    apply();
  }
}

function appliedVersions(db: Database): Set<number> {
  const rows = db
    .query<{version: number}, []>('SELECT version FROM schema_migrations')
    .all();
  const versions = new Set<number>();
  for (const row of rows) {
    versions.add(row.version);
  }
  return versions;
}

function loadMigrations(): Migration[] {
  const loaded: Migration[] = [];
  for (const name of readdirSync(MIGRATIONS_DIRECTORY)) {
    const match = MIGRATION_FILE.exec(name);
    if (match === null) {
      continue;
    }
    const versionText = match[1];
    if (versionText === undefined) {
      continue;
    }
    const version = Number(versionText);
    if (!Number.isInteger(version)) {
      throw new Error(`migration ${name} has a non-integer version`);
    }
    const sql = readFileSync(join(MIGRATIONS_DIRECTORY, name), 'utf8');
    if (sql.trim() === '') {
      throw new Error(`migration ${name} is empty`);
    }
    loaded.push({version, name, sql});
  }

  loaded.sort((left, right) => left.version - right.version);
  let previous = -1;
  for (const migration of loaded) {
    if (migration.version === previous) {
      throw new Error(`duplicate migration version ${migration.version}`);
    }
    previous = migration.version;
  }
  if (loaded.length === 0) {
    throw new Error(`no migrations found in ${MIGRATIONS_DIRECTORY}`);
  }
  return loaded;
}
