// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { createApp } from '../../src/server/app.js';
import { createSession, getOrCreateUser } from '../../src/server/auth.js';
import type { Config } from '../../src/server/config.js';
import {
  documentCollaborators,
  documentInvitations,
  documents,
  openDb,
  teamMembers,
  teams,
  users,
  type DB,
  type User,
} from '../../src/server/db/index.js';
import { resolveDocumentAccess } from '../../src/server/services/access.js';
import { createDocumentInvitations, recordInvitationDelivery, resendDocumentInvitation } from '../../src/server/services/collaboration.js';
import { baseTestConfig } from './teamTestUtils.js';

describe('private document collaboration', () => {
  let tmpDir: string;
  let emailFile: string;
  let codeFile: string;
  let db: DB;
  let sqlite: import('better-sqlite3').Database;
  let config: Config;
  let app: ReturnType<typeof createApp>;
  let owner: User;
  let ownerSession: string;
  let csrf: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ac-collaboration-'));
    emailFile = join(tmpDir, 'emails.log');
    codeFile = join(tmpDir, 'codes.log');
    writeFileSync(emailFile, '');
    writeFileSync(codeFile, '');
    const opened = openDb(':memory:');
    db = opened.db;
    sqlite = opened.sqlite;
    config = baseTestConfig({ devEmailFile: emailFile, devLoginCodeFile: codeFile, devLoginCode: '654321', selfSignup: false });
    app = createApp({ db, config });

    const now = new Date();
    owner = getOrCreateUser(db, 'owner@company.test', now);
    db.insert(teams).values({ id: 'team-private', name: 'Private Team', createdAt: now }).run();
    db.insert(teamMembers).values({ teamId: 'team-private', userId: owner.id, role: 'admin', createdAt: now }).run();
    db.insert(documents)
      .values({
        id: 'private-artifact',
        title: 'Private Artifact',
        teamId: 'team-private',
        createdBy: owner.id,
        visibility: 'private',
        createdAt: now,
      })
      .run();
    ownerSession = createSession(db, owner.id, now).token;
    const csrfResponse = await app.request('/healthz');
    csrf = cookieValue(csrfResponse, 'csrf')!;
  });

  afterAll(() => {
    sqlite.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function cookieValue(response: Response, name: string): string | undefined {
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(';')[0]!;
      if (pair.startsWith(`${name}=`)) return pair.slice(name.length + 1);
    }
    return undefined;
  }

  function headers(session = ownerSession) {
    return {
      'content-type': 'application/json',
      cookie: `session=${session}; csrf=${csrf}`,
      'x-csrf-token': csrf,
    };
  }

  function recordedEmails(): Array<{ to: string; subject: string; text: string }> {
    return readFileSync(emailFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { to: string; subject: string; text: string });
  }

  function lastCode(email: string): string | undefined {
    return readFileSync(codeFile, 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.startsWith(`${email} `))
      .pop()
      ?.split(' ')[1];
  }

  function invitationToken(email: string): string {
    const message = recordedEmails().filter((entry) => entry.to === email && entry.text.includes('/invitations/')).pop();
    const match = message?.text.match(/\/invitations\/([0-9a-f]{64})/);
    if (!match) throw new Error(`no invitation token for ${email}`);
    return match[1]!;
  }

  test('normalizes, delivers, admits signup, and requires an explicit acceptance POST', async () => {
    const create = await app.request('/api/docs/private-artifact/invitations', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ invitations: [{ email: '@Guest@External.Test', role: 'viewer' }] }),
    });
    expect(create.status).toBe(200);
    const created = (await create.json()) as any;
    expect(created.results).toEqual([
      expect.objectContaining({ email: 'guest@external.test', ok: true, status: 'pending', deliveryStatus: 'sent' }),
    ]);
    expect(JSON.stringify(created)).not.toContain(invitationToken('guest@external.test'));

    const token = invitationToken('guest@external.test');
    const signin = await app.request(`/signin?next=${encodeURIComponent(`/invitations/${token}`)}`);
    expect(signin.headers.get('referrer-policy')).toBe('no-referrer');
    expect(signin.headers.get('cache-control')).toBe('private, no-store');
    const landing = await app.request(`/invitations/${token}`);
    expect(landing.status).toBe(200);
    expect(landing.headers.get('cache-control')).toBe('no-store');
    expect(landing.headers.get('referrer-policy')).toBe('no-referrer');
    expect(db.select().from(documentCollaborators).all()).toHaveLength(0);

    const requestCode = await app.request('/auth/request-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'GUEST@EXTERNAL.TEST' }),
    });
    expect(requestCode.status).toBe(200);

    const verify = await app.request('/auth/verify-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'guest@external.test', code: '654321', next: `/invitations/${token}` }),
    });
    expect(verify.status).toBe(200);
    const guestSession = cookieValue(verify, 'session')!;

    const guest = db.select().from(documentInvitations).where(eq(documentInvitations.email, 'guest@external.test')).get();
    expect(guest?.status).toBe('pending');
    const guestUser = getOrCreateUser(db, 'guest@external.test', new Date());
    expect(db.select().from(teamMembers).where(eq(teamMembers.userId, guestUser.id)).all()).toHaveLength(0);

    const accept = await app.request(`/invitations/${token}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `session=${guestSession}; csrf=${csrf}`,
      },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    expect(accept.status).toBe(303);
    expect(accept.headers.get('location')).toBe('/d/private-artifact');
    expect(resolveDocumentAccess(db, 'private-artifact', guestUser.id)?.effectiveRole).toBe('viewer');

    const repeat = await app.request(`/invitations/${token}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `session=${guestSession}; csrf=${csrf}`,
      },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    expect(repeat.status).toBe(303);
  });

  test('owner lists and changes roles; a Viewer request emails the owner once per cooldown', async () => {
    const guest = db.select().from(documentCollaborators).where(eq(documentCollaborators.documentId, 'private-artifact')).get()!;
    const guestSession = createSession(db, guest.userId, new Date()).token;

    const request = await app.request('/api/docs/private-artifact/request-edit', {
      method: 'POST',
      headers: headers(guestSession),
      body: '{}',
    });
    expect(request.status).toBe(200);
    expect(recordedEmails().some((message) => message.to === owner.email && message.text.includes('?share=1'))).toBe(true);
    const repeated = await app.request('/api/docs/private-artifact/request-edit', {
      method: 'POST',
      headers: headers(guestSession),
      body: '{}',
    });
    expect(repeated.status).toBe(429);

    const forbiddenList = await app.request('/api/docs/private-artifact/collaborators', { headers: headers(guestSession) });
    expect(forbiddenList.status).toBe(403);

    const patch = await app.request(`/api/docs/private-artifact/collaborators/${guest.userId}`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({ role: 'editor' }),
    });
    expect(patch.status).toBe(200);
    expect(resolveDocumentAccess(db, 'private-artifact', guest.userId)?.effectiveRole).toBe('editor');

    const list = await app.request('/api/docs/private-artifact/collaborators', { headers: headers() });
    const state = (await list.json()) as any;
    expect(state.invitations).toEqual([expect.objectContaining({ email: 'guest@external.test', status: 'accepted', role: 'editor' })]);
    expect(state.collaborators).toEqual([expect.objectContaining({ email: 'guest@external.test', role: 'editor' })]);
  });

  test('resend rotates the token and revocation prevents private access', async () => {
    await app.request('/api/docs/private-artifact/invitations', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ invitations: [{ email: 'second@external.test', role: 'viewer' }] }),
    });
    const oldToken = invitationToken('second@external.test');
    const invitation = db.select().from(documentInvitations).where(eq(documentInvitations.email, 'second@external.test')).get()!;
    const oldTokenHash = invitation.tokenHash;
    db.update(documentInvitations)
      .set({ lastDeliveryAt: new Date(Date.now() - 61_000) })
      .where(eq(documentInvitations.id, invitation.id))
      .run();

    const resend = await app.request(`/api/docs/private-artifact/invitations/${invitation.id}/resend`, {
      method: 'POST',
      headers: headers(),
      body: '{}',
    });
    expect(resend.status).toBe(200);
    const newToken = invitationToken('second@external.test');
    expect(newToken).not.toBe(oldToken);
    recordInvitationDelivery(db, invitation.id, oldTokenHash, false);
    expect(db.select().from(documentInvitations).where(eq(documentInvitations.id, invitation.id)).get()?.deliveryStatus).toBe('sent');
    expect((await app.request(`/invitations/${oldToken}`)).status).toBe(404);
    expect((await app.request(`/invitations/${newToken}`)).status).toBe(200);

    const guest = db
      .select()
      .from(documentCollaborators)
      .where(and(eq(documentCollaborators.documentId, 'private-artifact'), eq(documentCollaborators.role, 'editor')))
      .get()!;
    const revoke = await app.request(`/api/docs/private-artifact/collaborators/${guest.userId}`, {
      method: 'DELETE',
      headers: headers(),
    });
    expect(revoke.status).toBe(200);
    expect(resolveDocumentAccess(db, 'private-artifact', guest.userId)).toBeUndefined();
    const accepted = db
      .select()
      .from(documentInvitations)
      .where(eq(documentInvitations.acceptedBy, guest.userId))
      .get();
    expect(accepted?.status).toBe('revoked');
  });

  test('a different signed-in account cannot inspect or accept the invitation', async () => {
    const other = getOrCreateUser(db, 'other@elsewhere.test', new Date());
    const otherSession = createSession(db, other.id, new Date()).token;
    const token = invitationToken('second@external.test');
    const get = await app.request(`/invitations/${token}`, { headers: { cookie: `session=${otherSession}` } });
    expect(get.status).toBe(403);
    expect(await get.text()).not.toContain('Private Artifact');
    const post = await app.request(`/invitations/${token}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `session=${otherSession}; csrf=${csrf}`,
      },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    expect(post.status).toBe(403);
  });

  test('cancellation after code issuance prevents a new account from being created', async () => {
    const email = 'cancelled@external.test';
    await app.request('/api/docs/private-artifact/invitations', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ invitations: [{ email, role: 'viewer' }] }),
    });
    const invitation = db.select().from(documentInvitations).where(eq(documentInvitations.email, email)).get()!;
    const requestCode = await app.request('/auth/request-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    expect(requestCode.status).toBe(200);
    const code = lastCode(email);
    expect(code).toMatch(/^\d{6}$/);

    const cancel = await app.request(`/api/docs/private-artifact/invitations/${invitation.id}`, {
      method: 'DELETE',
      headers: headers(),
    });
    expect(cancel.status).toBe(200);
    const verify = await app.request('/auth/verify-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code }),
    });
    expect(verify.status).toBe(400);
    expect(db.select().from(users).where(eq(users.email, email)).get()).toBeUndefined();
  });

  test('expiry and owner suspension invalidate admission and acceptance', async () => {
    const expiredEmail = 'expired@external.test';
    await app.request('/api/docs/private-artifact/invitations', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ invitations: [{ email: expiredEmail, role: 'viewer' }] }),
    });
    const expiredToken = invitationToken(expiredEmail);
    db.update(documentInvitations)
      .set({ expiresAt: new Date(Date.now() - 1000), status: 'pending' })
      .where(eq(documentInvitations.email, expiredEmail))
      .run();
    const codeCountBefore = readFileSync(codeFile, 'utf8').split('\n').length;
    expect(
      (
        await app.request('/auth/request-code', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: expiredEmail }),
        })
      ).status,
    ).toBe(200);
    expect(readFileSync(codeFile, 'utf8').split('\n')).toHaveLength(codeCountBefore);
    expect((await app.request(`/invitations/${expiredToken}`)).status).toBe(404);

    const suspendedEmail = 'suspended@external.test';
    await app.request('/api/docs/private-artifact/invitations', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ invitations: [{ email: suspendedEmail, role: 'editor' }] }),
    });
    const suspendedToken = invitationToken(suspendedEmail);
    db.delete(teamMembers)
      .where(and(eq(teamMembers.teamId, 'team-private'), eq(teamMembers.userId, owner.id)))
      .run();
    expect((await app.request(`/invitations/${suspendedToken}`)).status).toBe(404);
    const suspendedUser = getOrCreateUser(db, suspendedEmail, new Date());
    const suspendedSession = createSession(db, suspendedUser.id, new Date()).token;
    const accept = await app.request(`/invitations/${suspendedToken}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `session=${suspendedSession}; csrf=${csrf}`,
      },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    expect(accept.status).toBe(409);
    expect(resolveDocumentAccess(db, 'private-artifact', suspendedUser.id)).toBeUndefined();
    db.insert(teamMembers)
      .values({ teamId: 'team-private', userId: owner.id, role: 'admin', createdAt: new Date() })
      .run();
  });

  test('acceptance uses the latest pending role and rejects a missing CSRF token', async () => {
    const email = 'role-change@external.test';
    await app.request('/api/docs/private-artifact/invitations', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ invitations: [{ email, role: 'viewer' }] }),
    });
    const invitation = db.select().from(documentInvitations).where(eq(documentInvitations.email, email)).get()!;
    const token = invitationToken(email);
    const changed = await app.request(`/api/docs/private-artifact/invitations/${invitation.id}`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({ role: 'editor' }),
    });
    expect(changed.status).toBe(200);

    const verify = await app.request('/auth/verify-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code: '654321', next: `/invitations/${token}` }),
    });
    const session = cookieValue(verify, 'session')!;
    const noCsrf = await app.request(`/invitations/${token}`, {
      method: 'POST',
      headers: { cookie: `session=${session}` },
    });
    expect(noCsrf.status).toBe(403);
    const accepted = await app.request(`/invitations/${token}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `session=${session}; csrf=${csrf}`,
      },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    expect(accepted.status).toBe(303);
    const user = db.select().from(users).where(eq(users.email, email)).get()!;
    expect(resolveDocumentAccess(db, 'private-artifact', user.id)?.effectiveRole).toBe('editor');
  });

  test('create reports invalid, duplicate, and self addresses without duplicating successful invitations', async () => {
    const email = 'one-good@external.test';
    const result = await app.request('/api/docs/private-artifact/invitations', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        invitations: [
          { email: 'broken-address', role: 'viewer' },
          { email, role: 'viewer' },
          { email: '@ONE-GOOD@EXTERNAL.TEST', role: 'editor' },
          { email: owner.email, role: 'viewer' },
        ],
      }),
    });
    const body = (await result.json()) as any;
    expect(body.results).toEqual([
      { email: 'broken-address', ok: false, error: 'invalid_email' },
      expect.objectContaining({ email, ok: true }),
      { email, ok: false, error: 'duplicate' },
      { email: owner.email, ok: false, error: 'self' },
    ]);
    const messagesBefore = recordedEmails().filter((message) => message.to === email).length;
    const repeated = await app.request('/api/docs/private-artifact/invitations', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ invitations: [{ email, role: 'viewer' }] }),
    });
    expect(((await repeated.json()) as any).results).toEqual([{ email, ok: false, error: 'already_invited' }]);
    expect(recordedEmails().filter((message) => message.to === email)).toHaveLength(messagesBefore);
  });

  test('failed delivery remains retryable through resend', async () => {
    const email = 'retry-delivery@external.test';
    const devEmailFile = config.devEmailFile;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let failed: Response;
    try {
      config.devEmailFile = undefined;
      failed = await app.request('/api/docs/private-artifact/invitations', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ invitations: [{ email, role: 'viewer' }] }),
      });
    } finally {
      config.devEmailFile = devEmailFile;
      consoleError.mockRestore();
    }
    expect((await failed.json()) as any).toEqual(
      expect.objectContaining({ results: [expect.objectContaining({ email, deliveryStatus: 'failed' })] }),
    );
    const invitation = db.select().from(documentInvitations).where(eq(documentInvitations.email, email)).get()!;
    db.update(documentInvitations)
      .set({ lastDeliveryAt: new Date(Date.now() - 61_000) })
      .where(eq(documentInvitations.id, invitation.id))
      .run();
    const resend = await app.request(`/api/docs/private-artifact/invitations/${invitation.id}/resend`, {
      method: 'POST',
      headers: headers(),
      body: '{}',
    });
    expect(resend.status).toBe(200);
    expect((await resend.json()) as any).toEqual(
      expect.objectContaining({ invitation: expect.objectContaining({ deliveryStatus: 'sent' }) }),
    );
  });

  test('concurrent resends rotate once while the first delivery is in flight', async () => {
    const email = 'concurrent-resend@external.test';
    await app.request('/api/docs/private-artifact/invitations', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ invitations: [{ email, role: 'viewer' }] }),
    });
    const invitation = db.select().from(documentInvitations).where(eq(documentInvitations.email, email)).get()!;
    db.update(documentInvitations)
      .set({ lastDeliveryAt: new Date(Date.now() - 61_000) })
      .where(eq(documentInvitations.id, invitation.id))
      .run();
    const deliveriesBefore = recordedEmails().filter((message) => message.to === email).length;

    const resendRequest = () =>
      app.request(`/api/docs/private-artifact/invitations/${invitation.id}/resend`, {
        method: 'POST',
        headers: headers(),
        body: '{}',
      });
    const responses = await Promise.all([resendRequest(), resendRequest()]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 429]);
    expect(recordedEmails().filter((message) => message.to === email)).toHaveLength(deliveriesBefore + 1);
  });

  test('the initial delivery claims its cooldown before email I/O starts', () => {
    const now = new Date();
    const [created] = createDocumentInvitations(db, 'private-artifact', owner, [{ email: 'initial-flight@external.test', role: 'viewer' }], now);
    expect(created?.ok).toBe(true);
    if (!created?.ok) throw new Error('expected an invitation');
    const resend = resendDocumentInvitation(db, 'private-artifact', created.invitation.id, owner.id, new Date(now.getTime() + 1));
    expect(resend).toEqual({ ok: false, error: 'cooldown' });
    expect(db.select().from(documentInvitations).where(eq(documentInvitations.id, created.invitation.id)).get()?.tokenHash).toBe(created.invitation.tokenHash);
  });

  test('request-edit follows effective publishing rights on Public artifacts', async () => {
    const now = new Date();
    db.insert(documents)
      .values({ id: 'public-request', title: 'Public Request', teamId: 'team-private', createdBy: owner.id, visibility: 'public', createdAt: now })
      .run();
    const external = getOrCreateUser(db, 'public-viewer@external.test', now);
    const teammate = getOrCreateUser(db, 'public-teammate@external.test', now);
    const guest = getOrCreateUser(db, 'public-guest@external.test', now);
    db.insert(teamMembers).values({ teamId: 'team-private', userId: teammate.id, role: 'member', createdAt: now }).run();
    db.insert(documentCollaborators)
      .values([
        {
          documentId: 'public-request',
          userId: external.id,
          role: 'viewer',
          grantedBy: owner.id,
          createdAt: now,
          updatedAt: now,
        },
        {
          documentId: 'public-request',
          userId: teammate.id,
          role: 'viewer',
          grantedBy: owner.id,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();

    const externalAccess = resolveDocumentAccess(db, 'public-request', external.id)!;
    expect(externalAccess).toEqual(expect.objectContaining({ canComment: true, canPublish: false, canRequestEdit: true }));
    const externalSession = createSession(db, external.id, now).token;
    const requested = await app.request('/api/docs/public-request/request-edit', {
      method: 'POST',
      headers: headers(externalSession),
      body: '{}',
    });
    expect(requested.status).toBe(200);

    const teammateAccess = resolveDocumentAccess(db, 'public-request', teammate.id)!;
    expect(teammateAccess).toEqual(expect.objectContaining({ canPublish: true, canRequestEdit: false }));
    const teammateSession = createSession(db, teammate.id, now).token;
    expect(
      (
        await app.request('/api/docs/public-request/request-edit', {
          method: 'POST',
          headers: headers(teammateSession),
          body: '{}',
        })
      ).status,
    ).toBe(403);

    const guestAccess = resolveDocumentAccess(db, 'public-request', guest.id)!;
    expect(guestAccess).toEqual(expect.objectContaining({ canComment: true, canPublish: false, canRequestEdit: false }));
    const guestSession = createSession(db, guest.id, now).token;
    expect(
      (
        await app.request('/api/docs/public-request/request-edit', {
          method: 'POST',
          headers: headers(guestSession),
          body: '{}',
        })
      ).status,
    ).toBe(403);
  });

  test('service boundaries reject invalid roles and normalized invalid email addresses', () => {
    const results = createDocumentInvitations(
      db,
      'private-artifact',
      owner,
      [
        { email: 'not-an-email', role: 'viewer' },
        { email: 'valid@external.test', role: 'admin' },
      ],
      new Date(),
    );
    expect(results).toEqual([
      { email: 'not-an-email', ok: false, error: 'invalid_email' },
      { email: 'valid@external.test', ok: false, error: 'invalid_role' },
    ]);
  });
});
