# Phase 6.13 — Benchmark, hardening and freeze: audit record

**Status:** CLOSED (Gate A, §10) — gate conditions in §9 · **Date:** 2026-10-08 · **Delivery:** TEST MODE ONLY; production delivery
DISABLED.

Evidence labels:
- **MEASURED** — observed here;
- **INFERRED** — reasoned from code or other evidence;
- **NOT TESTED**;
- **UNVERIFIED** — claimed elsewhere, not re-checked here.

Host: Windows 11 laptop, 7.5 GB RAM, PostgreSQL 16 local, Node 24.19. Long runs are made with a keep-awake request,
because a lid-close standby voided one run earlier (audit 6.10–6.12 §3.3).

## 1. Current-state matrix (inspected 2026-10-08)

| Area | Status | Evidence | Remaining |
|---|---|---|---|
| 6.1 Domain | PASS | `campaign-domain.test.ts`, `campaign-contracts.test.ts` (part of API 532/532 in regression r3) | — |
| 6.2 Audience-core boundary | PASS | dependency-cruiser rules (359 modules, 0 violations); `audience-boundary.test.ts` | — |
| 6.3 Resolution and snapshots | PASS | audits 6.3; regression r3 | — |
| 6.4 Shared contracts | PASS | `packages/shared` tests (62) | — |
| 6.5 to 6.8 Persistence, drafts, pre-flight, lifecycle | PASS | audits 6.5 to 6.8; regression r3 | — |
| 6.9 Execution (test mode) | PASS, with one recorded measurement | audit 6.9; peak-heap investigation §9.1 there; 1M clean and crash runs (§3) | — |
| 6.10 Events and audit | PASS | audit 6.10–6.12 §1; `campaigns-events-audit.test.ts` | — |
| 6.11 Frontend | PASS | web 79/79 (r3) + later additions | — |
| 6.12 E2E | PASS | 45/45 ×2 (runs 8 and 9); 53/53 ×2 after the content work (r3); 57/57 ×2 (r5, r6) | — |
| Content, rendering, personalization, preview | PASS | content amendment §8 and §8.1 | — |
| Templates | PASS | `templates.test.ts` (CRUD, clone, roles, races) | — |
| Recipients (row 23) | PASS | `campaigns-recipients.test.ts`; read bench (§4) | — |
| Analytics v1 (pipeline) | PASS | `campaigns-analytics.test.ts`; read bench | — |
| Engagement analytics | NOT AVAILABLE by design | no producers until Phases 8 and 9 | Phases 8 and 9 |
| Tracking architecture | PASS (contracts and reference semantics; inactive) | `message-metrics.test.ts` | Phases 8 and 9 |
| Security | see §5 | | |
| Performance | see §3 and §4 | | |
| Reliability | PASS | audit 6.9 §5 (crash points, sweep); 1M crash run (§3); pause/resume/cancel at 100k and 1M (§3.1) | — |
| Observability | PASS | `observability.test.ts`; runbook | queue-depth metric needs a real queue (Phase 8 worker) |
| Accessibility | PASS (axe, WCAG 2.1 A/AA) on every campaign, template and content screen | e2e `phase6-a11y`, `phase6-content` | manual screen-reader pass NOT TESTED |
| AI readiness | PARTIAL (contracts and disabled ports) | `ai-billing-readiness.md` | an AI context |
| Billing readiness | PARTIAL (contracts and disabled ports) | same | a billing context |
| Integrations (CRM, webhooks, providers) | PARTIAL: `ChannelAdapter` / `verifyCallback` exist (Phase 4); webhooks permission catalogue only | `packages/channels` | Phases 8 and 15 |
| Production delivery | DISABLED | config refuses `live`; NullDeliveryPort is test-only | Phase 8 (explicit approval) |

## 2. Hardening completed in this phase

| Item | Change | Evidence |
|---|---|---|
| Recipient reason filter (unbounded scan) | reads only skipped rows; a reason a finished run never had is answered from its counts | 500k no-match: **1,898 → 9 ms** p50 (MEASURED, §4) |
| Pagination cursors | **signed (HMAC) and scoped** to tenant, list and filters; forged, edited, legacy, cross-workspace and cross-filter cursors give 400 | `pagination-cursor.test.ts`; e2e `phase6-security` S3 |
| Rate limits | analytics 300/h, recipients 1,200/h, template writes 600/h per user (429 + Retry-After) | `campaigns-analytics.test.ts` (429) |
| Template clone | `POST /templates { fromTemplateId }` (additive) | `templates.test.ts` |
| Observability | structured access and job logs from allowlists | `observability.test.ts` |
| UI error states | retry, not-found | web tests |
| **Defect: pause/cancel failed intermittently on an actively delivering campaign** (found by the lifecycle-at-scale benchmark) | Commands compared the execution version loaded with the campaign row, unlocked, while the runner bumps it every batch. `updateExecution` now locks the execution after the campaign (lock order campaign → execution) and re-reads it; the cancel event's counts and stage come from the locked row | new test "pause, resume and cancel succeed while the runner is actively delivering": **failed 3/3 before, passed 3/3 after** (MEASURED); execution, lifecycle and events suites 241/241 |
| **Defect: finalize after cancel never completed (100k; also 5k)** (found by the lifecycle-at-scale benchmark) | Finalize used `UPDATE … WHERE id IN (SELECT … ORDER BY id LIMIT 1000 FOR UPDATE SKIP LOCKED)`. Right after a bulk load (`reltuples = -1`, before autoanalyze) the planner chose a **nested-loop semi join that re-ran the locking subquery once per row of the workspace**: plan captured live inside the failing transaction (MEASURED); the session was CPU-active, not lock-waiting (pg_stat_activity/pg_locks sampling, MEASURED); the first chunk hit the 15 s statement timeout, finalize failed and 64,000 recipients stayed open. A first hypothesis (sorting across two statuses) was **disproved**: splitting the claim per status did not change the failure. Fix: claim with one `SELECT … FOR UPDATE SKIP LOCKED` per status, then `UPDATE … WHERE id = ANY(ids)` (the shape delivery uses; no join to mis-plan). No other statement uses the pattern (repository search) | new `campaigns-finalize-stale-stats.test.ts` (stale statistics asserted as precondition; 5,000 recipients): **old code FAILED** (57014 after 15 s; 5,000 left open), **fixed code passed ×2** (MEASURED); lifecycle benchmark §3.1 |
| **Defect: lock-order inversion between completion or configuration failure and pause/cancel** (deadlock risk) | `complete()` and the configuration-failure path took execution → campaign. They now use `lockCampaignThenExecution` (campaign → execution), like `start()` | same suites; static review of every path that updates the campaign status |

## 3. Execution at 1,000,000 recipients — MEASURED

Harness: `campaigns-execution-bench.test.ts` (opt-in). 1M contacts, 80 % with valid consent, one list, send-now over HTTP,
production page and batch sizes (1,000), test-mode delivery. Bulk seeding leaves the count bitmap INVALID (by design).
The harness then requests recovery through the Audience-owned port, as the worker's count maintenance does in a
deployment, and waits until the bitmap is VALID **before** the measured section. Every long run used the display-awake runner,
and the power log was checked for standby inside each run window.

**Valid run (2026-10-08 19:35–19:58, 0 standby events in the window):**

| | Clean | Crash injected mid-materialization |
|---|---|---|
| Audience recovery (before measuring) | 71 s | 77 s |
| Capture | 2.10 s | 2.19 s |
| Materialization | 8,417 /s | 6,071 /s |
| Page transaction p50 / p95 / max | 115 / 134 / 175 ms | 136 / 212 / 1,621 ms |
| Checkpoint B p50 / p95 (1,000 ids) | 68 / 82 ms | 72 / 99 ms |
| Delivery batch p50 / p95 | 273 / 293 ms | 278 / 714 ms |
| Delivery (test mode) | 3,127 /s | 1,967 /s |
| Start → complete | 375 s | 571 s (+197 s: retry backoff and resume from the committed cursor) |
| Heap: peak growth / after GC (baseline) | 79 MB / 89 (87) | **112 MB** / 89 (89) |
| RSS base → peak | 364 → 390 MB | 401 → 402 MB |
| Duplicates · counts | **0** · planned = sent = 800,000; skipped = 200,000 | **0** · identical |
| PostgreSQL: commits / blocks read / hit / temp bytes | 5,192 / 4.4 M / 104 M / 68 MB | 5,208 / 8.5 M / 105 M / **1.27 GB** |

**Against the targets:**

| Target | Result |
|---|---|
| Capture at 1M ≤ 10 s | MET (2.1 s) |
| Materialization ≥ 2,000 /s | MET |
| Page transaction p95 < 1 s, never > 10 s | MET |
| Recovery within one job retry and at most one page of rework | MET (0 duplicates; resume from the cursor) |
| Memory < 100 MB above baseline | live/retained memory MET (§9.1 of audit 6.9: at most +4 MB live at 500k). Peak `heapUsed`, including garbage, is **NOT MET** in the 1M crash run (112 MB), and met in the 1M clean run (79 MB). Recorded as is: a GC-timing peak, not retention. Options are in audit 6.9 §9.1 |

**Open observation: temp-file spill on the crash path.**
- **What:** 1.27 GB of temp files in this crash run; 68 MB in every clean 1M run; 68 MB in an earlier 1M crash run; 0 to 133 MB at 500k. The spill varies between identical runs.
- **Attribution:** NOT POSSIBLE on this host. `pg_stat_statements` is not loaded, `log_temp_files = -1`, and the application roles are not superusers. Enabling either is a server configuration change the owner has to make.
- **Probable cause:** a sort or hash on the resume path (INFERRED).
- **Plan:** attribute it in the first staging environment with `pg_stat_statements` enabled, before Phase 8 load tests.

**Void runs, kept for the record:**
- The first 1M attempts failed the harness on degraded pre-flight, before the harness requested recovery like the worker does.
- One run overlapped standby (16:55–17:14). `ES_SYSTEM_REQUIRED` alone did not prevent Modern Standby.
- One crash run overlapped a 52-minute lid-close standby (18:36–19:28). Its timings are void. Its correctness still held across a crash plus a suspension: 0 duplicates, exact counts.

### 3.1 Pause, resume and cancel at scale — MEASURED (`campaigns-lifecycle-bench.test.ts`, through HTTP)

Real execution, test delivery mode, 80 % eligible; commands issued while delivering (pause at ≥ 10 % sent). Display-awake runner; **0 standby events** in both windows (100k 21:58:05–21:59:04, 1M 21:59:04–22:11:19). Code: after the pause/cancel version-race and finalize fixes (§2).

| Measure | 100,000 | 1,000,000 |
|---|---|---|
| Pause: HTTP latency | 346 ms | 171 ms |
| Pause: last send recorded after the command | 286 ms | 40 ms |
| Sends while paused (2 s + 3 s observed stable) | 0 (held at 9,000) | 0 (held at 80,000) |
| Resume: HTTP latency / first new send | 60 ms / 670 ms | 76 ms / 824 ms |
| Cancel: HTTP latency | 204 ms | 124 ms |
| Cancel → every remaining recipient final | 6.3 s (67,000) | 129.1 s (717,000; ≈ 5,600 /s) |
| Final state | cancelled; sent 13,000 = rows; cancelled 67,000 = rows | cancelled; sent 83,000 = rows; cancelled 717,000 = rows |
| Duplicate recipients | 0 | 0 |

Before the finalize fix the same benchmark failed at 100k: finalize timed out on its first chunk and 64,000 recipients stayed open after 10 minutes (§2). Cancel-finalize at 1M is a background job (the command returns in 124 ms); its 129 s is linear in the recipients left (INFERRED from the two sizes).

## 4. Read paths at scale — MEASURED (`campaigns-read-bench.test.ts`, through HTTP)

| N | Sequential pages p50 / p95 | Deep page p95 | Status filter p95 | Reason filter p95 | Reason with no match p50 | Analytics p95 |
|---|---|---|---|---|---|---|
| 10k | 16 / 34 ms | 20 | 24 | 23 | 43 ms (before the fix) | 19 |
| 100k (after fix) | 14 / 20 ms | 15 | 14 | 15 | **10 ms** (was 389) | 18 |
| 500k (after fix) | 19 / 38 ms (one outlier at 164) | 20 | 19 | 56 | **9 ms** (was 1,898) | 20 |

1M read paths: NOT TESTED as a separate run. The no-match fix is O(1) for finished executions, and the other paths are
index keysets bounded by the page size (INFERRED to stay flat).

## 5. Security — evidence

| Area | Result | Evidence |
|---|---|---|
| Tenant isolation (HTTP) | PASS | API suites: cross-workspace and cross-organization 404s for campaigns, templates, executions, recipients, preview contacts and analytics. E2E `phase6-security` S1–S4: another organization's ids on both its own and the victim's workspace paths, across read, write, clone, preview, pre-flight, cancel, history, recipients, template apply/clone and analytics; every attempt 403 or 404 with no victim data in any response; the victim's data unchanged |
| RLS | PASS | every public tenant table has RLS **enabled and forced** (§6); `templates.test.ts` proves at the DB that another workspace sees 0 rows and that cross-tenant INSERT and DELETE are refused |
| RBAC | PASS | viewer (read-only), editor (manages templates), custom roles (apply needs `templates.read`; preview with a contact and recipients need `contacts.read`; analytics needs `reports.read`); denials audited |
| IDOR via cursors | PASS | cursors signed and scoped (§2): forged, edited, legacy, cross-workspace and cross-filter cursors give 400 (API and E2E) |
| Injection | PASS | all raw SQL is parameterized (static review); content is structured, HTML is generated by the renderer with escaping and URL allowlists, and merge fields are never allowed in URLs (M1 fixed); an XSS set and a mutation check are in `packages/content` |
| Header injection | PASS | subject and preheader are single-line after substitution (test) |
| Rate limits | PASS | per-user and per-IP policies on every expensive or abusable route (429 with Retry-After); per-deployment overrides validated at boot |
| Privacy | PASS | events, audit metadata, logs, analytics and recipients carry ids and codes only (tests scan for addresses and names); the preview is not logged, audited or emitted |
| Secrets | PASS | no secrets in code; production config refuses development secrets; the cursor key is derived from SESSION_SECRET |
| Independent review | 1 medium and 5 low, all fixed with tests | content amendment §8.1 |

## 6. Database checks — MEASURED on the migrated test database (2026-10-08)

| Check | Result |
|---|---|
| Public tables without RLS enabled AND forced | **none** |
| `workeasy_app` privileges on `email_templates` / `campaign_versions` | SELECT, INSERT only (template UPDATE is column-scoped; no DELETE; versions immutable) |
| SECURITY DEFINER functions without a pinned `search_path` | **none** |
| `app` functions executable by PUBLIC | `app.audience_snapshot_guard`. It is a trigger function (RETURNS trigger, not SECURITY DEFINER) and cannot be called directly, so there is no exposure. **Low hygiene item:** add a REVOKE in the next migration |
| Migrations | all applied, none failed or rolled back; new ones are additive (a CHECK widened, a new RLS table, a partial index) |

## 7. Final regression r6 — MEASURED (2026-10-08 22:11–22:37, display-awake runner, **0 standby events in every step window**)

Run after every code change of this phase (the pause/cancel race, the lock order and the finalize fixes).

| Step | Result |
|---|---|
| Dependency boundaries | 374 modules, 1,722 dependencies, **0 violations** |
| Typecheck | PASS |
| Build | PASS |
| Package suites | 81 passed, 7 skipped (opt-in audience scale benches) |
| Web | **81/81** |
| API | **564 passed**; 9 skipped — all env-gated opt-in benches (`campaigns-bench`, `-execution-bench`, `-lifecycle-bench`, `-preflight-bench`, `-read-bench`, `import-scale`); no `.only`, `xit` or unconditional skip in the repository |
| Worker | 9/9 |
| E2E run 1 | **57/57** (2.2 min) |
| E2E run 2, consecutive | **57/57** (2.9 min) |
| `git diff --check` | clean; the 166 untracked text files have no trailing whitespace; the owner's 3 staged deletions preserved |

Difference from r5 (562 passed, 8 skipped), accounted for: +1 the actively-delivering pause/cancel test, +1 the
finalize stale-statistics test, +1 skipped the lifecycle bench (opt-in, added after r5).

### 7.1 Regression r5 (for the record) — MEASURED (2026-10-08 20:23–20:46, 0 standby events)

| Step | Result |
|---|---|
| Dependency boundaries | 372 modules, 1,706 dependencies, **0 violations** |
| Typecheck | PASS |
| Build | PASS |
| Package suites | shared 62, content 55, and the others: 124 / 86 / 81 (7 opt-in benches skipped) |
| Web | **81/81** |
| API | **562 passed**; 8 skipped (opt-in benches: execution, read, pre-flight, campaigns, lifecycle) |
| Worker | 9/9 |
| E2E run 1 | **57/57** (2.6 min) |
| E2E run 2, consecutive | **57/57** (3.5 min) |
| `git diff --check` | clean (untracked files included via intent-to-add, then reset; the owner's 3 staged deletions preserved) |

Earlier regressions are kept for the record:
- r1 and r2 were void (outdated tests; CPU contention I caused).
- r3 was green.
- In r4 the E2E runs failed twice. One cause was a security test body that failed validation before the tenant check. The other was the IP registration limit, hit by the larger suite; fixed with configurable overrides, not by disabling the limit.

## 8. Known limitations (none hidden)

1. **Production delivery is disabled**: NullDeliveryPort and test mode only. Phase 8 needs explicit approval.
2. **Engagement metrics** (delivered, bounces, opens, clicks, unsubscribes, complaints) are not measurable: there are no producers. The contracts and reference semantics exist; analytics say "not tracked".
3. **Peak heap** above 100 MB in the 1M crash run (112 MB). Retained memory is constant, so this is GC timing (§3; audit 6.9 §9.1).
4. **Unattributed temp-file spill** on the crash/resume path (68 MB to 1.27 GB, varying). Needs `pg_stat_statements` in staging.
5. **The page transaction p95 is close to its limit in some 1M runs** (956 ms in a void run; 134–212 ms in the valid one).
6. Due-time scheduling of later sends is the Phase 8 scheduler: send-now runs now, scheduled sends stay pending.
7. A bitmap-rebuild statement waits without a lock deadline behind long exclusive locks, holding a pool connection (audit 6.10–6.12 §3.3).
8. Manual screen-reader testing NOT TESTED (axe automated only). WCAG 2.2-specific criteria (e.g. target size) not separately verified.
9. 1M read paths not run separately (INFERRED flat).
10. Template version history and restore are not implemented: optimistic locking only, and deleted templates stay deleted.
11. AI, billing and integrations: contracts and disabled ports only.
12. `app.audience_snapshot_guard` EXECUTE granted to PUBLIC (harmless trigger function, §6).

## 9. Gate decision — Phase 6.13 (2026-10-08)

Every condition set for 6.13 is checked against the evidence above.

| Condition | Result | Evidence |
|---|---|---|
| Benchmark including 1M | MET | §3 (clean and crash runs, 0 standby) |
| Performance evidence | MET | §3, §4; every 1M target met except the one below |
| Memory evidence | MET (evidence); **one target NOT MET** | peak `heapUsed` 112 MB above baseline in the 1M crash run (79 MB clean); retained memory constant (audit 6.9 §9.1). Recorded, not waived by me |
| Crash / recovery | MET | §3 crash run: 0 duplicates, exact counts, resume from the committed cursor |
| Pause / resume | MET | §3.1: nothing sent while paused, at 100k and 1M |
| Cancel | MET | §3.1: every remaining recipient final (717,000 at 1M); counts = rows; 0 duplicates |
| Tenant isolation, RLS, RBAC, security review, privacy | PASS | §5, §6 |
| API contract | PASS | OpenAPI regenerated and contract tests in the API suite (r6) |
| Typecheck, build, boundaries, diff check, DB checks | PASS | §6, §7 |
| E2E ×2 | PASS | §7 (57/57 twice, consecutive) |
| No unexplained failures | MET | the void runs are explained (§3, §7.1); both benchmark defects are root-caused and fixed with fail-before / pass-after tests (§2) |
| No hidden skips | MET | §7 (every skip is an env-gated benchmark) |
| Production delivery disabled | MET | §1, §8 item 1 |
| Audit, contracts, runbook, limitations | MET | this record; contracts frozen; runbook §3.7 added; §8 |

**Result: the 6.13 gate conditions are met**, with one recorded target miss (peak heap in the 1M crash run). Whether
that miss blocks the gate is the product owner's call; the evidence and the options are in audit 6.9 §9.1. Closing the
gate and moving the official progress figure (45 %, audit 6.9 §12) are owner decisions; this record does not move them.

**Phase 7: technically unblocked by Phase 6** (all Phase 6 milestones have evidence). Phase 8 (production delivery)
still requires explicit approval.

## 10. Closure — Gate A (milestone 7.0, 2026-10-08)

**Authority:** the product owner's Phase 7 instruction ("formally mark Phase 6.13 CLOSED only if all existing evidence
still supports closure; do not silently waive the target miss").

**Re-verification before closing (MEASURED, 22:58):** no source file changed after regression r6 started (22:11).
The only later changes are documentation (this record, runbook §3.7), the Prisma client regenerated by r6's own build,
and E2E mail artefacts. The r6 evidence (§7) therefore still describes the code.

**Result: Phase 6.13 CLOSED. Gate A (Phase 6 closure) PASS.** Every 6.13 condition in §9 is met with evidence.

**The target miss is kept, not waived:**

| Item | Classification | Owner / action |
|---|---|---|
| Peak `heapUsed` 112 MB above baseline in the 1M crash run (target < 100 MB; clean run 79 MB; retained memory constant) | ACCEPTABLE PRE-PRODUCTION | engineering; investigated again in the database/memory hardening milestone (retained heap, RSS, external memory, GC) and re-measured at Gate E. The measurement and the target stay as recorded |

**Remaining §8 limitations, classified** (rule: BLOCKER = must be fixed before production):

| § 8 item | Classification | Closed by |
|---|---|---|
| 1 Production delivery disabled | BLOCKER | Gate C |
| 2 Engagement metrics not produced | BLOCKER | Gate C |
| 3 Peak heap (above) | ACCEPTABLE PRE-PRODUCTION | DB/memory hardening, Gate E |
| 4 Unattributed temp-file spill on crash/resume | ACCEPTABLE PRE-PRODUCTION | DB hardening (attribution), Gate E |
| 5 Page p95 near its limit (in a void run only) | ACCEPTABLE PRE-PRODUCTION | re-measured at Gate E |
| 6 No due-time scheduler | BLOCKER | Gate B |
| 7 Bitmap rebuild has no lock deadline | BLOCKER | DB hardening |
| 8 Manual screen-reader pass not done; WCAG 2.2 criteria not verified | BLOCKER | Gate F |
| 9 1M read paths not run separately | ACCEPTABLE PRE-PRODUCTION | Gate E |
| 10 No template version history / restore | BLOCKER | Gate B |
| 11 AI, billing, integrations: contracts only | FUTURE PRODUCT FEATURE (the bounded parts in the Phase 7 plan are scheduled) | Phase 7 plan |
| 12 `app.audience_snapshot_guard` PUBLIC EXECUTE | ACCEPTABLE PRE-PRODUCTION (no exposure) | DB hardening |

**Why Phase 7 is unblocked:** every Phase 6 milestone (6.0–6.13) has recorded evidence. The frozen contracts
(audience, campaign, content amendment) are the base Phase 7 builds on. Nothing above prevents product work.

**Not claimed:** production readiness. Delivery stays disabled until Gate C's provider safety tests pass.

Progress accounting from here on: `docs/audit/progress-accounting.md`.
