/**
 * Authentication service functions: login codes (email OTP), sessions
 * (cookie-based), and personal access tokens (bearer, used by /mcp). Nothing
 * here talks to HTTP directly — routes and middleware call into these.
 *
 * Secrets are never stored in plaintext: login codes, session tokens, and
 * access tokens are all hashed with SHA-256 before hitting the database, and
 * comparisons use `timingSafeEqual` to avoid leaking timing information.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { and, desc, eq, gte, lt } from 'drizzle-orm';

import type { DB } from './db/index.js';
import { loginCodes, sessions, teamMembers, tokens, users, type Token, type User } from './db/schema.js';
import { materializeMemberships } from './services/teams.js';

const LOGIN_CODE_TTL_MS = 10 * 60 * 1000;
const LOGIN_CODE_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const LOGIN_CODE_RATE_LIMIT_MAX = 10;
const LOGIN_CODE_MAX_ATTEMPTS = 5;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function randomId(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function generateLoginCode(db: DB, email: string, now: Date): { code: string } | { error: 'rate_limited' } {
  const windowStart = new Date(now.getTime() - LOGIN_CODE_RATE_LIMIT_WINDOW_MS);
  const recent = db
    .select()
    .from(loginCodes)
    .where(and(eq(loginCodes.email, email), gte(loginCodes.createdAt, windowStart)))
    .all();

  if (recent.length >= LOGIN_CODE_RATE_LIMIT_MAX) {
    return { error: 'rate_limited' };
  }

  const num = randomBytes(4).readUInt32BE(0) % 1_000_000;
  const code = String(num).padStart(6, '0');
  const id = randomId();

  db.insert(loginCodes)
    .values({
      id,
      email,
      codeHash: sha256hex(code),
      expiresAt: new Date(now.getTime() + LOGIN_CODE_TTL_MS),
      attempts: 0,
      createdAt: now,
    })
    .run();

  // Garbage-collect codes old enough to fall outside the rate-limit window;
  // codes still inside it are kept so the count check above stays accurate.
  db.delete(loginCodes)
    .where(and(eq(loginCodes.email, email), lt(loginCodes.createdAt, windowStart)))
    .run();

  return { code };
}

export function verifyLoginCode(
  db: DB,
  email: string,
  code: string,
  now: Date,
): { ok: true } | { error: 'invalid' | 'expired' | 'locked' } {
  const [row] = db.select().from(loginCodes).where(eq(loginCodes.email, email)).orderBy(desc(loginCodes.createdAt)).limit(1).all();

  if (!row) {
    return { error: 'invalid' };
  }
  if (row.expiresAt.getTime() < now.getTime()) {
    return { error: 'expired' };
  }
  if (row.attempts >= LOGIN_CODE_MAX_ATTEMPTS) {
    return { error: 'locked' };
  }

  if (!safeEqualHex(row.codeHash, sha256hex(code))) {
    db.update(loginCodes)
      .set({ attempts: row.attempts + 1 })
      .where(eq(loginCodes.id, row.id))
      .run();
    return { error: 'invalid' };
  }

  db.delete(loginCodes).where(eq(loginCodes.id, row.id)).run();
  return { ok: true };
}

/**
 * Fetches or creates the user, then materializes team memberships (pending
 * invites convert, the email's domain team auto-joins) — on every sign-in,
 * so a domain attached later pulls in existing users the next time they
 * verify a code.
 */
export function getOrCreateUser(db: DB, email: string, now: Date): User {
  const normalized = email.trim().toLowerCase();

  return db.transaction((tx) => {
    let user = tx.select().from(users).where(eq(users.email, normalized)).get();
    if (!user) {
      user = tx
        .insert(users)
        .values({ id: randomId(8), email: normalized, createdAt: now })
        .returning()
        .get();
    }
    materializeMemberships(tx, user, now);
    return user;
  });
}

export function createSession(db: DB, userId: string, now: Date): { token: string } {
  const token = randomBytes(32).toString('hex');

  db.insert(sessions)
    .values({ id: sha256hex(token), userId, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) })
    .run();

  return { token };
}

export function getSessionUser(db: DB, token: string, now: Date): User | null {
  const id = sha256hex(token);
  const [session] = db.select().from(sessions).where(eq(sessions.id, id)).all();
  if (!session) {
    return null;
  }
  if (session.expiresAt.getTime() < now.getTime()) {
    db.delete(sessions).where(eq(sessions.id, id)).run();
    return null;
  }

  const [user] = db.select().from(users).where(eq(users.id, session.userId)).all();
  return user ?? null;
}

export function deleteSession(db: DB, token: string): void {
  db.delete(sessions).where(eq(sessions.id, sha256hex(token))).run();
}

export function createToken(db: DB, userId: string, teamId: string, label: string, now: Date): { plaintext: string; id: string } {
  const plaintext = `acp_${randomBytes(32).toString('hex')}`;
  const id = randomId(8);

  db.insert(tokens)
    .values({ id, userId, teamId, tokenHash: sha256hex(plaintext), label, createdAt: now, lastUsedAt: null })
    .run();

  return { plaintext, id };
}

export function revokeToken(db: DB, userId: string, tokenId: string): boolean {
  const result = db.delete(tokens).where(and(eq(tokens.id, tokenId), eq(tokens.userId, userId))).run();
  return result.changes > 0;
}

/**
 * Resolves a bearer token to its user AND the token row — publishes are
 * scoped by the token's team, not the user. The owner must still be a member
 * of that team: removal revokes the team's tokens, but a token that survived
 * (e.g. a partially applied manual cleanup) must not outlive the membership.
 */
export function getTokenAuth(db: DB, bearer: string, now: Date): { user: User; token: Token } | null {
  const tokenHash = sha256hex(bearer);
  const [token] = db.select().from(tokens).where(eq(tokens.tokenHash, tokenHash)).all();
  if (!token) {
    return null;
  }

  const membership = db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, token.teamId), eq(teamMembers.userId, token.userId)))
    .get();
  if (!membership) {
    return null;
  }

  db.update(tokens).set({ lastUsedAt: now }).where(eq(tokens.id, token.id)).run();

  const [user] = db.select().from(users).where(eq(users.id, token.userId)).all();
  return user ? { user, token } : null;
}
