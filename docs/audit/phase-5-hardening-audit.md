# Phase 5 hardening audit — Audience, contacts, consent, eligibility, imports

Date: 2026-10-03 · Scope: everything shipped in Phase 5 (commits `fe9fb42`…`02bd107`) · Method: specification →
implementation → tests → live database catalogue, compared line by line; every finding reproduced by a test
before it was fixed.

## Executive summary

Phase 5 was functionally complete and green, but the audit found **three High** defects (two in consent integrity,
one in uploads), eight Medium and seven Low issues. All High and Medium findings are **fixed and covered by new tests**; Low findings are
fixed or explicitly accepted. No Critical issue was found: tenant isolation, RLS, immutability and authorization held
under every attack in the matrix.

- **H-1** A user with `consent.manage` could destroy a contact's consent history: retention was measured from the client-supplied `occurredAt`, so a withdrawal "dated" years ago became purgeable immediately.
- **H-2** Consent was not bound to an address: after the primary email changed, consent given for the old address silently covered the new one.
- **H-3** CSV uploads between 10 and 20 MB failed through the web app: the Next.js proxy silently truncated request bodies at 10 MB, the API waited for the missing bytes, and the user got a 500 after 30 s. A body without a length header could have been imported partially.

Phase 5 is **frozen** (`docs/contracts/phase-5-audience.md`). Final decision: **READY_FOR_PHASE_6**.

## Baseline (before any change)

| Check | Result |
|---|---|
| `pnpm lint` | **Script does not exist** (see L-7). `pnpm lint:boundaries` is the lint gate. |
| `pnpm lint:boundaries` | PASS (237 modules, 965 dependencies) |
| `pnpm typecheck` | PASS |
| `pnpm build` | PASS |
| `pnpm test` | PASS — database 59, API 175, web 39, shared 4, worker 6 |
| `pnpm test:e2e` | PASS — 18/18 |

## Findings

| ID | Severity | Area | Finding | Status |
|---|---|---|---|---|
| H-1 | **High** | Consent / retention | Purge measured withdrawal age from `consent_states.changed_at` = client `occurredAt` → backdated withdrawal + purge deleted all evidence for that channel. Future dates were also accepted. | **Fixed**: `consent_states.recorded_at` (server time); purge uses it and only deletes events recorded no later than the withdrawal; `occurredAt` must not be in the future (Zod + `CHECK (occurred_at <= recorded_at + 5 min)`). Test: `audience-hardening` "backdating". |
| H-2 | **High** | Consent / identity | Consent stored per (contact, channel) only; a primary-address change carried consent to an address that never gave it. | **Fixed**: `consent_states.subject_fingerprint`; eligibility compares it with the current primary → `CONSENT_ADDRESS_CHANGED`; contact page shows it; `contact.primary_identity_changed` event. Withdrawals still block all addresses. |
| H-3 | **High** | Imports / web proxy | Next.js buffers proxied request bodies (because `proxy.ts` exists, even for `/api`) and truncates them at `experimental.proxyClientMaxBodySize` = 10 MB. Uploads of 10–20 MB (allowed by the API) hung until the proxy's 30 s timeout → 500. Found by the new large-upload E2E test; the API alone answered in 0.3 s. | **Fixed**: limit set to 32 MB with the invariant *web limit > API IMPORT_MAX_BYTES*, so even a truncated body is still over the API limit → clean 413, never a partial import. E2E: a ~14 MB file arrives byte-for-byte (size and row count asserted); 21 MB and 40 MB → 413. |
| M-1 | Medium | Consent | `pending_expiry_days` stored but never applied (half-implemented rule). | **Fixed**: derived expiry (`effectiveChannelState`) → `CONSENT_EXPIRED`; expired requests cannot be confirmed. No scheduler, evidence untouched. |
| M-2 | Medium | Consent | An explicit unsubscribe from a contact with no prior consent was a no-op: no evidence and not sticky, so staff could later "grant" for them. | **Fixed**: `unsubscribed` from `none`/`expired` records `withdrawn`. |
| M-3 | Medium | Authorization | Import options (lists, tags, topics, consent) needed only `contacts.import`; contact creation with lists/tags needed only `contacts.create`. Built-in roles were unaffected; custom roles could escalate. | **Fixed**: per-option permission checks at mapping, start and retry; create checks `lists.manage`/`tags.manage`. Tested with a custom "Importer only" role. |
| M-4 | Medium | Imports / disk | Uploaded-but-never-started files were kept forever; no limit on unfinished imports (disk exhaustion with 30 uploads/h/user × 20 MB). | **Fixed**: max 10 unfinished imports per workspace (`409 TOO_MANY_OPEN_IMPORTS`); abandoned (24 h) and failed (7 d) imports are cancelled and files deleted on list/upload; audited. |
| M-5 | Medium | Imports / integrity | Two imports could run concurrently in one workspace, racing for the same addresses (one fails on the unique constraint). | **Fixed**: advisory-locked single-runner check at start/retry (`409 IMPORT_IN_PROGRESS`), works across instances. |
| M-6 | Medium | Imports / reliability | A transient pause > 10 s (reproduced: the host entered Modern Standby) expired the chunk transaction and failed the whole import; a "stalled" retry while the first runner lived could apply a chunk twice and emit `import.completed` twice. | **Fixed**: up to 3 attempts per chunk for transient errors; each attempt row-locks the import and re-checks status + checkpoint; completion is conditional. Observed in a 100k run: the import resumed by itself after the machine woke. |
| M-7 | Medium | Accessibility | axe: table headers and secondary text failed WCAG AA contrast (`ink-faint` ≈ 3.9:1, warning text ≈ 3.9:1); the CSV file input had no accessible name and was an invisible tab stop. | **Fixed**: tokens raised to ≥ 4.8:1 in light and dark themes; input labelled and removed from tab order. Automated axe checks added. |
| M-8 | Medium | API contract | OpenAPI described no success schema for the eligibility contract, not the raw-CSV upload body, not CSV downloads, and no route-specific errors. | **Fixed**: `RouteDoc.response/errors/requestContentType/responseContentType`; eligibility response schema; documented 403/409/413/422 where behaviour is specific. |
| L-1 | Low | Events | Changing the primary identity emitted no event. | **Fixed**: `contact.primary_identity_changed`. |
| L-2 | Low | Events | Bulk delete emitted `contact.deleted` for every selected id, even ones already deleted by a concurrent request. | **Fixed**: events only for rows actually deleted. |
| L-3 | Low | Eligibility | An unknown or other-workspace `topicId` produced `TOPIC_INACTIVE` per contact. | **Fixed**: `400 validation_failed` for the request. |
| L-4 | Low | Docs integrity | `docs/security.md` (commit `02bd107`) contained a spliced duplicate of its first 69 lines (a `$\`` replacement pattern in an edit script). | **Fixed**; all docs scanned for duplicate headings. Edit scripts now use index splicing. |
| L-5 | Low | Provenance | `eligibility.md`/spec described Zoho as mailing any marketing contact (unverified); sticky self-unsubscribe was labelled parity for channel/topic consent, where only the subscription-type rule is verified. | **Fixed** wording; "consent required on every channel" is labelled our product decision everywhere. |
| L-6 | Low | Privacy | Idempotency records store the response of `POST /contacts` (contains the contact's email) for 24 h; erasure does not remove them. | **Accepted** (24 h, user-scoped, RLS-protected); documented in `docs/security.md`. |
| L-7 | Low | Tooling | `pnpm lint` does not exist; there is no ESLint configuration. | **Accepted / recorded**: type checking + boundary lint are the gates; adopting ESLint is a tooling decision outside Phase 5 scope (no new packages added for it). |
| I-1 | Info | RLS | `domain_events` policy lets an organization-level context (no workspace selected) read all workspaces' events. Only the workspace-scoped timeline reads events, with an explicit workspace filter. | No change; noted for Phase 11 consumers. |
| I-2 | Info | Consent | `consent_states.last_event_id` has no FK, so it can point at purged evidence. | By design (purge must not be blocked); the projection stays authoritative. |
| I-3 | Info | Platform | Prisma 7.10 issues parallel queries on a transaction connection (pg deprecation warning). | Already tracked; blocks pg 9 only. |
| I-4 | Info | Deployment | Import files live on the API instance's disk; multiple instances need a shared `FILE_STORE_DIR` until the object store. | Documented (`docs/imports.md`). |
| I-5 | Info | Privacy | Address suppressions keep the normalized address after erasure. | By design: a do-not-contact request must keep working. |

## Consent audit

All 14 questions are answered against the code and tests in `docs/consent.md` §2. Summary: valid consent =
`granted` **for the current primary address**; explicit unsubscribe always recorded; staff, imports and APIs cannot
reverse a self-unsubscribe (`SELF_UNSUBSCRIBED`); only the contact can re-grant (no such entry point until forms);
consent is channel-specific, topics are separate and both are required when a topic is named; evidence is
append-only at grant, trigger and CHECK level; the projection is authoritative; purged evidence never changes
eligibility; revocation blocks every address; changing address invalidates old consent; consent cannot leak between
identities or contacts.

"Marketing requires recorded channel consent on every channel" remains **our product decision**
(`[OUR_ORIGINAL_DESIGN]`), labelled as such in the spec, `consent.md` and `eligibility.md`.

**Pending consent** is part of the active design (staff "consent requested" now, double opt-in later) → implemented
(M-1) rather than removed.

## Retention audit

Scope: per workspace (organization-level default **deferred**, not required by the architecture). Purgeable: consent
evidence only, via the definer function, only past policy, never behind a granted state. Not purgeable: projections,
audit log, domain events, import issues (none contain personal data beyond ids except as documented), suppressions.
Changing the policy only affects future purges and is audited. Full table: `docs/consent.md` §5.

**Purge execution:** on demand, idempotent (a second run deletes nothing), current-workspace only. **Scheduling
deferred** — nothing requires deletion on a schedule; a BullMQ tenant job will call the same function (Phase 9). No
scheduler was added.

## Import security audit

| Concern | Finding / measured | Status |
|---|---|---|
| Request duration | Upload and dry run run inside the request, behind the web proxy's 30 s timeout. Measured dry run: 0.24 s (10k rows), 0.6 s (30k), 1.8 s (100k). | Safe |
| Memory | Streaming parse (csv-parse), chunks of 250, issues capped at 5,000. Peak RSS stayed flat (~500 MB for the test process running API + client) from 10k to 100k rows — not linear in rows. | Safe |
| Throughput | ~165 rows/s steady (30k in 187 s); 100k: completed in 18.3 min (≈ 91 rows/s average on this laptop while other work ran; 145–210 rows/s when idle). 5.3 MB file uploaded in 0.4 s. Peak RSS 506 MB at 30k and 600 MB at 100k (process start ≈ 220 MB). No degradation as the workspace grows (query plans verified, all indexed). | Acceptable for async |
| Transactions | One transaction per chunk with its checkpoint; dry run reuses the same decision code. | Safe |
| Partial failure / retry | Committed chunks stay; retry resumes after the checkpoint; transient errors retried automatically (M-6). | Fixed |
| Cancellation | Checked under row lock per chunk; file deleted. | Safe |
| Idempotency | `start` takes Idempotency-Key; runners are idempotent per chunk (M-6). | Safe |
| Duplicates | Deterministic: in-file duplicates skipped, conflicting owners rejected, never merged. | Safe |
| Workspace isolation | Storage key `imports/{workspace}/{id}.csv`; RLS on rows; cross-workspace ids 404. | Safe |
| Concurrency | One processing import per workspace (M-5). | Fixed |
| Rate limiting | Upload 30/h/user, dry run 60/h/user; plus 10 unfinished imports per workspace (M-4). | Fixed |
| File cleanup / orphans | Deleted on completion, cancel, failed upload, abandonment (24 h) and failed expiry (7 d). | Fixed |
| Malformed CSV, invalid UTF-8, empty, header only | 400 with stable codes. | Tested |
| Delimiters | `,` `;` tab `\|` detected from the header line. | Tested |
| Embedded newlines | Preserved inside quoted fields; row count correct. | Tested |
| Long fields / wide rows | Cell > 2,000 chars → per-row `CELL_TOO_LONG`; > 100 columns → 400; record > 1 MB → 400. | Tested |
| Formula injection | Stored as text; CSV outputs neutralize `= + - @ \t \r`. | Tested |
| Oversized | 413 while streaming (partial file removed, body drained). Through the web proxy: ~14 MB valid file stored byte-for-byte; 21 MB and 40 MB → 413 (H-3). | Fixed + tested |
| Path traversal / malicious names | Names are display-only and sanitized; keys server-generated and root-confined. | Tested |
| Disk exhaustion | Bounded at 200 MB per workspace in files (10 × 20 MB). | Fixed |

## Identity audit

Matching hierarchy (frozen in `docs/contracts/phase-5-audience.md` §8): normalize → find owners → duplicate in file
(skip) → different owners (error, never merged) → deleted owner (error) → one owner (update + attach the row's new
identities) → none (create). Verified: email case/whitespace, phone formatting variants (`+44 20…`, `0044 (20)…`,
national with default country) resolve to one identity; WhatsApp is its own kind (same number may be a phone of one
contact and WhatsApp of another; a row linking both is an `IDENTITY_CONFLICT`); external ids unique per provider.
External ids are not importable in Phase 5 (API only). **No automatic merge exists anywhere.**

## Tenant isolation audit

Tested through API **and** database for: contacts, timeline, consent history and recording, lists and membership,
tags, topics, custom fields, suppressions (lift), imports (get, preview, cancel), search, bulk actions, eligibility
(foreign contacts → `notFound`, foreign topic → 400), domain events and consent evidence (zero rows in B's context).
Other organization → 404; other workspace of the same owner → 404; viewer of A without access to B → 404.
OpenAPI routes all carry a workspace access policy (`apps/api/test/routes.test.ts`). **PASS.**

## RLS audit (live catalogue, `pg_policies` / `pg_class` / grants)

| Table | RLS | Forced | Policy (all commands) | App UPDATE | App DELETE | Workspace enforced |
|---|---|---|---|---|---|---|
| contacts | ✓ | ✓ | `org = ctx AND workspace = ctx` (USING + CHECK) | 14 columns | — | ✓ |
| contact_identities | ✓ | ✓ | same | is_primary, verified_at | ✓ | ✓ |
| custom_field_definitions | ✓ | ✓ | same | 12 columns | ✓ (unused only, service) | ✓ |
| lists | ✓ | ✓ | same | 7 columns | — (soft) | ✓ |
| list_memberships | ✓ | ✓ | same | — | ✓ | ✓ |
| tags | ✓ | ✓ | same | 7 columns | — (soft) | ✓ |
| contact_tags | ✓ | ✓ | same | — | ✓ | ✓ |
| topics | ✓ | ✓ | same | 8 columns (not `key`) | — | ✓ |
| contact_topic_preferences | ✓ | ✓ | same | 4 columns | — | ✓ |
| **consent_events** | ✓ | ✓ | same; **update trigger** | — | — (purge function only) | ✓ |
| consent_states | ✓ | ✓ | same | 7 columns | — | ✓ |
| consent_retention_policies | ✓ | ✓ | same | 6 columns | — | ✓ |
| suppressions | ✓ | ✓ | same | lift columns only | — | ✓ |
| contact_imports | ✓ | ✓ | same | 17 columns | — | ✓ |
| contact_import_issues | ✓ | ✓ | same | — | ✓ (dry-run reset) | ✓ |
| domain_events | ✓ | ✓ | org + (workspace or org-level context) | — + trigger | — | ✓ in workspace context (I-1) |
| audit_logs | ✓ | ✓ | org | — + trigger | — | org-owned by design |

No policy anywhere has `USING (true)`: the four NULL-`USING` policies in the schema are Phase 4 **INSERT-only**
policies with tenant `WITH CHECK` (organizations, roles, organization/workspace memberships). Background jobs use
`workeasy_app` with the job's server-built tenant context — no service role bypasses RLS.

## Immutability audit

Attempted `UPDATE` and `DELETE` on `consent_events`, `audit_logs` and `domain_events` as `workeasy_app` (the role
behind every API user — viewer, editor and admin alike): all `42501 insufficient_privilege`. The owner role
(migrations only, never configured at runtime) is blocked from UPDATE by triggers. No HTTP route edits or deletes
evidence for any role (404). Integration events do not exist yet.

## Event privacy audit

Every audience payload inspected (`catalogue.ts`) and verified by a test that creates, edits, consents, suppresses,
imports and erases a contact, then searches **all** domain-event payloads and audit metadata for its email, phone,
names, company, suppressed address and imported values: **zero matches**. Intentional non-personal strings: list and
tag names, topic and field keys, import file names in audit metadata (display names chosen by staff).

## Eligibility contract

Frozen v1 in `docs/eligibility.md` and `packages/shared/src/eligibility.ts` (`EligibilityRequest`,
`EligibilityResult`, `EligibilityResponse`, reason codes); service contract
`EligibilityService.evaluate(tx, workspaceId, request)`; API contract with response schema in OpenAPI; error
behaviour; relationship to events. Exposes ids and codes only; `addressIdentityId` tells Phase 6 where to send
without exposing the address.

## Authorization audit

Server-side on every route (`@WorkspaceAccess`), re-checked per request, denials audited. Viewer: every mutation
refused (create, update, delete, consent, suppression, import, bulk, custom fields) — tested. Editor: creates, edits,
tags, lists; cannot import, delete, suppress or record consent — tested. Admin/owner: full workspace access.
Composite actions require every permission they exercise (M-3). The frontend only hides controls; tested in
components and E2E, and the API refuses the same calls directly. **PASS.**

## Idempotency audit

| Case | Behaviour | Test |
|---|---|---|
| Same key + same payload | Stored response replayed for 24 h | `audience.test.ts`, hardening |
| Same key + different payload | `422` | `audience.test.ts` |
| Concurrent duplicates | Key claimed before work: exactly one executes; the other gets the replay or a retryable `409` (still running). Never two executions. | hardening |
| Retry after failure | Failed attempts release the claim and are not cached; a retry runs again | hardening |
| Retry after timeout | `409` while the first is running, then the stored replay | by construction (claim-first) |

Semantic results never depend on timing: the losing request either replays the winner's response or is told to
retry.

## Concurrency audit

Stale `version` → `409 version_conflict` with the standard error body and request id; the newer value is kept
(tested for contacts; same mechanism for lists, tags, topics, custom fields, retention policy, import mappings).

## Search and bulk limits

Search: 1,000 matches (`searchTruncated: true`, UI asks to refine). Bulk "all matching": 10,000 (`truncated: true`,
UI says "first 10,000"). Explicit ids: ≤ 1,000 per request (400 beyond). Page size ≤ 100 (400 beyond). Verified on a
10,050-contact workspace; limits are enforced by the API, not the UI.

## API audit

All 66 audience routes: Zod-validated input, access policy, workspace resolution from the URL validated against
membership, one error shape, idempotency where creating or acting in bulk, version checks on edits, audit on
sensitive actions, keyset pagination with bounded page sizes, rate limits on uploads, dry runs, bulk and purge. No
route exposes table structures beyond documented view types. OpenAPI regenerated and extended (M-8); no debug
endpoints.

## Accessibility audit

Automated: `apps/e2e/tests/phase5-a11y.spec.ts` runs axe-core (WCAG 2.0/2.1 A + AA) on every Phase 5 screen with real
data (contacts, contact detail, lists, tags, topics, custom fields, do-not-contact, consent, imports, import mapping
and dry run, the New list dialog) — **0 violations** after fixing M-7. Keyboard: skip link, dialog containment
(native modal; the page behind is unreachable), Escape closes, focus returns to the trigger. Manual review: every
control labelled; buttons vs links used correctly; tables have captions via `aria-label`; loading, empty and error
states present on every screen; layouts collapse to one column on small screens.

## Production database permissions

| Role | Attributes | Needs |
|---|---|---|
| `workeasy_owner` | login, NOSUPERUSER, **BYPASSRLS**, owns schemas, tables and definer functions | Migrations only. Never configured in the API or worker. |
| `workeasy_app` | login, NOBYPASSRLS, statement 15 s, idle-in-tx 30 s, UTC | Table grants exactly as in the RLS table (column-level UPDATE); EXECUTE on `app.current_*`, `app.purge_consent_evidence`, `app.search_contact_ids` and the Phase 4 lookups; `pg_advisory_xact_lock` (PUBLIC by default). API **and** worker use this role. |
| `workeasy_reporting` | NOBYPASSRLS | SELECT on organizations, workspaces, audit_logs, domain_events; still RLS-scoped |
| `workeasy_identity` | NOBYPASSRLS | `identity` schema only |

No sequences exist (UUIDv7 keys), so no sequence grants are needed. All definer functions pin `search_path`, revoke
PUBLIC and grant `workeasy_app` only. These grants come from migrations, so a hosted database gets the same; the
Docker image's superuser is a local convenience only.

## File storage audit

Upload path `FILE_STORE_DIR/imports/{workspaceId}/{importId}.csv`: server-generated, regex- and root-checked,
exclusive create (`wx`), size and UTF-8 enforced while streaming, workspace in the path and in RLS. Lifecycle:
deleted on completion, cancel, failed validation, abandonment and failed expiry. Files hold personal data, so
production should use a private, encrypted volume or the planned object store (`FileStore` interface, Phase 8);
multi-instance deployments need shared storage (I-4).

## Worker boundary

No Phase 5 feature needs the worker, Redis or BullMQ (Redis is used only for Phase 4 rate limiting). Imports use
`JobDispatcher` with the worker's tenant-job envelope, so moving them to BullMQ replaces only the dispatcher; the
worker's `tenant-job` wrapper rejects jobs without a valid tenant. Redis/BullMQ execution remains **untested**.

## Security test matrix

| Area | Attack / test | Expected result | Status | Where |
|---|---|---|---|---|
| Tenant isolation | Cross-workspace read (same owner, 14 routes) | 404 | PASS | `apps/api/test/audience-hardening.test.ts`, `apps/api/test/audience.test.ts`, `apps/e2e/tests/phase5.spec.ts` |
| Tenant isolation | Cross-organization read | 404 | PASS | `apps/api/test/audience.test.ts` |
| Tenant isolation | Foreign ids in bulk / eligibility | ignored / `notFound` | PASS | `apps/api/test/audience-hardening.test.ts` |
| Tenant isolation | Foreign topic in eligibility | 400 | PASS | `apps/api/test/audience-hardening.test.ts` |
| Authorization | Viewer mutation (8 kinds) | 403, audited | PASS | `apps/api/test/audience.test.ts`, `apps/e2e/tests/phase5.spec.ts` |
| Authorization | Editor import / delete / suppress / consent | 403 | PASS | `apps/api/test/audience.test.ts` |
| Authorization | Custom role escalates via import options or create-with-lists | 403 | PASS (fixed M-3) | `apps/api/test/audience-hardening.test.ts` |
| Consent | Unauthorized consent mutation | 403 | PASS | `apps/api/test/audience.test.ts` |
| Consent | Staff reverses a self-unsubscribe | 422 `SELF_UNSUBSCRIBED` | PASS | `apps/api/test/audience.test.ts` |
| Consent | Immutable history mutation (UPDATE/DELETE as API role) | `42501` | PASS | `apps/api/test/audience-hardening.test.ts` |
| Consent | Evidence destroyed by backdating + purge | nothing purged | PASS (fixed H-1) | `apps/api/test/audience-hardening.test.ts`, `packages/db/test/audience-rls.test.ts` |
| Consent | Future-dated evidence | 400 / `23514` | PASS (fixed H-1) | `apps/api/test/audience-hardening.test.ts`, `packages/db/test/audience-rls.test.ts` |
| Consent | Consent reused for a different address | `CONSENT_ADDRESS_CHANGED` | PASS (fixed H-2) | `apps/api/test/audience-hardening.test.ts` |
| Consent | Confirming an expired request | 422 `INVALID_TRANSITION` | PASS (fixed M-1) | `apps/api/test/audience-hardening.test.ts` |
| Imports | Oversized upload (direct, via proxy, beyond proxy limit) | 413 | PASS (fixed H-3) | `apps/api/test/audience.test.ts`, `apps/e2e/tests/phase5.spec.ts` |
| Imports | 10–20 MB upload through the web app | stored byte-for-byte | PASS (fixed H-3) | `apps/e2e/tests/phase5.spec.ts` |
| Imports | Path traversal / hostile file names | sanitized, stored safely | PASS | `apps/api/test/audience.test.ts`, `apps/api/test/audience-hardening.test.ts` |
| Imports | Formula injection | stored as text; CSV output neutralized | PASS | `apps/api/test/audience.test.ts` |
| Imports | Invalid UTF-8 / malformed / empty / header only | 400 | PASS | `apps/api/test/audience.test.ts` |
| Imports | 101 columns / 2,500-char cell / embedded newlines / `;` tab `\|` delimiters | 400 / row issue / preserved / detected | PASS | `apps/api/test/audience-hardening.test.ts` |
| Imports | Disk exhaustion via unfinished uploads | 409 at 10; stale files deleted | PASS (fixed M-4) | `apps/api/test/audience-hardening.test.ts` |
| Imports | Concurrent imports in one workspace | 409 `IMPORT_IN_PROGRESS` | PASS (fixed M-5) | `apps/api/test/audience-hardening.test.ts` |
| Imports | Resume after failure; no row imported twice | resumes from checkpoint | PASS | `apps/api/test/audience.test.ts` |
| Identity | Conflicting identities (email/phone, phone/WhatsApp owners differ) | row error, never merged | PASS | `apps/api/test/audience.test.ts`, `apps/api/test/audience-hardening.test.ts` |
| Identity | Phone formatting variants / external id per provider | same identity / 409 | PASS | `apps/api/test/audience-hardening.test.ts` |
| Idempotency | Replay | stored response | PASS | `apps/api/test/audience.test.ts`, `apps/api/test/audience-hardening.test.ts` |
| Idempotency | Key reuse with another payload | 422 | PASS | `apps/api/test/audience.test.ts` |
| Idempotency | Concurrent duplicates | executes once | PASS | `apps/api/test/audience-hardening.test.ts` |
| Concurrency | Stale version | 409 `version_conflict`, no overwrite | PASS | `apps/api/test/audience-hardening.test.ts` |
| Events | PII leakage in event payloads or audit metadata | none | PASS | `apps/api/test/audience-hardening.test.ts` |
| RLS | Cross-workspace query as the API role | 0 rows | PASS | `apps/api/test/audience-hardening.test.ts`, `packages/db/test/audience-rls.test.ts` |
| Bulk | Limit bypass (> 1,000 ids; "all matching" > 10,000) | 400; capped + `truncated` | PASS | `apps/api/test/audience-hardening.test.ts` |
| Search | Limit bypass (> 1,000 matches; page > 100) | capped + `searchTruncated`; 400 | PASS | `apps/api/test/audience-hardening.test.ts` |
| Accessibility | WCAG 2.1 A/AA on every Phase 5 screen | 0 violations | PASS (fixed M-7) | `apps/e2e/tests/phase5-a11y.spec.ts` |

## Deferred items

- Scheduled consent purge (BullMQ tenant job, Phase 9).
- Organization-level retention default with workspace overrides.
- Domain-level suppression (Zoho behaviour `[NOT_VERIFIED]`); Phase 6 must not assume it.
- The 3× monthly status-change cap: a Zoho plan safeguard; deferred to plans/usage (Phase 21). Not required by any Phase 5 or 6 rule.
- Contact merge (manual, reversible) — no automatic merge will be added.
- Object-store `FileStore`; malware scanning of uploads.
- Contact-originated consent (forms, preference centre, double opt-in) — Phase 20.
- Response schemas for the remaining OpenAPI routes (contract-critical eligibility is done).
- ESLint adoption (L-7).

## Known limitations

- Imports run in the API process (async, resumable); measured 90–210 rows/s on a laptop, so 100k rows take 10–20 minutes. Faster batched writes are possible later without changing the contract.
- Search returns at most 1,000 matches; bulk "all matching" processes at most 10,000.
- A self-unsubscribed contact cannot currently re-subscribe (no contact-facing entry point yet).
- Redis, BullMQ and real SMTP have not been tested.

## Test results

Final regression on the finished code (2026-10-03):

| Check | Result |
|---|---|
| `pnpm lint` | Not available — the script does not exist (L-7) |
| `pnpm lint:boundaries` | PASS (245 modules, 990 dependencies) |
| `pnpm typecheck` | PASS |
| `pnpm build` | PASS |
| Database tests | 61/61 (baseline 59; +2: backdating cannot purge, future dates refused) |
| API tests | 207/207 (baseline 175; +25 hardening, +5 domain, +2 unit) · 1 opt-in scale test skipped by default |
| Web tests | 40/40 (baseline 39) |
| Shared / worker tests | 4/4 · 6/6 |
| E2E run 1 | PASS — 24/24 (Phase 4: 7, Phase 5: 12, accessibility: 5) |
| E2E run 2 | PASS — 24/24 |
| Import scale (opt-in, `IMPORT_SCALE=1`) | 10k, 30k and 100k rows completed; numbers above |

One existing database test changed: its "old evidence" fixture had backdated only the client-supplied date, which by
design (H-1) no longer makes evidence purgeable; it now backdates the server-recorded time, and a new test asserts the
backdated-only case purges nothing.

Environment note: during measurements the laptop entered Modern Standby several times (Windows Kernel-Power events
506/507). Those runs were discarded; the published numbers come from runs with the system kept awake for the test
process only. No power settings were changed.

## Final decision

No Critical finding was found and all three High findings are fixed and tested; every Medium finding is fixed and tested; Low findings are fixed or
accepted with reasons. Phase 5 is frozen (`docs/contracts/phase-5-audience.md`).

```text
READY_FOR_PHASE_6
```
