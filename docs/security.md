# Security

Security controls as implemented in Phase 4. Gaps and later-phase items are listed at the end.

## Database roles and privileges

The bootstrap (`packages/db/scripts/bootstrap.ts`) creates the roles and databases. Every table privilege below is
granted by **migrations**, so a hosted database gets exactly the same grants.

| Role | Login | Attributes | Purpose |
|---|---|---|---|
| `workeasy_owner` | yes | NOSUPERUSER NOCREATEROLE NOCREATEDB **BYPASSRLS** | Owns the schemas, runs migrations, owns the `SECURITY DEFINER` lookup functions. **Never configured in the API or worker.** |
| `workeasy_app` | yes | NOSUPERUSER NOBYPASSRLS; statement_timeout 15 s; idle_in_transaction 30 s | API and worker runtime |
| `workeasy_identity` | yes | NOSUPERUSER NOBYPASSRLS | Local identity provider (schema `identity` only) |
| `workeasy_reporting` | yes | NOSUPERUSER NOBYPASSRLS | Read-only reporting, still tenant-scoped by RLS |

### `workeasy_app` grants

**UPDATE is granted per column.** No runtime role can update `id`, `org_id`, `workspace_id` or `user_id` on any table (enforced by test).

| Table | SELECT | INSERT | UPDATE (columns) | DELETE |
|---|---|---|---|---|
| users | ✓ | — (only via `link_identity`) | display_name, last_login_at, updated_at, version | — |
| user_identities | ✓ | — | last_used_at | — |
| sessions | ✓ | ✓ | token/rotation fields, last_seen_at, idle_expires_at, revoked_at, revoked_reason, ip/ua, last org/workspace | — |
| security_events | ✓ | — (only via `record_security_event`) | — | — |
| idempotency_records | ✓ | ✓ | response_status, response_body | ✓ (release a failed claim; expiry) |
| organizations | ✓ | ✓ | name, status, updated_at, deleted_at, version | — |
| workspaces | ✓ | ✓ | name, slug, timezone, status, updated_at, archived_at, version | — |
| workspace_settings | ✓ | ✓ | default_sender_name, default_reply_to, locale, updated_at, version | — |
| roles | ✓ | ✓ | name, description, permissions, updated_at, deleted_at, version | — |
| organization_memberships | ✓ | ✓ | role_id, status, updated_at, suspended_at, removed_at, version | — |
| workspace_memberships | ✓ | ✓ | role_id, updated_at, version | ✓ |
| invitations | ✓ | ✓ | status, token_hash, expires_at, accepted_at, accepted_by_user_id, revoked_at, version | — |
| **audit_logs** | ✓ | ✓ | — **append-only** | — |
| **domain_events** | ✓ | ✓ | — **append-only** | — |
| provider_message_routes | ✓ | ✓ | — | — |
| `_prisma_migrations` | — | — | — | — |

### Other roles

- **`workeasy_identity`:**
  - `identity.local_accounts`: SELECT, INSERT, UPDATE on credential/verification columns, DELETE (registration rollback and erasure).
  - `identity.local_account_tokens`: SELECT, INSERT, UPDATE(consumed_at).
  - `identity.login_attempts`: SELECT, INSERT (append-only).
  - **No** access to `public`.
- **`workeasy_reporting`:** SELECT on organizations, workspaces, audit_logs and domain_events. RLS applies.

### Defences on top of grants

- **Forced RLS.** `ENABLE` + `FORCE ROW LEVEL SECURITY` on every public table.
- **Append-only triggers.** `BEFORE UPDATE` triggers on `audit_logs`, `domain_events`, `security_events` and `identity.login_attempts` reject updates, even from the owner.
- **Definer functions:**
  - pinned `search_path`
  - no dynamic SQL
  - return the minimum (ids and status)
  - EXECUTE revoked from PUBLIC and granted to `workeasy_app` only
- **CHECK constraints** on every status and scope enum.

All of this is verified by `packages/db/test/security-invariants.test.ts`, which fails when a future migration weakens it.

## Application controls

| Control | Implementation |
|---|---|
| Authentication | Global guard on every request. A route with no declared access policy is refused (fail closed), and a test checks every route. |
| Authorization | Global AccessGuard: membership + workspace access + permission, re-evaluated per request. Outsiders get 404, members without the permission get 403 (audited). |
| Tenant isolation | `docs/tenancy.md` (service layer + RLS) |
| Frontend authority | None. `packages/shared` holds only contracts (catalogue, enums, Zod DTOs). Role policy, transitions and approval rules live in `apps/api/src/modules/*/domain`. The UI receives effective permissions as hints. |
| Config | Zod-validated. `NODE_ENV` defaults to production. Production requires APP_URL (https), SESSION_SECRET (≥ 32 characters, not the dev value), TRUST_PROXY, REDIS_URL, SMTP mail and MAIL_FROM. Development defaults are isolated in one block and never read in production. |
| Trusted proxies | `TRUST_PROXY`: `false`, a hop count, or an IP/CIDR/keyword list. `true` is rejected. Development default: `loopback` (only the local Next.js server). Client IP feeds rate limits, login throttling, audit logs and security events (tested both ways). |
| Rate limiting | Per-route policies keyed by trusted IP or user. Redis store in production (required), in-memory in development/test. |
| CSRF | `docs/identity.md` §CSRF |
| Sessions and passwords | `docs/identity.md` |
| Idempotency | `Idempotency-Key` on organization, workspace and invitation creation. Claimed before work runs, replayed for 24 h, mismatched body gives 422. |
| Optimistic concurrency | `version` on organizations, workspaces, roles and memberships. A stale write gives 409 `version_conflict`. |
| Errors | One shape `{ error: { code, message, fields?, requestId } }`. No stack traces or SQL reach clients. 5xx responses are logged with the request id. |
| HTTP headers (API) | helmet: `default-src 'none'`, `frame-ancestors 'none'`, nosniff, CORP same-origin, HSTS in production, `Cache-Control: no-store` |
| HTTP headers (web) | CSP (self only; `unsafe-inline` scripts are needed by Next.js), `X-Frame-Options: DENY`, nosniff, Referrer-Policy, Permissions-Policy |
| Same-origin API | The browser calls `/api/*`, which Next.js rewrites to the API. Cookies stay first-party and there is no CORS surface. |
| Open redirects | `safeNext()` accepts only same-origin absolute paths (tested) |
| Export safety | Audit CSV export is permission-gated (`audit.export`), rate-limited and audited. Cells starting with `= + - @` are neutralized (formula injection, tested). |
| Email content | Templates escape every interpolated value |
| SQL injection | Prisma parameterization; tagged-template raw SQL only; context ids validated as UUIDs |

## Audit coverage (Phase 4)

**Organization audit log (append-only):**
- organization created/updated/deleted
- workspace created/updated/archived/restored
- invitation created/resent/revoked/accepted
- member role changed/suspended/reactivated/removed
- workspace member added/role changed/removed
- role created/updated/deleted
- access denied
- audit exported

Each record holds the actor, a snapshot of the actor's email, the IP (trusted), the user agent, the correlation id and a metadata diff.

**User security log (append-only):**
- registered, email verified
- login succeeded, login failed (email stored hashed)
- logout
- password changed, password reset
- session revoked, sessions revoked

**Later phases** add API key changes (15), campaign approval and send (6, 9), consent changes (5), integration credential changes (15) and data exports (5).

## Secrets

- `.env` is git-ignored. `.env.example` contains no secrets.
- Local credentials are generated by `scripts/local-postgres.ps1` and the bootstrap.
- Docker Compose requires `POSTGRES_SUPERUSER_PASSWORD` and `MINIO_ROOT_PASSWORD`; it has no hard-coded defaults.
- Services publish on 127.0.0.1 only.

## Known gaps (tracked)

| Gap | Plan |
|---|---|
| Breached-password check (HIBP k-anonymity) | Phase 17 |
| MFA (TOTP/WebAuthn), SSO | Contracts ready; implement before enterprise launch |
| CSP still allows inline scripts (Next.js requirement) | Nonce-based CSP in Phase 17 |
| Prisma 7.10 issues parallel queries inside one transaction (pg prints a deprecation warning) | Upstream issue; blocks moving to pg 9; `pg` pinned to 8.23.1 |
| Encryption of provider credentials (envelope, per-organization key) | With the first stored credential (Phase 12/15) |
| SSRF-safe fetcher, upload scanning, sandboxed HTML preview | With the features that need them (Phases 7, 8, 15) |
| Production migration role is a superuser in the local Docker image | Production uses `workeasy_owner` (non-superuser) via the bootstrap; documented in deployment (Phase 19) |
