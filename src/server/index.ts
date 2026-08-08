/**
 * Process entrypoint: loads config, opens the database (running migrations),
 * builds the app, starts the HTTP server, and runs the comment-digest sweep
 * on an interval.
 */

import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { sendDigest } from './email.js';
import { runDigestSweep } from './services/watches.js';

const DIGEST_SWEEP_INTERVAL_MS = 60 * 1000;

const config = loadConfig();
const { db } = openDb(config.databasePath);
const app = createApp({ db, config });

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Listening on http://localhost:${info.port}`);
});

// The sweep itself decides what is due (documents quiet for 5 minutes with
// unseen comments); the interval only sets how promptly that fires.
setInterval(() => {
  runDigestSweep(db, config.baseUrl, (email) => sendDigest(config, email.to, email.subject, email.text)).catch(
    (err) => console.error('Digest sweep failed:', err),
  );
}, DIGEST_SWEEP_INTERVAL_MS).unref();
