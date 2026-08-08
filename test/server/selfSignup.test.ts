// @vitest-environment node
//
// Same rationale as `test/server/auth.test.ts`: happy-dom strips `Set-Cookie`
// from every `Response`, which breaks cookie-based session/CSRF assertions.

/**
 * Self sign-up: the SELF_SIGNUP gate in `canRequestCode`, the wizard's
 * domain-claim eligibility rules, and the `POST /teams` wizard route
 * (invisibility, validation, both happy paths, and the domain-claim race
 * rolling the whole team creation back).
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createApp } from '../../src/server/app.js';
import { createSession, getOrCreateUser } from '../../src/server/auth.js';
import type { AppEnv } from '../../src/server/context.js';
import { openDb, teamDomains, teamMembers, teams, type DB } from '../../src/server/db/index.js';
import { canRequestCode, claimableDomain, createSelfServeTeam, getUserTeams, inviteMember } from '../../src/server/services/teams.js';
import { baseTestConfig, seedTeamWithDomain } from './teamTestUtils.js';

const NOW = new Date('2026-08-08T12:00:00Z');

describe('sign-in gate with SELF_SIGNUP', () => {
  test('matrix: flag on/off × stranger, existing user, invited email, domain match, instance admin', () => {
    const db = openDb(':memory:').db;
    seedTeamWithDomain(db, 'team-1', 'cliq.dev');
    const admin = getOrCreateUser(db, 'boss@cliq.dev', NOW);
    inviteMember(db, 'team-1', 'guest@gmail.com', 'member', admin, NOW);
    getOrCreateUser(db, 'old@legacy.com', NOW);

    const off = baseTestConfig({ instanceAdminEmails: ['root@admin.io'] });
    const on = baseTestConfig({ instanceAdminEmails: ['root@admin.io'], selfSignup: true });

    const cases: Array<[string, boolean]> = [
      ['nobody@nowhere.net', false], // stranger: the only row the flag changes
      ['old@legacy.com', true], // existing user
      ['guest@gmail.com', true], // invited email
      ['new@cliq.dev', true], // domain match
      ['root@admin.io', true], // instance admin
    ];
    for (const [email, allowedWhenOff] of cases) {
      expect(canRequestCode(db, off, email), `flag off: ${email}`).toBe(allowedWhenOff);
      expect(canRequestCode(db, on, email), `flag on: ${email}`).toBe(true);
    }
  });
});

describe('wizard domain eligibility (claimableDomain)', () => {
  test('free-email providers are never claimable', () => {
    const db = openDb(':memory:').db;
    expect(claimableDomain(db, 'person@gmail.com')).toBeNull();
    expect(claimableDomain(db, 'person@proton.me')).toBeNull();
  });

  test('a domain already attached to a team is not claimable', () => {
    const db = openDb(':memory:').db;
    seedTeamWithDomain(db, 'team-1', 'acme.com');
    expect(claimableDomain(db, 'person@acme.com')).toBeNull();
  });

  test('an unclaimed company domain is claimable, derived from the email', () => {
    const db = openDb(':memory:').db;
    expect(claimableDomain(db, 'Person@Acme.COM')).toBe('acme.com');
  });
});

describe('createSelfServeTeam', () => {
  test('a lost domain race rolls back the team and membership', () => {
    const db = openDb(':memory:').db;
    seedTeamWithDomain(db, 'squatter', 'acme.com');
    const user = getOrCreateUser(db, 'person@acme.com', NOW);
    // getOrCreateUser auto-joined them via the squatter's domain rule; strip
    // that so the scenario is "domain claimed between render and submit".
    db.delete(teamMembers).where(eq(teamMembers.userId, user.id)).run();

    const outcome = createSelfServeTeam(db, 'Acme', user, true, NOW);
    expect(outcome).toEqual({ ok: false, error: 'domain_taken' });
    expect(db.select().from(teams).all().map((t) => t.name)).not.toContain('Acme');
    expect(getUserTeams(db, user.id)).toHaveLength(0);
  });

  test('the zero-team rule is re-checked inside the transaction', () => {
    // The route's own zero-team check sits across an await, so a concurrent
    // submission can slip past it; the transaction must be the arbiter.
    const db = openDb(':memory:').db;
    seedTeamWithDomain(db, 'team-1', 'acme.com');
    const user = getOrCreateUser(db, 'person@acme.com', NOW); // auto-joined team-1

    const outcome = createSelfServeTeam(db, 'Second', user, false, NOW);
    expect(outcome).toEqual({ ok: false, error: 'already_in_team' });
    expect(db.select().from(teams).all().map((t) => t.name)).not.toContain('Second');
  });
});

describe('POST /teams (wizard route)', () => {
  let db: DB;
  let sqlite: import('better-sqlite3').Database;
  let config: ReturnType<typeof baseTestConfig>;
  let app: Hono<AppEnv>;

  beforeAll(() => {
    const opened = openDb(':memory:');
    db = opened.db;
    sqlite = opened.sqlite;
    config = baseTestConfig({ selfSignup: true });

    // The full app, not just pageRoutes: the admin router is mounted before
    // the pages and its /teams middleware must not swallow POST /teams.
    app = createApp({ db, config });
  });

  afterAll(() => {
    sqlite.close();
  });

  function setCookieValue(res: Response, name: string): string | undefined {
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [key, value] = pair.split('=');
      if (key === name) return value;
    }
    return undefined;
  }

  async function getCsrfCookie(): Promise<string> {
    const res = await app.request('/signin');
    const csrf = setCookieValue(res, 'csrf');
    if (!csrf) throw new Error('expected csrfProtect to issue a csrf cookie on GET /signin');
    return csrf;
  }

  function signedInSession(email: string): { userId: string; sessionCookie: string } {
    const user = getOrCreateUser(db, email, NOW);
    const { token } = createSession(db, user.id, NOW);
    return { userId: user.id, sessionCookie: token };
  }

  async function postTeams(
    fields: Record<string, string>,
    sessionCookie?: string,
  ): Promise<Response> {
    const csrf = await getCsrfCookie();
    const body = new URLSearchParams({ ...fields, _csrf: csrf });
    const cookies = [`csrf=${csrf}`, ...(sessionCookie ? [`session=${sessionCookie}`] : [])].join('; ');
    return app.request('/teams', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookies },
      body: body.toString(),
    });
  }

  test('anonymous request gets a 404', async () => {
    const res = await postTeams({ name: 'Ghost Team' });
    expect(res.status).toBe(404);
  });

  test('a user who already has a team gets a 404', async () => {
    seedTeamWithDomain(db, 'team-existing', 'joined.com');
    const { sessionCookie } = signedInSession('member@joined.com');
    const res = await postTeams({ name: 'Second Team' }, sessionCookie);
    expect(res.status).toBe(404);
  });

  test('with the flag off the route does not exist', async () => {
    const { sessionCookie } = signedInSession('flagless@solo-a.com');
    config.selfSignup = false;
    try {
      const res = await postTeams({ name: 'No Flag' }, sessionCookie);
      expect(res.status).toBe(404);
    } finally {
      config.selfSignup = true;
    }
  });

  test('a missing name re-renders the wizard with an inline error', async () => {
    const { sessionCookie } = signedInSession('nameless@solo-b.com');
    const res = await postTeams({ name: '   ' }, sessionCookie);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Team name is required.');
  });

  test('happy path: invite-only team, creator becomes team admin, no domain row', async () => {
    const { userId, sessionCookie } = signedInSession('founder@solo-c.com');
    const res = await postTeams({ name: 'Solo C', claimDomain: 'false' }, sessionCookie);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');

    const memberships = getUserTeams(db, userId);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.team.name).toBe('Solo C');
    expect(memberships[0]!.role).toBe('admin');
    expect(db.select().from(teamDomains).where(eq(teamDomains.domain, 'solo-c.com')).get()).toBeUndefined();
  });

  test('happy path: domain auto-join claims the creator email domain', async () => {
    const { userId, sessionCookie } = signedInSession('founder@solo-d.com');
    const res = await postTeams({ name: 'Solo D', claimDomain: 'true' }, sessionCookie);
    expect(res.status).toBe(302);

    const memberships = getUserTeams(db, userId);
    expect(memberships[0]!.role).toBe('admin');
    const rule = db.select().from(teamDomains).where(eq(teamDomains.domain, 'solo-d.com')).get();
    expect(rule?.teamId).toBe(memberships[0]!.team.id);

    // The claim now auto-joins colleagues at sign-in, wizard-free.
    const colleague = getOrCreateUser(db, 'colleague@solo-d.com', NOW);
    expect(getUserTeams(db, colleague.id).map((m) => m.team.id)).toContain(memberships[0]!.team.id);
  });

  test('JSON clients use a boolean claimDomain and get JSON errors', async () => {
    const { userId, sessionCookie } = signedInSession('founder@solo-json.com');
    const csrf = await getCsrfCookie();
    const post = (payload: unknown) =>
      app.request('/teams', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrf,
          cookie: `csrf=${csrf}; session=${sessionCookie}`,
        },
        body: JSON.stringify(payload),
      });

    const invalid = await post({ name: 'Solo JSON', claimDomain: 'yes please' });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'claimDomain must be a boolean.' });

    const res = await post({ name: 'Solo JSON', claimDomain: true });
    expect(res.status).toBe(302);
    const rule = db.select().from(teamDomains).where(eq(teamDomains.domain, 'solo-json.com')).get();
    expect(rule?.teamId).toBe(getUserTeams(db, userId)[0]!.team.id);
  });

  test('claiming a free-email domain is rejected server-side even if the form is forged', async () => {
    const { userId, sessionCookie } = signedInSession('someone@gmail.com');
    const res = await postTeams({ name: 'Gmail Inc', claimDomain: 'true' }, sessionCookie);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('be claimed for auto-join');
    expect(getUserTeams(db, userId)).toHaveLength(0);
  });

  test('losing the domain race shows the inline error and leaves no half-created team', async () => {
    const { userId, sessionCookie } = signedInSession('late@solo-e.com');
    // Another team claims the domain between the wizard render and the submit.
    seedTeamWithDomain(db, 'team-sniped', 'solo-e.com', 'Sniped');

    const res = await postTeams({ name: 'Solo E', claimDomain: 'true' }, sessionCookie);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('just claimed by another team');
    expect(getUserTeams(db, userId)).toHaveLength(0);
    expect(db.select().from(teams).all().map((t) => t.name)).not.toContain('Solo E');
  });
});
