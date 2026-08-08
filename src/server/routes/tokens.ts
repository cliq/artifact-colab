/**
 * Personal access token management API, used by the (not-yet-built) settings
 * page to mint/revoke tokens for MCP access. Mounted behind `sessionAuth`.
 */

import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';

import { createToken, revokeToken } from '../auth.js';
import type { AppEnv } from '../context.js';
import { getUserTeams } from '../services/teams.js';

const createTokenSchema = z.object({ label: z.string().min(1), team_id: z.string().min(1).optional() });

async function readBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const contentType = c.req.header('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return (await c.req.json()) as Record<string, unknown>;
  }
  return (await c.req.parseBody()) as Record<string, unknown>;
}

export const tokensRoutes = new Hono<AppEnv>();

tokensRoutes.post('/tokens', async (c) => {
  const parsed = createTokenSchema.safeParse(await readBody(c));
  if (!parsed.success) {
    return c.json({ error: 'label is required' }, 400);
  }

  const db = c.get('db');
  const user = c.get('user');

  // Tokens are team-scoped: team_id is required unless exactly one team makes
  // the choice unambiguous. Membership is checked so a token can't be minted
  // into someone else's team.
  const memberships = getUserTeams(db, user.id);
  const requested = parsed.data.team_id;
  const team =
    requested !== undefined
      ? memberships.find((m) => m.team.id === requested)?.team
      : memberships.length === 1
        ? memberships[0]!.team
        : undefined;
  if (!team) {
    return c.json({ error: requested !== undefined ? 'unknown team' : 'team_id is required' }, 400);
  }

  const { plaintext, id } = createToken(db, user.id, team.id, parsed.data.label, new Date());

  return c.json({ id, token: plaintext, team_id: team.id });
});

tokensRoutes.delete('/tokens/:id', (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const ok = revokeToken(db, user.id, c.req.param('id'));

  return c.json({ ok });
});
