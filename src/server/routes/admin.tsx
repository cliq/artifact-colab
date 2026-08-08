/**
 * Admin routes: the instance-admin area (/admin — teams, auto-join domains,
 * instance admins) and team settings for team admins (/teams/:id/settings).
 * Session-authed and CSRF-protected like every other page. Authorization
 * failures render 404, not 403 — admin surfaces are invisible to anyone who
 * can't use them, matching the cross-tenant convention for documents.
 */

import { asc, count, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '../context.js';
import type { DB } from '../db/index.js';
import { documents, teamDomains, teamInvites, teamMembers, teams, users, type Team, type User } from '../db/schema.js';
import { sendInviteEmail } from '../email.js';
import { csrfTokenFor, sessionAuth } from '../middleware.js';
import {
  AdminPage,
  AdminTeamDeletePage,
  AdminTeamPage,
  TeamSettingsPage,
  type AdminTeamListRow,
  type InstanceAdminRow,
  type MemberRow,
} from '../pages/teams.js';
import {
  addTeamDomain,
  cancelInvite,
  createTeam,
  deleteTeamCascade,
  demoteInstanceAdmin,
  getTeam,
  inviteMember,
  isInstanceAdmin,
  isTeamAdmin,
  promoteInstanceAdmin,
  removeMember,
  removeTeamDomain,
  renameTeam,
  setTeamRole,
} from '../services/teams.js';

/** The instance admin making this request, or null → the caller must 404. */
function requireInstanceAdmin(c: Context<AppEnv>): User | null {
  const user = c.get('user');
  return isInstanceAdmin(user, c.get('config')) ? user : null;
}

/** The team, if the requester administers it, or null → the caller must 404. Instance admins do NOT pass implicitly. */
function requireTeamAdmin(c: Context<AppEnv>, teamId: string): Team | null {
  const user = c.get('user');
  const db = c.get('db');
  if (!isTeamAdmin(db, teamId, user.id)) return null;
  return getTeam(db, teamId) ?? null;
}

function memberRows(db: DB, teamId: string): MemberRow[] {
  return db
    .select({ userId: teamMembers.userId, email: users.email, role: teamMembers.role })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(eq(teamMembers.teamId, teamId))
    .orderBy(asc(users.email))
    .all();
}

function inviteRows(db: DB, teamId: string) {
  return db.select().from(teamInvites).where(eq(teamInvites.teamId, teamId)).orderBy(asc(teamInvites.createdAt)).all();
}

async function formString(c: Context<AppEnv>, key: string): Promise<string> {
  const body = await c.req.parseBody();
  const value = body[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** Redirect carrying a one-shot inline message; the target page reads it from the query string. */
function redirectWith(c: Context<AppEnv>, path: string, kind: 'error' | 'notice', message: string) {
  return c.redirect(`${path}?${kind}=${encodeURIComponent(message)}`, 302);
}

/**
 * Shared by instance-admin and team-admin member management: one invite code
 * path (immediate join for existing accounts, emailed invite otherwise).
 */
async function handleInvite(c: Context<AppEnv>, team: Team, backPath: string) {
  const db = c.get('db');
  const email = await formString(c, 'email');
  const role = (await formString(c, 'role')) === 'admin' ? 'admin' : 'member';
  // Same validator as the sign-in route — anything looser could mint invites
  // that z.email() would later refuse to redeem.
  if (!z.email().safeParse(email).success) return redirectWith(c, backPath, 'error', 'enter a valid email address');

  const outcome = inviteMember(db, team.id, email, role, c.get('user'), new Date());
  switch (outcome.kind) {
    case 'joined':
      await sendInviteEmail(c.get('config'), outcome.user.email, c.get('user').email, team.name);
      return redirectWith(c, backPath, 'notice', `${outcome.user.email} was added to the team.`);
    case 'invited':
      await sendInviteEmail(c.get('config'), outcome.invite.email, c.get('user').email, team.name);
      return redirectWith(c, backPath, 'notice', `Invited ${outcome.invite.email} — they'll join when they sign in.`);
    case 'already_member':
      return redirectWith(c, backPath, 'error', 'already a member');
    case 'already_invited':
      return redirectWith(c, backPath, 'error', 'already invited');
  }
}

export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use('/admin', sessionAuth({ redirect: true }));
adminRoutes.use('/admin/*', sessionAuth({ redirect: true }));
// `:id` and not `*`: a bare `/teams/*` would also swallow POST /teams (the
// self-signup wizard in routes/pages.tsx), which must 404 — not redirect —
// for anonymous callers.
adminRoutes.use('/teams/:id/*', sessionAuth({ redirect: true }));

// --------------------------------------------------------------------------
// Instance admin: /admin

adminRoutes.get('/admin', (c) => {
  const admin = requireInstanceAdmin(c);
  if (!admin) return c.notFound();
  const db = c.get('db');
  const config = c.get('config');

  const allDomains = db.select().from(teamDomains).all();
  const teamRows: AdminTeamListRow[] = db
    .select()
    .from(teams)
    .orderBy(asc(teams.name))
    .all()
    .map((team) => ({
      team,
      memberCount: db.select({ value: count() }).from(teamMembers).where(eq(teamMembers.teamId, team.id)).all()[0]!.value,
      domains: allDomains.filter((d) => d.teamId === team.id).map((d) => d.domain),
    }));

  const uiAdmins = db.select().from(users).where(eq(users.isInstanceAdmin, true)).all();
  const envAdmins = config.instanceAdminEmails
    .map((email) => db.select().from(users).where(eq(users.email, email)).get())
    .filter((u): u is User => u !== undefined);
  const seen = new Set<string>();
  const admins: InstanceAdminRow[] = [...envAdmins, ...uiAdmins]
    .filter((u) => (seen.has(u.id) ? false : (seen.add(u.id), true)))
    .map((u) => ({ user: u, envListed: config.instanceAdminEmails.includes(u.email) }));
  const pendingEnvAdmins = config.instanceAdminEmails.filter((email) => !admins.some((a) => a.user.email === email));

  return c.html(
    <AdminPage
      user={admin}
      csrfToken={csrfTokenFor(c)}
      teams={teamRows}
      admins={admins}
      pendingEnvAdmins={pendingEnvAdmins}
      error={c.req.query('error')}
      notice={c.req.query('notice')}
    />,
  );
});

adminRoutes.post('/admin/teams', async (c) => {
  if (!requireInstanceAdmin(c)) return c.notFound();
  const name = await formString(c, 'name');
  if (!name) return redirectWith(c, '/admin', 'error', 'team name is required');

  const team = createTeam(c.get('db'), name, new Date());
  return c.redirect(`/admin/teams/${team.id}`, 302);
});

adminRoutes.get('/admin/teams/:id', (c) => {
  const admin = requireInstanceAdmin(c);
  if (!admin) return c.notFound();
  const db = c.get('db');
  const team = getTeam(db, c.req.param('id'));
  if (!team) return c.notFound();

  const domains = db.select().from(teamDomains).where(eq(teamDomains.teamId, team.id)).orderBy(asc(teamDomains.domain)).all();

  return c.html(
    <AdminTeamPage
      user={admin}
      csrfToken={csrfTokenFor(c)}
      team={team}
      domains={domains}
      members={memberRows(db, team.id)}
      invites={inviteRows(db, team.id)}
      error={c.req.query('error')}
      notice={c.req.query('notice')}
    />,
  );
});

adminRoutes.post('/admin/teams/:id/rename', async (c) => {
  if (!requireInstanceAdmin(c)) return c.notFound();
  const db = c.get('db');
  const team = getTeam(db, c.req.param('id'));
  if (!team) return c.notFound();

  const name = await formString(c, 'name');
  if (!name) return redirectWith(c, `/admin/teams/${team.id}`, 'error', 'team name is required');
  renameTeam(db, team.id, name);
  return c.redirect(`/admin/teams/${team.id}`, 302);
});

adminRoutes.post('/admin/teams/:id/domains', async (c) => {
  if (!requireInstanceAdmin(c)) return c.notFound();
  const db = c.get('db');
  const team = getTeam(db, c.req.param('id'));
  if (!team) return c.notFound();

  const outcome = addTeamDomain(db, team.id, await formString(c, 'domain'), new Date());
  if (!outcome.ok) return redirectWith(c, `/admin/teams/${team.id}`, 'error', outcome.error);
  return c.redirect(`/admin/teams/${team.id}`, 302);
});

adminRoutes.post('/admin/teams/:id/domains/remove', async (c) => {
  if (!requireInstanceAdmin(c)) return c.notFound();
  const db = c.get('db');
  const team = getTeam(db, c.req.param('id'));
  if (!team) return c.notFound();

  removeTeamDomain(db, team.id, await formString(c, 'domain'));
  return c.redirect(`/admin/teams/${team.id}`, 302);
});

adminRoutes.post('/admin/teams/:id/members', async (c) => {
  if (!requireInstanceAdmin(c)) return c.notFound();
  const team = getTeam(c.get('db'), c.req.param('id'));
  if (!team) return c.notFound();
  return handleInvite(c, team, `/admin/teams/${team.id}`);
});

adminRoutes.post('/admin/teams/:id/members/:userId/remove', (c) => {
  if (!requireInstanceAdmin(c)) return c.notFound();
  const db = c.get('db');
  const team = getTeam(db, c.req.param('id'));
  if (!team) return c.notFound();

  removeMember(db, team.id, c.req.param('userId'));
  return c.redirect(`/admin/teams/${team.id}`, 302);
});

adminRoutes.post('/admin/teams/:id/members/:userId/role', async (c) => {
  if (!requireInstanceAdmin(c)) return c.notFound();
  const db = c.get('db');
  const team = getTeam(db, c.req.param('id'));
  if (!team) return c.notFound();

  const role = (await formString(c, 'role')) === 'admin' ? 'admin' : 'member';
  setTeamRole(db, team.id, c.req.param('userId'), role);
  return c.redirect(`/admin/teams/${team.id}`, 302);
});

adminRoutes.post('/admin/teams/:id/invites/:inviteId/cancel', (c) => {
  if (!requireInstanceAdmin(c)) return c.notFound();
  const db = c.get('db');
  const team = getTeam(db, c.req.param('id'));
  if (!team) return c.notFound();

  cancelInvite(db, team.id, c.req.param('inviteId'));
  return c.redirect(`/admin/teams/${team.id}`, 302);
});

adminRoutes.get('/admin/teams/:id/delete', (c) => {
  const admin = requireInstanceAdmin(c);
  if (!admin) return c.notFound();
  const db = c.get('db');
  const team = getTeam(db, c.req.param('id'));
  if (!team) return c.notFound();

  const counts = {
    members: db.select({ value: count() }).from(teamMembers).where(eq(teamMembers.teamId, team.id)).all()[0]!.value,
    documents: db.select({ value: count() }).from(documents).where(eq(documents.teamId, team.id)).all()[0]!.value,
  };
  return c.html(<AdminTeamDeletePage user={admin} csrfToken={csrfTokenFor(c)} team={team} counts={counts} />);
});

adminRoutes.post('/admin/teams/:id/delete', (c) => {
  if (!requireInstanceAdmin(c)) return c.notFound();
  const db = c.get('db');
  const team = getTeam(db, c.req.param('id'));
  if (!team) return c.notFound();

  deleteTeamCascade(db, team.id);
  return redirectWith(c, '/admin', 'notice', `Deleted team ${team.name}.`);
});

adminRoutes.post('/admin/admins', async (c) => {
  if (!requireInstanceAdmin(c)) return c.notFound();
  const email = await formString(c, 'email');

  const promoted = promoteInstanceAdmin(c.get('db'), email);
  if (!promoted) return redirectWith(c, '/admin', 'error', 'no account with that email — they need to sign in first');
  return redirectWith(c, '/admin', 'notice', `${promoted.email} is now an instance admin.`);
});

adminRoutes.post('/admin/admins/:userId/demote', (c) => {
  if (!requireInstanceAdmin(c)) return c.notFound();
  const db = c.get('db');
  const target = db.select().from(users).where(eq(users.id, c.req.param('userId'))).get();
  if (!target) return c.notFound();

  const outcome = demoteInstanceAdmin(db, c.get('config'), target);
  if (!outcome.ok) return redirectWith(c, '/admin', 'error', outcome.error);
  return c.redirect('/admin', 302);
});

// --------------------------------------------------------------------------
// Team admin: /teams/:id/settings

adminRoutes.get('/teams/:id/settings', (c) => {
  const team = requireTeamAdmin(c, c.req.param('id'));
  if (!team) return c.notFound();
  const db = c.get('db');
  const user = c.get('user');

  return c.html(
    <TeamSettingsPage
      user={user}
      csrfToken={csrfTokenFor(c)}
      isInstanceAdmin={isInstanceAdmin(user, c.get('config'))}
      team={team}
      members={memberRows(db, team.id)}
      invites={inviteRows(db, team.id)}
      error={c.req.query('error')}
      notice={c.req.query('notice')}
    />,
  );
});

adminRoutes.post('/teams/:id/settings/rename', async (c) => {
  const team = requireTeamAdmin(c, c.req.param('id'));
  if (!team) return c.notFound();

  const name = await formString(c, 'name');
  if (!name) return redirectWith(c, `/teams/${team.id}/settings`, 'error', 'team name is required');
  renameTeam(c.get('db'), team.id, name);
  return c.redirect(`/teams/${team.id}/settings`, 302);
});

adminRoutes.post('/teams/:id/settings/members', async (c) => {
  const team = requireTeamAdmin(c, c.req.param('id'));
  if (!team) return c.notFound();
  return handleInvite(c, team, `/teams/${team.id}/settings`);
});

adminRoutes.post('/teams/:id/settings/members/:userId/remove', (c) => {
  const team = requireTeamAdmin(c, c.req.param('id'));
  if (!team) return c.notFound();

  removeMember(c.get('db'), team.id, c.req.param('userId'));
  // Removing yourself as the last admin is allowed; you lose access to this
  // page, so land somewhere that still exists.
  return c.redirect(isTeamAdmin(c.get('db'), team.id, c.get('user').id) ? `/teams/${team.id}/settings` : '/', 302);
});

adminRoutes.post('/teams/:id/settings/members/:userId/role', async (c) => {
  const team = requireTeamAdmin(c, c.req.param('id'));
  if (!team) return c.notFound();

  const role = (await formString(c, 'role')) === 'admin' ? 'admin' : 'member';
  setTeamRole(c.get('db'), team.id, c.req.param('userId'), role);
  return c.redirect(isTeamAdmin(c.get('db'), team.id, c.get('user').id) ? `/teams/${team.id}/settings` : '/', 302);
});

adminRoutes.post('/teams/:id/settings/invites/:inviteId/cancel', (c) => {
  const team = requireTeamAdmin(c, c.req.param('id'));
  if (!team) return c.notFound();

  cancelInvite(c.get('db'), team.id, c.req.param('inviteId'));
  return c.redirect(`/teams/${team.id}/settings`, 302);
});
