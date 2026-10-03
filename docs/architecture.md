# Workeasy Campaign — Architecture

Status: as built through Phase 4. Companion documents:

| Document | Covers |
|---|---|
| `tenancy.md` | Ownership and isolation |
| `identity.md` | Authentication and sessions |
| `events.md` | Event model |
| `security.md` | Controls and privileges |
| `spec.md` | Product rules with provenance |

## 1. Principle

```
Customer → Identity → Audience → Consent → Journey → Message → Delivery → Engagement → Event → Analytics → Optimization
```

Email, SMS and WhatsApp are delivery channels behind one adapter contract. No business rule lives in a channel.

## 2. Stack (pinned versions: `docs/audit/foundation-audit.md` §1)

| Concern | Choice |
|---|---|
| Runtime | Node 24 LTS, TypeScript 6.0, ESM everywhere |
| Web | Next.js 16 (App Router), React 19.3, Tailwind 4, TanStack Query |
| API | NestJS 11 on Fastify 5 |
| Worker | NestJS standalone + BullMQ 5 (ioredis 5) |
| Database | PostgreSQL 16 via Prisma 7.10 (driver adapter `pg`) with forced row-level security |
| Contracts | Zod 4 schemas in `packages/shared`, used by both API and UI |
| Tests | Vitest 5 (unit / database / API / worker / components), Playwright (E2E) |
| Tasks | `pnpm -r`. Turborepo removed because its Windows binary needs the MSVC runtime. |

## 3. Repository and boundaries

```
apps/web        Next.js UI. Talks to the API over HTTP only (/api/* rewrite → API).
apps/api        HTTP API: modules/<context>/{domain,application,infrastructure,http}
apps/worker     Background jobs (tenant-job wrapper; queue processors from Phase 9)
apps/e2e        Playwright end-to-end suite
packages/shared Contracts only: permission catalogue, enums, Zod DTOs, response types (browser-safe; no Node types)
packages/db     Prisma schema + migrations; exports context-bound access only
                  @workeasy/db          createDatabase() → withTenant / asUser / system
                  @workeasy/db/identity identity-schema store (local identity provider only)
                  @workeasy/db/testing  test helpers (tests only)
packages/channels ChannelAdapter contract + adapters
packages/config  shared tsconfig
```

### Boundary rules (enforced by `pnpm lint:boundaries` = manifest check + dependency-cruiser)

| Rule | Detail |
|---|---|
| No server packages in the browser | `apps/web` cannot import `@workeasy/db`, `@workeasy/channels`, the API or the worker, Prisma, `pg`, Redis/BullMQ, argon2, nodemailer, NestJS or Fastify. It cannot import undeclared packages, and it cannot declare forbidden ones. |
| `packages/shared` is contracts only | No server packages and no Node globals. |
| Generated Prisma client is private | Only `packages/db` may touch it. |
| Identity store is local-provider only | `@workeasy/db/identity` only from `apps/api/src/modules/identity/infrastructure/local`. |
| Test helpers stay in tests | `@workeasy/db/testing` only from tests and db scripts. |
| Domain code is pure | `modules/*/domain` imports no HTTP, persistence or framework code. |
| API and worker are independent | They never import each other. |
| No cycles | |

### Layering

```
apps/web ──HTTP──▶ http (controllers, guards) ─▶ application (services, use cases) ─▶ domain (pure rules)
                                                     │
                                                     ▼
                                        @workeasy/db (context-bound tx) ─▶ PostgreSQL (RLS)
apps/worker ─▶ tenant-job wrapper ─▶ application code ─▶ @workeasy/db
Other Workeasy products ─▶ public API (Phase 15) and integration events only — never the database
```

### API modules (Phase 5)

| Module | Owns |
|---|---|
| `identity`, `tenancy`, `audit`, `events` | Phase 4 (sessions, organizations, workspaces, RBAC, audit log, domain events) |
| `audience` | contacts, identities, custom fields, lists, tags, topics, consent, suppression, eligibility, bulk actions, imports (`docs/audience.md`) |

Shared infrastructure added in Phase 5:
- **`FileStore`** (`apps/api/src/infrastructure/files`): streaming save with a byte limit, server-generated keys confined to `FILE_STORE_DIR`. Local disk today; S3/MinIO behind the same interface later.
- **`JobDispatcher`** (`apps/api/src/common/jobs.ts`): `InlineJobDispatcher` runs jobs in-process after the response, and shutdown waits for them. Jobs use the worker's tenant-job envelope, so moving them to BullMQ changes only the dispatcher. Redis/BullMQ execution is not yet exercised.
- **Search** goes through `app.search_contact_ids()`, a workspace-bound definer function, because PostgreSQL will not use a trigram index for a non-leakproof `ILIKE` under RLS (`docs/audience.md` §7).

**Rule: the API never sends messages; the worker sends.** The API depends on `packages/channels` only for verifying
and parsing provider callbacks and for test sends.

## 4. Multi-tenancy (summary — see `tenancy.md`)

**Hierarchy:** Platform → Organization → Workspace. Every entity is declared platform-, user-, organization- or workspace-owned.

**Two independent layers:**
1. **Application:** principal from the session, context from the URL looked up through the caller's own membership, permission check, then `inTenant`.
2. **Database:** forced RLS on every table, keyed on transaction-local `app.org_id`, `app.workspace_id` and `app.user_id`.

**The runtime role cannot bypass RLS.** Genuinely cross-tenant lookups are narrow `SECURITY DEFINER` functions owned by
`workeasy_owner` that return ids only:
- session by token hash
- invitation by token hash
- provider message → tenant
- slug availability
- identity linking
- security-event write

Background jobs **do not** use a privileged role. They run as `workeasy_app` inside `withTenant`, built from a validated
envelope.

## 5. Identity (summary — see `identity.md`)

`IdentityProvider` (local today, Workeasy SSO later) → `ExternalIdentity` → `link_identity` → platform session →
`AuthenticatedPrincipal`. Nothing below the session layer knows how the user authenticated.

## 6. Request pipeline (API)

Global guards run in this fixed order:
1. **AuthenticationGuard:** session cookie → principal (with rotation). Refuses routes with no declared access policy.
2. **CsrfGuard:** signed, session-bound double-submit token + Origin check on unsafe methods.
3. **RateLimitGuard:** per-route policy by trusted IP or user.
4. **AccessGuard:** for organization/workspace routes, membership + workspace access + permission. Outsiders get 404; members without the permission get 403 and an audit record.

Then the controller validates input with the shared Zod contract, and the service runs one transaction via `inTenant`.
That transaction holds the change, its audit record and its domain events.

**Errors** use one shape. **Request id = correlation id**: it is generated server-side, returned as `X-Request-Id`, and stored on every audit record and event.

## 7. Communication pipeline (Phases 9+)

```
Campaign / journey step → Message → audience resolution → Eligibility Engine (ordered reason codes)
  → deliveries (idempotent per message×contact) → per-recipient schedule → send queue (per-org + per-provider limits)
  → renderer → ChannelAdapter.send() → provider callbacks (verifyCallback + tenant from provider_message_routes)
  → analytics events → scoring / journeys / rollups / suppression
```

```ts
interface ChannelAdapter {
  channel; capabilities;
  validateAddress(address);
  send(payload, ctx);
  verifyCallback(rawBody, headers, credentials): boolean;   // before parsing; constant-time
  parseCallback(body, headers): NormalizedEvent[];           // provider ids only, never tenant ids
}
```

## 8. Events (summary — see `events.md`)

| Kind | Where | Purpose |
|---|---|---|
| Domain events | `domain_events`, written in the same transaction (outbox) | Business facts inside Campaigns |
| Integration events | Versioned contracts derived from domain/analytics events | Other services, customer webhooks |
| Analytics events | Partitioned `engagement_events` | Measurement |

One envelope covers all three kinds: id, type, version, org, workspace, aggregate, occurred/recorded, actor, source,
correlation, causation, idempotency key, payload. Every event store is append-only.

## 9. Data design

**Conventions:**
- UUIDv7 ids.
- `org_id` leads every tenant index.
- Composite tenant foreign keys.
- `version` columns for optimistic concurrency.
- Soft delete for configuration objects.
- Append-only history tables.
- Column-level UPDATE grants.

**Retention and partitioning** for high-volume tables are in the audit document (§9).

**Migrations:**
- Prisma generates Part A (DDL).
- Part B is hand-written security: RLS, grants, functions, CHECK constraints, triggers.
- Applied migrations are immutable.
- `security-invariants.test.ts` guards Part B.

## 10. Hot paths

| Path | Mode |
|---|---|
| Imports | Streamed, dry run first, then chunks of 250 with a resumable checkpoint (`docs/imports.md`) |
| Contact search | Trigram index via a definer function; at most 1,000 matches, then the UI asks to refine |
| Bulk actions | Server-side chunks of 500; "all matching" capped at 10,000 |
| Segment counts | Cached and estimated |
| Recipient generation | Set-based, chunked |
| Sending | Queued and rate-limited |
| Callbacks | Accept then process |
| Analytics | Precomputed rollups |
| Timeline | Indexed keyset over `domain_events` by (workspace, aggregate) |
| Scoring | Event-driven + nightly decay |
| Journeys | Durable queue |

Details are in `docs/audit/foundation-audit.md` §10.

## 11. Local development

| Concern | Setup |
|---|---|
| Database | PostgreSQL 16 via `scripts/local-postgres.ps1` (no Docker or admin needed) or `docker compose`. `pnpm db:bootstrap` then `pnpm db:migrate`. |
| Mail | Development mail goes to `.dev-mail/` (JSON with the action link) |
| Redis | Optional in development (in-memory rate limits); required in production |
