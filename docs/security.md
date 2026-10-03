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
| contacts | ✓ | ✓ | profile, subscription, custom_fields, search_text, deleted/erased markers, version (no tenant keys) | — (erasure is a tombstone update) |
| contact_identities | ✓ | ✓ | is_primary, verified_at (value immutable: change = remove + add) | ✓ |
| custom_field_definitions | ✓ | ✓ | definition columns; key/type changes refused by the service once `key_locked` | ✓ (service allows only never-used fields) |
| lists / tags | ✓ | ✓ | name, description, status/color, deleted_at, version | — (soft delete) |
| list_memberships / contact_tags | ✓ | ✓ | — | ✓ |
| topics | ✓ | ✓ | parent, name, description, status, is_default, position, version — **not `key`** | — |
| contact_topic_preferences / consent_states | ✓ | ✓ | state/status, changed_by, lawful_basis, last_event_id, changed_at | — |
| **consent_events** | ✓ | ✓ | — **append-only** | — (only `app.purge_consent_evidence`) |
| consent_retention_policies | ✓ | ✓ | retention columns, updated_by, version | — |
| suppressions | ✓ | ✓ | **lift columns only** (active_key, lifted_at, lifted_by_user_id, lift_reason) | — |
| contact_imports | ✓ | ✓ | status, progress, counts, mapping/options, dry-run summary, timestamps, version | — |
| contact_import_issues | ✓ | ✓ | — | ✓ (discarded dry-run issues) |
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
- **Append-only triggers.** `BEFORE UPDATE` triggers on `audit_logs`, `domain_events`, `security_events`, `consent_events` and `identity.login_attempts` reject updates, even from the owner.
- **Definer functions:**
  - pinned `search_path`
  - no dynamic SQL
  - return the minimum (ids and status)
  - EXECUTE revoked from PUBLIC and granted to `workeasy_app` only
- **CHECK constraints** on every status and scope enum (Phase 5: subscription types, identity kinds, field types and keys `^[a-z][a-z0-9_]{1,39}# Security

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
| contacts | ✓ | ✓ | profile, subscription, custom_fields, search_text, deleted/erased markers, version (no tenant keys) | — (erasure is a tombstone update) |
| contact_identities | ✓ | ✓ | is_primary, verified_at (value immutable: change = remove + add) | ✓ |
| custom_field_definitions | ✓ | ✓ | definition columns; key/type changes refused by the service once `key_locked` | ✓ (service allows only never-used fields) |
| lists / tags | ✓ | ✓ | name, description, status/color, deleted_at, version | — (soft delete) |
| list_memberships / contact_tags | ✓ | ✓ | — | ✓ |
| topics | ✓ | ✓ | parent, name, description, status, is_default, position, version — **not `key`** | — |
| contact_topic_preferences / consent_states | ✓ | ✓ | state/status, changed_by, lawful_basis, last_event_id, changed_at | — |
| **consent_events** | ✓ | ✓ | — **append-only** | — (only `app.purge_consent_evidence`) |
| consent_retention_policies | ✓ | ✓ | retention columns, updated_by, version | — |
| suppressions | ✓ | ✓ | **lift columns only** (active_key, lifted_at, lifted_by_user_id, lift_reason) | — |
| contact_imports | ✓ | ✓ | status, progress, counts, mapping/options, dry-run summary, timestamps, version | — |
| contact_import_issues | ✓ | ✓ | — | ✓ (discarded dry-run issues) |
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
- **Append-only triggers.** `BEFORE UPDATE` triggers on `audit_logs`, `domain_events`, `security_events`, `consent_events` and `identity.login_attempts` reject updates, even from the owner.
- **Definer functions:**
  - pinned `search_path`
  - no dynamic SQL
  - return the minimum (ids and status)
  - EXECUTE revoked from PUBLIC and granted to `workeasy_app` only
, consent scope = exactly one of channel/topic, suppression target = exactly one of contact/address, import statuses).
- **Phase 5 definer functions:**
  - `app.search_contact_ids(query, limit)` filters to the caller's current org + workspace itself, escapes LIKE wildcards (`%`, `_`, `!`), returns ids only, caps at 5,000. Needed because `ILIKE` is not leakproof, so RLS prevents index use.
  - `app.purge_consent_evidence(workspace)` refuses any workspace other than the current context, and deletes only evidence past its retention.

All of this is verified by `packages/db/test/security-invariants.test.ts`, which fails when a future migration weakens it.

## Application controls

| Control | Implementation |
|---|---|
| Authentication | Global guard on every request. A route with no declared access policy is refused (fail closed), and a test checks every route. |
| Authorization | Global AccessGuard: membership + workspace access + permission, re-evaluated per request. Outsiders get 404, members without the permission get 403 (audited). |
| Tenant isolation | `docs/tenancy.md` (service layer + RLS) |
| Frontend authority | None. `packages/shared` holds only contracts (catalogue, enums, Zod DTOs). Role policy, transitions and approval rules live in `apps/api/src/modules/*/domain`. The UI receives effective permissions as hints. |
| Config | Zod-validated. `NODE_ENV` defaults to production. Production requires APP_URL (https), SESSION_SECRET and DATA_FINGERPRINT_SECRET (≥ 32 characters, not the dev values), FILE_STORE_DIR, TRUST_PROXY, REDIS_URL, SMTP mail and MAIL_FROM. Development defaults are isolated in one block and never read in production. |
| Trusted proxies | `TRUST_PROXY`: `false`, a hop count, or an IP/CIDR/keyword list. `true` is rejected. Development default: `loopback` (only the local Next.js server). Client IP feeds rate limits, login throttling, audit logs and security events (tested both ways). |
| Rate limiting | Per-route policies keyed by trusted IP or user. Redis store in production (required), in-memory in development/test. |
| CSRF | `docs/identity.md` §CSRF |
| Sessions and passwords | `docs/identity.md` |
| Idempotency | `Idempotency-Key` on organization, workspace and invitation creation, and (Phase 5) contact creation, bulk actions and import start. Claimed before work runs, replayed for 24 h, mismatched body gives 422. |
| Optimistic concurrency | `version` on organizations, workspaces, roles and memberships, and (Phase 5) contacts, lists, tags, topics, custom fields, retention policy and import mappings. A stale write gives 409 `version_conflict`. |
| Errors | One shape `{ error: { code, message, fields?, requestId } }`. No stack traces or SQL reach clients. 5xx responses are logged with the request id. |
| HTTP headers (API) | helmet: `default-src 'none'`, `frame-ancestors 'none'`, nosniff, CORP same-origin, HSTS in production, `Cache-Control: no-store` |
| HTTP headers (web) | CSP (self only; `unsafe-inline` scripts are needed by Next.js), `X-Frame-Options: DENY`, nosniff, Referrer-Policy, Permissions-Policy |
| Same-origin API | The browser calls `/api/*`, which Next.js rewrites to the API. Cookies stay first-party and there is no CORS surface. |
| Open redirects | `safeNext()` accepts only same-origin absolute paths (tested) |
| Uploads (Phase 5) | CSV only (`text/csv` raw stream), streamed with a byte cap (413 + partial file removed, request body drained), UTF-8 validated, row/column/cell/record limits, server-generated storage keys confined to `FILE_STORE_DIR` (path traversal tested), files deleted when the import ends. Details: `docs/imports.md` §2. |
| CSV injection | Imported formula text is stored as data, never evaluated. Every CSV the API produces (audit export, import problems) neutralizes cells starting with `= + - @`, tab or CR (tested). |
| IDOR | Every audience id is loaded under RLS for the workspace in the URL, which AccessGuard validated against membership. Ids from another workspace or organization behave as not found (tested at DB, API and E2E level). |
| Replay | `Idempotency-Key` on contact creation, bulk actions and import start: replay returns the first response; a different body with the same key is 422 (tested). |
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

**Phase 5 audit actions:** contact erased, bulk action, suppression added/lifted, custom field archived/deleted, consent recorded by staff, retention policy updated, retention purged, import started/completed/failed/cancelled. Routine edits are covered by domain events.

**Later phases** add API key changes (15), campaign approval and send (6, 9), integration credential changes (15) and contact exports (with the export feature).

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
| Uploaded CSVs are not malware-scanned (they are parsed as text, never executed or served back) | Add scanning with object storage (Phase 8) |
| Domain-level suppression | Not implemented (Zoho behaviour `[NOT_VERIFIED]`) |
| SSRF-safe fetcher, upload scanning, sandboxed HTML preview | With the features that need them (Phases 7, 8, 15) |
| Production migration role is a superuser in the local Docker image | Production uses `workeasy_owner` (non-superuser) via the bootstrap; documented in deployment (Phase 19) |
