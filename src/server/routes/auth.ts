/**
 * Sign-in flow: request a one-time code by email, verify it to establish a
 * session, and sign out. Deliberately avoids leaking whether an email's
 * domain is allowed — disallowed domains get the exact same response as a
 * successful code request.
 */

import type { Context } from 'hono';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';

import { createSession, deleteSession, generateLoginCode, getOrCreateUser, verifyLoginCode } from '../auth.js';
import type { AppEnv } from '../context.js';
import { sendLoginCode } from '../email.js';
import { canRequestCode } from '../services/teams.js';
import { clearSessionCookie, setSessionCookie } from '../middleware.js';
import { safeLocalPath } from '../safeRedirect.js';

const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const requestCodeSchema = z.object({ email: z.email() });
const verifyCodeSchema = z.object({ email: z.email(), code: z.string(), next: z.string().optional() });

function isFormRequest(c: Context<AppEnv>): boolean {
  const contentType = c.req.header('content-type') ?? '';
  return !contentType.includes('application/json');
}

async function readBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  if (isFormRequest(c)) {
    return (await c.req.parseBody()) as Record<string, unknown>;
  }
  return (await c.req.json()) as Record<string, unknown>;
}

export const authRoutes = new Hono<AppEnv>();

authRoutes.post('/auth/request-code', async (c) => {
  const parsed = requestCodeSchema.safeParse(await readBody(c));
  if (!parsed.success) {
    return c.json({ error: 'invalid email' }, 400);
  }

  const email = parsed.data.email.trim().toLowerCase();
  const db = c.get('db');
  const config = c.get('config');

  if (!canRequestCode(db, config, email)) {
    return c.json({ ok: true });
  }

  const result = generateLoginCode(db, email, new Date());
  if ('error' in result) {
    return c.json({ error: result.error }, 429);
  }

  const sent = await sendLoginCode(config, email, result.code);
  if (!sent.ok) {
    return c.json({ error: "couldn't send email, try again" }, 503);
  }

  return c.json({ ok: true });
});

authRoutes.post('/auth/verify-code', async (c) => {
  const parsed = verifyCodeSchema.safeParse(await readBody(c));
  if (!parsed.success) {
    return c.json({ error: 'invalid' }, 400);
  }

  const { code, next } = parsed.data;
  const email = parsed.data.email.trim().toLowerCase();
  const db = c.get('db');
  const config = c.get('config');
  const now = new Date();

  // Dev-only fixed code (DEV_LOGIN_CODE): accepted without a stored code,
  // but still gated by the sign-in rules. Never enabled in production.
  const devBypass = config.devLoginCode !== undefined && code === config.devLoginCode;
  if (devBypass && !canRequestCode(db, config, email)) {
    return c.json({ error: 'invalid' }, 400);
  }
  if (!devBypass) {
    const result = verifyLoginCode(db, email, code, now);
    if ('error' in result) {
      return c.json({ error: result.error }, 400);
    }
  }

  const user = getOrCreateUser(db, email, now);
  const session = createSession(db, user.id, now);
  setSessionCookie(c, session.token, SESSION_MAX_AGE_SECONDS);

  const safeNext = safeLocalPath(next);

  if (isFormRequest(c)) {
    return c.redirect(safeNext ?? '/', 302);
  }
  // JSON callers (the sign-in page's fetch) can't use a 302 — fetch would
  // follow it into HTML and the client's res.json() would throw.
  return c.json({ ok: true, redirect: safeNext ?? '/' });
});

authRoutes.post('/auth/signout', async (c) => {
  const db = c.get('db');
  const token = getCookie(c, 'session');
  if (token) {
    deleteSession(db, token);
  }
  clearSessionCookie(c);
  return c.redirect('/signin', 302);
});
