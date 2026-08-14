/**
 * Teams: the tenancy boundary. Membership, roles, invites, auto-join domains,
 * and instance admins all live here. Routes call into these; nothing here
 * talks to HTTP directly.
 *
 * Two invariants worth knowing:
 * - Invites are redeemed by the normal sign-in code flow (the code proves
 *   email ownership), except that inviting an email which already has an
 *   account converts to membership immediately.
 * - Removing a member also revokes their tokens for that team and deletes
 *   their watches on that team's documents — the digest sweep never re-checks
 *   access, so stale watches would keep emailing them comments.
 */

import { randomBytes } from 'node:crypto';

import { and, asc, eq, inArray } from 'drizzle-orm';

import type { Config } from '../config.js';
import type { DB, DBOrTx } from '../db/index.js';
import {
  documents,
  teamDomains,
  teamExclusions,
  teamInvites,
  teamMembers,
  teams,
  tokens,
  users,
  watches,
  type Team,
  type TeamInvite,
  type User,
} from '../db/schema.js';
import { deleteDocumentsWithin } from './documents.js';

function randomId(bytes = 8): string {
  return randomBytes(bytes).toString('hex');
}

export function domainOf(email: string): string {
  return email.trim().toLowerCase().split('@')[1] ?? '';
}

/** Effective status: promoted in the UI, or listed in INSTANCE_ADMIN_EMAILS (which is not demotable). */
export function isInstanceAdmin(user: User, config: Config): boolean {
  return user.isInstanceAdmin || config.instanceAdminEmails.includes(user.email);
}

/**
 * Sign-in gate, replacing the old domain allowlist. An email may request a
 * code if the instance allows self sign-up, a team would auto-join it, an
 * invite is pending for it, it's an instance admin, or it already has an
 * account (so removing a domain rule never locks out existing members).
 */
export function canRequestCode(db: DB, config: Config, email: string): boolean {
  if (config.selfSignup) return true;

  const normalized = email.trim().toLowerCase();
  if (config.instanceAdminEmails.includes(normalized)) return true;

  const domain = domainOf(normalized);
  if (domain && db.select().from(teamDomains).where(eq(teamDomains.domain, domain)).get()) return true;

  if (db.select().from(teamInvites).where(eq(teamInvites.email, normalized)).get()) return true;

  return db.select().from(users).where(eq(users.email, normalized)).get() !== undefined;
}

/**
 * Runs on every sign-in: converts pending invites into memberships (with the
 * invite's role) and auto-joins the email's domain team. Running every time —
 * not just at account creation — means attaching a domain later pulls in
 * existing users on their next sign-in.
 */
export function materializeMemberships(db: DBOrTx, user: User, now: Date): void {
  const pending = db.select().from(teamInvites).where(eq(teamInvites.email, user.email)).all();
  for (const invite of pending) {
    // An invite is an explicit re-admission — it clears a removal tombstone.
    db.delete(teamExclusions)
      .where(and(eq(teamExclusions.teamId, invite.teamId), eq(teamExclusions.userId, user.id)))
      .run();
    db.insert(teamMembers)
      .values({ teamId: invite.teamId, userId: user.id, role: invite.role, createdAt: now })
      .onConflictDoNothing()
      .run();
    db.delete(teamInvites).where(eq(teamInvites.id, invite.id)).run();
  }

  const domain = domainOf(user.email);
  const rule = domain ? db.select().from(teamDomains).where(eq(teamDomains.domain, domain)).get() : undefined;
  if (rule) {
    // Auto-join respects removal tombstones: a member removed from their
    // domain's team must not silently rejoin on their next sign-in.
    const excluded = db
      .select()
      .from(teamExclusions)
      .where(and(eq(teamExclusions.teamId, rule.teamId), eq(teamExclusions.userId, user.id)))
      .get();
    if (!excluded) {
      db.insert(teamMembers)
        .values({ teamId: rule.teamId, userId: user.id, role: 'member', createdAt: now })
        .onConflictDoNothing()
        .run();
    }
  }
}

export interface TeamMembership {
  team: Team;
  role: string;
}

export function getUserTeams(db: DB, userId: string): TeamMembership[] {
  return db
    .select({ team: teams, role: teamMembers.role })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(eq(teamMembers.userId, userId))
    .orderBy(asc(teams.name))
    .all();
}

export function getTeamRole(db: DB, teamId: string, userId: string): string | undefined {
  const row = db
    .select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .get();
  return row?.role;
}

export function isTeamAdmin(db: DB, teamId: string, userId: string): boolean {
  return getTeamRole(db, teamId, userId) === 'admin';
}

export function getTeam(db: DB, teamId: string): Team | undefined {
  return db.select().from(teams).where(eq(teams.id, teamId)).get();
}

export function createTeam(db: DB, name: string, now: Date): Team {
  return db.insert(teams).values({ id: randomId(), name, createdAt: now }).returning().get();
}

/**
 * Domains the first-run wizard must never claim for auto-join: shared mailbox
 * providers, where "anyone @domain" would mean "anyone at all".
 */
export const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'aol.com',
  'gmx.com',
  'gmx.net',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'fastmail.com',
]);

/**
 * The domain the wizard may claim for auto-join on this user's behalf: always
 * derived from their verified email (never client input), and only if it is
 * not a free-email provider and no team has claimed it yet. Null → the new
 * team can only be invite-only.
 */
export function claimableDomain(db: DBOrTx, email: string): string | null {
  const domain = domainOf(email);
  if (!domain || FREE_EMAIL_DOMAINS.has(domain)) return null;
  if (db.select().from(teamDomains).where(eq(teamDomains.domain, domain)).get()) return null;
  return domain;
}

export type SelfServeTeamOutcome = { ok: true; team: Team } | { ok: false; error: 'domain_taken' | 'already_in_team' };

/** Sentinels thrown inside the wizard transaction so the whole team creation rolls back. */
class DomainTakenError extends Error {}
class AlreadyInTeamError extends Error {}

/**
 * The first-run wizard's submit, in one transaction: the team, its creator as
 * team admin, and — when requested — the auto-join claim on the creator's own
 * email domain. The creator's zero-team status is re-checked here, inside the
 * transaction, because the route's earlier check sits across an await and two
 * interleaved submissions could both pass it. A concurrent claim of the same
 * domain (checked here, and ultimately settled by the `team_domains` primary
 * key) rolls everything back, leaving no half-created team.
 */
export function createSelfServeTeam(db: DB, name: string, creator: User, claimDomain: boolean, now: Date): SelfServeTeamOutcome {
  try {
    return db.transaction((tx) => {
      const existing = tx.select().from(teamMembers).where(eq(teamMembers.userId, creator.id)).get();
      if (existing) throw new AlreadyInTeamError();

      const team = tx.insert(teams).values({ id: randomId(), name, createdAt: now }).returning().get();
      tx.insert(teamMembers).values({ teamId: team.id, userId: creator.id, role: 'admin', createdAt: now }).run();

      if (claimDomain) {
        const domain = claimableDomain(tx, creator.email);
        if (!domain) throw new DomainTakenError();
        tx.insert(teamDomains).values({ domain, teamId: team.id, createdAt: now }).run();
      }

      return { ok: true, team } as const;
    });
  } catch (err) {
    if (err instanceof AlreadyInTeamError) return { ok: false, error: 'already_in_team' };
    // The eligibility re-check above races only across processes; the PK
    // constraint is the real arbiter, and both failures mean the same thing.
    if (err instanceof DomainTakenError || (err instanceof Error && err.message.includes('UNIQUE constraint failed'))) {
      return { ok: false, error: 'domain_taken' };
    }
    throw err;
  }
}

/**
 * Solo-user path: minting a token must not require joining a team first, so a
 * teamless user gets a personal workspace created on the fly (they're its
 * admin and can invite people later). Returns the user's first team when they
 * already have one — callers only reach for this when no team was picked.
 */
export function ensurePersonalTeam(db: DB, user: User, now: Date): Team {
  const memberships = getUserTeams(db, user.id);
  if (memberships.length > 0) return memberships[0]!.team;

  const base = (user.name ?? user.email.split('@')[0] ?? 'Personal').trim();
  const result = createSelfServeTeam(db, `${base}'s workspace`, user, false, now);
  if (result.ok) return result.team;

  // Lost a race with a concurrent membership (invite redemption, another
  // token create): the membership that beat us is the team to use.
  return getUserTeams(db, user.id)[0]!.team;
}

export function renameTeam(db: DB, teamId: string, name: string): void {
  db.update(teams).set({ name }).where(eq(teams.id, teamId)).run();
}

export type InviteOutcome =
  | { kind: 'joined'; user: User }
  | { kind: 'invited'; invite: TeamInvite }
  | { kind: 'already_member' }
  | { kind: 'already_invited' };

/**
 * One code path for team-admin invites and instance-admin "add member by
 * email". If the email already has an account, membership is immediate
 * (ownership is already proven; waiting for their next sign-in would be
 * surprising). Otherwise a pending invite is created, redeemed at sign-in.
 */
export function inviteMember(db: DB, teamId: string, email: string, role: string, invitedBy: User, now: Date): InviteOutcome {
  const normalized = email.trim().toLowerCase();

  const existing = db.select().from(users).where(eq(users.email, normalized)).get();
  if (existing) {
    if (getTeamRole(db, teamId, existing.id) !== undefined) return { kind: 'already_member' };
    db.delete(teamExclusions)
      .where(and(eq(teamExclusions.teamId, teamId), eq(teamExclusions.userId, existing.id)))
      .run();
    db.insert(teamMembers).values({ teamId, userId: existing.id, role, createdAt: now }).run();
    return { kind: 'joined', user: existing };
  }

  const pending = db
    .select()
    .from(teamInvites)
    .where(and(eq(teamInvites.teamId, teamId), eq(teamInvites.email, normalized)))
    .get();
  if (pending) return { kind: 'already_invited' };

  const invite = db
    .insert(teamInvites)
    .values({ id: randomId(), teamId, email: normalized, role, invitedBy: invitedBy.id, createdAt: now })
    .returning()
    .get();
  return { kind: 'invited', invite };
}

export function cancelInvite(db: DB, teamId: string, inviteId: string): boolean {
  const result = db
    .delete(teamInvites)
    .where(and(eq(teamInvites.id, inviteId), eq(teamInvites.teamId, teamId)))
    .run();
  return result.changes > 0;
}

/**
 * One transaction: removes the membership, records a removal tombstone (so
 * domain auto-join can't undo the removal on the next sign-in), revokes the
 * member's tokens for this team, and deletes their watches on this team's
 * documents (the digest sweep emails every 'watching' row without re-checking
 * access).
 */
export function removeMember(db: DB, teamId: string, userId: string, now: Date = new Date()): boolean {
  return db.transaction((tx) => {
    const result = tx
      .delete(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
      .run();
    if (result.changes === 0) return false;

    tx.insert(teamExclusions).values({ teamId, userId, createdAt: now }).onConflictDoNothing().run();
    tx.delete(tokens).where(and(eq(tokens.teamId, teamId), eq(tokens.userId, userId))).run();

    const teamDocs = tx.select({ id: documents.id }).from(documents).where(eq(documents.teamId, teamId)).all();
    if (teamDocs.length > 0) {
      tx.delete(watches)
        .where(
          and(
            eq(watches.userId, userId),
            inArray(
              watches.documentId,
              teamDocs.map((d) => d.id),
            ),
          ),
        )
        .run();
    }
    return true;
  });
}

export function setTeamRole(db: DB, teamId: string, userId: string, role: 'member' | 'admin'): boolean {
  const result = db
    .update(teamMembers)
    .set({ role })
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .run();
  return result.changes > 0;
}

export type AddDomainOutcome = { ok: true } | { ok: false; error: string };

export function addTeamDomain(db: DB, teamId: string, domain: string, now: Date): AddDomainOutcome {
  const normalized = domain.trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(normalized)) return { ok: false, error: 'not a valid domain' };

  const existing = db.select().from(teamDomains).where(eq(teamDomains.domain, normalized)).get();
  if (existing) return { ok: false, error: 'domain is already attached to a team' };

  db.insert(teamDomains).values({ domain: normalized, teamId, createdAt: now }).run();
  return { ok: true };
}

export function removeTeamDomain(db: DB, teamId: string, domain: string): boolean {
  const result = db
    .delete(teamDomains)
    .where(and(eq(teamDomains.domain, domain), eq(teamDomains.teamId, teamId)))
    .run();
  return result.changes > 0;
}

/**
 * Deletes a team and everything scoped to it: documents (with their versions,
 * assets, comments, anchor states, and watches — see
 * `deleteDocumentsWithin`), memberships, domain rules, pending invites, and
 * team-scoped tokens.
 */
export function deleteTeamCascade(db: DB, teamId: string): void {
  db.transaction((tx) => {
    const docIds = tx
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.teamId, teamId))
      .all()
      .map((d) => d.id);
    deleteDocumentsWithin(tx, docIds);

    tx.delete(teamInvites).where(eq(teamInvites.teamId, teamId)).run();
    tx.delete(teamDomains).where(eq(teamDomains.teamId, teamId)).run();
    tx.delete(teamMembers).where(eq(teamMembers.teamId, teamId)).run();
    tx.delete(teamExclusions).where(eq(teamExclusions.teamId, teamId)).run();
    tx.delete(tokens).where(eq(tokens.teamId, teamId)).run();
    tx.delete(teams).where(eq(teams.id, teamId)).run();
  });
}

/** Guardrail: the env-listed admins are the recovery path and can't be demoted; nor can the last admin standing. */
export type DemoteOutcome = { ok: true } | { ok: false; error: string };

export function demoteInstanceAdmin(db: DB, config: Config, target: User): DemoteOutcome {
  if (config.instanceAdminEmails.includes(target.email)) {
    return { ok: false, error: 'this admin is listed in INSTANCE_ADMIN_EMAILS and cannot be demoted' };
  }

  const uiAdmins = db.select().from(users).where(eq(users.isInstanceAdmin, true)).all();
  const others = uiAdmins.filter((u) => u.id !== target.id);
  if (others.length === 0 && config.instanceAdminEmails.length === 0) {
    return { ok: false, error: 'cannot demote the last instance admin' };
  }

  db.update(users).set({ isInstanceAdmin: false }).where(eq(users.id, target.id)).run();
  return { ok: true };
}

export function promoteInstanceAdmin(db: DB, email: string): User | undefined {
  const normalized = email.trim().toLowerCase();
  const user = db.select().from(users).where(eq(users.email, normalized)).get();
  if (!user) return undefined;
  db.update(users).set({ isInstanceAdmin: true }).where(eq(users.id, user.id)).run();
  return { ...user, isInstanceAdmin: true };
}
