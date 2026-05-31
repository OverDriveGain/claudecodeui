# syntax=docker/dockerfile:1

# ---------- builder ----------
# Native modules (better-sqlite3, node-pty, bcrypt) are compiled here, so the
# builder needs a full toolchain. The runtime stage then reuses the compiled
# node_modules (same Node 22 / Debian bookworm ABI).
FROM node:22-bookworm AS builder
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
# the postinstall hook (scripts/fix-node-pty.js) runs during `npm ci`, so it must
# be present before install — copy it alongside the manifests to keep caching.
COPY scripts ./scripts
RUN npm ci

COPY . .
RUN npm run build \
    && npm prune --omit=dev

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    SERVER_PORT=3001 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/data/auth.db

WORKDIR /app
# Copy the built app + production node_modules (with compiled native addons).
COPY --from=builder /app ./

# Persistent SQLite auth/settings DB lives here.
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3001
CMD ["node", "dist-server/server/index.js"]
