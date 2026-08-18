/**
 * Server-rendered HTML pages: sign-in, the document list, and personal
 * access token settings. These are the "browser" routes, as opposed to the
 * JSON APIs in `routes/auth.ts`/`routes/tokens.ts` and the MCP endpoint.
 *
 * Named `.tsx` (not `.ts`) because it renders JSX directly; consumers still
 * import it as `../routes/pages.js`, matching this project's convention of
 * `.js`-suffixed relative imports regardless of source extension.
 */

import { count, eq, and, isNull, desc, ne, or } from 'drizzle-orm';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';

import { createToken, getSessionUser, revokeToken } from '../auth.js';
import type { AppEnv } from '../context.js';
import type { DB } from '../db/index.js';
import { comments, documents, teamMembers, tokens, users, versions, watches, type Document } from '../db/schema.js';
import { csrfTokenFor, sessionAuth } from '../middleware.js';
import { gravatarUrl } from '../services/gravatar.js';
import {
  FREE_EMAIL_DOMAINS,
  claimableDomain,
  createSelfServeTeam,
  domainOf,
  ensurePersonalTeam,
  getUserTeams,
  isInstanceAdmin,
} from '../services/teams.js';
import { DocumentsPage, type DocumentListRow, type TeamDocumentsGroup } from '../pages/documents.js';
import { ProfilePage } from '../pages/profile.js';
import { SigninPage } from '../pages/signin.js';
import { TokensPage, type TokenTeamOption } from '../pages/tokens.js';
import { safeLocalPath } from '../safeRedirect.js';
import { appCss } from '../static/appCss.js';

function documentRow(db: DB, doc: Document): DocumentListRow {
  const [{ value: versionCount }] = db.select({ value: count() }).from(versions).where(eq(versions.documentId, doc.id)).all();

  const [{ value: openCommentCount }] = db
    .select({ value: count() })
    .from(comments)
    .where(and(eq(comments.documentId, doc.id), eq(comments.status, 'open'), isNull(comments.parentId)))
    .all();

  const [latest] = db
    .select({ publishedAt: versions.publishedAt })
    .from(versions)
    .where(eq(versions.documentId, doc.id))
    .orderBy(desc(versions.number))
    .limit(1)
    .all();

  return {
    id: doc.id,
    title: doc.title,
    versionCount,
    openCommentCount,
    lastPublishedAt: latest?.publishedAt ?? null,
    isPrivate: doc.visibility === 'private',
  };
}

/** A team's documents, minus other users' private ones — those exist only for their creator. */
function documentRowsForTeam(db: DB, teamId: string, userId: string): DocumentListRow[] {
  return db
    .select()
    .from(documents)
    .where(and(eq(documents.teamId, teamId), or(ne(documents.visibility, 'private'), eq(documents.createdBy, userId))))
    .orderBy(desc(documents.createdAt))
    .all()
    .map((doc) => documentRow(db, doc));
}

/**
 * "Shared with you": public documents outside the user's teams that they hold
 * a watch row on (interacting auto-watches, so commenting once is enough to
 * pin a document here; an explicit unwatch only mutes email, it doesn't lose
 * the link). Flipping a document back to team-only prunes non-member watches,
 * which removes it from this list too.
 */
function sharedWithUserRows(db: DB, userId: string): DocumentListRow[] {
  return db
    .select({ document: documents })
    .from(documents)
    .innerJoin(watches, and(eq(watches.documentId, documents.id), eq(watches.userId, userId)))
    .leftJoin(teamMembers, and(eq(teamMembers.teamId, documents.teamId), eq(teamMembers.userId, userId)))
    .where(and(eq(documents.visibility, 'public'), isNull(teamMembers.userId)))
    .orderBy(desc(documents.createdAt))
    .all()
    .map((row) => documentRow(db, row.document));
}

export const pageRoutes = new Hono<AppEnv>();

pageRoutes.get('/signin', (c) => {
  const csrfToken = csrfTokenFor(c);
  const next = safeLocalPath(c.req.query('next'));
  return c.html(<SigninPage next={next} csrfToken={csrfToken} selfSignup={c.get('config').selfSignup} />);
});

pageRoutes.get('/', sessionAuth({ redirect: true }), (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const config = c.get('config');
  const csrfToken = csrfTokenFor(c);

  const groups: TeamDocumentsGroup[] = getUserTeams(db, user.id).map((membership) => ({
    teamId: membership.team.id,
    teamName: membership.team.name,
    isTeamAdmin: membership.role === 'admin',
    documents: documentRowsForTeam(db, membership.team.id, user.id),
  }));

  const wizard =
    config.selfSignup && groups.length === 0 ? { claimableDomain: claimableDomain(db, user.email) } : undefined;

  return c.html(
    <DocumentsPage
      user={user}
      csrfToken={csrfToken}
      groups={groups}
      shared={sharedWithUserRows(db, user.id)}
      isInstanceAdmin={isInstanceAdmin(user, config)}
      wizard={wizard}
    />,
  );
});

/**
 * The first-run wizard's submit. Deliberately not a general create-team API:
 * it exists only for zero-team users on a self-signup instance, and any other
 * caller gets the same 404 an unauthorized admin URL would (invisibility
 * convention) — including anonymous requests, so the route's existence leaks
 * nothing about the instance's configuration.
 */
pageRoutes.post('/teams', async (c) => {
  const db = c.get('db');
  const config = c.get('config');

  const sessionToken = getCookie(c, 'session');
  const user = sessionToken ? getSessionUser(db, sessionToken, new Date()) : null;
  if (!config.selfSignup || !user) return c.notFound();
  if (getUserTeams(db, user.id).length > 0) return c.notFound();

  const isForm = !(c.req.header('content-type') ?? '').includes('application/json');
  const body = isForm ? ((await c.req.parseBody()) as Record<string, unknown>) : ((await c.req.json()) as Record<string, unknown>);
  const name = typeof body['name'] === 'string' ? body['name'].trim() : '';
  // Boolean for JSON clients, "true"/"false" strings from the wizard's radios.
  const claim = body['claimDomain'];
  const claimRequested = claim === true || claim === 'true';

  // Validation failures re-render the wizard inline for browsers; JSON
  // clients get a plain 400.
  const rerender = (error: string) => {
    if (!isForm) {
      return c.json({ error }, 400);
    }
    return c.html(
      <DocumentsPage
        user={user}
        csrfToken={csrfTokenFor(c)}
        groups={[]}
        shared={sharedWithUserRows(db, user.id)}
        isInstanceAdmin={isInstanceAdmin(user, config)}
        wizard={{ claimableDomain: claimableDomain(db, user.email), error }}
      />,
      400,
    );
  };

  if (!name) return rerender('Team name is required.');
  if (claim !== undefined && ![true, false, 'true', 'false'].includes(claim as boolean | string)) {
    return rerender('claimDomain must be a boolean.');
  }
  // The domain is derived from the signed-in user's verified email, never from
  // client input; a claim request for a free-email domain can only be forged.
  // An already-claimed domain is left to the transaction — that's the race,
  // with its own message.
  const domain = domainOf(user.email);
  if (claimRequested && (!domain || FREE_EMAIL_DOMAINS.has(domain))) {
    return rerender("Your email domain can't be claimed for auto-join — create an invite-only team instead.");
  }

  const outcome = createSelfServeTeam(db, name, user, claimRequested, new Date());
  if (!outcome.ok) {
    // The zero-team check above sits across an await; the transaction is the
    // authoritative re-check, and a loser here is treated like the pre-check.
    if (outcome.error === 'already_in_team') return c.notFound();
    return rerender(
      'That domain was just claimed by another team — sign in again to join it, or create an invite-only team.',
    );
  }

  return c.redirect('/', 302);
});

function tokenTeamOptions(db: DB, userId: string): TokenTeamOption[] {
  return getUserTeams(db, userId).map((m) => ({ id: m.team.id, name: m.team.name }));
}

pageRoutes.get('/settings/tokens', sessionAuth({ redirect: true }), (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const config = c.get('config');
  const csrfToken = csrfTokenFor(c);

  const userTokens = db.select().from(tokens).where(eq(tokens.userId, user.id)).orderBy(desc(tokens.createdAt)).all();

  return c.html(
    <TokensPage
      user={user}
      csrfToken={csrfToken}
      tokens={userTokens}
      teams={tokenTeamOptions(db, user.id)}
      isInstanceAdmin={isInstanceAdmin(user, config)}
      baseUrl={config.baseUrl}
    />,
  );
});

pageRoutes.post('/settings/tokens', sessionAuth({ redirect: true }), async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const config = c.get('config');
  const csrfToken = csrfTokenFor(c);

  const body = await c.req.parseBody();
  const label = typeof body['label'] === 'string' && body['label'].trim().length > 0 ? body['label'].trim() : 'MCP token';

  let teams = tokenTeamOptions(db, user.id);
  const requestedTeamId = typeof body['team_id'] === 'string' ? body['team_id'] : undefined;
  let team = requestedTeamId !== undefined ? teams.find((t) => t.id === requestedTeamId) : teams.length === 1 ? teams[0] : undefined;

  // Solo users aren't blocked on joining a team: their first token creates a
  // personal workspace to publish into.
  if (!team && teams.length === 0) {
    const personal = ensurePersonalTeam(db, user, new Date());
    teams = tokenTeamOptions(db, user.id);
    team = { id: personal.id, name: personal.name };
  }

  const render = (justCreated?: { plaintext: string }, error?: string) => {
    const userTokens = db.select().from(tokens).where(eq(tokens.userId, user.id)).orderBy(desc(tokens.createdAt)).all();
    return c.html(
      <TokensPage
        user={user}
        csrfToken={csrfToken}
        tokens={userTokens}
        teams={teams}
        isInstanceAdmin={isInstanceAdmin(user, config)}
        baseUrl={config.baseUrl}
        justCreated={justCreated}
        error={error}
      />,
    );
  };

  if (!team) {
    return render(undefined, 'Pick a team for this token.');
  }

  const { plaintext } = createToken(db, user.id, team.id, label, new Date());
  return render({ plaintext });
});

pageRoutes.get('/settings/profile', sessionAuth({ redirect: true }), (c) => {
  const user = c.get('user');
  return c.html(
    <ProfilePage
      user={user}
      csrfToken={csrfTokenFor(c)}
      isInstanceAdmin={isInstanceAdmin(user, c.get('config'))}
      avatarUrl={gravatarUrl(user.email)}
      saved={c.req.query('saved') !== undefined}
    />,
  );
});

pageRoutes.post('/settings/profile', sessionAuth({ redirect: true }), async (c) => {
  const db = c.get('db');
  const user = c.get('user');

  const body = await c.req.parseBody();
  const raw = typeof body['name'] === 'string' ? body['name'].trim().slice(0, 120) : '';
  db.update(users)
    .set({ name: raw.length > 0 ? raw : null })
    .where(eq(users.id, user.id))
    .run();

  return c.redirect('/settings/profile?saved', 302);
});

pageRoutes.post('/settings/tokens/:id/delete', sessionAuth({ redirect: true }), (c) => {
  const db = c.get('db');
  const user = c.get('user');
  revokeToken(db, user.id, c.req.param('id'));
  return c.redirect('/settings/tokens', 302);
});

pageRoutes.get('/static/app.css', (c) => {
  return c.text(appCss, 200, { 'content-type': 'text/css', 'cache-control': 'public, max-age=300' });
});
