# syntax=docker/dockerfile:1.7
# Workeasy Campaigns — production images (docs/operations/deployment.md).
# STATUS: all four targets BUILT and smoke-tested locally on 2026-10-10 (Docker 29.8.2): migrate applies every migration
# to an empty database; api (http and jobs,scheduler roles) is healthy and ready; web serves and proxies /api to the
# runtime API_URL; worker stays up. See docs/operations/release-checklist.md §2 for the checks.
#
# One build, four targets:
#   docker build --target migrate -t workeasy-migrate .   # prisma migrate deploy as workeasy_owner (one-off job)
#   docker build --target api     -t workeasy-api .       # PROCESS_ROLES=http (API) or jobs,scheduler (campaign worker)
#   docker build --target worker  -t workeasy-worker .    # Audience count-bitmap maintenance
#   docker build --target web     -t workeasy-web .       # Next.js (API_URL = internal API address)

ARG NODE_VERSION=24.19.0
ARG PNPM_VERSION=12.8.1

# ── build: full install, compile every package and app ────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS build
ARG PNPM_VERSION
ENV CI=true NEXT_TELEMETRY_DISABLED=1
# openssl: Prisma detects the libssl version to pick its engines (without it, it warns and guesses openssl-1.1.x).
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*  && corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY apps/e2e/package.json apps/e2e/
COPY packages packages
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ── prod: production dependencies only (same lockfile) on top of the compiled output ──────────────────────────────
FROM build AS prod
RUN pnpm install --frozen-lockfile --prod --config.confirmModulesPurge=false \
 && rm -rf apps/e2e apps/web apps/api/src apps/api/test apps/worker/src packages/*/test docs ops scripts

# ── runtime bases: non-root, tini for signal forwarding (SIGTERM → graceful shutdown) ────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates openssl && rm -rf /var/lib/apt/lists/* \
 && groupadd --system workeasy && useradd --system --gid workeasy --home /app workeasy
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
ENTRYPOINT ["/usr/bin/tini", "--"]

# API and Audience worker: production dependencies only.
FROM base AS runtime
COPY --from=prod --chown=workeasy:workeasy /repo /app
USER workeasy

# Migrations and the web need packages that are dev dependencies (the prisma CLI; loading next.config.ts): full install.
FROM base AS runtime-full
COPY --from=build --chown=workeasy:workeasy /repo /app
USER workeasy

# Migrations: run once per release BEFORE the new code (DATABASE_OWNER_URL only — never give it to running services).
FROM runtime-full AS migrate
WORKDIR /app/packages/db
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]

FROM runtime AS api
WORKDIR /app/apps/api
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/main.js"]

FROM runtime AS worker
WORKDIR /app/apps/worker
CMD ["node", "--enable-source-maps", "dist/main.js"]

FROM runtime-full AS web
WORKDIR /app/apps/web
EXPOSE 3000
# Keep-alive above the load balancer idle timeout (typically 60 s); Node's 5 s default makes the balancer reuse sockets the
# server is closing (intermittent 502 / connection reset). The API (Fastify) defaults to 72 s.
CMD ["node", "node_modules/next/dist/bin/next", "start", "--port", "3000", "--keepAliveTimeout", "65000"]
