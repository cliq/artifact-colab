/**
 * Opens the app's SQLite database: resolves the file path, ensures the parent
 * directory exists, applies pragmas (WAL journaling, foreign key
 * enforcement), wraps the connection with Drizzle, and runs pending
 * migrations before handing the connection back.
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import * as schema from './schema.js';

export type DB = ReturnType<typeof drizzle<typeof schema>>;
/** A DB or the transaction handle passed to `db.transaction` — for services callable from either. */
export type DBOrTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

export function openDb(path?: string): { db: DB; sqlite: Database.Database } {
  const dbPath = path ?? process.env.DATABASE_PATH ?? './data/app.db';
  const isMemory = dbPath === ':memory:';

  if (!isMemory) {
    mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  }

  const sqlite = new Database(dbPath);
  if (!isMemory) {
    sqlite.pragma('journal_mode = WAL');
  }

  const db = drizzle(sqlite, { schema });

  // Migrations run inside one transaction, where PRAGMA foreign_keys is a
  // no-op — so table-recreate migrations (SQLite's only way to drop/alter
  // columns) need enforcement off for the whole run. foreign_key_check
  // catches any violation a migration would have slipped through. Note that
  // drizzle commits before returning, so a violation is detected only after
  // the migration is journaled: the throw below stops the app from serving
  // corrupt data, but recovery means restoring the pre-migration backup.
  sqlite.pragma('foreign_keys = OFF');
  const migrationsFolder = resolve(process.cwd(), './drizzle');
  migrate(db, { migrationsFolder });
  const violations = sqlite.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0) {
    throw new Error(`migrations left foreign key violations: ${JSON.stringify(violations.slice(0, 5))}`);
  }
  sqlite.pragma('foreign_keys = ON');

  return { db, sqlite };
}

export * from './schema.js';
