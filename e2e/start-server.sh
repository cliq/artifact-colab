#!/usr/bin/env bash
# Builds the annotator/client bundles the server reads at runtime, then boots
# the app against a scratch database/codes file under test-results/ (which is
# gitignored) so e2e runs never touch real dev data.
set -euo pipefail

cd "$(dirname "$0")/.."

TMP=test-results/e2e-tmp
rm -rf "$TMP"
mkdir -p "$TMP"

# Clear out any leftover server from a previous interrupted run (xargs -r is
# a GNU extension, so guard with a count check for portability on macOS).
if lsof -ti :3789 >/dev/null 2>&1; then
  lsof -ti :3789 | xargs kill 2>/dev/null || true
fi

npm run build:annotator
npm run build:client

exec env \
  DATABASE_PATH="$TMP/app.db" \
  DEV_LOGIN_CODE_FILE="$TMP/codes.log" \
  DEV_EMAIL_FILE="$TMP/emails.log" \
  INSTANCE_ADMIN_EMAILS=alice@example.com \
  SELF_SIGNUP=true \
  BASE_URL=http://localhost:3789 \
  PORT=3789 \
  npx tsx src/server/index.ts
