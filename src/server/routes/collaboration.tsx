import { getCookie } from 'hono/cookie';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';

import { getSessionUser } from '../auth.js';
import type { AppEnv } from '../context.js';
import { sendDocumentInvitation, sendEditPermissionRequest } from '../email.js';
import { csrfTokenFor, sessionAuth } from '../middleware.js';
import { Layout } from '../pages/layout.js';
import { resolveDocumentAccess, type DocumentAccess } from '../services/access.js';
import {
  acceptDocumentInvitation,
  beginEditPermissionRequest,
  changeCollaboratorRole,
  changeInvitationRole,
  clearFailedEditPermissionRequest,
  collaborationState,
  createDocumentInvitations,
  inspectDocumentInvitation,
  normalizeInvitationEmail,
  recordInvitationDelivery,
  resendDocumentInvitation,
  revokeDocumentCollaborator,
  revokeDocumentInvitation,
  takeCollaborationRateLimit,
} from '../services/collaboration.js';

const invitationInput = z.object({ email: z.string().max(320), role: z.enum(['viewer', 'editor']) });
const invitationsInput = z.object({ invitations: z.array(invitationInput).min(1).max(25) });
const roleInput = z.object({ role: z.enum(['viewer', 'editor']) });

type OwnerAuthorization = { access: DocumentAccess } | { response: Response };

function ownerAccess(c: Context<AppEnv>, slug: string): OwnerAuthorization {
  const access = resolveDocumentAccess(c.get('db'), slug, c.get('user').id);
  if (!access) return { response: c.json({ error: 'not found' }, 404) };
  if (!access.canManageAccess) return { response: c.json({ error: 'forbidden' }, 403) };
  return { access };
}

function invitationForJson(invitation: ReturnType<typeof collaborationState>['invitations'][number]) {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    status: invitation.status,
    deliveryStatus: invitation.deliveryStatus,
    createdAt: invitation.createdAt,
    updatedAt: invitation.updatedAt,
    expiresAt: invitation.expiresAt,
    acceptedBy: invitation.acceptedBy,
    acceptedAt: invitation.acceptedAt,
    lastDeliveryAt: invitation.lastDeliveryAt,
  };
}

function stateForJson(state: ReturnType<typeof collaborationState>) {
  return { invitations: state.invitations.map(invitationForJson), collaborators: state.collaborators };
}

export const collaborationRoutes = new Hono<AppEnv>();

collaborationRoutes.use('/api/docs/*', sessionAuth({ redirect: false }));

collaborationRoutes.get('/api/docs/:slug/collaborators', (c) => {
  const authorization = ownerAccess(c, c.req.param('slug'));
  if ('response' in authorization) return authorization.response;
  const rechecked = ownerAccess(c, c.req.param('slug'));
  if ('response' in rechecked) return rechecked.response;
  return c.json(stateForJson(collaborationState(c.get('db'), rechecked.access.document.id)));
});

collaborationRoutes.post('/api/docs/:slug/invitations', async (c) => {
  const slug = c.req.param('slug');
  let authorization = ownerAccess(c, slug);
  if ('response' in authorization) return authorization.response;
  const parsed = invitationsInput.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: 'invalid invitations' }, 400);
  authorization = ownerAccess(c, slug);
  if ('response' in authorization) return authorization.response;
  const access = authorization.access;
  const db = c.get('db');
  const user = c.get('user');
  const now = new Date();
  if (!takeCollaborationRateLimit(db, 'invite', user.id, now)) return c.json({ error: 'rate_limited' }, 429);

  const created = createDocumentInvitations(db, slug, user, parsed.data.invitations, now);
  const results = await Promise.all(
    created.map(async (result) => {
      if (!result.ok) return result;
      const delivery = await sendDocumentInvitation(
        c.get('config'),
        result.email,
        user.email,
        access.document.title,
        result.invitation.role,
        result.token,
      );
      recordInvitationDelivery(db, result.invitation.id, result.invitation.tokenHash, delivery.ok, new Date());
      return {
        email: result.email,
        ok: true as const,
        id: result.invitation.id,
        status: result.invitation.status,
        deliveryStatus: delivery.ok ? 'sent' : 'failed',
      };
    }),
  );
  const rechecked = ownerAccess(c, slug);
  if ('response' in rechecked) return rechecked.response;
  return c.json({ results, ...stateForJson(collaborationState(db, slug)) });
});

collaborationRoutes.post('/api/docs/:slug/invitations/:id/resend', async (c) => {
  await c.req.text();
  const slug = c.req.param('slug');
  const authorization = ownerAccess(c, slug);
  if ('response' in authorization) return authorization.response;
  const access = authorization.access;
  const db = c.get('db');
  const user = c.get('user');
  if (!takeCollaborationRateLimit(db, 'resend', user.id)) return c.json({ error: 'rate_limited' }, 429);
  const result = resendDocumentInvitation(db, slug, c.req.param('id'), user.id);
  if (!result.ok) {
    const status = result.error === 'cooldown' ? 429 : result.error === 'not_found' ? 404 : 409;
    return c.json({ error: result.error }, status);
  }
  const delivery = await sendDocumentInvitation(
    c.get('config'),
    result.invitation.email,
    user.email,
    access.document.title,
    result.invitation.role,
    result.token,
  );
  recordInvitationDelivery(db, result.invitation.id, result.invitation.tokenHash, delivery.ok);
  const rechecked = ownerAccess(c, slug);
  if ('response' in rechecked) return rechecked.response;
  const invitation = collaborationState(db, slug).invitations.find((row) => row.id === result.invitation.id);
  if (!invitation) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true, invitation: invitationForJson(invitation) });
});

collaborationRoutes.patch('/api/docs/:slug/invitations/:id', async (c) => {
  const slug = c.req.param('slug');
  let authorization = ownerAccess(c, slug);
  if ('response' in authorization) return authorization.response;
  const parsed = roleInput.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: 'invalid role' }, 400);
  authorization = ownerAccess(c, slug);
  if ('response' in authorization) return authorization.response;
  const result = changeInvitationRole(c.get('db'), slug, c.req.param('id'), c.get('user').id, parsed.data.role);
  if (!result.ok) return c.json({ error: result.error }, result.error === 'not_found' ? 404 : 409);
  return c.json(result);
});

collaborationRoutes.delete('/api/docs/:slug/invitations/:id', async (c) => {
  await c.req.text();
  const slug = c.req.param('slug');
  const authorization = ownerAccess(c, slug);
  if ('response' in authorization) return authorization.response;
  const ok = revokeDocumentInvitation(c.get('db'), slug, c.req.param('id'), c.get('user').id);
  return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
});

collaborationRoutes.patch('/api/docs/:slug/collaborators/:userId', async (c) => {
  const slug = c.req.param('slug');
  let authorization = ownerAccess(c, slug);
  if ('response' in authorization) return authorization.response;
  const parsed = roleInput.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: 'invalid role' }, 400);
  authorization = ownerAccess(c, slug);
  if ('response' in authorization) return authorization.response;
  const collaborator = changeCollaboratorRole(
    c.get('db'),
    slug,
    c.req.param('userId'),
    c.get('user').id,
    parsed.data.role,
  );
  return collaborator ? c.json({ ok: true, collaborator }) : c.json({ error: 'not found' }, 404);
});

collaborationRoutes.delete('/api/docs/:slug/collaborators/:userId', async (c) => {
  await c.req.text();
  const slug = c.req.param('slug');
  const authorization = ownerAccess(c, slug);
  if ('response' in authorization) return authorization.response;
  const ok = revokeDocumentCollaborator(c.get('db'), slug, c.req.param('userId'), c.get('user').id);
  return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
});

collaborationRoutes.post('/api/docs/:slug/request-edit', async (c) => {
  await c.req.text();
  const slug = c.req.param('slug');
  const db = c.get('db');
  const user = c.get('user');
  const access = resolveDocumentAccess(db, slug, user.id);
  if (!access) return c.json({ error: 'not found' }, 404);
  if (!access.canRequestEdit) return c.json({ error: 'not_allowed' }, 403);
  if (!takeCollaborationRateLimit(db, 'editRequest', user.id)) return c.json({ error: 'rate_limited' }, 429);
  const now = new Date();
  const request = beginEditPermissionRequest(db, slug, user.id, now);
  if (!request.ok) return c.json({ error: request.error }, request.error === 'cooldown' ? 429 : 403);
  const delivery = await sendEditPermissionRequest(
    c.get('config'),
    request.ownerEmail,
    user.email,
    request.documentTitle,
    slug,
  );
  if (!delivery.ok) {
    clearFailedEditPermissionRequest(db, slug, user.id, now);
    return c.json({ error: "couldn't send request, try again" }, 503);
  }
  return c.json({ ok: true });
});

collaborationRoutes.get('/invitations/:token', (c) => {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  const token = c.req.param('token');
  const inspection = inspectDocumentInvitation(c.get('db'), token);
  const sessionToken = getCookie(c, 'session');
  const user = sessionToken ? getSessionUser(c.get('db'), sessionToken, new Date()) : null;
  const next = `/invitations/${encodeURIComponent(token)}`;

  if (inspection.kind !== 'available') {
    return c.html(
      <Layout title="Invitation unavailable" csrfToken={csrfTokenFor(c)}>
        <div class="card form-card">
          <h1>Invitation unavailable</h1>
          <p>This invitation is invalid, expired, cancelled, or no longer available.</p>
        </div>
      </Layout>,
      404,
    );
  }
  if (!user) {
    return c.html(
      <Layout title="Artifact invitation" csrfToken={csrfTokenFor(c)}>
        <div class="card form-card">
          <h1>You’ve been invited</h1>
          <p>Sign in with the email address that received this invitation to continue.</p>
          <a class="button" href={`/signin?next=${encodeURIComponent(next)}`}>Sign in to continue</a>
        </div>
      </Layout>,
    );
  }
  if (normalizeInvitationEmail(user.email) !== inspection.invitation.email) {
    return c.html(
      <Layout title="Switch account" csrfToken={csrfTokenFor(c)}>
        <div class="card form-card">
          <h1>Use the invited account</h1>
          <p>This invitation was sent to {inspection.invitation.email}. You’re signed in as {user.email}.</p>
          <a class="button" href={`/signin?next=${encodeURIComponent(next)}`}>Sign in with another account</a>
        </div>
      </Layout>,
      403,
    );
  }
  return c.html(
    <Layout title="Accept invitation" csrfToken={csrfTokenFor(c)}>
      <div class="card form-card">
        <h1>Accept artifact invitation</h1>
        <p>You’ll join this artifact as a {inspection.invitation.role === 'editor' ? 'Editor' : 'Viewer'}.</p>
        <form method="post" action={next}>
          <input type="hidden" name="_csrf" value={csrfTokenFor(c)} />
          <button type="submit">Accept invitation</button>
        </form>
      </div>
    </Layout>,
  );
});

collaborationRoutes.post('/invitations/:token', sessionAuth({ redirect: true }), async (c) => {
  await c.req.text();
  const result = acceptDocumentInvitation(c.get('db'), c.req.param('token'), c.get('user'));
  if (result.ok) return c.redirect(`/d/${encodeURIComponent(result.slug)}`, 303);
  if (result.error === 'wrong_account') return c.json({ error: 'wrong account' }, 403);
  return c.json({ error: 'invitation unavailable' }, result.error === 'not_found' ? 404 : 409);
});
