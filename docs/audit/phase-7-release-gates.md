# Release gates D–H — status record (2026-10-09)

Gate C is recorded in docs/audit/phase-7-gate-c.md. Figures follow docs/audit/progress-accounting.md: a gate counts only
when every condition holds with evidence.

| Gate | Status | Points |
|---|---|---|
| A Phase 6 closure | PASS (2026-10-08) | counted |
| B Phase 7 core product | PASS (2026-10-09) | counted |
| C Production infrastructure | PASS (2026-10-09) | 15, counted |
| D Security | **PASS** | 5, counted |
| E Scale and reliability | **OPEN: heap target now met in both final runs; page p95 exceeded 1 s once and capture exceeded 10 s once (local PostgreSQL checkpoint storms, default config)** | 5, not counted |
| F Accessibility | **BLOCKED (external): manual screen-reader pass** | 3, not counted |
| G Operations | **OPEN: images BUILT and smoke-tested (17/17); CI workflow not run on a runner (no git remote)** | 5, not counted |
| H External production release | **EXTERNAL** | 2, not counted |

**Official progress: 85 %** (remaining 15 %: E 5, F 3, G 5, H 2).

## Gate D — Security: PASS

| Area | Evidence (MEASURED) |
|---|---|
| Tenant isolation / IDOR / RLS | Every public table has RLS forced; the runtime roles cannot bypass RLS and have no update on key columns; no application function is executable by PUBLIC (new invariant; the last offender was revoked in migration `20261030000000`). Cross-tenant tests at DB, API and E2E level (`phase6-security.spec.ts`); new Phase 7 routes return 404 across tenants (usage, sending rate, results, webhooks) |
| Authorization / role escalation | Global guards (authentication, CSRF, rate limit, access) on every route; route inventory test; per-feature permission tests (`billing.manage`, `campaigns.send`, `reports.read`, `deliverability.manage`) |
| Webhook forgery / replay | Wrong key, stale, unsigned, re-bodied signature → 401, nothing recorded; event deduplication; tenant from the routing table only |
| Token routes | Forged unsubscribe tokens → 404; `/metrics` constant-time bearer; unsubscribe key separate from sessions, rotatable |
| Injection / XSS | Parameterized SQL; html blocks rebuilt through a parse5 allowlist (40-vector corpus); header CR/LF dropped; malformed provider domain refused before any request |
| Rate limits | Fail closed (503) when Redis is down; X-Forwarded-For spoofing closed (hop-count trust refused; fastify 5.12.5) |
| Mass assignment | Strict bodies (unknown fields → 400), tested per endpoint |
| Secrets and PII | No secrets in source; `.env` ignored; logs and metrics built from allowlists (tested: no addresses, ids or query strings in metrics) |
| Dependencies | `pnpm audit --prod`: no known vulnerabilities (after fastify 5.12.5, csv-parse 7.0.3) |

Tracked, not blocking (docs/security.md "Known gaps"):
- MFA and SSO;
- CSP `unsafe-inline` (Next.js);
- breached-password check;
- upload malware scanning;
- encryption of stored provider credentials (none are stored today).

## Gate E — Scale and reliability: OPEN (heap fixed; two latency outliers on the local database)

### Final code (2026-10-10): allocation found, cut, and measured twice

**How the cause was found (MEASURED).**
- **Allocation profiles:** an opt-in V8 sampling heap profiler that counts collected objects too (`EXECUTION_BENCH_ALLOC_PROFILE`, `EXECUTION_BENCH_ALLOC_PHASE=materialize`). It showed materialization allocating **17.7 MB per 1,000-recipient page**.
- **The biggest allocators were:**
  - Prisma's model-query machinery for the eligibility facts (500-placeholder `IN` lists, two batches per page);
  - the pg driver turning JS arrays into array literals;
  - the evaluator's per-contact scans (O(n²) per batch);
  - the uuid library (about 900 bytes per id).
- **GC traces** (`EXECUTION_BENCH_TRACE_GC`) explained the variance. V8 lets old-space garbage grow to live size × a growing factor, and it raises the factor with the promotion rate:
  - **crash run before the fix:** about 2.4× (about 146 MB of garbage at each full GC);
  - **after the fix:** a median of about 1.4× (about 44 MB).

**Changes (behaviour identical; the full suites pass):**
1. The facts reader uses raw SQL, one text or JSON parameter per query.
2. The evaluator indexes the batch once.
3. Recipients are inserted from one JSON parameter.
4. Counts come from PostgreSQL.
5. A lean monotonic UUIDv7 replaces the uuid library on the hot path (`apps/api/src/common/uuid-v7.ts`, tested).

**Result:** materialization allocation per 100k recipients dropped from 1,773 MB to 848 MB, before the UUID change.

**Final-code runs** (1M contacts, 80 % eligible, production page and batch sizes, awake runner, on AC power, 0 standby events):

| | Run k clean | Run k crash | Run l clean | Run l crash | Target |
|---|---|---|---|---|---|
| **Peak heap growth** | **83 MB** | **76 MB** | **76 MB** | **79 MB** | < 100 MB: **MET in all four** |
| Heap after GC (base) | 102 (100) | 102 (102) | 102 (100) | 102 (102) | no retained growth: MET |
| Capture | 5.3 s | 7.3 s | 2.6 s | 3.6 s | ≤ 10 s: MET |
| Materialization | 5,285 /s | 5,951 /s | 4,458 /s | 4,631 /s | ≥ 2,000 /s: MET |
| Page p95 / max | 359 / 849 ms | 268 / 1,087 ms | **1,055** / 1,723 ms | 258 / 339 ms | p95 < 1 s: **MISSED once**; max < 10 s: MET |
| Duplicates · counts | 0 · exact | 0 · exact | 0 · exact | 0 · exact | MET |
| PostgreSQL temp | 68 MB | 68 MB | 68 MB | 68 MB | — |

**Earlier run of the intermediate code (run i), recorded rather than hidden.**
- **Crash scenario:** capture 14.5 s and a peak of 314 MB, with 337 MB of PostgreSQL temp files.
- **Run j (GC tracing, crash scenario):** 182 MB, with a 2.2 GB temp spill.
- **Why the peaks:** both preceded the UUID and parameter changes. GC tracing then attributed the peaks to the promotion-driven growing factor described above.
- **The 2.2 GB spill:** it did not recur in the two logged runs (`log_temp_files = 0` on the test database). Its statement is unknown, because temp logging was off at the time.

**Remaining before Gate E counts:**
- **Page p95:** 1,055 ms in one clean run.
- **Capture:** over 10 s in one earlier run.
- **Likely cause of both:** during those windows the local PostgreSQL ran WAL-triggered checkpoints every 20–30 s. This cluster uses default settings (`max_wal_size` 1 GB, `shared_buffers` 128 MB).
- **Production settings:** recommended in docs/operations/deployment.md ("PostgreSQL settings").
- **To close the gate:** re-run the bench on a production-like database instance. The targets are unchanged.

### History: repeat run of 2026-10-10 16:59 (after the first fix): the 113 MB miss

| | Clean | Crash mid-materialization | Target |
|---|---|---|---|
| Capture | 1.91 s | 9.13 s | ≤ 10 s |
| Materialization | 5,860 /s | 5,181 /s | ≥ 2,000 /s |
| Page transaction p95 / max | 786 ms / 1,117 ms | 965 ms / 1,214 ms | < 1 s, never > 10 s |
| Duplicates · counts | 0 · exact | 0 · exact | — |
| **Peak heap growth** | 82 MB | **113 MB** | < 100 MB: NOT MET |

### History: run of 2026-10-09 22:31 (first run after the first fix)

**Re-measured 2026-10-09 22:31–23:06** (awake runner, **on AC power**, 0 standby events) after an allocation fix in the
materialization page. Before the fix, each page returned one row object (status plus a reason array) per inserted
recipient just to count them. Now PostgreSQL returns the counts: planned, skipped, and skipped by reason code (`execution.service.ts`, `insertRecipients`).

| | Clean | Crash mid-materialization | Target |
|---|---|---|---|
| Capture | 1.92 s | 2.04 s | ≤ 10 s: MET |
| Materialization | 5,074 /s | 4,776 /s | ≥ 2,000 /s: MET |
| Page transaction p95 / max | 950 ms / 1,194 ms | 982 ms / 1,334 ms | < 1 s, never > 10 s: MET (p95 close to the limit) |
| Delivery (test mode) | 1,956 /s | 1,911 /s | — |
| Start → complete | 606 s | 628 s (+22 s retry and resume) | recovery within one retry: MET |
| Duplicates · counts | 0 · planned = sent = 800,000; skipped 200,000 | 0 · identical | MET |
| **Peak heap growth** / heap after GC | 82 MB / 102 MB (base 101) | **82 MB** / 103 MB (base 102) | < 100 MB: **MET** |
| PostgreSQL temp bytes | 68 MB | 68 MB | — |

**Caveat:**
- This is ONE run per scenario. Peak heap includes garbage and depends on GC timing; earlier runs of the same code path ranged from 58 to 123 MB.
- The fix removes per-recipient allocations, so the result points the right way, but variance remains.
- **Recommendation:** repeat the bench on production-like hardware before relying on the margin.

The earlier run is kept below as history.

### History: run of 2026-10-09 19:10 (before the fix): one target miss

Final code, `campaigns-execution-bench.test.ts`, 1M contacts (80 % eligible), production page and batch sizes. Awake
runner; **0 standby events** (19:10–19:38). **Laptop on battery (CPU throttled)**, so throughput figures are conservative.

| | Clean | Crash mid-materialization | Target |
|---|---|---|---|
| Capture | 2.15 s | 2.18 s | ≤ 10 s: MET |
| Materialization | 6,005 /s | 5,382 /s | ≥ 2,000 /s: MET |
| Page transaction p95 / max | 354 ms / 1,224 ms | 940 ms / 1,202 ms | < 1 s, never > 10 s: MET |
| Checkpoint B p95 | 142 ms | 340 ms | — |
| Delivery (test mode) | 2,541 /s | 1,757 /s | — (6.13 baseline 3,127 / 1,967, on AC) |
| Start → complete | 481 s | 641 s (+160 s retry and resume) | recovery within one retry: MET |
| Duplicates · counts | 0 · planned = sent = 800,000; skipped 200,000 | 0 · identical | MET |
| Peak heap growth / heap after GC | 82 MB / 101 MB (base 99) | **102 MB** / 101 MB (base 101) | < 100 MB: **NOT MET in the crash run** |
| RSS growth | 26 MB | 168 MB | — |
| PostgreSQL temp bytes | 68 MB | 68 MB | (the 1.27 GB spill of 6.13 did not recur) |

Also MEASURED today:
- engagement 10k–1M (webhooks 318–347/s per process; reads 10–15 ms p50, flat);
- usage and rate-limit correctness under concurrency (`send-rate.test.ts`: concurrent takers never exceed the bucket).

**The miss.** Peak `heapUsed` (including garbage) is 102 MB in the crash run against < 100 MB (112 MB in 6.13). The
heap returns to its baseline after GC, so retained memory is constant. This is a GC-timing peak, not a leak. The target
was not changed and the miss is not waived by engineering.

**Owner decision:** accept it as ACCEPTABLE PRE-PRODUCTION (the Gate A classification), or ask for an allocation
reduction in the materialization page path before Gate E counts.

## Gate F — Accessibility: BLOCKED (external)

- **Automated: PASS.** axe WCAG 2.1 A/AA runs on every E2E screen, including Phase 7 (sending speed, results, usage), with 0 violations in both final runs. Keyboard and dialog focus tests pass. The violation found today (link colour only) was fixed at its source.
- **Manual screen-reader pass (NVDA/JAWS/VoiceOver): NOT DONE.** It needs a person. Script: the release workflows in docs/operations/release-checklist.md §4.

## Gate G — Operations: OPEN (CI runner)

Done and tested locally:
- the deployment guide and topology (docs/operations/deployment.md);
- production fail-fast, verified on the built API and on the built image;
- **container images BUILT (2026-10-10, Docker 29.8.2): `migrate`, `api`, `worker`, `web`;**
- **container smoke test, `scripts/container-smoke.sh`, 17/17 PASS:**
  - `migrate` applies all 29 migrations to an empty database;
  - `api` is healthy and ready (database, job queue, Redis);
  - `web` serves pages and proxies `/api` to the RUNTIME `API_URL`;
  - all containers run as non-root with tini as PID 1;
  - web keep-alive is 65 s;
  - both workers stay up;
  - SIGTERM shutdown takes 0.5–0.7 s.
- **Defects found by the smoke test, fixed and regression-tested:**
  - the Audience worker exited (code 0) after its first run;
  - Prisma could not detect OpenSSL in the images.
- **CI-equivalent run in a clean Linux container** (the Dockerfile `build` stage):
  - audit, boundaries, migrate:test and typecheck PASS;
  - **two collation-dependent DB tests fixed:** `postgres:16` sorts `contact_tags` after `contacts`; the tests now order with `COLLATE "C"`;
  - **web suite caps workers at 2 when `CI` is set:** one worker per CPU exhausted a 3.5 GB VM.
- migrations from empty, on the dev database (backed up first) and in the image;
- the backup → restore drill, PASS;
- health, readiness and draining;
- metrics, alerts and runbooks;
- the release checklist and rollback.

**Not done:**
- **CI workflow on a real runner.** The repository has no git remote and the `gh` CLI is not installed, so `.github/workflows/ci.yml` cannot run here.
- **Linux timings.** In the local container, render-heavy web tests still crossed 5 s while the HOST had 0.5 GB free RAM (Docker VM under host memory pressure). Timings there are not representative of a dedicated runner, and a real CI run is the evidence still missing.
- **No staging deployment.**

## Gate H — External production validation: EXTERNAL

Needs the owner's accounts:
- a Mailgun account and keys;
- webhooks registered;
- the customer sending domain's DNS (ownership, SPF, DKIM, DMARC);
- a controlled smoke test to an internal mailbox;
- then `CAMPAIGN_DELIVERY_MODE=live`.

Steps: release-checklist §6. Live delivery code is implemented and OFF by default (owner-authorized 2026-10-09).
