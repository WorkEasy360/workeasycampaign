# Phase 6.7–6.8 — Audience Resolution v1.1, pre-flight, lifecycle commands (implementation record)

**Status:** Audience Resolution v1.1 IMPLEMENTED · 6.7 (pre-flight) COMPLETE · 6.8 (lifecycle commands) COMPLETE ·
**6.9 NOT STARTED** (Gate G3 not requested). **Date:** 2026-10-07. **Official progress:** 35 % (unchanged; §11).
**Authority:** product-owner approval of "Option 1" (Audience Resolution v1.1: `sample` + `topicStatus`) on 2026-10-07,
with implementation of 6.7 and 6.8 and a stop before 6.9. Architecture record: `docs/architecture/phase-6-campaign-engine.md` §21.

Evidence labels: **MEASURED** (observed on this host in this change), **INFERRED** (reasoned, not measured). Host:
the same laptop as Phase 6.3 (Windows 11, PostgreSQL 16 local, Node 24.19).

---

## 1. Why 6.7 was blocked and how it was resolved

Contract phase-6-campaign §3.1 requires pre-flight to report the exact audience size, an eligibility estimate on a
*uniform sample of ≤ 2,000 members*, and `TOPIC_UNAVAILABLE` for a deleted, archived or category topic. Audience
Resolution v1 offered `count` (no members) and `capture` (a durable snapshot); Campaigns may not read Audience tables
(Audience contract §9.8). Recorded as BLOCKED in `docs/audit/phase-6.5-6.8-campaign-management.md` §6.

Resolution (approved): **Audience Resolution v1.1** — additive `sample(scope, def, { size ≤ 2000 })` and
`topicStatus(scope, topicId)`. Normative text: `docs/contracts/phase-5-audience.md` §9.9 (why it was needed, approval
date, port shape, sampling and topic semantics, security, performance, compatibility, campaign consumption, why a
snapshot is not used).

Rules honoured (from the approval): v1 not rewritten, no consumer broken (v1 tests unchanged and green, §9); no
snapshot for pre-flight (asserted: snapshot count unchanged, §6); sample not `ORDER BY id LIMIT 2000` (uniformity
test, §2); no Campaign query of topics, contacts, memberships, consents or suppressions (dependency-cruiser +
architecture test green); no Campaign foreign key to new Audience tables (v1.1 adds no table) and no Campaign import
in Audience; the closed 6.3 G2 decision untouched (bitmap tables, functions, maintenance unchanged; the new functions
only *read* the VALID bitmap).

## 2. Audience Resolution v1.1 — what was built

| Item | Where |
|---|---|
| Port: `AudienceResolutionV1_1`, `AudienceSample`, `AudienceSampleOptions`, `AudienceTopicStatus`, `AUDIENCE_SAMPLE_LIMIT` | `packages/audience-core/src/ports.ts` |
| Adapter: `sample`, `sampleWithPath`, `topicStatus` | `packages/audience-infra/src/audience-resolution.ts` |
| Read side typed v1.1 | `packages/audience-infra/src/index.ts` |
| Functions `app.audience_sample_nth_bit`, `app.audience_sample_ids` | migration `20261015000000_audience_resolution_sample` |
| Plan-independent replacement of `app.audience_sample_ids` (§4.1) | migration `20261015000001_audience_sample_fixed_plan` |
| DI token `AUDIENCE_RESOLUTION`, bound by the Audience module | `apps/api/src/infrastructure/providers.ts`, `apps/api/src/modules/audience/audience.module.ts` |

Both migrations are additive (functions only; Part A of each is empty — no Prisma schema change). The first applied
migration was **not modified**; the defect fix is a second migration (`CREATE OR REPLACE`, same signature, owner and
grants). MEASURED: applying both invalidated no count bitmap (no `DDL:` invalidation reason; a VALID bitmap stayed
VALID and answered the sample).

Tests (`packages/audience-infra/test/audience-resolution-v1-1.test.ts`, 14, all on both the bitmap and exact path
unless stated):

| Test | Asserts |
|---|---|
| sizes 0, 1, 1,999, 2,000, 2,001 | exact `audienceSize` = independent oracle; `min(2000, N)` ids; distinct; every id a live member (deleted and excluded contacts seeded alongside, never returned); ascending |
| large audience (12,000 over 3 chunks) | exactly 2,000; members only; size 0 → `[]`; size 10 → 10 |
| uniformity | 60 members scattered over ≥ 3 chunks (2,000 draws bitmap, 600 exact), χ² with 59 d.f. (mean 59, sd ≈ 10.9, bound 120): run 1 50.1 / 65.4 (md5 order), run 2 81.3 / 73.0 (`uuid_hash_extended` order, §4.4) — consistent with uniform (MEASURED) |
| seeds / no write | seeded draws repeat, unseeded vary; no row written |
| errors | same as `count`: invalid definition, missing source, size bounds, seed bounds |
| tenant isolation | another workspace (same org, other org): sources not found, members never sampled |
| privileges | app may execute `audience_sample_ids`; reporting / identity / PUBLIC may not; `nth_bit` not executable by app; SECURITY DEFINER with pinned `search_path`; owner NOBYPASSRLS; no workspace context → 42501 |
| topicStatus | available; archived; category; not found for missing, malformed (`x' OR 1=1 --`), another workspace, another org |
| plan independence (new) | forced `enable_hashjoin=off, enable_mergejoin=off`, `enable_nestloop=off`, `plan_cache_mode=force_generic_plan`, 7 calls each, 3 s statement timeout, 20,000 members: bitmap path answers 2,000 members every time. **Shown to fail on the original function** (57014 statement timeout) and pass on the replacement (MEASURED) |
| consistency guard (new) | a VALID bitmap whose positions lost a contact → the exact path answers (never a short sample) |

## 3. Milestone 6.7 — pre-flight

`POST /v1/workspaces/{workspaceId}/campaigns/{campaignId}/preflight` (contract row 10): `campaigns.read`,
rate limit 60/h/user, strict empty body, `200 PreflightResult`. Implementation: `PreflightService`
(`apps/api/src/modules/campaigns/application/preflight.service.ts`).

Fact flow (only ports): one short read transaction for `topicStatus` → topic fact, v1 `validate` → source
statuses and, if the definition is valid, v1.1 `sample(size 2,000)` → exact live size + uniform sample; then
Eligibility v1.1 `evaluateInBatches` on slices of 500 ids, each slice in its own short tenant read transaction, at
most 4 slices at once across the API process (channel email, purpose marketing; `topicPolicy: 'block_unsubscribed'`
only when the topic is available) → eligible count and reason counts (why: §4.3; no transaction is held while
waiting for a slot, so concurrent pre-flights queue but cannot starve the 10-connection pool — tested with 6
concurrent pre-flights); domain `preflightFindings` + `summarize` → result. `eligibleEstimate =
round(eligible / sampleSize × audienceSize)`; `topReasons` = top 5 codes by share of the sample. Read-only: nothing is
written, no snapshot is created, no sample id leaves the service.

The same `evaluate` runs inside `schedule` / send-now (§5), so a campaign can never be scheduled on weaker checks
than pre-flight shows.

API tests (`apps/api/test/campaigns-preflight.test.ts`, 19 — incl. 6 concurrent pre-flights on the 10-connection pool):

| Group | Cases |
|---|---|
| sample sizes | 0 (→ `AUDIENCE_EMPTY`), 1, 1,999, 2,000, 2,001 → `audienceSize` exact, `sampleSize = min(N, 2000)`; large audience 25,000 → sample exactly 2,000 |
| topic | valid (section `pass`, ready); archived → `TOPIC_UNAVAILABLE` (error), estimate falls back to channel rules, restoring the topic clears it (live); category → `TOPIC_UNAVAILABLE`; foreign and missing → refused at write by the composite FK (400, no database text) and therefore never reach pre-flight |
| eligibility | all (6/6, ready), none (0/6, `NO_ELIGIBLE_RECIPIENTS`), low share (1/6, `LOW_ELIGIBLE_SHARE` warning, still ready), high share (5/6, ready); `topReasons` = `CONSENT_MISSING` with the exact share |
| security | viewer (read) 200; role without `campaigns.read` 403; unauthenticated 401; outsider on their own workspace path with our id 404; outsider on our path 404; random id 404; non-UUID id 404; unknown body field 400 |
| privacy | response keys exactly `checkedAt, estimate, readiness, readinessFindings, sections`; estimate keys exactly the five counts; no contact id or email in the response, the findings, or stdout/stderr captured during the request; no domain event, audit row, snapshot or campaign change created by pre-flight; no campaign event or audit row in the workspace contains a sampled id |

## 4. Performance

Target (6.7): **pre-flight p95 < 2 s**, end to end. Not weakened; no timeout raised (the 15 s statement timeout and
30 s pre-flight transaction timeout are the pre-existing defaults).

### 4.1 Defect found and fixed (MEASURED)

The first benchmark run at 100,000 contacts returned `500 internal_error` on the bitmap path right after the bitmap
was rebuilt. The PostgreSQL log showed `canceling statement due to statement timeout` inside
`app.audience_sample_nth_bit`, called from the rank → member statement of `app.audience_sample_ids`: ranks were
joined to chunks with a range predicate and then to `audience_count_contact_seq` on an expression containing the
opaque bit-search function, so the planner could evaluate it per (rank × position). A fresh session chose a 53 ms
plan, the API session did not — correctness depended on a planner choice. The HTTP body was the generic
`internal_error` (no database text leaked).

Fix (migration `20261015000001`): chunk by `width_bucket(rank, prefix sums)`, positions in one scan of the rank array
(exactly one bit search per rank, no join), contacts by `seq = ANY(positions)` on the unique index; every step bounded
by the sample size or the number of chunks. MEASURED at 100,000: sampling statement 53–91 ms → 19–33 ms, and the
regression test of §2 fails on the old function, passes on the new.

### 4.2 Benchmark (MEASURED)

Harness: `apps/api/test/campaigns-preflight-bench.test.ts` (opt-in `PREFLIGHT_BENCH=1`). Per size N: contacts with a
primary email identity; include = 2 lists (all, plus 20 % overlap), exclude = 1 list (5 %), 1 % deleted; for every
contact a consent event + state (1/7 withdrawn), topic preference for half (10 % of those unsubscribed), 5 %
suppressed. Pre-flight through HTTP as a viewer (fresh user per path, so the rate limit is part of the stack and does
not trip), 3 warm-up + 25 measured sequential requests; then the components through the same ports, 10 runs. Exact
path first (bitmap not built), then `rebuildCountBitmap` and the bitmap path (the steady state the 6.3 maintenance
job keeps). The audience size is asserted against an independent owner-side oracle on every size.

### 4.3 Eligibility is random-IO bound — parallel slices (MEASURED)

The first full run (before the changes of §4.3–4.4) met the target on the bitmap path at 100,000 (p95 153 ms) and
500,000 (p95 782 ms) but **not at 1,000,000 (p95 3,232 ms)**, and the exact path failed from 500,000 (p95 4,955 ms;
1M 9,543 ms). Components at 1M, bitmap path: sample p95 260 ms, **eligibility p95 2,482 ms**.

`EXPLAIN (ANALYZE, BUFFERS)` of the eligibility queries for a random 1,000-id slice at 1M (as `workeasy_app`):
plans already optimal (index scans; BitmapOr for suppressions), but each fact table needs ≈ 1,600–1,700 pages not in
`shared_buffers` (contacts ≈ 330 ms, consent states 400–500 ms, identities 106–227 ms, topic preferences 135–337 ms;
suppressions 9–15 ms). Host: `shared_buffers` 160 MB for a 2.8 GB database, `effective_io_concurrency` 0 (no
prefetch on Windows) — every statement waits on its reads one by one. A uniform sample is spread over the whole
workspace by design, so locality cannot be engineered away; covering indexes would change frozen Audience tables
(Gate G1) and were not considered.

Measured remedy — overlap the IO of independent slices (2,000 fresh random ids per run, 6 runs, median): serial
2 × 1,000 = 1,857 ms; parallel 2 × 1,000 = 690 ms; **parallel 4 × 500 = 440 ms**. Implemented in `PreflightService`
(slices of 500, ≤ 4 in flight process-wide). Nothing about Eligibility changed; only how the Campaign side calls it.

### 4.4 Exact-path ordering (MEASURED)

The exact sample's ordering key `md5(contact_id::text || salt)` cost about as much as the exact count itself
(idle database, 4 runs: 470,000 members 1.2 s vs count 0.55 s; 940,000 members 2.6 s vs 1.1 s). Replaced by
`uuid_hash_extended(contact_id, seed)` with a fresh 64-bit seed (hashes the uuid's 16 bytes, no text conversion):
0.63 s and 1.25 s — within ≈ 10 % of the count. Same uniform-random-order argument; uniformity re-tested (§2).
The exact count itself is the floor of this path; it is the 6.3 D2 query (6.3 measured p95 0.60 s at 500k and
1.14 s / 8.25 s at 1M, timeout at 5M) and is unchanged — G2 is not reopened.

### 4.5 Results after the changes (MEASURED)

Host during the runs (MEASURED): Windows 11, **7.5 GB RAM with ≈ 0.6 GB free** (IDE and browsers resident),
PostgreSQL 16 with `shared_buffers` 160 MB, `effective_io_concurrency` 0; the test database held every size seeded
in the run (2.8 GB at 1M). Random reads therefore mostly go to disk; absolute numbers drift with the host's free
memory between runs (the second run was 2–3× slower than the first on unchanged work: 100k seed 31 s vs 14 s, 100k
bitmap rebuild 20.4 s vs 6.1 s), so compare paths within a run. HTTP: 3 warm-up + 25 sequential requests, fresh
uniform sample each; "concurrent 4": 3 rounds of 4 simultaneous requests (informational).

**Final results (code as delivered), pre-flight end to end through HTTP:**

| Contacts (audience) | Path | p50 | p95 | p99 | Failures | Target p95 < 2 s |
|---|---|---|---|---|---|---|
| 100,000 (94,000) | **bitmap** (VALID — steady state) | 218 ms | **282 ms** | 327 ms | 0 / 28 | **PASS** |
| 500,000 (470,000) | **bitmap** | 286 ms | **376 ms** | 395 ms | 0 / 28 | **PASS** |
| 1,000,000 (940,000) | **bitmap** | 250 ms | **1,456 ms** | 1,526 ms | 0 / 28 | **PASS** |
| 100,000 | exact (fallback: bitmap not VALID) | 916 ms | 1,106 ms | 1,143 ms | 0 / 28 | PASS |
| 500,000 | exact (fallback) | 3,488 ms | 5,925 ms | 6,328 ms | 0 / 28 | **FAIL** |
| 1,000,000 | exact (fallback) | 3,889 ms | 10,620 ms | 15,451 ms | **2 / 28** (500 `internal_error`: 15 s statement timeout) | **FAIL** |

Concurrent 4 (bitmap path, informational): 100k p95 1,070 ms; 500k p95 2,035 ms; 1M p95 721 ms (12 requests each,
0 failures).

Components (ports called serially in one transaction, 1,000 ids per eligibility call — the raw IO cost of a sample,
without the service's parallel slices), p50 / p95:

| Contacts | Path | sample | eligibility (serial) | topic + validate |
|---|---|---|---|---|
| 100,000 | bitmap | 61 / 86 ms | 350 / 384 ms | ≤ 7 ms |
| 500,000 | bitmap | 85 / 149 ms | 580 / 1,088 ms | ≤ 11 ms |
| 1,000,000 | bitmap | 50 / 452 ms | 242 / 1,476 ms | ≤ 16 ms |
| 100,000 | exact | 328 / 404 ms | 274 / 366 ms | ≤ 6 ms |
| 500,000 | exact | 3,514 / 4,760 ms | 1,425 / 2,597 ms | ≤ 25 ms |
| 1,000,000 | exact | 2,240 / 9,802 ms | 453 / 4,684 ms | ≤ 16 ms |

Before the changes of §4.3–4.4 (first run, same harness, faster host state): bitmap p95 153 ms / 782 ms /
**3,232 ms** (100k / 500k / 1M); exact p95 368 ms / 4,955 ms / 9,543 ms.

Bitmap rebuild for the benchmark (6.3 maintenance, unchanged): 100k 20.4 s, 500k 88.6 s, 1M 119.6 s (second/third
run). 5,000,000 was **not run**: on this host the seed alone would take ≈ 35 min and the database would exceed RAM
several times; the exact fallback at 5M is already known to time out (6.3: exact count times out at 5M), and the
bitmap sample's cost is bounded by the sample size and chunk count (§2), not by N — INFERRED, not measured at 5M.

**Verdict:** the target is met on the production path — the VALID bitmap that the 6.3 maintenance job keeps — at
100k, 500k and 1M with no failures. It is **not met on the exact fallback** from 500k: that path's floor is the 6.3
exact count (unchanged, G2 not reopened), and at 1M it can exceed the 15 s statement timeout, so pre-flight returns
a generic `500 internal_error` (no database text). This is reported as an open risk with options in §10; it was not
hidden by raising any timeout or shrinking the sample.

## 5. Milestone 6.8 — lifecycle commands

Implementation: `LifecycleService` (`apps/api/src/modules/campaigns/application/lifecycle.service.ts`), routes in
`campaigns.controller.ts`, OpenAPI in `routes-campaigns.ts` (regenerated `docs/api/openapi.json`). The 6.1 state
machine (`decideCommand`, `nextExecutionState`, `startFailure`) is used unchanged — not redesigned.

| Command | Route (contract row) | Permission | Concurrency | Idempotency-Key | Writes | Event / audit |
|---|---|---|---|---|---|---|
| schedule / send-now | `POST …/schedule` `{mode: at\|now}` (11) | `campaigns.send` | `expectedVersion` | ✓ | version (`scheduled` / `sent_now`) + execution `pending` + campaign `scheduled` | `campaign.version_created`, `campaign.scheduled` / `campaign.scheduled` |
| reschedule | `POST …/reschedule` (12) | send | `expectedVersion` | ✓ | execution `send_at`, draft schedule | `campaign.rescheduled` / ✓ |
| unschedule | `POST …/unschedule` (13) | send | `expectedVersion` | ✓ | execution `cancelled`, campaign `draft` | `campaign.unscheduled` / ✓ |
| pause | `POST …/pause` (14) | send | row lock | ✓ | execution `paused` (+ phase) | `campaign.paused` / ✓ |
| resume | `POST …/resume` (15) | send | row lock | ✓ | execution → paused phase, or `failed` (configuration) after the start-time re-check | `campaign.resumed` / ✓, or `campaign.failed` |
| cancel | `POST …/cancel` (16) | send | `expectedVersion` | ✓ | execution `cancelled` | `campaign.cancelled` (stage, counts) / ✓ |
| return to draft | `POST …/return-to-draft` (17) | `campaigns.update` | row lock | — | campaign `draft` | `campaign.returned_to_draft` (event only, per contract) |
| restore version | `POST …/versions/{versionId}/restore` (20) | update (+ composite) | `expectedVersion` | — | draft ← snapshot | `campaign.updated` with `restoredFromVersion` |

Order inside every command (contract §2.2): route authorization → `SELECT … FOR UPDATE` on the campaign → domain
decision, **`expectedVersion` checked before any outcome** (a stale request that would be a no-op is
`409 version_conflict`) → writes + events + audit in one transaction. `schedule` adds, before the lock, a cheap
decision (version, state, delivery mode) and the full pre-flight in its own read transaction — so no row lock is held
during Audience reads — then decides again under the lock with the pre-flight's error count; a draft edit in between
bumps the version and is a conflict, so a version never freezes an unchecked draft. Execution changes are conditional
updates (`status IN expected AND version = read`) through the execution state machine; lock order campaign →
execution.

Executions are **persisted, never executed**: nothing starts, materializes, creates recipients, captures snapshots,
leases, retries, releases or delivers. Production delivery stays `disabled` (`CAMPAIGN_DELIVERY_MODE` unset → schedule
and resume are `422 DELIVERY_NOT_AVAILABLE`); the lifecycle tests run with `CAMPAIGN_DELIVERY_MODE=test`, which the
config accepts only with `NODE_ENV=test`. No SMTP, no provider, no send. States that only the 6.9 runner will reach
(materializing, delivering, failed) are seeded through the owner connection in tests.

API tests (`apps/api/test/campaigns-lifecycle.test.ts`, 25):

| Group | Cases |
|---|---|
| schedule | at: version 1 `scheduled` with the exact snapshot, execution `pending` at `send_at`, events + audit, no recipient, no snapshot; send-now: `sent_now`, `send_at ≈ now`, still `pending` after 1.5 s (no runner), zero recipients; pre-flight errors → `422 PREFLIGHT_FAILED` with error findings only, nothing written; archived topic and past time refused through the same pre-flight; delivery disabled (production default) → `422 DELIVERY_NOT_AVAILABLE`, nothing written |
| authorization | editor (no `campaigns.send`) 403 + guard `access.denied` audit; unauthenticated 401; outsider (both paths) 404; random id 404; unknown body field 400 |
| concurrency | stale `expectedVersion` 409 also for a would-be no-op; 3 concurrent schedules → exactly one 200, one version, one execution; edit × schedule → exactly one wins and the version holds the locked draft; concurrent reschedules → one 200, one 409; pause × resume and cancel × unschedule serialize consistently |
| reschedule / unschedule | moves `send_at`, same time is a no-op, past → `PREFLIGHT_FAILED`, stale → conflict, draft → `INVALID_TRANSITION`; unschedule → execution cancelled, campaign draft; version byte-identical after later draft edits (immutability); re-schedule → version 2 / run 2, history keeps both |
| pause / resume / cancel / return | pause remembers the phase, repeat is a no-op, scheduled → `INVALID_TRANSITION`; resume returns to the phase, repeat no-op; topic archived while paused → resume fails the execution (`configuration`, `TOPIC_UNAVAILABLE`, `campaign.failed`); return-to-draft by an editor, repeat no-op; cancel from scheduled / delivering / paused with stage and counts in the event, repeat no-op, terminal afterwards |
| restore version | refused while scheduled (`CAMPAIGN_NOT_EDITABLE`), applied as an edit after unschedule with `changes: ['messages', 'restoredFromVersion']`, stale → conflict, foreign or unknown version 404 |
| idempotency | schedule (at and now): same key → identical replayed body, one version, one execution, one event; same key with another body → `idempotency_conflict`; 3 concurrent same-key requests run the command once (others `conflict` while in flight); reschedule, unschedule, pause, resume, cancel: replayed and applied once; a key is per user and per command |
| errors | malformed bodies → 400 with no database text |

## 6. Security evidence

| Property | Evidence |
|---|---|
| Tenant isolation | workspace from the route + authorized context only; outsider / IDOR / cross-org → 404 (pre-flight and every lifecycle route); RLS on all campaign and Audience reads; v1.1 cross-workspace and cross-org tests (§2) |
| RBAC | route permission (`campaigns.read` / `send` / `update`) + composite permissions on restore; 403s audited as `access.denied` |
| RLS | no policy changed; no table grant changed; new definer functions owned by a NOBYPASSRLS role and refuse to run without a workspace context |
| No database text | error filter maps unknown errors to `internal_error`; FK, validation and timeout paths asserted to contain no `prisma|postgres|sql|constraint|violat|relation|column` |
| Privacy | pre-flight result, findings, events, audit and logs carry no contact id, email or phone (§3 privacy test); lifecycle events carry ids of campaigns, versions and executions only |
| Delivery | production mode `disabled` enforced by the domain; no provider code exists |

## 7. Compatibility

No change to Audience Resolution v1, Eligibility, the 6.3 bitmap, or 6.5 / 6.6 behaviour. Additive contract
refinements are listed in contract §15 "Implementation status". Known non-blocking observation in 6.6 code: draft
`PATCH` detects changes with `JSON.stringify` (key-order sensitive; JSONB reorders keys), so an equivalent sub-object
sent with a different key order is reported as a change and bumps the version — a false positive, never a lost or
wrong write. Restore-version (new) uses an order-insensitive comparison. Not changed in 6.6 (not strictly required).

## 8. Files

New: `apps/api/src/modules/campaigns/application/preflight.service.ts`, `lifecycle.service.ts`;
`apps/api/test/campaigns-preflight.test.ts`, `campaigns-lifecycle.test.ts`, `campaigns-preflight-bench.test.ts`;
`packages/audience-infra/test/audience-resolution-v1-1.test.ts`;
migrations `20261015000000_audience_resolution_sample`, `20261015000001_audience_sample_fixed_plan`; this document.
Changed: `packages/audience-core/src/ports.ts`, `packages/audience-infra/src/audience-resolution.ts`, `index.ts`;
`apps/api/src/infrastructure/providers.ts`; `apps/api/src/modules/audience/audience.module.ts`;
`apps/api/src/modules/campaigns/campaigns.module.ts`, `http/campaigns.controller.ts`;
`apps/api/src/openapi/routes-campaigns.ts`; `docs/api/openapi.json`; `docs/contracts/phase-5-audience.md` (§9 E-5, §9.9);
`docs/contracts/phase-6-campaign.md` (§3.1 fact sources, §15 rows 12–16 and implementation status);
`docs/architecture/phase-6-campaign-engine.md` (§21); `docs/audit/phase-6.5-6.8-campaign-management.md` (forward
pointer only).

## 9. Regression

Final run 2026-10-07 22:22–22:50 (MEASURED), in the required order; one script, nothing else running against the
databases:

| Step | Result |
|---|---|
| Fresh database migration (drop dev + test, bootstrap, `migrate deploy` incl. `20261015000000`, `20261015000001`) | PASS |
| Security suite (`packages/db`: security invariants, RLS, Audience RLS, count bitmap, snapshots, campaigns) | PASS — 114 / 114 |
| Typecheck (all packages) | PASS |
| Dependency boundaries | PASS — 300 modules, 1,266 dependencies, 0 violations |
| Full tests (`pnpm test`) | PASS — **806 passed, 12 skipped** (db 123; shared 34; web 40; audience-core 86; audience-infra 77 + 7 skipped; api 437 + 5 skipped; worker 9). Skipped = opt-in benchmark / scale suites |
| Audience Resolution v1.1 (`audience-resolution-v1-1`) | PASS — 14 / 14 |
| Campaign 6.7 (`campaigns-preflight`) | PASS — 19 / 19 |
| Campaign 6.8 (`campaigns-lifecycle`) | PASS — 25 / 25 |
| Phase 6.3 regression — db bitmap 17 / 17, api 4 / 4, worker 3 / 3; audience-infra bitmap suites | inside the full suite: PASS; separate re-run: 50 / 52 — see below |
| Build | PASS |
| E2E #1 / E2E #2 | PASS — 24 / 24 and 24 / 24 |
| `git diff --check` | PASS |

**Phase 6.3 re-run, 2 failures — investigated (MEASURED):**
1. *generation compare-and-set* (`packages/audience-infra/test/audience-count-bitmap.test.ts`): **pre-existing test
   defect, not a product regression.** The test invalidates mid-rebuild by setting `deleted_at` on `contacts[0]`, but
   its workspace seed marks contacts deleted/erased with unseeded server-side `random()` (10 % / 3 %), and the
   liveness trigger fires only when liveness changes. When `contacts[0]` is already non-live (≈ 12.7 %), nothing is
   invalidated and `published` is the correct outcome. Proof: a temporary instrumented copy (deleted afterwards)
   logged the precondition over 25 runs — 3 failures, **all** with `contacts[0]` non-live; 22 passes, all live.
   Not changed (closed G2; tests are not altered to obtain green). Proposed fix for approval: pick a live contact.
2. *randomized correctness under writes*: one `57014` statement timeout on the loaded host in that re-run; passed in
   the full suite of the same run and in 5 further runs of the file. Timing, not correctness (its assertions never
   failed).

Neither test exercises code changed in 6.7–6.8 (rebuild, invalidation and count paths are untouched; this phase adds
the sample functions and the exact-sample query only).

Process notes (for transparency): (a) an earlier regression attempt was aborted because one of the new idempotency
tests sent three "identical" retries whose `sendAt` was computed per request — different bodies under one key,
for which `idempotency_conflict` is the correct answer. The test was corrected to send one body (the product
behaviour was right); 13 consecutive runs then passed. (b) stopping that attempt left its child processes running and
they overlapped a second attempt; both were discarded, every process tree was killed and the table above is from a
single clean run.

## 10. Deferred and risks

Deferred to 6.9 (Gate G3, not requested): runner, scheduler/due-execution discovery, queue, materialization,
recipient creation, Checkpoint A/B, delivery, provider calls, retries, leases, health, recovery sweep, snapshot
release, `NullDeliveryPort`, execution read routes (contract rows 21–23). Deferred elsewhere: rate-limit tuning,
the 6.6 key-order observation (§7).

Risks (INFERRED unless stated):
- The eligibility estimate is a sample estimate: for a 2,000 sample the 95 % margin on a share is about ±2.2
  percentage points; small sub-populations may not appear in `topReasons`. By design (contract §3.1).
- Pre-flight reads are point-in-time: the audience, topic or consent can change between pre-flight/schedule and
  start; the start-time re-check (6.9) and resume re-check (implemented) cover configuration failures.
- **OPEN — pre-flight on the exact fallback (MEASURED, §4.5).** When a workspace's bitmap is not VALID (never built,
  invalidated, or rebuilding), pre-flight — and therefore `schedule` / send-now, which run the same check — falls back
  to the exact query: p95 5.9 s at 500k, 10.6 s at 1M with 2 of 28 requests failing as `500 internal_error` (15 s
  statement timeout); at 5M every request would time out (6.3: exact count times out at 5M). The steady state is
  VALID (the 6.3 maintenance job rebuilds after invalidation: 1M in ≈ 2 min here), so exposure is the window between
  invalidation and rebuild on large workspaces. Not changed here because every remedy changes a frozen contract or
  the closed G2 design — **decision needed**: (a) accept as is (documented degraded mode); (b) graceful degradation:
  above a time budget on the exact path, return the pre-flight with `estimate: null` and a new finding such as
  `AUDIENCE_ESTIMATE_UNAVAILABLE` (additive change to the frozen finding codes; schedule semantics to decide);
  (c) have pre-flight request an Audience-owned bitmap rebuild through a port when the state is not VALID (touches
  the G2 maintenance design). Recommendation: (b) for pre-flight together with (c)-style prompt rebuilds — but this is
  the owner's call.
- Pre-flight latency on the bitmap path is IO-bound on this host (7.5 GB RAM, 160 MB `shared_buffers`); 1M p95 1,456 ms
  passes with ≈ 0.5 s headroom. A production database with a memory-sized cache should be faster (INFERRED); the
  harness is in the repository to re-measure on the target infrastructure.
- `pg` deprecation warning ("client.query() when the client is already executing a query") appears from the existing
  Eligibility v1.1 path (also emitted by the pre-existing `eligibility-v1-1.test.ts`); harmless today, must be fixed
  before `pg@9`. Not introduced here.

## 11. Progress

Phase 6 milestones complete: 6.0–6.8 (9 of 14: 6.0–6.13). Remaining: 6.9 (G3 execution), 6.10 events/audit,
6.11 frontend, 6.12 E2E, 6.13 benchmark/hardening/freeze. The repository defines no project-level weighting and the
official percentage has moved only at the product owner's direction, so **official progress stays 35 %**; the
milestone count above is the evidence for any change the owner decides.

## 12. Degraded mode, flaky-test repair and closure (2026-10-07, second round)

The two items left open in §10 were resolved by product-owner decision ("approve an additive degraded-mode design
based on Option B, combined with proactive bitmap recovery"). The measurements in §4.2–§4.5 stay as the historical
record of the unbounded exact fallback; the behaviour below replaces it.

### 12.1 What changed

| Item | Change |
|---|---|
| Audience Resolution v1.2 | `sampleWithin` (exact path under a 1 s statement budget inside a SAVEPOINT; never partial, never a 500) and `requestRecovery` (deduplicated, workspace-scoped, non-blocking 6.3 rebuild) — Audience contract §9.10 |
| Pre-flight | bounded: `ELIGIBILITY_ESTIMATE_UNAVAILABLE` (error, `retryAfterSeconds` 30) with `estimate: null` when the exact query does not fit; recovery requested — contract §3.3 |
| Schedule / send-now | `409 PREFLIGHT_UNAVAILABLE` + `Retry-After: 30` when that is the only error; no version, no execution, no state change; with other errors the ordinary 422 |
| Shared contracts | finding code + error code added (codes are added, never renamed); the code-count test moved 23 → 24 with the new code asserted by name |
| Flaky 6.3 test | the generation-CAS test now selects a LIVE contact (its precondition); production CAS unchanged |

### 12.2 Evidence (MEASURED)

**Flaky-test repair:** `packages/audience-infra/test/audience-count-bitmap.test.ts` "generation compare-and-set",
**100 / 100 consecutive passes** (before: ≈ 13 % failures, all with an already non-live contact — §9).

**Degraded-mode tests:** infra v1.2 (4 tests) and API (3 tests): budget-exceeded → controlled 200 with the finding in
< 5 s even with 8 concurrent requests under a held table lock; **8 concurrent pre-flights → exactly one rebuild
generation**; exact-fits-budget → normal answer; schedule and send-now → 409 + Retry-After, zero versions, zero
executions, campaign version unchanged; with an extra error → 422 with both; after recovery the same schedule
succeeds.

**Performance gate** (same harness as §4.2; "degraded" = the bitmap invalidated with a generation bump before EVERY
request, so recovery runs concurrently — the worst case; 3 warm-up + 25 measured sequential requests):

| Contacts | Path | Answers | p50 | p95 | p99 | max | Failures | Target |
|---|---|---|---|---|---|---|---|---|
| 100,000 | degraded | 28 normal (exact fit) | 169 ms | 207 ms | 208 ms | 208 ms | 0 | PASS |
| 500,000 | degraded | 28 normal (exact fit) | 606 ms | 785 ms | 788 ms | 788 ms | 0 | PASS |
| 1,000,000 | degraded | 28 `ELIGIBILITY_ESTIMATE_UNAVAILABLE` | 1,054 ms | 1,265 ms | 1,292 ms | 1,292 ms | 0 | PASS (bounded) |
| 100,000 | bitmap (normal) | 28 normal | 102 ms | 119 ms | 124 ms | 124 ms | 0 | PASS |
| 500,000 | bitmap | 28 normal | 172 ms | 253 ms | 266 ms | 266 ms | 0 | PASS |
| 1,000,000 | bitmap | 28 normal | 274 ms | 524 ms | 637 ms | 637 ms | 0 | PASS |

Concurrent 4 (informational, 12 requests): degraded p95 527 / 1,328 / 1,942 ms; bitmap p95 376 / 643 / 892 ms
(100k / 500k / 1M). Bitmap recovery after the degraded phase: 5.5 s (100k), 45 s (500k), 113 s (1M). **No 500 in any
run.** 5M not run (host: 7.5 GB RAM; seed alone ≈ 35 min) — the degraded path's cost is bounded by the 1 s budget
by construction (INFERRED for 5M, not measured).

Re-validated after the change: Audience v1.1/v1.2 (18), pre-flight (22), lifecycle (26), drafts (11), Phase 6.3
suites; the full regression of this round is recorded in docs/audit/phase-6.9-execution.md §10.

### 12.3 Closure

**Phase 6.7: PASS / CLOSED. Phase 6.8: PASS / CLOSED** (2026-10-07). Normal-path target met at 100k / 500k / 1M;
degraded path bounded with no 500s; the two open items of §10 resolved; contracts updated (Audience §9.10, campaign
§3.3, §15). Remaining non-blocking observations: §7 (6.6 key-order change detection), §10 (pg@9 deprecation warning
from the existing eligibility path).
