/**
 * Hono environment typing shared across the app. `db` and `config` are
 * injected by the app factory's root middleware; `user` is set by whichever
 * auth middleware (`sessionAuth` or `bearerAuth`) guards a given route.
 */

import type { Config } from './config.js';
import type { DB } from './db/index.js';
import type { User } from './db/schema.js';

export type AppEnv = {
  Variables: {
    user: User;
    db: DB;
    config: Config;
    /** Set by bearerAuth: the authenticating token's team — bearer-authed lookups and publishes are scoped to it. */
    tokenTeamId: string;
    /** Set by csrfProtect on GETs; valid even on the visit that mints the cookie. */
    csrfToken?: string;
  };
};
