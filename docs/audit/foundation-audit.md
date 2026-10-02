# Foundation Audit — before Phase 4

Date: 2026-10-02 · Scope: repository state after build steps 1–3 · Verdict: **NOT READY** (see §13)

Everything below was checked against the repository and installed packages, not against earlier claims.
Items marked **[fixed in audit]** were corrected during the audit because the audit brief asked for it (§1, §2).
Everything else is a finding only. Nothing from Phase 4 has been started.

---

## 1. Package / version audit

### 1.1 Installed versions (after audit fixes)

| Component | Version | Pinning | Release age | Notes |
|---|---|---|---|---|
| Node.js | 24.19.0 (LTS line) | runtime | — | portable install in `%LOCALAPPDATA%\Programs\node` |
| pnpm | 12.8.1 | `packageManager` | — | supply-chain policy (`minimumReleaseAge`) active |
| TypeScript | 6.0.3 | exact | 5.5 months | TS 7 (Go port) avoided: NestJS CLI declares `typescript ~6.0.2` |
| Next.js | 16.3.8 | exact | major 11 months | |
| React / React DOM | 19.3.0 | exact | major 22 months | |
| NestJS core/common/platform-fastify | 11.2.7 | exact | mature line | **[fixed in audit]** was 12.1.2 (major 5 weeks old, picked by default) |
| @nestjs/config | 4.0.4 | exact | — | **[fixed in audit]** Nest-11-compatible line (was 12.0.1) |
| Fastify | 5.11.3 (via platform-fastify) | transitive | major 2 years | |
| Prisma CLI / @prisma/client / adapter-pg | 7.10.0 | exact | major 10 months | npm `latest` tag points at 8.0.0-rc.19 — deliberately not used |
| PostgreSQL client (`pg`) | 8.23.1 | exact | — | |
| BullMQ | 5.81.5 | exact | mature line | **[fixed in audit]** was 6.3.11 (major 2 months old) |
| ioredis | 5.11.1 | exact | — | **[fixed in audit]** was 6.0.0 (2 months old); 5.11.1 is what BullMQ itself is tested against |
| Zod | 4.6.5 | exact | major 15 months | |
| Vitest | 5.0.3 | exact | major 1 month | dev-only; see warning W3 |
| @types/node | 24.19.0 | exact | — | **[fixed in audit]** was 26.x (types for a Node version we don't run) |
| argon2 | 0.45.1 | exact | — | |
| Turborepo | removed | — | — | Windows binary needs the MSVC++ runtime, not installed (W6) |

Root `engines.node` is `>=22`, but `@prisma/client` requires `^20.19 || ^22.12 || >=24.0`. Tighten it to
`>=24 <25` (required change R12).

### 1.2 Prerelease dependencies

| Package | Version | Path | Decision |
|---|---|---|---|
| `@visx/*` (9 packages) | 4.0.x-alpha.0 | `prisma` → `@prisma/studio-core` | **Accepted, documented.** Comes in through Prisma's stable CLI. Only Prisma Studio, a dev GUI, uses it, and it is never loaded by our runtime code. It cannot be removed without forking Prisma. Revisit when Prisma ships Studio without it. |
| `workerd`, `alchemy`, `@distilled.cloud/*` | rc/beta | came from the accidental `prisma@8.0.0-rc` | **[fixed in audit]** removed from the lockfile and tree |

We don't depend directly on any prerelease package.

### 1.3 Compatibility matrix (verified)

- **NestJS 11.2.7 + TypeScript 6.0.3** (`experimentalDecorators` + `emitDecoratorMetadata`, ESM output): build passes, the API boots and DI resolves.
- **NestJS 11 + Fastify 5:** the API serves `/health` with helmet security headers present.
- **Prisma 7.10 + Node 24 + TypeScript 6:** `prisma --version` and generation pass. The schema engine binary runs on this machine.
- **Next 16.3.8 + React 19.3.0:** builds and pre-renders.
- **BullMQ 5.81.5 + ioredis 5.11.1:** a single ioredis copy in the tree, so there is no client-type mismatch. Not yet exercised against Redis (no Redis available, see B2).

## 2. pnpm installation audit (`ERR_PNPM_IGNORED_BUILDS`)

The original error came from pnpm 12 blocking dependency install scripts by default. In step 3 I cleared it with
`pnpm approve-builds --all`, which was the unsafe blanket approach. **[fixed in audit]** Each package was re-examined:

| Package | Script | Needed? | Evidence | Decision |
|---|---|---|---|---|
| `@prisma/engines` | `postinstall` fetches the schema-engine binary | **Yes** | `prisma migrate` needs `schema-engine-windows.exe` / linux equivalent | allow |
| `prisma` | `preinstall` runs a Node version check | No | script only prints a warning | deny |
| `argon2` | `install`: `node-gyp-build` compiles only if no prebuild matches | No (our targets) | clean install with script denied → `argon2.hash()` works | deny |
| `esbuild` | `postinstall` verifies the binary (fallback download) | No | clean install with script denied → `tsx` and `vitest` work | deny |
| `msgpackr-extract` (BullMQ → msgpackr) | `install`: compile if no prebuild | No | denied → native extractor still loads from prebuilt package; JS fallback exists anyway | deny |
| `workerd` | — | n/a | no longer in tree | entry removed |

Verification sequence, run on a fully deleted `node_modules`:

1. `pnpm install --frozen-lockfile` exits 0, with no ignored-build errors.
2. `pnpm build` passes for all 6 buildable projects.
3. `pnpm typecheck` passes.
4. `pnpm test` passes 5/5.
5. Runtime smoke tests: argon2 hash, msgpackr round-trip, tsx, schema engine `--version`, API `/health`, and worker boot.

The approvals with their reasons now live in `pnpm-workspace.yaml`.

**Hidden-failure caveat.** Linux container builds (Phase 19) must re-run the same smoke checks. If the base image is
musl/Alpine or arm64 without matching prebuilds, argon2 and msgpackr-extract would need their install scripts
there. The Dockerfile should use a glibc image.

## 3. Monorepo audit

| Package | Exists | Depends on (workspace) | Exports | Verdict |
|---|---|---|---|---|
| `packages/config` | ✅ | — | `tsconfig.base.json` only | ✅ no logic |
| `packages/shared` | ✅ | — | ESM `dist/index.js` + d.ts | ⚠️ contains policy, see below |
| `packages/channels` | ✅ | shared | ESM | ✅ |
| `packages/db` | ✅ | — | ESM, re-exports full Prisma client | ❌ see B4 |
| `apps/api` | ✅ | shared, db, channels | app | ⚠️ |
| `apps/worker` | ✅ | shared, db, channels | app | ⚠️ exits immediately (W7) |
| `apps/web` | ✅ | shared | app | ✅ no db/channels dependency |

- **Dependency graph:** `config ← shared ← channels`; `db` stands alone; the apps sit on top. No cycles: pnpm's topological build order is `shared → channels → db → apps`.
- **Frontend → DB:** `apps/web/package.json` has no `@workeasy/db`, `pg` or `@prisma/*`, and pnpm's strict layout means web cannot import packages it doesn't declare. It's correct today, but **nothing prevents** someone adding the dependency later. No lint or boundary tool exists (B9).
- **TypeScript configuration:**
  - Packages build independently with `tsc`, with no project references. That's fine for now, but `dev` needs packages built once first.
  - **Gap:** no `composite`/references, so an IDE resolves workspace imports to `dist/`. Changing `shared` requires its watcher to be running.
- **Business logic in shared:** `packages/shared` holds `SYSTEM_ROLES` (role → permission policy) and `CAMPAIGN_TRANSITIONS` (domain state machine). Both are server-side policy. The frontend should receive *the current user's effective permissions* and *a campaign's allowed actions* from the API, never compute them. **Required change R3.**
- **API depends on channels:** acceptable only for provider callback parsing and test sends. Real sending must go through the worker. Documented as a rule in R10.

## 4. Architecture boundary audit

Target (enforced by tooling once R9 lands):

```
apps/web  ──HTTP──▶ apps/api ─▶ modules/*/application ─▶ modules/*/domain
                                        │
                                        ▼
                               modules/*/infrastructure (repositories) ─▶ @workeasy/db ─▶ PostgreSQL
apps/worker ─▶ modules/*/application ─▶ … same repositories
other Workeasy products ──▶ public API / integration events only (never the database)
```

Findings:

1. **Missing layer.** There is no application/domain/repository structure yet. The API has one controller. This is expected at this stage, but Phase 4 must create it before any feature code. Shape (R10):
   - `apps/api/src/modules/<context>/{domain,application,infrastructure,http}`
   - The worker imports the same `application` services.
   - Shared services move to `packages/core` if the worker and API must not depend on each other.
2. **Unscoped data access is possible.** `@workeasy/db` exports `PrismaClient` and `createPrismaClient()`, so any code can query without `withTenant` (B4).
3. **No cross-product contract yet.** Other Workeasy modules have no documented API or event contract to use. Phase 15 defines it; the event envelope (§6) must be settled now so contracts don't need a rewrite later.
4. **Architecture doc §4 is wrong** on one point: it says system jobs use the privileged (owner) role. That would let any job bypass RLS. Corrected rule: jobs run as the app role inside `withTenant`. Only a few cross-tenant *discovery* queries go through narrow `SECURITY DEFINER` functions, such as "which campaigns are due" or "which org owns provider message X". Those functions return IDs and org IDs only (R6).

## 5. Multi-tenancy audit

### 5.1 Application layer

| Rule | Current state | Required |
|---|---|---|
| Every tenant query scoped by org | `withTenant()` exists; nothing forces its use | `@workeasy/db` exports only `TenantDb` (scoped) and `SystemDb` (named discovery functions); lint bans `PrismaClient` imports outside `packages/db` (R4, R9) |
| Never trust client-supplied orgId | no endpoints yet | org comes from the session's *active membership* or the API key's bound org. A client-selected org (org switcher) is only an index into the principal's memberships and is verified per request; mismatch = 404 |
| Derive tenant from identity | — | `AuthContext` built by guard; services take `ctx`, never a bare `orgId` from DTOs |
| Composite tenant FKs | — | child rows reference `(org_id, parent_id)` so a row cannot point at another tenant's row even via a bug (see §9) |

### 5.2 Database layer

| Check | Current state | Verdict |
|---|---|---|
| App role is not owner, `NOBYPASSRLS` | `infra/postgres/init.sql`: `workeasy_app NOSUPERUSER NOBYPASSRLS` | ✅ |
| Migration role owns schema | `workeasy` (DB superuser in the docker image) owns tables | ⚠️ superuser for local dev only; production migration role should be a non-superuser owner |
| Grants | `ALTER DEFAULT PRIVILEGES … GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES` to app | ❌ app role could UPDATE/DELETE append-only tables (events, consent, audit) and touch `_prisma_migrations` (R5) |
| Grants only via docker init | `init.sql` runs only on a fresh docker volume | ❌ hosted Postgres would get no roles/grants. Role setup and grants must be a migration (R5) |
| RLS policies | none (only `organizations` table exists, no policy) | expected; Phase 4 migration must `ENABLE` **and** `FORCE ROW LEVEL SECURITY` |
| Policy expression | not written yet | use `org_id = nullif(current_setting('app.org_id', true), '')::uuid` → missing context returns **zero rows** instead of erroring or leaking |
| Pooled connections | `set_config(…, true)` = transaction-local | ✅ cannot leak between pooled requests. The rule: never use session-level `SET` |

### 5.3 Tenant-isolation test plan

Runs against real Postgres as the `workeasy_app` role. It's part of CI and fails the build on any leak.

| # | Test | Method | Expected |
|---|---|---|---|
| T1 | A cannot read B | seed orgs A, B with contacts; in `withTenant(A)` select all contacts, then select B's contact by id | only A rows; B by id → null |
| T2 | A cannot update B | `withTenant(A)` update B's contact by id | 0 rows affected; B unchanged |
| T3 | A cannot delete B | same for delete | 0 rows affected |
| T4 | A cannot insert into B | `withTenant(A)` insert row with `org_id = B` | rejected by `WITH CHECK` |
| T5 | No context = no data | query without `withTenant` as app role | 0 rows (not an error, not all rows) |
| T6 | Cross-tenant FK impossible | in A, insert list membership referencing B's contact id | FK violation (composite FK) |
| T7 | Context does not leak across pool | run A then B on the same pooled connection, then no-context query | no rows |
| T8 | Jobs keep tenant | enqueue job for A; processor wrapper asserts `job.data.orgId` present and runs `withTenant` | job without orgId fails fast, never runs unscoped |
| T9 | Webhooks cannot cross tenants | provider callback for B's message id arrives on A's credentials/endpoint | org resolved from message routing table, not payload; mismatch with endpoint's org → rejected and logged |
| T10 | Analytics scoped | rollup query in `withTenant(A)` | only A aggregates; platform-wide reporting only via a separate read role over anonymized aggregates |
| T11 | API surface sweep | for every route, call with org A credentials against org B resource ids | 404 (never 403, which would confirm existence) |
| T12 | Append-only enforced | as app role, `UPDATE`/`DELETE` on events, consent_records, audit_logs | permission denied |

## 6. Event architecture audit

The architecture doc's single `events` table lacks several envelope fields and mixes three different concepts.
**Required change R7** replaces §8 of `architecture.md` with the following.

### 6.1 Envelope (all event kinds)

| Field | Type | Notes |
|---|---|---|
| `id` | UUIDv7 | globally unique, time-ordered |
| `org_id` | uuid | tenant; RLS key |
| `type` | text | e.g. `contact.consent_withdrawn` |
| `version` | smallint | payload schema version per type |
| `aggregate_type` / `aggregate_id` | text / uuid | entity the event is about (contact, campaign, journey…) |
| `contact_id` | uuid null | denormalized for timeline queries |
| `occurred_at` | timestamptz | when it happened (provider time for callbacks) |
| `recorded_at` | timestamptz | when we stored it; late-arrival detection |
| `actor_type` / `actor_id` | enum / text | user, api_key, system, contact, provider |
| `source` | text | api, worker, import, webhook:<provider>, tracking |
| `correlation_id` | uuid | one per user request / send run / journey enrollment |
| `causation_id` | uuid null | id of the event that caused this one |
| `idempotency_key` | text null | provider event id or client key; dedupe via separate `event_dedupe(org_id, key)` table because unique constraints on a partitioned table must include the partition key |
| `payload` | jsonb | validated by a Zod schema per (type, version) |

### 6.2 Three event kinds, kept separate

| Kind | Purpose | Storage / transport | Examples | Guarantees |
|---|---|---|---|---|
| **Domain events** | state changes inside Campaigns; drive timeline, scoring, journeys | written in the same transaction as the change (outbox table) → relayed to queues | `contact.created`, `consent.withdrawn`, `campaign.status_changed`, `journey.published`, `suppression.added` | exactly-once write, at-least-once delivery, ordered per aggregate |
| **Integration events** | public, versioned contracts for other Workeasy products and customer webhooks | derived from domain/analytics events by a mapper; published to bus + webhooks | `campaigns.contact.unsubscribed.v1`, `campaigns.message.clicked.v1` | stable schemas, PII-minimized, signed, at-least-once, consumers must dedupe on `id` |
| **Analytics events** | high-volume engagement/delivery facts | appended directly by ingestion workers to the monthly-partitioned `engagement_events` table; never via the outbox; aggregated into rollups | `message.delivered`, `message.opened` (with `is_machine` flag), `message.clicked`, `message.bounced` | idempotent on provider event id; may arrive late or out of order |

An analytics event can *cause* a domain event: a hard bounce fact causes `suppression.added`, linked by
`causation_id`. The contact timeline is a merged read over domain + analytics events for one contact.

## 7. Zoho parity classification

Source key: **Z** = documented in Zoho docs (research report, Oct 2026) · **B** = product brief · **—** = neither.
Categories as requested: `ZOHO_PARITY`, `OUR_IMPROVEMENT`, `OUR_ORIGINAL_DESIGN`, `NOT_VERIFIED`.

| Spec | Feature | Class | Basis |
|---|---|---|---|
| M1 | Signup/login/reset/sessions/MFA/SSO-ready | OUR_ORIGINAL_DESIGN | B; Zoho auth is Zoho Accounts, not researched |
| M2 | Manager / Editor / Viewer roles, Editor cannot send | ZOHO_PARITY | Z (workspace roles) |
| M2 | Owner and Analyst roles | OUR_ORIGINAL_DESIGN | — |
| M2 | Custom roles per module/action | ZOHO_PARITY | Z |
| M2 | Rule-based approval policies, invalidate on edit, all channels | OUR_IMPROVEMENT | Z has per-user approval (2.0) |
| M2 | Workspaces deferred | OUR_ORIGINAL_DESIGN | Z has workspaces → see USER DECISION D2 |
| M3 | Actionable insight dashboard (value → change → action) | OUR_ORIGINAL_DESIGN | B |
| M4 | Subscription types marketing / non-marketing / unsubscribed | ZOHO_PARITY | Z |
| M4 | Self-unsubscribed resubscribe only by own action | ZOHO_PARITY | Z |
| M4 | Multi-identity contacts, reversible merge | OUR_ORIGINAL_DESIGN | — |
| M4 | Unified timeline | OUR_ORIGINAL_DESIGN | B |
| M5 | Lists, tags | ZOHO_PARITY | Z |
| M5 | Suppression by address/domain/phone | OUR_IMPROVEMENT | Z: Do-Not-Mail registry; domain-level **NOT_VERIFIED** in Zoho |
| M6 | Nested AND/OR/NOT segments | OUR_IMPROVEMENT | Z: groups of criteria, 50 criteria / 10 groups |
| M6 | Segment "save as list" | ZOHO_PARITY | Z |
| M6 | Unused segments flagged at 90 days | OUR_IMPROVEMENT | Z: inactive after 60 days |
| M7 | Topic hierarchy Brand → Category → Topic, preference center | ZOHO_PARITY | Z |
| M7 | Multiple topics per campaign | OUR_IMPROVEMENT | Z: exactly one |
| M8 | Consent record fields + evidence | OUR_IMPROVEMENT | Z: GDPR lawful basis per topic; evidence model not documented |
| M8 | Double opt-in | ZOHO_PARITY | Z |
| M8 | DOI expiry 7 d, reminder 48 h | OUR_ORIGINAL_DESIGN | Z expiry NOT_VERIFIED |
| M8 | Eligibility exclusions (non-marketing, unsubscribed, bounced, frequency, no topic consent, unengaged) | ZOHO_PARITY | Z |
| M8 | Ordered reason codes visible per contact | OUR_IMPROVEMENT | — |
| M8 | Frequency caps per channel day/week/month + min interval | ZOHO_PARITY | Z |
| M8 | Quiet hours deferral | OUR_ORIGINAL_DESIGN | — (aligned with US TCPA hours) |
| M9 | Engagement per channel + fit, total clamped −999…999, decay | ZOHO_PARITY | Z |
| M9 | Default point values | **mixed, see §8 (spec error)** | |
| M10 | Email regular / A/B / RSS / follow-up; SMS; WhatsApp | ZOHO_PARITY | Z |
| M10 | Our 13-state machine | OUR_IMPROVEMENT | Z states: drafts, scheduled, inprogress, sent, stopped, canceled, tobereviewed, reviewed, paused, intesting |
| M10 | Clone, cancel schedule, pause in progress | ZOHO_PARITY | Z |
| M10 | Reports archived (not deleted) on delete | OUR_IMPROVEMENT | Z deletes reports |
| M10 | Auto-pause on bounce > 5 % | ZOHO_PARITY | Z (pause 24 h; 2nd breach cancels) |
| M10 | Complaints > 0.1 % → paused for review | OUR_IMPROVEMENT | Z stops/cancels |
| M10 | Automated validation with explained content score | OUR_IMPROVEMENT | Z: manual ~30 min review |
| M10 | Scheduling: now / later / batches / recipient TZ / optimal time | ZOHO_PARITY | Z |
| M10 | "Skip if window passed", configurable optimal window | OUR_IMPROVEMENT | — |
| M10 | Follow-up targets (unopened/opened/clicked/opened-not-clicked) | ZOHO_PARITY | Z |
| M10 | 25 lists/segments; 10 test addresses | OUR_IMPROVEMENT | Z: 10 and 5 |
| M10 | A/B 2–5 variants, significance test, fallback, stoppable | OUR_IMPROVEMENT | Z: 2 variants, ≤60 %, open/click/manual |
| M11 | DnD / HTML / plain text editors, saved sections, dynamic content | ZOHO_PARITY | Z |
| M11 | Liquid-style merge tags (Zoho syntax imported) | OUR_IMPROVEMENT | Z: `$[FNAME\|fallback]$` |
| M11 | Template versioning with diff, brand kit | OUR_IMPROVEMENT | Z versioning NOT_VERIFIED (2017 blog only) |
| M11 | 5 MB images / 20 MB files | OUR_IMPROVEMENT | Z: 1 MB / 10 MB |
| M12 | Machine-open detection | OUR_IMPROVEMENT | Z: bot opens separated; Apple MPP NOT_VERIFIED |
| M12 | RFC 8058 one-click unsubscribe | OUR_ORIGINAL_DESIGN | — (Gmail/Yahoo bulk-sender requirement) |
| M12 | Soft-bounce retry 72 h, 5 consecutive → hard | OUR_ORIGINAL_DESIGN | Z: retries up to 5 days, ~7 soft → hard |
| M13 | Trigger, process and action catalogue | ZOHO_PARITY (+ additions) | Z 15 triggers; we add custom event, field changed |
| M13 | Goal node | NOT_VERIFIED | Z 2.0 had goals; 3.0 not verified |
| M13 | Drain state, in-flight version migration, debugger, re-entry cooldown | OUR_IMPROVEMENT | Z: freeze only; contacts stranded; on/off re-entry |
| M14 | Metric formulas (open = opens / delivered…) | ZOHO_PARITY | Z (3.0) |
| M14 | ISP breakdown, revenue attribution | OUR_IMPROVEMENT | Z not documented |
| M15 | SPF/DKIM verification, free-mail senders rejected | ZOHO_PARITY | Z |
| M15 | DMARC report ingestion, warm-up, configurable thresholds | OUR_IMPROVEMENT | Z checks DMARC presence only |
| M16 | DLT/10DLC registration, segment splitting | ZOHO_PARITY | Z |
| M16 | Multiple links, STOP/START handling, transactional SMS, two-way | OUR_IMPROVEMENT | Z: one link, promotional only, keywords not documented |
| M17 | Meta template approval, components, limits | ZOHO_PARITY | Z |
| M17 | 24 h service window handling, quality rating/tier | OUR_IMPROVEMENT | Meta platform rule; Z not documented |
| M18 | Resource REST API, OpenAPI, SDK, bulk 10k, no lockouts | OUR_IMPROVEMENT | Z: verb endpoints, 500/5 min, 30 min lockout |
| M18 | Signed, retried webhooks with replay | OUR_IMPROVEMENT | Z signing/retries NOT_VERIFIED |
| M19 | AI content / audience / optimization | OUR_IMPROVEMENT | Z has Zia generation (3.0); scope otherwise B |
| M20 | Forms incl. pop-ups, CAPTCHA, DOI | ZOHO_PARITY | Z |
| M20 | Exit-intent/scroll triggers, Turnstile, honeypot | OUR_IMPROVEMENT | — |
| M21 | Usage metering, plans-as-data, DSAR | OUR_ORIGINAL_DESIGN | B |

## 8. Business-rule audit

### 8.1 Spec errors found

1. **M9 default scores contradict both sources.**
   - The spec says soft bounce −5. Zoho documents −20, and the brief gives no value, so −5 was invented and is presented as a default. **Fix:** use Zoho's −20 and label it.
   - WhatsApp click +12 comes from the brief, Zoho uses +10. Keep +12 (the brief wins) but label it.
   - Email open +5 / click +10 / form +20 / purchase +50 / unsubscribe −30 / spam −100 are from the brief. Spam −100 and hard bounce −50 also match Zoho.
2. **M6 wording.** The spec calls Zoho segments "flat". They are actually criteria grouped into up to 10 AND/OR groups (two levels). Fix the wording.
3. **Spec header** says "every rule below is ours", yet many rules are Zoho parity. Replace it with per-rule provenance tags (R1).

### 8.2 Rule provenance

| Kind | Rules |
|---|---|
| **Copied from documented Zoho behaviour** | subscription types and resubscription rule; topic-required sending; exclusion list at send; frequency-cap dimensions; segment save-as-list; A/B variables + 60 % max test share (if we keep a cap); auto-pause at 5 % bounce; DLT/10DLC; WhatsApp template component limits (header 60, body 800 / 10 vars, footer 60, buttons ≤10); score clamp −999…999; metric formulas over *delivered*; free-mail senders rejected |
| **Inferred from documentation** | campaign state transitions (Zoho documents states and actions piecemeal; transition table is our reconstruction); "only marketing contacts count toward plan"; webhook event list |
| **Created by us (proposed defaults)** | password ≥10 chars; lockout 5/15 min account, 20/15 min IP; session 7 d idle / 30 d absolute; invitation 7 d; 200 custom fields; 500 tags; 1 M-row imports; nesting depth 5 / 100 conditions; 25 audiences/campaign; 10 test addresses; A/B 2–5 variants, ≥100 per variant, 95 % z-test; DOI 7 d + 48 h reminder; quiet hours 21:00–08:00; soft-bounce 72 h / 5 consecutive; complaint auto-pause; 5 MB / 20 MB assets; API 100 rps burst / 6000 per min; bulk 10 k; webhook retry 24 h; segment staleness 90 d; dashboard p95 300 ms and other NFR targets |
| **Still requires verification** | Zoho goal node in 3.0; DOI expiry; Apple MPP handling; webhook retries/signing; domain-level suppression; 3.0 API; whether 3.0 keeps content approval; retention periods (legal input needed: §9.9) |

Every "created by us" value is a **configurable default**, stored as plan or org settings, not as code constants.
Requiring that is part of R1.

## 9. Database readiness

The audit judges the bounded contexts stable enough to *design*, but the full schema should not be implemented
yet. D1 (identity ownership) changes the identity tables, and B2 means RLS can't be exercised. Phase 4 should
build only Identity/Tenancy/Audit tables once D1 is answered.

### 9.1 Domain boundaries (bounded contexts) and aggregate roots

| Context | Aggregate roots | Owned entities | Tenant-owned? |
|---|---|---|---|
| Identity & Access | User | Session, UserIdentity, MfaFactor, TrustedDevice, PasswordReset/EmailVerification tokens | **No** (global; users span orgs) |
| Tenancy | Organization | Membership, Role, RolePermission, Invitation, OrgSettings, PlanSubscription, UsageCounter | Yes |
| Audience | Contact; List; Segment; CustomFieldDefinition | ContactIdentity (channel address), ListMembership, ContactTag, Tag, SegmentSnapshot, Suppression | Yes |
| Preferences & Consent | Topic (with Brand/Category) | TopicSubscription, ConsentRecord, ConsentText (versioned) | Yes |
| Scoring | ScoringModel | ScoringRule, ContactScore, ScoreLedger | Yes |
| Content | Template; Asset; BrandKit | TemplateVersion, SavedSection, AssetFolder | Yes |
| Campaigns | Campaign | CampaignVersion (immutable content+config snapshot at validation), CampaignAudience, AbVariant, Approval, StatusHistory | Yes |
| Messaging | SendRun | Delivery (one per contact×message), TrackedLink, ProviderMessageRoute | Yes (route table has privileged lookup) |
| Journeys | Journey | JourneyVersion (immutable graph), Enrollment, StepRun, Timer | Yes |
| Events & Analytics | — (append-only facts) | DomainEvent/Outbox, EngagementEvent, rollups, ContactEngagementStats | Yes |
| Deliverability | SenderDomain; SenderIdentity | DnsCheck, DmarcReport, ReputationSnapshot | Yes |
| Integrations & API | Integration; WebhookEndpoint; ApiKey | Credential (encrypted), FieldMapping, SyncRun, WebhookDelivery | Yes |
| Forms | Form | FormVersion, FormSubmission | Yes |
| Audit | — | AuditLog | Yes (+ platform security log, global) |

### 9.2 Key relationships

- `Organization 1─* Membership *─1 User` and `Membership *─1 Role`.
- `Contact 1─* ContactIdentity`. Each identity has a channel and a normalized address, unique per org per channel.
- `Contact *─* List` (via ListMembership) and `Contact *─* Tag`.
- `Contact 1─* TopicSubscription *─1 Topic` (per channel).
- `Contact 1─* ConsentRecord`, which is append-only. Current consent is a materialized `contact_consent_state` row per (contact, channel, topic), updated in the same transaction.
- `Campaign 1─* CampaignVersion`. Sending uses one frozen version.
- `CampaignVersion 1─* SendRun 1─* Delivery *─1 Contact`.
- `Delivery 1─* EngagementEvent` (logical link, no FK).
- `Journey 1─* JourneyVersion 1─* Enrollment *─1 Contact`, and `Enrollment 1─* StepRun`.

### 9.3 Ownership and tenant rules

- Every tenant table has `org_id uuid NOT NULL` as the **first column of the PK or a unique key** (`UNIQUE (org_id, id)`).
- RLS is enabled **and forced** on every tenant table, with policy `USING` and `WITH CHECK` on `app.org_id`.
- Global tables (users, sessions, platform config) have no RLS. They are only reachable through the identity service.

### 9.4 Volume classes

| Class | Tables | Strategy |
|---|---|---|
| **High-volume, append-only** | engagement_events, domain_events/outbox, deliveries, step_runs, score_ledger, webhook_deliveries, audit_logs, form_submissions | monthly range partitions on time; BRIN on time; no FKs inbound; detach-and-drop for retention |
| **High-volume, mutable** | contacts, contact_identities, list_memberships, contact_tags, topic_subscriptions, contact_consent_state, contact_scores, enrollments, contact_engagement_stats | B-tree on (org_id, …); fillfactor < 100 on hot-update tables (scores, stats, enrollments) |
| **Mutable configuration** | organizations, roles, lists, segments, topics, templates, campaigns, journeys, sender_domains, integrations, webhook_endpoints, scoring_rules, forms | low volume; soft delete; versioned where publishing matters |
| **Immutable versions** | campaign_versions, journey_versions, template_versions, consent_texts, form_versions | insert-only after publish; referenced by id from runtime rows |

### 9.5 Required indexes (initial)

- `contacts`:
  - `(org_id, id)` PK
  - `(org_id, updated_at, id)` for cursor lists
  - GIN `(custom_fields jsonb_path_ops)`
  - `(org_id, subscription_type)`
- `contact_identities`: unique `(org_id, channel, address_normalized)`; `(org_id, contact_id)`.
- `list_memberships`: PK `(org_id, list_id, contact_id)`; `(org_id, contact_id)`.
- `engagement_events`:
  - `(org_id, contact_id, occurred_at DESC)` for the timeline
  - `(org_id, source_type, source_id, type)` for reports
  - BRIN `(occurred_at)`
- `deliveries`: unique `(org_id, send_run_id, contact_id)`, which is the idempotency key; `(org_id, contact_id, created_at DESC)`.
- `provider_message_routes`: unique `(provider, provider_message_id)` → org_id, delivery_id. This is a global lookup table, exposed only through a `SECURITY DEFINER` function.
- `enrollments`: unique `(org_id, journey_id, contact_id) WHERE status = 'active'`, unless re-entry is allowed; `(org_id, next_wake_at)` for timers.
- `audit_logs`: `(org_id, occurred_at DESC)`; `(org_id, actor_id, occurred_at DESC)`.

### 9.6 Unique constraints

| Table | Constraint |
|---|---|
| `users` | `lower(email)` unique (global) |
| `organizations` | `slug` |
| `memberships` | `(org_id, user_id)` |
| `roles` | `(org_id, key)` |
| `tags` | `(org_id, lower(name))` |
| `lists` | `(org_id, lower(name)) WHERE deleted_at IS NULL` |
| `topics` | `(org_id, key)` |
| `sender_domains` | `(org_id, domain)` |
| `api_keys` | `prefix` (global, so keys are identifiable) |
| `contact_scores` | `(org_id, contact_id)` |
| `event_dedupe` | `(org_id, idempotency_key)` |

### 9.7 Foreign-key strategy

- **Composite tenant FKs:** `(org_id, contact_id) REFERENCES contacts(org_id, id)`. This makes a cross-tenant reference impossible even if application code is wrong.
- `ON DELETE RESTRICT` by default. `CASCADE` only for owned join rows (list_memberships, contact_tags, topic_subscriptions on contact erasure).
- **No FKs into or out of partitioned high-volume tables.** Integrity there is guaranteed by the writer and a nightly orphan check.

### 9.8 Soft delete and erasure

- **Configuration objects** (campaigns, templates, lists, segments, journeys, forms): `deleted_at` with 30-day restore, and partial unique indexes `WHERE deleted_at IS NULL`. Blocked while referenced by an active journey or scheduled campaign.
- **Contacts:**
  - User-initiated delete is a soft delete (30 days).
  - A GDPR erasure is a hard delete of PII. It leaves a `suppression` tombstone holding the *hash* of each address, so re-import doesn't resurrect the contact.
  - Events keep `contact_id` but lose PII fields.
- **Append-only tables** are never updated or deleted by the app role. Retention is done by dropping partitions.

### 9.9 Audit and retention strategy (proposed defaults, plan-configurable)

| Data | Retention | Basis |
|---|---|---|
| Raw engagement events | 25 months, then rollups only | ours |
| Deliveries | 13 months | ours |
| Domain events / outbox | outbox rows 7 days after relay; domain events 25 months | ours |
| Audit logs | 2 years (enterprise configurable) | ours |
| Consent records | life of contact + period after withdrawal | **legal input required** (see D3) |
| Webhook delivery logs | 30 days | ours |
| Sessions / tokens | until expiry + 30 days | ours |

Audit mechanism:
- An interceptor writes an `audit_logs` row for every mutating request: actor, org, action, target, before/after diff (PII fields masked), IP, user agent and correlation_id.
- Security events (login, MFA, role change, key creation, export) are written explicitly.

## 10. Performance audit — hot paths

| Path | Mode | Design |
|---|---|---|
| Contact import | **async, batched, queued** | upload to object storage → streaming parse → 1–5 k row batches via `COPY` into staging table → set-based upsert → progress events; never per-row API calls |
| Segment evaluation (builder count) | **sync, cached, estimated** | debounced; AST → SQL over `contacts` + `contact_engagement_stats`; Redis cache by AST hash; statement timeout; >1 M → estimate then async exact |
| Segment evaluation (send/trigger) | **async, precomputed** | at send: materialize into `segment_snapshots`; for journey triggers: incremental re-evaluation on relevant domain events |
| Campaign recipient generation | **async, batched** | single set-based `INSERT … SELECT` of eligible contacts into `deliveries` with ineligibility reasons, chunked by contact id range |
| Message scheduling | **queued** | per-delivery `scheduled_at`; a ticker enqueues due chunks; recipient-TZ / optimal-time compute `scheduled_at` at generation |
| Message delivery | **queued, rate-limited** | BullMQ with per-org and per-provider limiters; idempotent by delivery id; provider batch APIs where available |
| Webhook / callback ingestion | **sync accept, async process** | verify signature → write raw payload to a queue → 200 fast; processing resolves tenant via `provider_message_routes` |
| Event ingestion | **queued, batched** | consumers batch-insert (`COPY`/multi-row) into partitions; dedupe table |
| Analytics aggregation | **precomputed** | incremental rollup counters per campaign/day; unique counts via per-delivery first-open/first-click flags, not `COUNT(DISTINCT)` over events |
| Contact timeline | **sync, indexed** | `(org_id, contact_id, occurred_at DESC)` keyset pagination over events + domain events |
| Scoring | **async, event-driven + nightly batch** | real-time increments via ledger; nightly decay recompute only for contacts with ledger activity in the window |
| Workflow execution | **queued, durable** | enrollment state in Postgres; delayed jobs for waits keyed `(enrollment, node)`; timer sweeper as safety net; step runs append-only |

## 11. Security audit

| Area | Current state | Gap / required |
|---|---|---|
| Authentication boundary | none yet | Phase 4. Every route authenticated by default (global guard), opt-out via `@Public()` |
| Authorization / RBAC | permission catalogue exists | guard + service-level checks; role policy moved server-side (R3) |
| Tenant isolation | design only | §5; B4, R4–R6 |
| Secrets | `.env` git-ignored; `.env.example` has empty secrets ✅; `init.sql` and `docker-compose.yml` hold **dev-only** passwords | env validated with Zod at boot, fail fast on missing `SESSION_SECRET`/`ENCRYPTION_KEY` (R8). Today `@fastify/cookie` silently starts with `secret: undefined` |
| Encryption | planned envelope encryption | key-provider interface (local key in dev, KMS in prod) before storing any provider credential |
| API keys | planned | `wk_live_<prefix>_<secret>`; store SHA-256 of secret; scopes; last-used; org-bound |
| Webhook signing | planned | HMAC-SHA256 over `timestamp.body`, 5-minute tolerance, key rotation with two active secrets |
| Inbound provider callbacks | `ChannelAdapter.parseCallback` has **no verification hook** | add `verifyCallback(rawBody, headers, credentials)` to the contract before step 9 (R11) |
| Rate limiting | `@fastify/rate-limit` installed, not registered | Redis-backed; per IP + per account on auth; per API key on public API |
| Client IP trust | `trustProxy: true` trusts **any** `X-Forwarded-For` | spoofable, defeats IP rate limits and audit IPs. Set explicit hop count / proxy CIDRs from env (R8) |
| Audit logs | planned | §9.9 |
| PII handling | — | PII field registry (email, phone, names, IP, custom fields flagged PII); masked in logs/audit diffs; pino redaction |
| Export permissions | `contacts.export`, `reports.export`, `audit.export` exist ✅ | exports async, audited, expiring signed URLs |
| Import validation | — | size/row limits, MIME + magic-byte check, CSV formula-injection neutralization on **export** (`=`,`+`,`-`,`@` prefixes) |
| File uploads | — | type allow-list, re-encode images, SVG sanitized or rasterized, served from separate cookieless asset domain |
| SSRF | — | webhook URLs, RSS feeds, URL imports, link checker: shared fetcher that resolves DNS and blocks private/link-local/metadata ranges, no redirects to private IPs |
| XSS | — | user HTML only rendered in sandboxed `iframe` (`sandbox` without `allow-same-origin`) on a separate origin; CSP on web app |
| SQL injection | Prisma parameterized; `withTenant` uses tagged template ✅ | segment compiler must emit parameterized SQL only; field names from allow-list, never from input |
| CSRF | cookie auth planned, `SameSite=Lax` | double-submit token on state-changing cookie routes; public API is bearer-only |
| Replay | — | signed webhook timestamps; single-use tokens (reset/verify/invite) hashed + consumed atomically |
| Idempotency | — | `Idempotency-Key` on public POST (24 h store); deliveries unique per (run, contact); event dedupe table |

## 12. Test foundation

| Layer | Scope | Tooling | Runs | Exists now |
|---|---|---|---|---|
| Unit | pure domain: state machines, eligibility order, permission sets, segment AST validation/compilation, scoring math, merge-tag rendering | Vitest | every commit | 5 tests (shared) |
| Integration | repositories + services against real Postgres/Redis | Vitest + Testcontainers or compose services | every commit (CI) | none (B2) |
| Database / RLS | §5.3 T1–T7, T12; grant checks (`has_table_privilege`) | Vitest, connecting as `workeasy_app` | every commit | none |
| Authorization | matrix: every route × every system role → expected 2xx/403; T11 cross-tenant sweep auto-generated from route table | Vitest + Nest testing module + Fastify inject | every commit | none |
| API | request/response schemas, error shapes, pagination, idempotency | Fastify `inject` + OpenAPI response validation | every commit | none |
| Worker | job processors with fake adapters: retries, idempotency, tenant wrapper (T8), rate limits | Vitest + real Redis | every commit | none |
| Event | envelope validation, outbox relay exactly-once write, dedupe, ordering per aggregate, analytics → domain causation | Vitest | every commit | none |
| Contract | integration events + public API vs. versioned JSON Schemas/OpenAPI; channel adapter contract suite run against every adapter | Vitest + schema snapshots | every commit | none |
| End-to-end | signup → org → import → segment → campaign → send (Mailpit) → open/click → report; journey happy path | Playwright | nightly + pre-release | none |
| Performance | import 1 M rows, recipient generation 1 M, event ingest rate, segment count p95 | k6 + seeded datasets | weekly / pre-release | none |
| Security | dependency audit, secret scan, ZAP baseline on staging | pnpm audit, gitleaks, OWASP ZAP | CI / nightly | none |

---

## 13. Final decision

### A. BLOCKERS (must be resolved before Phase 4)

| # | Blocker | Owner |
|---|---|---|
| B1 | **Identity ownership is undecided.** The brief says other Workeasy modules talk to Campaigns via contracts, which implies a wider Workeasy platform. Whether Campaigns owns users, orgs and login or consumes them from Workeasy changes the entire Phase 4 scope. | **You: D1** |
| B2 | **No PostgreSQL/Redis available.** RLS, grants and isolation tests T1–T12 cannot be executed, and Phase 4's core deliverable is unverifiable without them. | **You:** install Docker Desktop or provide hosted DB/Redis |
| B3 | DB role/grant design is unsafe: blanket DML grants include append-only tables and `_prisma_migrations`, and grants exist only in docker init. | me (R5) |
| B4 | `@workeasy/db` exposes an unscoped `PrismaClient`; app-layer isolation is convention only. | me (R4) |
| B5 | Event envelope and event taxonomy undefined in architecture; the identity/tenancy tables in Phase 4 already emit domain events and audit logs. | me (R7) |
| B6 | Spec presents invented rules next to Zoho behaviour without provenance, and contains a wrong default (soft bounce −5). | me (R1, R2) |
| B7 | `trustProxy: true` and unvalidated env (cookie secret may be `undefined`). Both directly undermine Phase 4 auth (rate limiting, audit IPs, signed cookies). | me (R8) |
| B8 | Policy code (roles, transitions) lives in a package shipped to the browser. | me (R3) |
| B9 | No boundary enforcement: nothing stops web → db imports or `PrismaClient` use outside `packages/db`. | me (R9) |

### B. WARNINGS (safe to address later)

| # | Warning |
|---|---|
| W1 | `@visx/*` alpha packages come in transitively through Prisma Studio. They aren't used at runtime; accepted and documented. |
| W2 | The migration role is a Postgres superuser locally. Production needs a non-superuser owner role (Phase 19). |
| W3 | Vitest 5 is one month old. It's dev-only; fall back to 4.x if any instability appears. |
| W4 | No TypeScript project references. Dev requires package watchers. Revisit if DX suffers. |
| W5 | Not a git repository. There's no history and CI can't run. Recommend `git init` before Phase 4. |
| W6 | Turborepo is removed because this machine lacks the MSVC++ runtime. `pnpm -r` is fine at this size; reintroduce Turborepo in CI if build times grow. |
| W7 | The worker process exits right after boot because nothing holds the event loop. This resolves itself once queue processors exist (step 9). |
| W8 | `ConfigModule` loads `../../.env` relative to the working directory. Make it absolute or use a root-resolved path. |
| W9 | `packages/db/src/generated` isn't git-ignored. |
| W10 | Linux/container installs must re-run the native-module smoke checks (§2). Use a glibc base image. |
| W11 | UI libraries (`@tanstack/react-query`, `lucide-react`, `clsx`, Tailwind) use caret ranges. That's acceptable because they're non-critical and the lockfile pins them. |
| W12 | API depends on `channels`; must not send directly (rule in R10). |

### C. VERIFIED

- Clean `pnpm install --frozen-lockfile` with only one approved install script, whose need is demonstrated.
- `pnpm build`, `pnpm typecheck` and `pnpm test` all pass from a clean tree.
- All seven workspace projects exist, resolve through `workspace:*`, build in topological order and have no cycles.
- No direct prerelease dependencies. Production-critical packages are pinned exactly to mature lines.
- Compatibility:
  - NestJS 11 + TypeScript 6 + ESM + decorators boots.
  - Fastify helmet headers are present.
  - Prisma 7.10 works on Node 24 and the schema engine runs.
  - Next 16 + React 19.3 builds.
- Native modules (argon2, msgpackr-extract) load from prebuilds.
- The frontend has no database or channel dependency.
- `packages/config` contains no logic.
- `withTenant` uses transaction-local `set_config`, which is safe with pooled connections.
- `.env` is git-ignored and `.env.example` contains no secrets.

### D. REQUIRED CHANGES

| # | File(s) | Change |
|---|---|---|
| R1 | `docs/spec.md` | Replace the header claim with a provenance legend. Tag each rule `[Z]`, `[B]` or `[ours]`. Mark all `[ours]` numbers as configurable defaults. Fix the M6 wording. |
| R2 | `docs/spec.md` M9 | Soft bounce −20 `[Z]`. WhatsApp click +12 `[B]` (Zoho uses +10). Label each default with its source. |
| R3 | `packages/shared/src/permissions.ts`, `campaigns.ts` → `apps/api/src/modules/iam/domain/system-roles.ts`, `apps/api/src/modules/campaigns/domain/campaign-state.ts` | `shared` keeps only contracts: the `Permission` type and catalogue, status enums, Zod DTO schemas. Role policy and transitions move server-side. The API returns `permissions[]` and `allowedActions[]`. Move the tests with them. |
| R4 | `packages/db/src/index.ts` | Stop re-exporting `PrismaClient`/`createPrismaClient`. Export `createDatabase()` returning `{ tenant(ctx).run(fn), system: { dueCampaigns(), resolveProviderMessage(), … } }`. Export generated **types** only. |
| R5 | `infra/postgres/init.sql`; new `packages/db/prisma/migrations/0001_roles_and_rls/migration.sql` | Docker init only creates the login role. The migration: <br>• creates `app_rw` group role <br>• revokes default DML <br>• grants `SELECT, INSERT, UPDATE, DELETE` per mutable table and `SELECT, INSERT` only on append-only tables <br>• gives no access to `_prisma_migrations` <br>• adds helper `app.current_org()` with `nullif(current_setting('app.org_id', true), '')::uuid` <br>• `ENABLE` + `FORCE` RLS on every tenant table |
| R6 | `docs/architecture.md` §4 | Remove "privileged role used by system jobs". Document `SECURITY DEFINER` discovery functions returning ids + org ids only, and the job tenant wrapper. |
| R7 | `docs/architecture.md` §8 (+ new `docs/events.md`) | Replace with the envelope and three-kind taxonomy from §6. Add the `event_dedupe` table and the outbox. |
| R8 | `apps/api/src/main.ts`, new `apps/api/src/config/env.ts` (+ worker equivalent) | Zod-validated env, failing at boot. `trustProxy` from `TRUSTED_PROXIES` env (hop count or CIDR list), defaulting to `false`. Register `@fastify/rate-limit` with Redis store in Phase 4. Absolute `.env` path. |
| R9 | new `.dependency-cruiser.cjs`, root `package.json` script `lint:boundaries` | Rules: <br>• `apps/web` ✗→ `@workeasy/db`, `@workeasy/channels`, `pg`, `@prisma/*`, `ioredis`, `bullmq` <br>• nothing outside `packages/db` imports `generated/prisma` <br>• no cycles <br>• `domain/` imports nothing from `infrastructure/` or `http/` <br>Add to CI. |
| R10 | `docs/architecture.md` §3 | Document module layout `modules/<ctx>/{domain,application,infrastructure,http}`, worker reuse of application services, "API never sends; worker sends", and that other Workeasy products use only the public API and integration events. |
| R11 | `packages/channels/src/adapter.ts` | Add `verifyCallback(rawBody: Buffer, headers, credentials): boolean`. Callback tenant resolution goes via `provider_message_routes`, never the payload. |
| R12 | root `package.json`, new `.node-version` | `"engines": { "node": ">=24 <25" }`, `.node-version` = `24.19.0`, `engine-strict` in `pnpm-workspace.yaml`. |
| R13 | `.gitignore` | Add `packages/db/src/generated`. |
| R14 | repo root | `git init` and initial commit (with your approval). |

### USER DECISION REQUIRED

**D1 — Who owns identity, organizations and login? (blocks Phase 4)**

The brief mentions "other modules in the larger Workeasy platform".

| Option | Phase 4 scope | Consequence |
|---|---|---|
| **A. Campaigns owns identity** (standalone product) | full signup/login/sessions/MFA-ready/orgs/RBAC as specified in M1–M2 | fastest to a usable product. If Workeasy later gains central identity, users and orgs need migrating to it and Campaigns becomes an OIDC client then (moderate rework of M1, M2 untouched) |
| **B. Workeasy platform owns identity** (Campaigns is an OIDC client) | no signup/password code. Campaigns validates Workeasy tokens, maps Workeasy org → tenant, and keeps only Campaigns-specific roles and permissions | needs the Workeasy identity provider's details now (issuer, claims, org model). Avoids duplicate accounts. Phase 4 is smaller but blocked on that system |
| **C. A now, built as a separable identity module** | as A, but identity lives in its own bounded context behind an interface, with org ids that are already globally unique UUIDs | slightly more structure in Phase 4. Switching to B later swaps the module rather than migrating data models. **Recommended if a Workeasy identity service is planned but not ready** |

**D2 — Workspaces inside an organization?**

Zoho has org → workspaces, with roles per workspace.

| Option | Consequence |
|---|---|
| **A. Org is the only tenant boundary now** (current plan) | simplest RLS (one key). Adding workspaces later means adding `workspace_id` + policies to every content table: a large migration once data exists |
| **B. Workspaces from day one** | every content table and RLS policy carries `workspace_id`, and roles are per workspace. More Phase 4 work, but agencies and multi-brand customers are supported natively |

**D3 — Consent-record retention period.** This is a legal/compliance choice, not an engineering one. For example, keep evidence for the lifetime of the contact plus N years after withdrawal. Until decided, consent records are kept indefinitely. That's the safe default, but it has a storage and GDPR-minimization cost.

**Also needed (environment, not product):** Docker Desktop installed (`winget install Docker.DockerDesktop` in an admin terminal, then reboot), or hosted Postgres and Redis connection strings. Without one of these, B2 stays open.

### E. PHASE 4 READINESS

**NOT READY.** Blockers B3–B9 are fixable by me in one pass once you approve the R-list. B1 needs your decision
(D1), and B2 needs Docker or hosted database credentials.

---

## 14. Resolution (2026-10-02, after approval)

Product decisions received:
- **D1:** option C, own identity behind a provider abstraction
- **D2:** workspaces from Phase 4
- **D3:** configurable, immutable consent evidence

**B2 (no database).** Resolved without admin rights. The EDB PostgreSQL 16.15 portable build lives in
`%LOCALAPPDATA%\Programs\pgsql`. The VC++ runtime DLLs it needs were copied app-locally from Microsoft-signed copies
(Edge 14.50.35719). It is managed by `scripts/local-postgres.ps1`.

| # | Status | Where |
|---|---|---|
| R1 | ✅ Provenance tags on every major rule; Zoho rule recorded next to each improvement | `docs/spec.md` |
| R2 | ✅ Soft bounce −20 (Zoho); every default labelled with its source | `docs/spec.md` §M9 |
| R3 | ✅ `shared` = contracts only (browser-safe, no Node types); roles/transitions server-side | `apps/api/src/modules/{tenancy,campaigns}/domain` |
| R4 | ✅ No client export; `withTenant` / `asUser` / `system`; identity and testing entry points | `packages/db/src` |
| R5 | ✅ Bootstrap roles (owner/app/identity/reporting); grants, column-level UPDATE, forced RLS, definer functions, append-only triggers in the migration | `packages/db/scripts/bootstrap.ts`, migration Part B |
| R6 | ✅ No privileged role for jobs; definer lookups only | `docs/architecture.md` §4, `docs/tenancy.md` |
| R7 | ✅ Envelope + three event kinds; domain events implemented | `docs/events.md`, `apps/api/src/modules/events` |
| R8 | ✅ Fail-closed Zod config; TRUST_PROXY explicit (never `true`); dev defaults isolated | `apps/api/src/config` |
| R9 | ✅ dependency-cruiser + manifest check (`pnpm lint:boundaries`); violations proven to fail | `.dependency-cruiser.cjs`, `scripts/check-package-boundaries.mjs` |
| R10 | ✅ Module layout and the "API never sends" rule documented and applied | `docs/architecture.md` §3 |
| R11 | ✅ `verifyCallback` added to `ChannelAdapter` | `packages/channels/src/adapter.ts` |
| R12 | ✅ `engines: >=24 <25`, `.node-version`, `engineStrict` | root |
| R13 | ✅ Generated client, dev mail, Playwright output ignored | `.gitignore` |
| R14 | ✅ Git initialized; work committed in reviewable steps | `git log` |

**New findings during implementation** (all fixed):

| Finding | Fix |
|---|---|
| A session was created for a deactivated user before being rejected | Status is now checked first |
| CSRF tokens were bound only to the session, so a stale session blocked sign-in | Public routes also accept an anonymous-bound signed token |
| Idempotency keys could be raced | Claim-first design (needed a column UPDATE grant) |
| TypeScript 6's `types: []` default hid Node types | Declared in the server tsconfig and kept out of `shared` |
| Timestamps written through Prisma were 5 h 30 min off, because the pg adapter sends timestamps without an offset and the server runs in Asia/Kolkata. Sessions rotated on every request and idle expiry was shortened. Caught by a flaky E2E step. | Every connection pinned to `TimeZone=UTC`, roles default to UTC, regression tests `packages/db/test/timezone.test.ts` + API rotation test |

**Phase 4 readiness: READY** (and Phase 4 implemented — see the Phase 4 report).
