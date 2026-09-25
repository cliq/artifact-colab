// @vitest-environment node
//
// Cookie-based auth needs Node's native fetch (see test/server/auth.test.ts
// for why happy-dom can't observe Set-Cookie / cookie headers).

/**
 * Admin backups: packing all data into a downloadable tar.gz, the status
 * endpoint the progress bar polls, range (resumable) downloads, and deletion.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createApp } from '../../src/server/app.js';
import { createSession, getOrCreateUser } from '../../src/server/auth.js';
import type { AppEnv } from '../../src/server/context.js';
import { openDb, type DB } from '../../src/server/db/index.js';
import { BackupManager, isPackageName } from '../../src/server/services/backups.js';
import { baseTestConfig, seedTeamWithDomain } from './teamTestUtils.js';

describe('admin backups', () => {
  let tmpDir: string;
  let backupDir: string;
  let db: DB;
  let sqlite: Database.Database;
  let backups: BackupManager;
  let app: Hono<AppEnv>;
  let rootCookie: string;
  let memberCookie: string;
  let csrf: string;
  let packageName: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ac-backups-'));
    backupDir = join(tmpDir, 'backups');
    const opened = openDb(join(tmpDir, 'app.db'));
    db = opened.db;
    sqlite = opened.sqlite;
    backups = new BackupManager(backupDir, sqlite);
    app = createApp({ db, config: baseTestConfig({ instanceAdminEmails: ['root@cliq.dev'], backupDir }), backups });

    seedTeamWithDomain(db, 'team-1', 'cliq.dev', 'Cliq');
    const now = new Date();
    rootCookie = `session=${createSession(db, getOrCreateUser(db, 'root@cliq.dev', now).id, now).token}`;
    memberCookie = `session=${createSession(db, getOrCreateUser(db, 'dev@cliq.dev', now).id, now).token}`;

    const res = await app.request('/healthz');
    csrf = res.headers
      .getSetCookie()
      .map((raw) => raw.split(';')[0]!.split('='))
      .find(([k]) => k === 'csrf')?.[1] as string;
  });

  afterAll(() => {
    sqlite.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function startBackup(cookie: string) {
    return app.request('/admin/backups', {
      method: 'POST',
      headers: { accept: 'application/json', 'x-csrf-token': csrf, cookie: `${cookie}; csrf=${csrf}` },
    });
  }

  function download(name: string, headers: Record<string, string> = {}) {
    return app.request(`/admin/backups/${name}/download`, { headers: { cookie: rootCookie, ...headers } });
  }

  test('backup endpoints are invisible to non-admins', async () => {
    expect((await startBackup(memberCookie)).status).toBe(404);
    expect((await app.request('/admin/backups/status', { headers: { cookie: memberCookie } })).status).toBe(404);
  });

  test('starts one backup at a time and reports progress while packing', async () => {
    const res = await startBackup(rootCookie);
    expect(res.status).toBe(202);
    const { job } = (await res.json()) as { job: { name: string; percent: number } };
    packageName = job.name;
    expect(isPackageName(packageName)).toBe(true);

    expect((await startBackup(rootCookie)).status).toBe(409);
    const status = (await (await app.request('/admin/backups/status', { headers: { cookie: rootCookie } })).json()) as {
      job: { name: string } | null;
    };
    expect(status.job?.name).toBe(packageName);

    await backups.settled();
    const after = (await (await app.request('/admin/backups/status', { headers: { cookie: rootCookie } })).json()) as {
      job: unknown;
      failure: unknown;
    };
    expect(after).toEqual({ job: null, failure: null });
    // No temp files survive a finished job.
    expect(readdirSync(backupDir)).toEqual([packageName]);
  });

  test('the package holds a manifest and a restorable copy of the database', async () => {
    const res = await download(packageName);
    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-disposition')).toContain(packageName);

    const archive = join(tmpDir, 'download.tar.gz');
    writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
    const out = join(tmpDir, 'extracted');
    execFileSync('mkdir', ['-p', out]);
    execFileSync('tar', ['-xzf', archive, '-C', out]);

    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    expect(manifest.format).toBe('artifact-colab-backup');
    const restored = new Database(join(out, 'app.db'), { readonly: true });
    const emails = restored.prepare('select email from users order by email').all().map((r) => (r as { email: string }).email);
    restored.close();
    expect(emails).toEqual(['dev@cliq.dev', 'root@cliq.dev']);
  });

  test('lists the package with its size on the admin page', async () => {
    const html = await (await app.request('/admin', { headers: { cookie: rootCookie } })).text();
    expect(html).toContain('id="backups"');
    expect(html).toContain(`/admin/backups/${packageName}/download`);
  });

  test('serves byte ranges so interrupted downloads can resume', async () => {
    const full = Buffer.from(await (await download(packageName)).arrayBuffer());
    const etag = (await download(packageName)).headers.get('etag')!;

    const tail = await download(packageName, { range: 'bytes=10-' });
    expect(tail.status).toBe(206);
    expect(tail.headers.get('content-range')).toBe(`bytes 10-${full.length - 1}/${full.length}`);
    expect(Buffer.from(await tail.arrayBuffer()).equals(full.subarray(10))).toBe(true);

    const suffix = await download(packageName, { range: 'bytes=-5', 'if-range': etag });
    expect(suffix.status).toBe(206);
    expect(Buffer.from(await suffix.arrayBuffer()).equals(full.subarray(full.length - 5))).toBe(true);

    // A resume against a package that changed gets the whole file instead.
    const stale = await download(packageName, { range: 'bytes=10-', 'if-range': '"stale"' });
    expect(stale.status).toBe(200);

    expect((await download(packageName, { range: `bytes=${full.length}-` })).status).toBe(416);
  });

  test('refuses names that are not packages', async () => {
    expect((await download('..%2Fapp.db')).status).toBe(404);
    expect((await download('app.db')).status).toBe(404);
  });

  test('deletes a package', async () => {
    const res = await app.request(`/admin/backups/${packageName}/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `${rootCookie}; csrf=${csrf}` },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    expect(res.status).toBe(302);
    expect(existsSync(join(backupDir, packageName))).toBe(false);
    expect((await download(packageName)).status).toBe(404);
  });

  test('sweeps temp files left by an interrupted backup', async () => {
    writeFileSync(join(backupDir, 'abc123.db.partial'), 'x');
    await backups.sweepLeftovers();
    expect(readdirSync(backupDir)).toEqual([]);
  });
});
