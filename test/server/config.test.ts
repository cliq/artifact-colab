// @vitest-environment node

/**
 * loadConfig guardrails. DEV_LOGIN_CODE turns email verification off — with
 * it set, anyone who knows the code can sign in as any existing user — so a
 * production process must refuse to boot with it rather than trusting deploy
 * hygiene (the Dockerfile sets NODE_ENV=production).
 */

import { describe, expect, test } from 'vitest';

import { loadConfig } from '../../src/server/config.js';

describe('loadConfig DEV_LOGIN_CODE guard', () => {
  test('refuses to boot in production with DEV_LOGIN_CODE set', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', DEV_LOGIN_CODE: '123456' })).toThrow(/DEV_LOGIN_CODE/);
  });

  test('allows the code outside production', () => {
    expect(loadConfig({ DEV_LOGIN_CODE: '123456' }).devLoginCode).toBe('123456');
  });

  test('a blank DEV_LOGIN_CODE counts as unset — "" must never become a valid sign-in code', () => {
    expect(loadConfig({ DEV_LOGIN_CODE: '' }).devLoginCode).toBeUndefined();
    expect(() => loadConfig({ NODE_ENV: 'production', DEV_LOGIN_CODE: '' })).not.toThrow();
  });

  test('production without the code boots normally', () => {
    expect(loadConfig({ NODE_ENV: 'production' }).devLoginCode).toBeUndefined();
  });
});
