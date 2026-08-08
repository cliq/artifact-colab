/**
 * Loads runtime configuration from environment variables, applying the
 * defaults used for local development. See `.env.example` for the full list
 * of variables this reads.
 */

const DEFAULT_FRAME_CDN_ALLOWLIST = [
  'cdn.tailwindcss.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

export interface Config {
  databasePath: string;
  resendApiKey: string;
  emailFrom: string;
  /**
   * Bootstrap instance admins (lowercased emails). They can always sign in
   * and can never be demoted from the UI — the recovery path if every
   * UI-promoted admin is gone.
   */
  instanceAdminEmails: string[];
  baseUrl: string;
  port: number;
  /**
   * When true, anyone may sign up: the sign-in code gate opens to any email,
   * and new users with no team get a first-run wizard to create their own.
   * Default off — upgrading a locked-down instance changes nothing.
   */
  selfSignup: boolean;
  frameCdnAllowlist: string[];
  devLoginCodeFile?: string;
  /**
   * Dev-only escape hatch: when set (e.g. "123456"), verify-code accepts this
   * exact code for any allowed-domain email without a code ever being
   * requested. Never set this in production.
   */
  devLoginCode?: string;
  /** Dev/test-only: append digest emails to this file (JSON lines) instead of sending via Resend. */
  devEmailFile?: string;
}

function parseCommaSeparated(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const frameCdnAllowlist = env.FRAME_CDN_ALLOWLIST
    ? parseCommaSeparated(env.FRAME_CDN_ALLOWLIST)
    : DEFAULT_FRAME_CDN_ALLOWLIST;

  if (env.ALLOWED_DOMAINS) {
    console.warn('ALLOWED_DOMAINS is no longer used — manage teams and auto-join domains from /admin instead.');
  }

  // The fixed code skips email verification entirely: anyone who knows it can
  // sign in as any existing user and read every team's artifacts. Fail closed
  // rather than trusting deploy hygiene ("" also must not become a valid
  // code, so blank counts as unset).
  const devLoginCode = env.DEV_LOGIN_CODE || undefined;
  if (devLoginCode !== undefined && env.NODE_ENV === 'production') {
    throw new Error('DEV_LOGIN_CODE is a development-only sign-in bypass and must not be set in production');
  }

  return {
    databasePath: env.DATABASE_PATH ?? './data/app.db',
    resendApiKey: env.RESEND_API_KEY ?? '',
    emailFrom: env.EMAIL_FROM ?? '',
    instanceAdminEmails: parseCommaSeparated(env.INSTANCE_ADMIN_EMAILS),
    baseUrl: env.BASE_URL ?? 'http://localhost:3000',
    port: env.PORT ? Number(env.PORT) : 3000,
    selfSignup: env.SELF_SIGNUP === 'true',
    frameCdnAllowlist,
    devLoginCodeFile: env.DEV_LOGIN_CODE_FILE,
    devLoginCode,
    devEmailFile: env.DEV_EMAIL_FILE,
  };
}
