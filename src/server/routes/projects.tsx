import { and, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../context.js';
import { teamMembers, teams } from '../db/schema.js';
import { documentsView } from '../documentsView.js';
import { csrfTokenFor, sessionAuth } from '../middleware.js';
import { ProjectPage } from '../pages/project.js';
import { safeLocalPath } from '../safeRedirect.js';
import { resolveDocumentAccess } from '../services/access.js';
import { documentRowsForTeam } from '../services/documentLists.js';
import { createProject, deleteProject, getProjectForUser, moveArtifact, ProjectError, renameProject, visibleProjectsForTeam } from '../services/projects.js';
import { isInstanceAdmin } from '../services/teams.js';

export const projectRoutes = new Hono<AppEnv>();

function privateResponse(c: Context<AppEnv>): void {
  c.header('Cache-Control', 'private, no-store');
}

async function readObject(c: Context<AppEnv>): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = await c.req.json();
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function mutation(c: Context<AppEnv>, run: () => Record<string, unknown>) {
  privateResponse(c);
  try { return c.json(run()); }
  catch (error) {
    if (error instanceof ProjectError) return c.json({ error: error.message }, error.status);
    throw error;
  }
}

projectRoutes.get('/p/:id', sessionAuth({ redirect: true }), (c) => {
  privateResponse(c);
  const db = c.get('db');
  const user = c.get('user');
  const project = getProjectForUser(db, c.req.param('id'), user.id);
  if (!project) return c.notFound();
  const team = db.select({ name: teams.name }).from(teams).where(eq(teams.id, project.teamId)).get()!;
  return c.html(<ProjectPage user={user} csrfToken={csrfTokenFor(c)}
    isInstanceAdmin={isInstanceAdmin(user, c.get('config'))} project={project} teamName={team.name}
    documents={documentRowsForTeam(db, project.teamId, user.id, [project], project.id)} view={documentsView(c)} />);
});

projectRoutes.get('/api/teams/:teamId/projects', sessionAuth({ redirect: false }), (c) => {
  privateResponse(c);
  const db = c.get('db');
  const teamId = c.req.param('teamId');
  const userId = c.get('user').id;
  if (!db.select().from(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId))).get()) return c.json({ error: 'not found' }, 404);
  return c.json({ projects: visibleProjectsForTeam(db, teamId, userId) });
});

projectRoutes.post('/api/teams/:teamId/projects', sessionAuth({ redirect: false }), async (c) => {
  privateResponse(c);
  const body = await readObject(c);
  if (!body || (body.document_id !== undefined && (typeof body.document_id !== 'string' || !body.document_id))) return c.json({ error: 'expected a name and optional document_id' }, 400);
  return mutation(c, () => {
    const db = c.get('db');
    const userId = c.get('user').id;
    const documentId = body.document_id as string | undefined;
    const sourceId = documentId ? resolveDocumentAccess(db, documentId, userId)?.document.projectId : undefined;
    const project = createProject(db, c.req.param('teamId'), userId, body.name, documentId);
    const returnUrl = sourceId && !getProjectForUser(db, sourceId, userId) ? `/?view=${documentsView(c)}` : undefined;
    return { project, ...(returnUrl ? { returnUrl } : {}) };
  });
});

projectRoutes.patch('/api/projects/:id', sessionAuth({ redirect: false }), async (c) => {
  privateResponse(c);
  const body = await readObject(c);
  if (!body) return c.json({ error: 'expected a project name' }, 400);
  return mutation(c, () => ({ project: renameProject(c.get('db'), c.req.param('id'), c.get('user').id, body.name) }));
});

projectRoutes.delete('/api/projects/:id', sessionAuth({ redirect: false }), async (c) => {
  await c.req.text();
  return mutation(c, () => {
    deleteProject(c.get('db'), c.req.param('id'), c.get('user').id);
    return { ok: true };
  });
});

projectRoutes.patch('/api/docs/:slug/project', sessionAuth({ redirect: false }), async (c) => {
  privateResponse(c);
  const body = await readObject(c);
  if (!body || !Object.hasOwn(body, 'project')) return c.json({ error: 'project is required (a name or null for Unfiled)' }, 400);
  const db = c.get('db');
  const userId = c.get('user').id;
  const access = resolveDocumentAccess(db, c.req.param('slug'), userId);
  if (!access) return c.json({ error: 'not found' }, 404);
  return mutation(c, () => {
    const sourceId = access.document.projectId;
    const project = moveArtifact(db, access.document.id, access.document.teamId, userId, body.project);
    const returnUrl = sourceId && !getProjectForUser(db, sourceId, userId)
      ? safeLocalPath(`/?view=${documentsView(c)}`) ?? '/' : undefined;
    return { project, ...(returnUrl ? { returnUrl } : {}) };
  });
});
