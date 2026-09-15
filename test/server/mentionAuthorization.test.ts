// @vitest-environment node

import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createSession, getOrCreateUser } from '../../src/server/auth.js';
import type { AppEnv } from '../../src/server/context.js';
import {
  comments,
  documentCollaborators,
  documentInvitations,
  documents,
  openDb,
  versions,
  watches,
  type DB,
  type User,
} from '../../src/server/db/index.js';
import { sessionAuth } from '../../src/server/middleware.js';
import { apiRoutes } from '../../src/server/routes/api.js';
import { mentionableUsers } from '../../src/server/services/access.js';
import { runDigestSweep, setWatching } from '../../src/server/services/watches.js';
import { baseTestConfig, seedTeamWithDomain } from './teamTestUtils.js';

const NOW = new Date('2026-09-15T10:00:00Z');
const ANCHOR = { v: 1 as const, exact: 'Artifact text.', prefix: '', suffix: '', start: 0, docLength: 14 };

describe('outsider mention authorization', () => {
  let db: DB;
  let sqlite: ReturnType<typeof openDb>['sqlite'];
  let app: Hono<AppEnv>;
  let owner: User;
  let teammate: User;
  let editor: User;
  let collaborator: User;
  let pending: User;
  let revoked: User;
  let publicGuest: User;
  let cookies: Map<string, string>;

  beforeEach(() => {
    ({ db, sqlite } = openDb(':memory:'));
    seedTeamWithDomain(db, 'home', 'company.test');
    owner = getOrCreateUser(db, 'owner@company.test', NOW);
    teammate = getOrCreateUser(db, 'teammate@company.test', NOW);
    editor = getOrCreateUser(db, 'editor@outside.test', NOW);
    collaborator = getOrCreateUser(db, 'collaborator@outside.test', NOW);
    pending = getOrCreateUser(db, 'pending@outside.test', NOW);
    revoked = getOrCreateUser(db, 'revoked@outside.test', NOW);
    publicGuest = getOrCreateUser(db, 'guest@elsewhere.test', NOW);
    cookies = new Map(
      [owner, teammate, editor, collaborator, pending, revoked, publicGuest].map((user) => [
        user.id,
        `session=${createSession(db, user.id, NOW).token}`,
      ]),
    );

    for (const [id, visibility] of [
      ['team-artifact', 'team'],
      ['public-artifact', 'public'],
      ['private-artifact', 'private'],
    ] as const) {
      db.insert(documents)
        .values({ id, title: id, teamId: 'home', createdBy: owner.id, visibility, currentVersionId: `${id}-v1`, createdAt: NOW })
        .run();
      db.insert(versions)
        .values({ id: `${id}-v1`, documentId: id, number: 1, html: '<p>Artifact text.</p>', publishedAt: NOW, publishedBy: owner.id })
        .run();
      db.insert(documentCollaborators)
        .values([
          { documentId: id, userId: editor.id, role: 'editor', grantedBy: owner.id, createdAt: NOW, updatedAt: NOW },
          { documentId: id, userId: collaborator.id, role: 'viewer', grantedBy: owner.id, createdAt: NOW, updatedAt: NOW },
        ])
        .run();
      db.insert(documentInvitations)
        .values([
          {
            id: `${id}-pending`, documentId: id, email: pending.email, role: 'editor', invitedBy: owner.id,
            tokenHash: `${id}-pending-hash`, createdAt: NOW, updatedAt: NOW,
            expiresAt: new Date(NOW.getTime() + 86_400_000), status: 'pending',
          },
          {
            id: `${id}-revoked`, documentId: id, email: revoked.email, role: 'editor', invitedBy: owner.id,
            tokenHash: `${id}-revoked-hash`, createdAt: NOW, updatedAt: NOW,
            expiresAt: new Date(NOW.getTime() + 86_400_000), status: 'revoked', acceptedBy: revoked.id, acceptedAt: NOW,
          },
        ])
        .run();
    }

    app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', db);
      c.set('config', baseTestConfig());
      await next();
    });
    app.use('/api/*', sessionAuth({ redirect: false }));
    app.route('/', apiRoutes);
  });

  afterEach(() => sqlite.close());

  function auth(user: User, body?: unknown): RequestInit {
    return {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie: cookies.get(user.id)!, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
  }

  function mentionedEmails(...users: User[]): string {
    return users.map((user) => `@${user.email}`).join(' ');
  }

  async function pickerEmails(documentId: string, actor: User): Promise<string[]> {
    const response = await app.request(`/api/docs/${documentId}/mentionable`, auth(actor));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { users: Array<{ email: string }> };
    return payload.users.map((user) => user.email);
  }

  test.each(['team-artifact', 'public-artifact'])('an accepted outsider sees only owner and accepted collaborators on %s', async (documentId) => {
    expect(await pickerEmails(documentId, editor)).toEqual([collaborator.email, owner.email]);
    expect(mentionableUsers(db, documentId, editor.id).map((user) => user.email).sort()).toEqual(
      [owner.email, editor.email, collaborator.email].sort(),
    );
  });

  test('an accepted outsider can mention legitimate private collaborators but not the team roster', async () => {
    expect(await pickerEmails('private-artifact', editor)).toEqual([collaborator.email, owner.email]);
    expect(mentionableUsers(db, 'private-artifact', editor.id).map((user) => user.email).sort()).toEqual(
      [owner.email, editor.email, collaborator.email].sort(),
    );
  });

  test('typed emails in outsider threads and replies use the same scoped directory for DTOs and watches', async () => {
    const body = mentionedEmails(owner, collaborator, teammate, pending, revoked);
    const createdResponse = await app.request('/api/docs/team-artifact/comments', auth(editor, {
      body,
      quotedText: ANCHOR.exact,
      anchor: ANCHOR,
      versionId: 'team-artifact-v1',
    }));
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as { id: string; mentions: Array<{ email: string }> };
    expect(created.mentions.map((mention) => mention.email)).toEqual([owner.email, collaborator.email]);
    expect(
      db.select({ userId: watches.userId }).from(watches).where(eq(watches.documentId, 'team-artifact')).all().map((row) => row.userId).sort(),
    ).toEqual([editor.id, owner.id, collaborator.id].sort());

    const replyResponse = await app.request(`/api/comments/${created.id}/replies`, auth(editor, { body }));
    expect(replyResponse.status).toBe(201);
    const reply = (await replyResponse.json()) as { mentions: Array<{ email: string }> };
    expect(reply.mentions.map((mention) => mention.email)).toEqual([owner.email, collaborator.email]);

    const listResponse = await app.request('/api/docs/team-artifact/comments', auth(owner));
    const list = (await listResponse.json()) as { comments: Array<{ mentions: Array<{ email: string }>; replies: Array<{ mentions: Array<{ email: string }> }> }> };
    expect(list.comments[0]!.mentions.map((mention) => mention.email)).toEqual([owner.email, collaborator.email]);
    expect(list.comments[0]!.replies[0]!.mentions.map((mention) => mention.email)).toEqual([owner.email, collaborator.email]);
  });

  test('an uninvited Public guest can discover and mention only the owner', async () => {
    expect(await pickerEmails('public-artifact', publicGuest)).toEqual([owner.email]);
    const body = mentionedEmails(owner, teammate, collaborator, pending, revoked);
    const response = await app.request('/api/docs/public-artifact/comments', auth(publicGuest, {
      body,
      quotedText: ANCHOR.exact,
      anchor: ANCHOR,
      versionId: 'public-artifact-v1',
    }));
    expect(response.status).toBe(201);
    const created = (await response.json()) as { mentions: Array<{ email: string }> };
    expect(created.mentions.map((mention) => mention.email)).toEqual([owner.email]);
    expect(
      db.select({ userId: watches.userId }).from(watches).where(eq(watches.documentId, 'public-artifact')).all().map((row) => row.userId).sort(),
    ).toEqual([publicGuest.id, owner.id].sort());
  });

  test('a known but unauthorized Public teammate email is not treated as a mention in their ordinary digest', async () => {
    const posted = await app.request('/api/docs/public-artifact/comments', auth(publicGuest, {
      body: `Please look, @${teammate.email}`,
      quotedText: ANCHOR.exact,
      anchor: ANCHOR,
      versionId: 'public-artifact-v1',
    }));
    expect(posted.status).toBe(201);
    const comment = db.select().from(comments).where(eq(comments.documentId, 'public-artifact')).get()!;

    db.delete(watches).where(eq(watches.documentId, 'public-artifact')).run();
    setWatching(db, 'public-artifact', teammate.id, true, new Date(comment.createdAt.getTime() - 1));
    const sent = await runDigestSweep(db, 'https://artifacts.test', async () => undefined, new Date(comment.createdAt.getTime() + 10 * 60 * 1000));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: teammate.email, subject: '1 new comment on "public-artifact"' });
    expect(sent[0]!.text).toContain(`${publicGuest.email} commented on`);
    expect(sent[0]!.text).not.toContain('mentioned you');
  });

  test('revoking an accepted outsider removes them from another outsider\'s picker and typed mentions', async () => {
    db.delete(documentCollaborators)
      .where(and(eq(documentCollaborators.documentId, 'public-artifact'), eq(documentCollaborators.userId, collaborator.id)))
      .run();
    expect(await pickerEmails('public-artifact', editor)).toEqual([owner.email]);

    const response = await app.request('/api/docs/public-artifact/comments', auth(editor, {
      body: `@${collaborator.email}`,
      quotedText: ANCHOR.exact,
      anchor: ANCHOR,
      versionId: 'public-artifact-v1',
    }));
    expect(response.status).toBe(201);
    expect((await response.json()) as { mentions: unknown[] }).toMatchObject({ mentions: [] });
    expect(db.select().from(watches).where(and(eq(watches.documentId, 'public-artifact'), eq(watches.userId, collaborator.id))).all()).toEqual([]);
  });
});
