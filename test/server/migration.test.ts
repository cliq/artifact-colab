/**
 * Exercises the teams migration (0003) against a database seeded in the
 * pre-migration shape: domains on users/documents, tokens without a team.
 * Builds the old schema by replaying the earlier migration files verbatim,
 * marks them applied, seeds, then lets `openDb` run 0003 for real.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { openDb } from '../../src/server/db/index.js';

// `when` of the last pre-teams entry in drizzle/meta/_journal.json — marking
// the seed rows applied up to here makes the migrator run only 0003+.
const PRE_TEAMS_JOURNAL_MS = 1786138011101;

describe('teams migration (0003)', () => {
  let tmpDir: string;
  let sqlite: import('better-sqlite3').Database;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ac-migration-'));
    const dbPath = join(tmpDir, 'app.db');

    const seedDb = new Database(dbPath);
    for (const tag of ['0000_lame_scarecrow', '0001_deep_madripoor', '0002_watches']) {
      const sql = readFileSync(join(process.cwd(), 'drizzle', `${tag}.sql`), 'utf8');
      for (const stmt of sql.split('--> statement-breakpoint')) seedDb.exec(stmt);
    }
    seedDb.exec('CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)');
    seedDb.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run('pre-teams-seed', PRE_TEAMS_JOURNAL_MS);

    const now = Date.now();
    seedDb
      .prepare("INSERT INTO users (id, email, domain, created_at) VALUES ('u1','a@cliq.dev','cliq.dev',?),('u2','b@cliq.dev','cliq.dev',?),('u3','c@gmail.com','gmail.com',?)")
      .run(now, now, now);
    // d2 lives on a domain that has documents but no users — the team must still be created.
    seedDb
      .prepare("INSERT INTO documents (id, title, domain, created_by, current_version_id, created_at) VALUES ('d1','Doc1','cliq.dev','u1',NULL,?),('d2','Doc2','ghost.org','u1',NULL,?)")
      .run(now, now);
    seedDb
      .prepare("INSERT INTO tokens (id, user_id, token_hash, label, created_at) VALUES ('t1','u1','h1','one',?),('t2','u3','h2','two',?)")
      .run(now, now);
    seedDb.close();

    sqlite = openDb(dbPath).sqlite;
  });

  afterAll(() => {
    sqlite.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('creates one team per distinct domain across users and documents', () => {
    const teams = sqlite.prepare('SELECT name FROM teams ORDER BY name').all() as { name: string }[];
    expect(teams.map((t) => t.name)).toEqual(['cliq.dev', 'ghost.org', 'gmail.com']);

    const ids = sqlite.prepare('SELECT id FROM teams').all() as { id: string }[];
    for (const { id } of ids) expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  test('each domain becomes an auto-join rule for its team', () => {
    const rows = sqlite
      .prepare('SELECT td.domain, t.name FROM team_domains td JOIN teams t ON t.id = td.team_id ORDER BY td.domain')
      .all() as { domain: string; name: string }[];
    expect(rows).toEqual([
      { domain: 'cliq.dev', name: 'cliq.dev' },
      { domain: 'ghost.org', name: 'ghost.org' },
      { domain: 'gmail.com', name: 'gmail.com' },
    ]);
  });

  test('every user becomes a plain member of their domain team; nobody is auto-promoted', () => {
    const rows = sqlite
      .prepare('SELECT tm.user_id, t.name, tm.role FROM team_members tm JOIN teams t ON t.id = tm.team_id ORDER BY tm.user_id')
      .all() as { user_id: string; name: string; role: string }[];
    expect(rows).toEqual([
      { user_id: 'u1', name: 'cliq.dev', role: 'member' },
      { user_id: 'u2', name: 'cliq.dev', role: 'member' },
      { user_id: 'u3', name: 'gmail.com', role: 'member' },
    ]);
  });

  test('documents and tokens are backfilled onto their teams; old columns are gone', () => {
    const docs = sqlite
      .prepare('SELECT d.id, t.name FROM documents d JOIN teams t ON t.id = d.team_id ORDER BY d.id')
      .all() as { id: string; name: string }[];
    expect(docs).toEqual([
      { id: 'd1', name: 'cliq.dev' },
      { id: 'd2', name: 'ghost.org' },
    ]);

    const toks = sqlite
      .prepare('SELECT tk.id, t.name FROM tokens tk JOIN teams t ON t.id = tk.team_id ORDER BY tk.id')
      .all() as { id: string; name: string }[];
    expect(toks).toEqual([
      { id: 't1', name: 'cliq.dev' },
      { id: 't2', name: 'gmail.com' },
    ]);

    // openDb applies every migration, so 0004's profile `name` column is here too.
    const userCols = (sqlite.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name);
    expect(userCols).toEqual(['id', 'email', 'is_instance_admin', 'created_at', 'name']);
    const docCols = (sqlite.prepare('PRAGMA table_info(documents)').all() as { name: string }[]).map((c) => c.name);
    expect(docCols).not.toContain('domain');
  });

  test('nobody is an instance admin after the migration and no FK violations remain', () => {
    const admins = sqlite.prepare('SELECT COUNT(*) AS n FROM users WHERE is_instance_admin = 1').get() as { n: number };
    expect(admins.n).toBe(0);
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
  });
});
