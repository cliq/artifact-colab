// @vitest-environment node
//
// Cookie-based auth needs Node's native fetch (see test/server/auth.test.ts
// for why happy-dom can't observe Set-Cookie / cookie headers).

/**
 * Integration tests for the admin surfaces: the instance-admin area (/admin)
 * and team settings for team admins. Exercised through the full app so
 * sessionAuth + CSRF behave exactly as in production; asserts the 404
 * invisibility convention for unauthorized visitors.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createApp } from '../../src/server/app.js';
import { createSession, getOrCreateUser } from '../../src/server/auth.js';
import type { AppEnv } from '../../src/server/context.js';
import { openDb, teams, type DB } from '../../src/server/db/index.js';
import { getTeamRole, getUserTeams, setTeamRole } from '../../src/server/services/teams.js';
import { baseTestConfig, seedTeamWithDomain } from './teamTestUtils.js';

describe('admin surfaces', () => {
  let tmpDir: string;
  let emailFile: string;
  let db: DB;
  let sqlite: import('better-sqlite3').Database;
  let app: Hono<AppEnv>;

  let rootCookie: string;
  let teamAdminCookie: string;
  let memberCookie: string;
  let csrf: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ac-admin-'));
    emailFile = join(tmpDir, 'emails.log');
    writeFileSync(emailFile, '');

    const opened = openDb(':memory:');
    db = opened.db;
    sqlite = opened.sqlite;

    const config = baseTestConfig({ instanceAdminEmails: ['root@cliq.dev'], devEmailFile: emailFile });
    app = createApp({ db, config });

    seedTeamWithDomain(db, 'team-1', 'cliq.dev', 'Cliq');

    const now = new Date();
    const root = getOrCreateUser(db, 'root@cliq.dev', now);
    const teamAdmin = getOrCreateUser(db, 'lead@cliq.dev', now);
    const member = getOrCreateUser(db, 'dev@cliq.dev', now);
    setTeamRole(db, 'team-1', teamAdmin.id, 'admin');

    rootCookie = `session=${createSession(db, root.id, now).token}`;
    teamAdminCookie = `session=${createSession(db, teamAdmin.id, now).token}`;
    memberCookie = `session=${createSession(db, member.id, now).token}`;

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

  function post(path: string, cookie: string, fields: Record<string, string>) {
    return app.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `${cookie}; csrf=${csrf}`,
      },
      body: new URLSearchParams({ ...fields, _csrf: csrf }).toString(),
    });
  }

  describe('authorization is 404, not 403', () => {
    test('/admin is invisible to team admins and members', async () => {
      expect((await app.request('/admin', { headers: { cookie: memberCookie } })).status).toBe(404);
      expect((await app.request('/admin', { headers: { cookie: teamAdminCookie } })).status).toBe(404);
      expect((await app.request('/admin', { headers: { cookie: rootCookie } })).status).toBe(200);
    });

    test('team settings are invisible to plain members and to instance admins who are not team admins', async () => {
      expect((await app.request('/teams/team-1/settings', { headers: { cookie: memberCookie } })).status).toBe(404);
      // root is an instance admin but NOT a team admin of team-1 — no implicit pass-through
      expect((await app.request('/teams/team-1/settings', { headers: { cookie: rootCookie } })).status).toBe(404);
      expect((await app.request('/teams/team-1/settings', { headers: { cookie: teamAdminCookie } })).status).toBe(200);
    });

    test('unauthenticated visitors are redirected to sign in', async () => {
      const res = await app.request('/admin');
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('/signin');
    });
  });

  describe('instance admin flows', () => {
    let newTeamId: string;

    test('creates a team and lands on its page', async () => {
      const res = await post('/admin/teams', rootCookie, { name: 'Skunkworks' });
      expect(res.status).toBe(302);
      newTeamId = res.headers.get('location')!.split('/').pop()!;

      const created = db.select().from(teams).all().find((t) => t.name === 'Skunkworks');
      expect(created?.id).toBe(newTeamId);
    });

    test('attaches a domain; attaching it to another team is rejected', async () => {
      const ok = await post(`/admin/teams/${newTeamId}/domains`, rootCookie, { domain: 'Skunk.Works.io' });
      expect(ok.status).toBe(302);
      expect(ok.headers.get('location')).not.toContain('error');

      const dup = await post('/admin/teams/team-1/domains', rootCookie, { domain: 'skunk.works.io' });
      expect(dup.headers.get('location')).toContain('error');
    });

    test('adding a member by email: existing accounts join immediately, unknown emails get a pending invite + email', async () => {
      const existing = await post(`/admin/teams/${newTeamId}/members`, rootCookie, { email: 'dev@cliq.dev', role: 'member' });
      expect(existing.headers.get('location')).toContain('notice');
      const dev = getOrCreateUser(db, 'dev@cliq.dev', new Date());
      expect(getTeamRole(db, newTeamId, dev.id)).toBe('member');

      const invited = await post(`/admin/teams/${newTeamId}/members`, rootCookie, { email: 'guest@gmail.com', role: 'member' });
      expect(invited.headers.get('location')).toContain('notice');
      const emails = readFileSync(emailFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      expect(emails.some((e) => e.to === 'guest@gmail.com' && e.subject.includes('invited you to Skunkworks'))).toBe(true);
    });

    test('promote/demote instance admins, honoring the guardrails', async () => {
      const promote = await post('/admin/admins', rootCookie, { email: 'lead@cliq.dev' });
      expect(promote.headers.get('location')).toContain('notice');
      const adminPage = await app.request('/admin', { headers: { cookie: teamAdminCookie } });
      expect(adminPage.status).toBe(200); // promoted user now sees /admin

      const lead = getOrCreateUser(db, 'lead@cliq.dev', new Date());
      const demote = await post(`/admin/admins/${lead.id}/demote`, rootCookie, {});
      expect(demote.status).toBe(302);
      expect((await app.request('/admin', { headers: { cookie: teamAdminCookie } })).status).toBe(404);

      // env-listed root cannot be demoted
      const root = getOrCreateUser(db, 'root@cliq.dev', new Date());
      const locked = await post(`/admin/admins/${root.id}/demote`, rootCookie, {});
      expect(locked.headers.get('location')).toContain('error');

      const ghost = await post('/admin/admins', rootCookie, { email: 'nobody@nowhere.net' });
      expect(ghost.headers.get('location')).toContain('error');
    });

    test('deleting a team requires the confirmation page and then cascades', async () => {
      const confirm = await app.request(`/admin/teams/${newTeamId}/delete`, { headers: { cookie: rootCookie } });
      expect(confirm.status).toBe(200);
      expect(await confirm.text()).toContain('There is no undo');

      const res = await post(`/admin/teams/${newTeamId}/delete`, rootCookie, {});
      expect(res.status).toBe(302);
      expect(db.select().from(teams).all().some((t) => t.id === newTeamId)).toBe(false);
    });
  });

  describe('team admin flows', () => {
    test('invites a cross-domain guest, who joins on sign-in and sees the team', async () => {
      const res = await post('/teams/team-1/settings/members', teamAdminCookie, { email: 'guest2@gmail.com', role: 'member' });
      expect(res.headers.get('location')).toContain('notice');

      const guest = getOrCreateUser(db, 'guest2@gmail.com', new Date()); // = their first sign-in
      expect(getTeamRole(db, 'team-1', guest.id)).toBe('member');
    });

    test('promotes and demotes members; removing the last team admin is allowed', async () => {
      const dev = getOrCreateUser(db, 'dev@cliq.dev', new Date());
      await post(`/teams/team-1/settings/members/${dev.id}/role`, teamAdminCookie, { role: 'admin' });
      expect(getTeamRole(db, 'team-1', dev.id)).toBe('admin');
      await post(`/teams/team-1/settings/members/${dev.id}/role`, teamAdminCookie, { role: 'member' });
      expect(getTeamRole(db, 'team-1', dev.id)).toBe('member');

      // the only team admin demotes themselves — allowed; instance admins can re-appoint
      const lead = getOrCreateUser(db, 'lead@cliq.dev', new Date());
      const res = await post(`/teams/team-1/settings/members/${lead.id}/role`, teamAdminCookie, { role: 'member' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/');
      expect(getTeamRole(db, 'team-1', lead.id)).toBe('member');
      expect((await app.request('/teams/team-1/settings', { headers: { cookie: teamAdminCookie } })).status).toBe(404);

      setTeamRole(db, 'team-1', lead.id, 'admin'); // restore for later tests
    });

    test('removes a member', async () => {
      const guest = getOrCreateUser(db, 'guest2@gmail.com', new Date());
      const res = await post(`/teams/team-1/settings/members/${guest.id}/remove`, teamAdminCookie, {});
      expect(res.status).toBe(302);
      expect(getUserTeams(db, guest.id)).toHaveLength(0);
    });
  });
});
