#!/usr/bin/env bash
# Set up Artifact Colab as an MCP server for Claude Code — entirely from the
# terminal. Signs you in with an email code, mints a personal access token,
# and runs `claude mcp add` with it.
#
# Usage: scripts/mcp-setup.sh [BASE_URL]
#   BASE_URL defaults to http://localhost:3000

set -euo pipefail

BASE_URL="${1:-http://localhost:3000}"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

command -v claude >/dev/null || { echo "error: claude CLI not found on PATH" >&2; exit 1; }
command -v curl >/dev/null || { echo "error: curl not found" >&2; exit 1; }

read -r -p "Email: " EMAIL

echo "Requesting a sign-in code for $EMAIL ..."
curl -sf -X POST "$BASE_URL/auth/request-code" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\"}" >/dev/null

echo "Check your email for the 6-digit code."
echo "(Dev instances: DEV_LOGIN_CODE if set, or the DEV_LOGIN_CODE_FILE log.)"
read -r -p "Code: " CODE

VERIFY=$(curl -s -c "$JAR" -X POST "$BASE_URL/auth/verify-code" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"code\":\"$CODE\"}")
echo "$VERIFY" | grep -q '"ok":true' || { echo "sign-in failed: $VERIFY" >&2; exit 1; }

# A GET issues the csrf cookie needed for the token-creation POST.
curl -s -b "$JAR" -c "$JAR" -o /dev/null "$BASE_URL/healthz"
CSRF=$(awk '$6=="csrf" {print $7}' "$JAR")

LABEL="claude-code-$(hostname -s 2>/dev/null || echo cli)"
TOKEN_JSON=$(curl -s -b "$JAR" -X POST "$BASE_URL/tokens" \
  -H 'content-type: application/json' \
  -H "x-csrf-token: $CSRF" \
  -d "{\"label\":\"$LABEL\"}")
TOKEN=$(echo "$TOKEN_JSON" | sed -n 's/.*"token":"\(acp_[a-f0-9]*\)".*/\1/p')
[ -n "$TOKEN" ] || { echo "token creation failed: $TOKEN_JSON" >&2; exit 1; }

echo "Created token \"$LABEL\". Registering MCP server ..."
claude mcp remove artifact-colab >/dev/null 2>&1 || true
claude mcp add --transport http artifact-colab "$BASE_URL/mcp" \
  --header "Authorization: Bearer $TOKEN"

echo
echo "Done. Restart your Claude Code session (or run /mcp) to connect."
