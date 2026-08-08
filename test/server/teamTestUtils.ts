/**
 * Shared fixtures for the teams model: most integration tests want "a team
 * whose domain auto-joins" so that `getOrCreateUser` gives users a membership
 * the way a real sign-in would.
 */

import type { Config } from '../../src/server/config.js';
import { teamDomains, teams, type DB } from '../../src/server/db/index.js';

export function baseTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    databasePath: ':memory:',
    resendApiKey: '',
    emailFrom: 'noreply@example.com',
    instanceAdminEmails: [],
    baseUrl: 'http://localhost:3000',
    port: 3000,
    selfSignup: false,
    frameCdnAllowlist: [],
    ...overrides,
  };
}

/** Creates a team with an auto-join domain, so `getOrCreateUser('x@<domain>')` joins it. Returns the team id. */
export function seedTeamWithDomain(db: DB, id: string, domain: string, name = domain): string {
  const now = new Date();
  db.insert(teams).values({ id, name, createdAt: now }).run();
  db.insert(teamDomains).values({ domain, teamId: id, createdAt: now }).run();
  return id;
}
