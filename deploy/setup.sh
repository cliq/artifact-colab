#!/usr/bin/env bash
# One-shot production setup for Artifact Colab on Debian.
# Installs Docker Engine + Compose from Docker's official apt repo,
# then builds and starts the stack (app + Caddy reverse proxy).
# Run as root: sudo bash deploy/setup.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The non-root user to add to the docker group. Defaults to whoever invoked
# sudo; override with DEPLOY_USER=someuser when running as root directly.
DEPLOY_USER="${DEPLOY_USER:-${SUDO_USER:-}}"

if [[ $EUID -ne 0 ]]; then
	echo "This script must run as root (sudo bash deploy/setup.sh)" >&2
	exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
	echo "==> Installing Docker Engine from download.docker.com"
	apt-get update
	apt-get install -y --no-install-recommends ca-certificates curl gnupg
	install -m 0755 -d /etc/apt/keyrings
	curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
	chmod a+r /etc/apt/keyrings/docker.asc
	echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
		> /etc/apt/sources.list.d/docker.list
	apt-get update
	apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
	echo "==> Docker already installed, skipping"
fi

systemctl enable --now docker

# Let the regular user manage the stack without sudo (takes effect on next login)
if [[ -n "$DEPLOY_USER" ]]; then
	usermod -aG docker "$DEPLOY_USER"
else
	echo "==> No DEPLOY_USER/SUDO_USER detected — skipping docker group setup." >&2
	echo "    Run: usermod -aG docker <youruser>" >&2
fi

echo "==> Building and starting the stack"
cd "$APP_DIR"
docker compose up -d --build

echo
docker compose ps
echo
echo "Done. App is behind Caddy on ports 80/443."
echo "TLS certificates will be issued automatically once DNS for \$DOMAIN"
echo "(set in .env) points at this host."
if [[ -n "$DEPLOY_USER" ]]; then
	echo "Note: '$DEPLOY_USER' was added to the docker group — log out/in for it to apply."
fi
