/**
 * Unit tests for the teams service: the sign-in gate matrix, membership
 * materialization at verify-code time, membership-scoped document lookup,
 * member removal side effects (tokens revoked, watches deleted so the digest
 * sweep goes quiet), team deletion cascade, and instance-admin guardrails.
 */

import { describe, expect, test } from 'vitest';

import { createToken, getOrCreateUser, getTokenAuth } from '../../src/server/auth.js';
import {
  comments,
  documents,
  openDb,
  teamInvites,
  teamMembers,
  tokens,
  versions,
  watches,
  type DB,
} from '../../src/server/db/index.js';
import { findDocumentForUser, findDocumentInTeam } from '../../src/server/routes/api.js';
import {
  addTeamDomain,
  canRequestCode,
  createTeam,
  deleteTeamCascade,
  demoteInstanceAdmin,
  getTeamRole,
  getUserTeams,
  inviteMember,
  isInstanceAdmin,
  promoteInstanceAdmin,
  removeMember,
} from '../../src/server/services/teams.js';
import { runDigestSweep, setWatching, type DigestEmail } from '../../src/server/services/watches.js';
import { baseTestConfig, seedTeamWithDomain } from './teamTestUtils.js';

const NOW = new Date('2026-08-07T12:00:00Z');

function freshDb(): DB {
  return openDb(':memory:').db;
}

function seedDocument(db: DB, id: string, teamId: string, createdBy: string): void {
  db.insert(documents).values({ id, title: id, teamId, createdBy, currentVersionId: null, createdAt: NOW }).run();
  db.insert(versions).values({ id: `${id}-v1`, documentId: id, number: 1, html: '<body>x</body>', publishedAt: NOW }).run();
}

describe('sign-in gate (canRequestCode)', () => {
  test('matrix: domain rule / pending invite / admin email / existing user / stranger', () => {
    const db = freshDb();
    const config = baseTestConfig({ instanceAdminEmails: ['root@admin.io'] });
    seedTeamWithDomain(db, 'team-1', 'cliq.dev');

    // domain rule
    expect(canRequestCode(db, config, 'new@cliq.dev')).toBe(true);

    // pending invite for a foreign-domain email
    const admin = getOrCreateUser(db, 'boss@cliq.dev', NOW);
    inviteMember(db, 'team-1', 'guest@gmail.com', 'member', admin, NOW);
    expect(canRequestCode(db, config, 'guest@gmail.com')).toBe(true);

    // instance admin from the env list
    expect(canRequestCode(db, config, 'root@admin.io')).toBe(true);

    // existing user whose domain rule was removed keeps access
    const orphan = getOrCreateUser(db, 'old@legacy.com', NOW);
    expect(orphan.email).toBe('old@legacy.com');
    expect(canRequestCode(db, config, 'old@legacy.com')).toBe(true);

    // stranger
    expect(canRequestCode(db, config, 'nobody@nowhere.net')).toBe(false);
  });

  test('emails are matched case-insensitively', () => {
    const db = freshDb();
    seedTeamWithDomain(db, 'team-1', 'cliq.dev');
    expect(canRequestCode(db, baseTestConfig(), 'Person@CLIQ.dev')).toBe(true);
  });
});

describe('membership materialization', () => {
  test('a pending invite converts to membership (with its role) at sign-in and is deleted', () => {
    const db = freshDb();
    seedTeamWithDomain(db, 'team-1', 'cliq.dev');
    const admin = getOrCreateUser(db, 'boss@cliq.dev', NOW);

    inviteMember(db, 'team-1', 'guest@gmail.com', 'admin', admin, NOW);

    const guest = getOrCreateUser(db, 'guest@gmail.com', NOW); // = verify-code
    expect(getTeamRole(db, 'team-1', guest.id)).toBe('admin');
    expect(db.select().from(teamInvites).all()).toHaveLength(0);
  });

  test('attaching a domain later pulls in an existing user on their next sign-in', () => {
    const db = freshDb();
    const team = createTeam(db, 'Acme', NOW);
    const user = getOrCreateUser(db, 'dev@acme.com', NOW);
    expect(getUserTeams(db, user.id)).toHaveLength(0);

    addTeamDomain(db, team.id, 'acme.com', NOW);
    getOrCreateUser(db, 'dev@acme.com', NOW); // next sign-in
    expect(getTeamRole(db, team.id, user.id)).toBe('member');
  });

  test('inviting an email that already has an account joins immediately', () => {
    const db = freshDb();
    seedTeamWithDomain(db, 'team-1', 'cliq.dev');
    const admin = getOrCreateUser(db, 'boss@cliq.dev', NOW);
    const existing = getOrCreateUser(db, 'contractor@gmail.com', NOW);

    const outcome = inviteMember(db, 'team-1', 'contractor@gmail.com', 'member', admin, NOW);
    expect(outcome.kind).toBe('joined');
    expect(getTeamRole(db, 'team-1', existing.id)).toBe('member');
    expect(db.select().from(teamInvites).all()).toHaveLength(0);
  });

  test('domain auto-join never downgrades an invite-granted admin role', () => {
    const db = freshDb();
    seedTeamWithDomain(db, 'team-1', 'cliq.dev');
    const admin = getOrCreateUser(db, 'boss@cliq.dev', NOW);
    inviteMember(db, 'team-1', 'lead@cliq.dev', 'admin', admin, NOW);

    const lead = getOrCreateUser(db, 'lead@cliq.dev', NOW); // invite + domain rule both apply
    expect(getTeamRole(db, 'team-1', lead.id)).toBe('admin');
  });
});

describe('findDocumentForUser / findDocumentInTeam', () => {
  test('members find team documents; non-members and unknown slugs come back undefined', () => {
    const db = freshDb();
    seedTeamWithDomain(db, 'team-1', 'cliq.dev');
    seedTeamWithDomain(db, 'team-2', 'other.io');
    const member = getOrCreateUser(db, 'a@cliq.dev', NOW);
    const outsider = getOrCreateUser(db, 'b@other.io', NOW);
    seedDocument(db, 'doc-1', 'team-1', member.id);

    expect(findDocumentForUser(db, 'doc-1', member.id)?.id).toBe('doc-1');
    expect(findDocumentForUser(db, 'doc-1', outsider.id)).toBeUndefined();
    expect(findDocumentForUser(db, 'nope', member.id)).toBeUndefined();

    expect(findDocumentInTeam(db, 'doc-1', 'team-1')?.id).toBe('doc-1');
    expect(findDocumentInTeam(db, 'doc-1', 'team-2')).toBeUndefined();
  });

  test('a member of both teams sees both teams’ documents', () => {
    const db = freshDb();
    seedTeamWithDomain(db, 'team-1', 'cliq.dev');
    seedTeamWithDomain(db, 'team-2', 'other.io');
    const owner = getOrCreateUser(db, 'a@cliq.dev', NOW);
    const admin = getOrCreateUser(db, 'b@other.io', NOW);
    seedDocument(db, 'doc-1', 'team-1', owner.id);
    seedDocument(db, 'doc-2', 'team-2', admin.id);

    inviteMember(db, 'team-2', 'a@cliq.dev', 'member', admin, NOW);
    expect(findDocumentForUser(db, 'doc-1', owner.id)?.id).toBe('doc-1');
    expect(findDocumentForUser(db, 'doc-2', owner.id)?.id).toBe('doc-2');
  });
});

describe('member removal side effects', () => {
  test('revokes the member’s tokens for that team and stops their comment digests', async () => {
    const db = freshDb();
    seedTeamWithDomain(db, 'team-1', 'cliq.dev');
    seedTeamWithDomain(db, 'team-2', 'other.io');
    const owner = getOrCreateUser(db, 'owner@cliq.dev', NOW);
    const leaver = getOrCreateUser(db, 'leaver@cliq.dev', NOW);
    getOrCreateUser(db, 'stranger@other.io', NOW);
    seedDocument(db, 'doc-1', 'team-1', owner.id);

    // leaver is also in team-2: that token must survive
    const admin2 = getOrCreateUser(db, 'admin2@other.io', NOW);
    inviteMember(db, 'team-2', 'leaver@cliq.dev', 'member', admin2, NOW);
    createToken(db, leaver.id, 'team-1', 'doomed', NOW);
    createToken(db, leaver.id, 'team-2', 'survives', NOW);

    setWatching(db, 'doc-1', leaver.id, true, NOW);
    setWatching(db, 'doc-1', owner.id, true, NOW);

    expect(removeMember(db, 'team-1', leaver.id)).toBe(true);

    const remaining = db.select().from(tokens).all();
    expect(remaining.map((t) => t.label)).toEqual(['survives']);
    expect(db.select().from(watches).all().map((w) => w.userId)).toEqual([owner.id]);

    // Digest sweep after removal: a fresh comment reaches remaining watchers,
    // but never the removed member (their watch row is gone).
    const commentedAt = new Date(NOW.getTime() + 1000);
    db.insert(comments)
      .values({
        id: 'c-after-removal',
        documentId: 'doc-1',
        parentId: null,
        authorId: leaver.id,
        body: 'posted before removal took effect',
        quotedText: 'q',
        anchor: 'null',
        status: 'open',
        createdVersionId: 'doc-1-v1',
        createdAt: commentedAt,
      })
      .run();
    const later = new Date(commentedAt.getTime() + 60 * 60 * 1000);
    const sent: DigestEmail[] = [];
    await runDigestSweep(db, 'http://x', async (e) => void sent.push(e), later);
    expect(sent.map((e) => e.to)).toEqual(['owner@cliq.dev']);
  });

  test('removal is durable: domain auto-join does not resurrect the membership on the next sign-in', () => {
    const db = freshDb();
    seedTeamWithDomain(db, 'team-1', 'cliq.dev');
    const user = getOrCreateUser(db, 'leaver@cliq.dev', NOW);

    expect(removeMember(db, 'team-1', user.id, NOW)).toBe(true);
    getOrCreateUser(db, 'leaver@cliq.dev', NOW); // signs in again
    expect(getUserTeams(db, user.id)).toHaveLength(0);
  });

  test('an explicit re-invite clears the removal tombstone', () => {
    const db = freshDb();
    seedTeamWithDomain(db, 'team-1', 'cliq.dev');
    const admin = getOrCreateUser(db, 'boss@cliq.dev', NOW);
    const user = getOrCreateUser(db, 'leaver@cliq.dev', NOW);
    removeMember(db, 'team-1', user.id, NOW);

    const outcome = inviteMember(db, 'team-1', 'leaver@cliq.dev', 'member', admin, NOW);
    expect(outcome.kind).toBe('joined');
    expect(getTeamRole(db, 'team-1', user.id)).toBe('member');

    // ...and auto-join works again afterwards.
    removeMember(db, 'team-1', user.id, NOW);
    inviteMember(db, 'team-1', 'leaver@cliq.dev', 'member', admin, NOW);
    getOrCreateUser(db, 'leaver@cliq.dev', NOW);
    expect(getTeamRole(db, 'team-1', user.id)).toBe('member');
  });

  test('a bearer token whose owner lost the membership no longer authenticates', () => {
    const db = freshDb();
    seedTeamWithDomain(db, 'team-1', 'cliq.dev');
    const user = getOrCreateUser(db, 'a@cliq.dev', NOW);
    const { plaintext } = createToken(db, user.id, 'team-1', 'x', NOW);
    expect(getTokenAuth(db, plaintext, NOW)?.user.id).toBe(user.id);

    // Simulate a token that outlived its membership (e.g. manual DB surgery) —
    // removeMember would normally delete it in the same transaction.
    db.delete(teamMembers).run();
    expect(getTokenAuth(db, plaintext, NOW)).toBeNull();
  });

  test('removing a non-member is a no-op', () => {
    const db = freshDb();
    seedTeamWithDomain(db, 'team-1', 'cliq.dev');
    const user = getOrCreateUser(db, 'a@cliq.dev', NOW);
    expect(removeMember(db, 'team-does-not-exist', user.id)).toBe(false);
  });
});

describe('deleteTeamCascade', () => {
  test('leaves no orphaned documents, versions, watches, tokens, or invites', () => {
    const db = freshDb();
    seedTeamWithDomain(db, 'team-1', 'cliq.dev');
    const owner = getOrCreateUser(db, 'owner@cliq.dev', NOW);
    seedDocument(db, 'doc-1', 'team-1', owner.id);
    createToken(db, owner.id, 'team-1', 'x', NOW);
    setWatching(db, 'doc-1', owner.id, true, NOW);
    inviteMember(db, 'team-1', 'pending@gmail.com', 'member', owner, NOW);

    deleteTeamCascade(db, 'team-1');

    expect(db.select().from(documents).all()).toHaveLength(0);
    expect(db.select().from(versions).all()).toHaveLength(0);
    expect(db.select().from(watches).all()).toHaveLength(0);
    expect(db.select().from(tokens).all()).toHaveLength(0);
    expect(db.select().from(teamInvites).all()).toHaveLength(0);
    expect(db.select().from(teamMembers).all()).toHaveLength(0);
    expect(getUserTeams(db, owner.id)).toHaveLength(0);
  });
});

describe('instance admin guardrails', () => {
  test('env-listed admins cannot be demoted', () => {
    const db = freshDb();
    const config = baseTestConfig({ instanceAdminEmails: ['root@cliq.dev'] });
    const root = getOrCreateUser(db, 'root@cliq.dev', NOW);
    expect(isInstanceAdmin(root, config)).toBe(true);

    const outcome = demoteInstanceAdmin(db, config, root);
    expect(outcome.ok).toBe(false);
  });

  test('the last UI-promoted admin cannot be demoted when the env list is empty', () => {
    const db = freshDb();
    const config = baseTestConfig();
    getOrCreateUser(db, 'solo@cliq.dev', NOW);
    const solo = promoteInstanceAdmin(db, 'solo@cliq.dev')!;
    expect(solo.isInstanceAdmin).toBe(true);

    const outcome = demoteInstanceAdmin(db, config, solo);
    expect(outcome.ok).toBe(false);
    expect(isInstanceAdmin(solo, config)).toBe(true);
  });

  test('an admin can be demoted while another one remains', () => {
    const db = freshDb();
    const config = baseTestConfig();
    getOrCreateUser(db, 'a@cliq.dev', NOW);
    getOrCreateUser(db, 'b@cliq.dev', NOW);
    promoteInstanceAdmin(db, 'a@cliq.dev');
    const b = promoteInstanceAdmin(db, 'b@cliq.dev')!;

    const outcome = demoteInstanceAdmin(db, config, b);
    expect(outcome.ok).toBe(true);
  });

  test('promoting an email without an account fails', () => {
    const db = freshDb();
    expect(promoteInstanceAdmin(db, 'ghost@nowhere.net')).toBeUndefined();
  });
});
