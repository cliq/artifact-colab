# syntax=docker/dockerfile:1

# --- Build stage ---------------------------------------------------------
# better-sqlite3 ships prebuilt binaries for glibc (linux x64/arm64), not
# musl, so both stages use a Debian-based image instead of Alpine.
FROM node:22-bookworm-slim AS build

# Toolchain for native modules: better-sqlite3 compiles from source when no
# prebuilt binary matches the platform/Node ABI. Build stage only — the
# runtime stage copies the already-built node_modules.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Drop devDependencies now that the build output exists, so only the
# production node_modules gets copied into the runtime stage.
RUN npm prune --omit=dev

# --- Runtime stage --------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    DATABASE_PATH=/data/app.db \
    PORT=3000

# Create the volume mount point and hand it to the base image's unprivileged
# "node" user before dropping root, so the app can create/open the SQLite
# file at container start.
RUN mkdir -p /data && chown -R node:node /data

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/drizzle ./drizzle
COPY --from=build --chown=node:node /app/package.json ./package.json

VOLUME /data
EXPOSE 3000

USER node

CMD ["node", "dist/server/server/index.js"]
