# Workeasy Campaign

Multi-tenant customer engagement and marketing automation platform: email, SMS and WhatsApp on one
channel-agnostic pipeline.

- Product specification: [docs/spec.md](docs/spec.md)
- Architecture: [docs/architecture.md](docs/architecture.md)

## Layout

| Path | What |
|---|---|
| `apps/web` | Next.js frontend (port 3000; proxies `/api/*` to the API) |
| `apps/api` | NestJS + Fastify HTTP API (port 4000) |
| `apps/worker` | NestJS queue workers (BullMQ) |
| `packages/shared` | Permission catalogue, enums, state machines, shared Zod schemas |
| `packages/channels` | `ChannelAdapter` contract + channel providers |
| `packages/db` | Prisma 7 schema, migrations, tenant-scoped client (`withTenant`) |
| `packages/config` | Shared tsconfig |

## Getting started

Requirements: Node ≥ 22, pnpm 12 (`corepack enable pnpm`), Docker (for Postgres, Redis, Mailpit, MinIO).

```sh
pnpm install
cp .env.example .env        # fill SESSION_SECRET and ENCRYPTION_KEY
pnpm infra:up               # Postgres 16, Redis 7, Mailpit (http://localhost:8025), MinIO
pnpm db:migrate
pnpm build
pnpm dev
```

`pnpm test` runs all unit tests; `pnpm typecheck` type-checks every package.

## Notes

- Versions are pinned deliberately: TypeScript 6.0 (NestJS tooling does not yet target TS 7) and Prisma 7.10
  (the `latest` npm tag currently points at an 8.0 release candidate).
- Task running uses `pnpm -r` rather than Turborepo: Turborepo's Windows binary needs the Microsoft Visual C++
  Redistributable. It can be reintroduced for CI.
