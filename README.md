# Workeasy Campaign

Multi-tenant customer engagement and marketing automation: email, SMS and WhatsApp on one channel-agnostic pipeline.

| Doc | What |
|---|---|
| [docs/spec.md](docs/spec.md) | Product rules, each tagged ZOHO_PARITY / OUR_IMPROVEMENT / OUR_ORIGINAL_DESIGN / NOT_VERIFIED |
| [docs/architecture.md](docs/architecture.md) | System as built, boundaries, request pipeline |
| [docs/tenancy.md](docs/tenancy.md) | Organization/workspace ownership, RLS, RBAC |
| [docs/identity.md](docs/identity.md) | Identity-provider abstraction, local auth, sessions, CSRF |
| [docs/events.md](docs/events.md) | Domain / integration / analytics events |
| [docs/security.md](docs/security.md) | Database privileges, controls, known gaps |
| [docs/api/openapi.json](docs/api/openapi.json) | API reference (also served at `/api/v1/openapi.json`) |
| [docs/audit/foundation-audit.md](docs/audit/foundation-audit.md) | Foundation audit and its resolution |

## Layout

| Path | What |
|---|---|
| `apps/web` | Next.js UI (port 3000; `/api/*` is proxied to the API) |
| `apps/api` | NestJS + Fastify API (port 4000) |
| `apps/worker` | Background jobs |
| `apps/e2e` | Playwright end-to-end tests |
| `packages/shared` | Browser-safe contracts (permission catalogue, enums, Zod DTOs) |
| `packages/db` | Prisma schema, migrations (DDL + RLS/grants), context-bound database access |
| `packages/channels` | Channel adapter contract |

## Getting started

Requirements:
- Node 24
- pnpm 12 (`corepack enable pnpm`)
- PostgreSQL 16

### 1. Database (pick one)

**Without Docker** (Windows, no admin rights). This needs the portable PostgreSQL in `%LOCALAPPDATA%\Programs\pgsql`; see the audit doc.

```powershell
powershell -File scripts/local-postgres.ps1 init   # creates the cluster, writes DATABASE_ADMIN_URL to .env
powershell -File scripts/local-postgres.ps1 start  # after a reboot
```

**With Docker:**

```sh
POSTGRES_SUPERUSER_PASSWORD=… MINIO_ROOT_PASSWORD=… docker compose up -d
echo "DATABASE_ADMIN_URL=postgresql://postgres:…@localhost:5432/postgres" >> .env
```

### 2. Roles, databases, schema

```sh
pnpm install
pnpm db:bootstrap      # roles (owner/app/identity/reporting) + workeasy and workeasy_test databases; writes URLs to .env
pnpm db:migrate        # applies migrations as the schema owner
pnpm build
```

### 3. Run

```sh
NODE_ENV=development pnpm --filter @workeasy/api start   # http://localhost:4000
pnpm --filter @workeasy/web dev                            # http://localhost:3000
```

Development email (verification, reset, invitations) is written to `.dev-mail/*.json`, and each action link is logged.

## Checks

```sh
pnpm lint:boundaries   # architecture rules (web cannot reach db/server code, etc.)
pnpm typecheck
pnpm test              # unit + database/RLS + API + worker + component tests (uses workeasy_test)
pnpm test:e2e          # Playwright: builds the web app, starts API + web on ports 3100/4100
pnpm check             # boundaries + typecheck + tests
```

## Notes

- **Pinned versions:**
  - TypeScript 6.0: NestJS tooling targets it, and its `types: []` default is handled in `packages/config`.
  - Prisma 7.10: npm `latest` currently points at an 8.0 RC.
  - NestJS 11, BullMQ 5, ioredis 5: the mature lines.
- **Install scripts** are denied except `@prisma/engines` (see `pnpm-workspace.yaml`).
- **Configuration fails closed** in production. See `apps/api/src/config/env.ts` and `docs/security.md`.
