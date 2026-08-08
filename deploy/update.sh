#!/usr/bin/env bash
# Redeploy after pushing changes: pull, rebuild the image, swap the container.
# The SQLite volume and Caddy (and its certificates) are untouched.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ $EUID -eq 0 ]]; then
	echo "Run this as your regular user, not with sudo: git pull needs your" >&2
	echo "SSH key, and the docker group already lets you manage the stack." >&2
	exit 1
fi

git pull --ff-only
docker compose up -d --build
docker compose ps
