# Production image for the Express API. PostgreSQL is a separate managed
# service: compose.dev.yaml is for local development only. Build from the
# repository root:
#
#   docker build -f apps/api/Dockerfile -t my-api .
#   docker build -f apps/api/Dockerfile --target migrator -t my-api-migrate .
#
# Run the migrator once per release, then start the API. See docs/deployment.md.

ARG NODE_VERSION=22.18.0-slim

FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# --- Keep only the API and the workspace packages it depends on --------------
FROM base AS pruner
COPY . .
RUN pnpm dlx turbo@2.11.7 prune @starter/api --docker

# --- Install from the pruned lockfile (cached until a manifest changes) -------
FROM base AS deps
COPY --from=pruner /app/out/json/ .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# --- Bundle the server and migrator -----------------------------------------
FROM deps AS builder
COPY --from=pruner /app/out/full/ .
COPY tsconfig.base.json starter.config.json ./
# tsup bundles the code, @starter/shared, and npm dependencies into dist/. Only
# sharp stays external; the worker and runner images get it from the native stage. No secrets are needed to build.
RUN pnpm --filter @starter/api run build

# --- Native runtime deps: sharp cannot be bundled (platform .node binary) ----
# Installs the exact sharp version from the lockfile, plus its @img/* binary
# for this image's platform, into /native/node_modules.
FROM builder AS native
RUN mkdir /native && cd /native \
    && npm init -y >/dev/null \
    && npm install --omit=dev --no-audit --no-fund \
       "sharp@$(node -p "require('/app/apps/api/node_modules/sharp/package.json').version")"

# --- Migrator: apply committed SQL once per release --------------------------
# Uses MIGRATION_DATABASE_URL when set, otherwise DATABASE_URL.
FROM node:${NODE_VERSION} AS migrator
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder --chown=node:node /app/apps/api/dist ./dist
COPY --from=builder --chown=node:node /app/apps/api/drizzle ./drizzle
USER node
CMD ["node", "dist/migrate.js"]

# --- Worker: same bundle and runtime as API, with its own process -----------
FROM node:${NODE_VERSION} AS worker
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder --chown=node:node /app/apps/api/dist ./dist
COPY --from=native --chown=node:node /native/node_modules ./node_modules
USER node
# Liveness only: PID 1 must still be the worker process. Queue/relay health
# requires external monitoring; this probe does not claim readiness.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD \
  node -e "const fs=require('node:fs');try{process.exit(fs.readFileSync('/proc/1/cmdline','utf8').includes('dist/worker.js')?0:1)}catch{process.exit(1)}"
CMD ["node", "--enable-source-maps", "dist/worker.js"]

# --- Runner: the API --------------------------------------------------------
FROM node:${NODE_VERSION} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0
COPY --from=builder --chown=node:node /app/apps/api/dist ./dist
COPY --from=native --chown=node:node /native/node_modules ./node_modules
USER node
EXPOSE 4000

# Liveness only, so a database outage does not restart the API.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD \
  node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "--enable-source-maps", "dist/server.js"]

# An edge deployment uses the identical application bundle and runs with
# EDGE_MODE=true; choose the edge target or set the variable on runner.
FROM runner AS edge
# This is the edge image release version, independent of the API package.
ARG EDGE_NODE_VERSION=0.2.0
COPY --chown=node:node deploy/edge/check-image-version.mjs /tmp/check-image-version.mjs
RUN EDGE_NODE_VERSION="$EDGE_NODE_VERSION" node /tmp/check-image-version.mjs \
    && rm /tmp/check-image-version.mjs
ENV EDGE_MODE=true \
    EDGE_NODE_VERSION=${EDGE_NODE_VERSION}

# Keep the API as the default build target.
FROM runner AS default
