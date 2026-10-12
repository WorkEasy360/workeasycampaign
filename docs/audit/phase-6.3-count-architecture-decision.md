# Phase 6.3 — Audience COUNT Architecture Decision

> **Final status (2026-10-07): G2 PASS — CLOSED; Phase 6.3 COMPLETE; official progress 35 %.** Statements below that
> G2 is blocked are the status at the time of this investigation. Final evidence and scorecard:
> [phase-6.3-g2-closure.md](phase-6.3-g2-closure.md) §10–§11.
>
> **Implementation follow-up (2026-10-06).** Recommendation B was implemented in production as the chunked
> bitmap of the two successor investigations: migration `20261013000000_audience_count_bitmap`, adapter
> `packages/audience-infra/src/count-bitmap.ts`, count path in `audience-resolution.ts`. The public COUNT contract
> (§2) is unchanged: same API, request and response, still exact; the bitmap answers only while VALID, the exact
> query otherwise. Measured results, the security matrix and the G2 decision are in
> [phase-6.3-g2-closure.md](phase-6.3-g2-closure.md) §10–§11. This document remains the decision record; its
> measurements are from the prototypes.

**Status:** decision document — investigation only. No production source code, production migration or public
contract was changed. Every prototype ran in the disposable test database inside rolled-back transactions or in a
throw-away `bench` schema, and all of it was deleted afterwards (§15.4).
**Date:** 2026-10-05. **Predecessor:** [phase-6.3-performance-remediation.md](phase-6.3-performance-remediation.md)
(G2 BLOCKED — PERFORMANCE).

**Evidence labels.** **MEASURED** = observed on this machine in this investigation. **EXTRAPOLATED** = computed from
measured numbers. **THEORETICAL** = reasoning only, not observed. Unlabelled numbers in tables are MEASURED.

**Environment (MEASURED).** i7-1185G7 laptop, 8 GB RAM, NVMe, Windows 11, PostgreSQL 16.15. `shared_buffers` 128 MB
unless a sweep says otherwise, `work_mem` 4 MB server default, JIT unavailable. Every candidate ran as `workeasy_app`
with **forced RLS** and the tenant predicates in place. Data: a 300k-contact noise workspace (other org) plus
workspaces of 100k / 500k / 1M / 5M audience members, the stale-statistics workspace, and per-test fresh workspaces.

---

## 1. Executive summary

**Recommendation: B — ADOPT DERIVED EXACT COUNT**, as a *chunked, trigger-maintained membership bitmap*. Adoption
needs the explicit human decisions in §16.

- **A — direct exact count is not reliably feasible on this hardware.**
  - The best exact query (set algebra + InitPlan RLS + covering indexes + `work_mem` 64 MB) runs at 1M members in
    **856–1,063 ms p50**. Its p95 is **990–1,090 ms in quiet rounds** and **1.1–6.1 s in other rounds**: 60 samples per
    round, 4 `shared_buffers` sizes, plus a control.
  - At the 5M limit it counted within the runtime 15 s timeout in **only 4 of 6 warm runs**.
  - No `shared_buffers` size (128 MB – 2 GB) brings p95 under 1 s. The best p50 is ~900 ms, so there is no margin.
- **B — the chunked, trigger-maintained bitmap meets the gate easily and stays exact.**
  - Count time: **1.5–3.4 ms p50 / ≤ 3.7 ms p95 at 1M** and **10.0 ms p50 / 11.2 ms p95 at 5M**.
  - Correctness: **0 mismatches** in 200 randomized trigger-maintained cases (366 checks, 76 spanning several chunks),
    300 offline-built cases (976 checks), and 11 post-write checks.
  - RLS isolation holds.
  - Write costs: a single add-to-list is unchanged in latency (0.6 → 0.6 ms p50) and WAL roughly doubles
    (0.8 → 1.7–2.2 KB). A 250-row import chunk is +31–47% in database time (≈ 3–6% of end-to-end import time,
    EXTRAPOLATED). Bulk membership statements are 1.4–5× slower.
  - It adds a new invariant that must be guarded and reconciled (§11).
- **C — no large-audience policy is needed**, because B works. Experiment C was still measured (§6).
  - Sampled estimates are 250–1,085 ms with **up to 7.7 % error**.
  - A smaller `cap` does not make the exact query cheaper.
- **Semantics:** B returns the same quantity the contract defines — semantic **A** (live audience membership), exact.
  It does **not** change which "count" the API returns, and the public `AudienceResolution.count` signature is unchanged.

---

## 2. Existing COUNT contract

| Source | Text (verbatim) |
|---|---|
| Audience contract §9.4 (`AudienceResolution`) | `count(scope, def, opts?: { cap?: number }): Promise<AudienceCount>` — "Live, exact member count up to `cap` (default and maximum 5,000,000, the capture limit) — for editing and pre-flight only." |
| Audience contract §9.4 type | `interface AudienceCount { count: number; capped: boolean; countedAt: string }   // live estimate for editing` |
| Audience contract §9.5 | "`count` evaluates the same membership expression live, with the runtime role's default statement timeout (no elevation), `cap` 1–5,000,000. Decision M applies… a missing source is `AUDIENCE_SOURCE_NOT_FOUND`, never counted as empty." |
| Audience contract §9.6 table | "`count` vs snapshot size — `count` is a live estimate while editing; the snapshot `size` is the authoritative audience of a run" |
| Campaign contract, `estimate` | `audienceSize: number; audienceSizeCapped: boolean; // live, exact up to the 5,000,000 capture limit; capped ⇒ AUDIENCE_TOO_LARGE` |
| Architecture §7 (gate) | "Audience count (exact) — p95 < 1 s for 1 M members across 5 sources; exact up to the 5 M capture limit" |

**The five semantics.** Only A is in scope here. None of the candidates computes any of the others.

| | Semantic | Where it lives | Affected by this decision |
|---|---|---|---|
| **A** | Audience membership count: live, non-deleted, non-erased contacts in (∪ include) ∖ (∪ exclude), as of the statement | `AudienceResolution.count`, `estimate.audienceSize` | **yes** — this is the gated quantity |
| B | Snapshot size: frozen membership at T0 | `snapshot.size` (capture) | no |
| C | Eligible recipients: A ∩ eligibility v1.1 | `estimate.eligibleEstimate` (sampled, ≤ 2,000) | no |
| D | Deliverable / consented: C ∩ channel consent and suppression | materialization | no |
| E | Execution recipients: rows materialized for a run | execution | no |

**Contract observation (not changed — flagged).** The contract calls `count` both "exact" (§9.4 doc comment, campaign
contract, gate) and a "live estimate" (§9.4 type comment, §9.6 table). Read in context, "estimate" means "may
differ from the snapshot taken later", not "approximate". Every candidate recommended here returns the **exact**
semantic-A value. If the human prefers different wording, that is an editorial contract change for a later phase.

---

## 3. Baseline measurements

The production `COUNT_SQL` (A1) under the current RLS policy, with no new index, is variant **C0**. There were 12
runs per case: 2 warm-up runs and 10 samples. The plan columns come from `EXPLAIN (ANALYZE, BUFFERS, SETTINGS)`.

| Workspace / shape | Audience | p50 ms | p95 ms | Shared read (blocks) | Temp written (blocks) | Spill nodes |
|---|---|---|---|---|---|---|
| 100k REAL | 99,947 | 436 | 510 | 4 | 343 | 2 |
| 500k REAL | 499,733 | 2,374 | 2,618 | 28,956 | 17,860 | 3 |
| 1M REAL (5 lists + 1 tag − 1 list) | 999,465 | **7,131** | **7,173** | 55,135 | 20,759 | 2 |
| 1M SPARSE | 106,895 | 2,430 | 2,452 | 24,186 | 373 | 2 |
| 1M MULTIEX (3 exclusions) | 967,396 | 7,659 | 7,752 | 55,901 | 20,657 | 2 |
| 1M ARCHIVED (archived + active list) | 240,513 | 3,267 | 11,850 | 26,513 | 11,484 | 3 |
| 1M SINGLE | 411,545 | 3,777 | 13,772 | 30,648 | 9,654 | 3 |
| Stale statistics, 500k | 499,733 | 2,543 | 10,345 | 25,834 | 17,438 | 3 |
| **5M REAL**, runtime timeout 15 s | 4,969,765 | — | — | — | — | **timed out 2/2** (one cancellation took 47.8 s to return) |

The gate is p95 < 1 s at 1M. The baseline misses it by **7.2×**.

---

## 4. Exact-count experiments (Path A)

### 4.1 Candidates

All candidates use the same predicate as production: forced RLS, tenant columns, the decision-M existence check, and
the liveness filter.

| Id | Query | RLS policy form | Indexes | Settings |
|---|---|---|---|---|
| C0 | A1 production | current | current | nested loops off (production) |
| C1 | A3 set algebra (B3) | InitPlan `(SELECT app.current_…())` | + non-live partial index | + `work_mem` 64 MB |
| C2 | A3 set algebra | InitPlan | + non-live + **covering** `(list_id, contact_id) INCLUDE (org_id, workspace_id)` on memberships and tags | + `work_mem` 64 MB |
| C3 | A5 per-selector scans + `GROUP BY` + `NOT EXISTS` | InitPlan | as C2 | + `work_mem` 64 MB |
| C4 | A3 | **current** | as C2 | + `work_mem` 64 MB |

The InitPlan form is the same predicate, evaluated once per statement. It does not disable or bypass RLS. Covering
index sizes: `list_memberships` 275 MB, `contact_tags` 22 MB, non-live 2.5 MB.

### 4.2 Matrix (p50 / p95 ms, 10 samples each; every value equals C0's count)

| Case | C0 | C1 | C2 | C3 | C4 |
|---|---|---|---|---|---|
| 100k REAL | 436 / 510 | 68 / 71 | 64 / 102 | 63 / 67 | 249 / 332 |
| 500k REAL | 2,374 / 2,618 | 476 / 602 | 381 / 422 | 429 / 595 | 1,302 / 1,517 |
| **1M REAL** | 7,131 / 7,173 | 1,086 / 1,236 | **856 / 990** | 929 / 1,083 | 4,823 / 4,911 |
| 1M SPARSE | 2,430 / 2,452 | 172 / 261 | 87 / 89 | 48 / 51 | 568 / 652 |
| 1M MULTIEX | 7,659 / 7,752 | 1,115 / 1,188 | 974 / 8,283 † | 968 / 1,031 | 5,086 / 17,338 † |
| 1M ARCHIVED | 3,267 / 11,850 | 164 / 219 | 154 / 155 | 164 / 167 | 932 / 971 |
| 1M SINGLE | 3,777 / 13,772 | 293 / 321 | 279 / 327 | 114 / 116 | 1,550 / 1,653 |
| Stale 500k | 2,543 / 10,345 | 467 / 517 | 393 / 457 | 430 / 446 | 1,297 / 5,748 |

† A single host stall (§4.4).

Plan facts for C2 at 1M REAL:
- 16,687 shared blocks read, 0 temp, 0 spill nodes.
- 4 Index Only Scans with **0 heap fetches**.
- Execution time under `EXPLAIN ANALYZE` was 1,236 ms; instrumentation adds ~30 %.

Without the InitPlan form (C4), the covering indexes help only ~1.5×. Per-row RLS function evaluation dominates.

### 4.3 Reliability and `shared_buffers` sensitivity (1M, 3 rounds × 20 samples per cell)

The sweep was temporary: `ALTER SYSTEM SET shared_buffers`, then restart. It was reverted with `ALTER SYSTEM RESET` and
a restart, and verified at 128 MB with `postgresql.auto.conf` empty (§15.4).

| `shared_buffers` | Shape | Variant | p50 | p95 | p99 | Samples ≥ 1 s | Per-round p95 |
|---|---|---|---|---|---|---|---|
| 128 MB | REAL | C2 | 1,063 | 1,090 | 1,110 | 60/60 | 1,059 / 1,090 / 1,090 |
| 128 MB | REAL | C3 | 1,003 | 5,027 | 6,367 | 34/60 | 5,027 / 1,031 / 5,488 |
| 128 MB | MULTIEX | C2 | 1,081 | 3,382 | 8,834 | 60/60 | 1,104 / 3,675 / 3,382 |
| 128 MB | MULTIEX | C3 | 1,014 | 2,852 | 8,068 | 46/60 | 2,852 / 1,036 / 5,562 |
| 512 MB | REAL | C2 | 940 | 6,129 | 8,643 | 15/60 | 7,909 / 946 / 6,129 |
| 512 MB | REAL | C3 | 910 | 3,550 | 7,220 | 10/60 | 953 / 3,007 / 4,672 |
| 512 MB | MULTIEX | C2 | 934 | 3,967 | 7,550 | 8/60 | 3,967 / 942 / 6,124 |
| 512 MB | MULTIEX | C3 | 926 | 3,495 | 7,310 | 7/60 | 1,470 / 945 / 3,660 |
| 1 GB | REAL | C2 | 928 | 4,825 | 7,421 | 10/60 | 4,825 / 934 / 5,330 |
| 1 GB | REAL | C3 | 905 | 5,739 | 6,858 | 8/60 | 5,739 / 930 / 6,112 |
| 1 GB | MULTIEX | C2 | 936 | 4,594 | 7,410 | 9/60 | 4,594 / 951 / 5,040 |
| 1 GB | MULTIEX | C3 | 924 | 4,290 | 7,302 | 8/60 | 4,290 / 935 / 6,616 |
| 2 GB | REAL | C2 | 929 | 1,468 | 7,495 | 8/60 | 6,659 / 1,065 / 945 |
| 2 GB | REAL | C3 | 898 | 3,353 | 7,147 | 6/60 | 4,525 / 954 / 1,013 |
| 2 GB | MULTIEX | C2 | 936 | 4,943 | 7,704 | 8/60 | 4,943 / 951 / 5,514 |
| 2 GB | MULTIEX | C3 | 925 | 5,070 | 6,974 | 9/60 | 6,074 / 941 / 5,070 |
| 128 MB (control, after revert) | REAL | C2 | 1,047 | 5,316 | 8,517 | 60/60 | 5,316 / 5,330 / 1,077 |
| 128 MB (control) | REAL | C3 | 973 | 6,031 | 7,739 | 14/60 | 5,876 / 6,031 / 5,414 |

- **MEASURED:** a larger `shared_buffers` lowers p50 from ~1,050 ms to ~900–940 ms, because the working set
  (~33k blocks ≈ 260 MB) fits in the cache.
- **MEASURED:** even quiet rounds land at p95 945–1,100 ms. That is at the gate with no margin, and no cell meets
  p95 < 1 s over all 60 samples.

### 4.4 Stall diagnosis (MEASURED)

There were 60 per-sample `EXPLAIN (ANALYZE, BUFFERS)` runs with `track_io_timing` (transaction-local) and a
concurrent `pg_stat_activity` poll every 250 ms. Seven samples took more than 1.5 s, up to 11.6 s.

- **Work is identical in slow and fast samples:** 32,718 shared blocks read, no temp, no spill.
- **I/O time in slow samples was 0.12–0.84 s**, against 6–11.6 s of execution.
- **No overlap with database activity:** no autovacuum worker or checkpoint coincided with any slow sample.

The stalls are therefore host CPU starvation (laptop power/thermal management or background processes), not a
database plan effect. A dedicated server would likely not show them (THEORETICAL). Even without stalls, the quiet-round
p95 has no margin.

### 4.5 Fresh import (visibility map not set, statistics absent)

This case covers a 534k-contact workspace inserted and counted inside one transaction: InitPlan + covering +
`work_mem` 64 MB, 5 samples.

| Query | Audience | p50 | p95 | Heap fetches |
|---|---|---|---|---|
| A1 | 499,733 | 699 | 700 | 721,540 |
| A3 | 499,733 | 558 | 560 | 729,557 |
| A5 | 499,733 | 437 | 442 | 729,557 |

Index-only scans degrade to heap fetches, but at 534k the count stays below 1 s. At 1M this is roughly 0.9–1.4 s
(EXTRAPOLATED, linear).

### 4.6 At the 5M capture limit

These are REAL definitions with 4,969,765 members.

| Variant | Timeout | Runs |
|---|---|---|
| C2 cold (immediately after seeding) | 15 s (runtime) | 2/2 **timed out** |
| C2 warm | none (900 s) | 6,818 / 6,736 / 6,758 ms |
| C3 warm | none | 10,218 / 22,278 / 11,567 ms |
| C2 warm | 15 s | 10,776 ✓ / 8,745 ✓ / **timeout** / **timeout** / 7,125 ✓ / 7,643 ✓ |
| C3 warm | 15 s | **timeout** / 11,684 ✓ / **timeout** |
| C0 production | 15 s | 2/2 timed out |

**Path A verdict:**
- **MEASURED:** exact count does **not** reliably meet p95 < 1 s at 1M on this machine.
- **MEASURED:** exact count does **not** reliably complete at the 5M limit within the contract's runtime timeout.
- **THEORETICAL:** a faster dedicated server could pass at 1M, but the margin is at most ~10 %, and 5M would still
  need 7–22 s.

---

## 5. Derived-count experiments (Path B)

### 5.1 Design (prototype, `bench` schema, forced RLS with InitPlan policy, `workeasy_app` grants)

| Table | Purpose |
|---|---|
| `contact_seq (org_id, workspace_id, contact_id UNIQUE, seq, PK (workspace_id, seq))` | Dense per-workspace number per contact, assigned on insert and never reused. |
| `src_chunks (org_id, workspace_id, source_id, chunk, bits varbit(16384), PK (source_id, chunk))` | One 2 KB bitmap per list/tag per 16,384-contact range. Stored only when non-zero, inline (`STORAGE MAIN`). |
| `live_chunks (org_id, workspace_id, chunk, bits, PK (workspace_id, chunk))` | Bit = contact is not deleted and not erased. |
| `ws_counter (org_id, workspace_id PK, next)` | Next seq for the workspace. |

```sql
count = Σ_chunk bit_count( OR(include chunks) & ~OR(exclude chunks) & live chunk )
```

Maintenance runs in the **same transaction** as the write, through statement-level `AFTER` triggers with transition
tables:
- `list_memberships` and `contact_tags`: `INSERT` and `DELETE`;
- `contacts`: `INSERT` (seq allocation and live bits) and `UPDATE` (delete, erase, undelete).

Every write path — API, import, bulk operations and FK cascades — goes through the same triggers. The triggers run as
the invoker (`workeasy_app`), so RLS applies inside them.

The source-existence check (decision M) stays in SQL, unchanged. The bitmap answers only the membership arithmetic.

An **unchunked** variant (one varbit per source) was measured first and rejected (§5.4).

### 5.2 Count performance

20 samples per row.

| Workspace / shape | Count | Equals exact | p50 ms | p95 ms |
|---|---|---|---|---|
| 1M REAL | 999,465 | ✓ | **2.6** | **2.7** |
| 1M SPARSE | 106,895 | ✓ | 2.2 | 3.6 |
| 1M MULTIEX | 967,396 | ✓ | 3.4 | 3.7 |
| 1M ARCHIVED | 240,513 | ✓ | 2.0 | 2.2 |
| 1M SINGLE | 411,545 | ✓ | 1.5 | 2.0 |
| **5M REAL** | 4,969,765 | ✓ (vs exact SQL, §4.6) | **10.0** | **11.2** |

Unchunked variant for comparison: 1.5 / 1.9 ms (100k), 3.1 / 3.8 ms (500k), 5.4 / 6.0 ms (1M), 30.5 / 30.9 ms (5M).

### 5.3 Write-path cost (trigger-maintained, chunked)

Every row compares the same operation with triggers against without, in the same session.

| Operation | Today | Chunked bitmap | Change |
|---|---|---|---|
| Single add-to-list, 1M workspace (100 calls) | 0.6–0.7 ms p50 / 1.0 ms p95; 759–946 B WAL | 0.6 ms p50 / 1.1 ms p95; 1,690 B WAL | latency ≈ 0; WAL ≈ 2× |
| Single add-to-list, 5M workspace | — | 0.7 ms p50 / 1.0 ms p95; 2,203 B WAL | WAL independent of workspace size |
| Import chunk, 1M (250 contacts, 500 memberships, 25 tags, 3 deletes; 20 chunks) | 125 ms p50 / 166 ms p95; 6.1 MB WAL | 184 / 221 ms; 10.0 MB WAL | **+47 %** latency, +65 % WAL |
| Import chunk, 5M | 248 / 526 ms; 8.2 MB WAL | 325 / 368 ms; 9.4 MB WAL | **+31 %** p50, +14 % WAL |
| Bulk add 213,789 memberships, one statement | 13.1–21.5 s (two runs) | 30.5 s | **1.4–2.3×** |
| Bulk remove 50,000 memberships | 0.26 s | 1.33 s | **5×** |

**EXTRAPOLATED:** a 1M-row import is 4,000 chunks × +60–80 ms, which adds ~4–5 minutes of database time. The
measured Phase 5 end-to-end import rate is 90–210 rows/s, i.e. 1.2–2.8 s per chunk, so the overhead is ≈ 3–6 % of
import wall time.

### 5.4 Rejected or limited derived options

| Option | Result | Why rejected / limited |
|---|---|---|
| **Unchunked** bitmap with triggers | Count 5.4 ms (1M) and 30.5 ms (5M). Single add-to-list **4.2 ms p50 and 151 KB WAL per call** (199×). Bulk remove 6.5×. A concurrent writer to the same list **waited 1,840 ms** behind a 2 s holder. | WAL and lock scope grow with workspace size: ~750 KB WAL per single add at 5M (EXTRAPOLATED), and one hot row per list. Replaced by the chunked form. |
| Per-selector cached counters | THEORETICAL | Exact only for single-source definitions. Union and exclusion overlap cannot be derived from per-source counts. |
| Materialized view / periodically refreshed counts | THEORETICAL | Stale between refreshes, so it can return a wrong exact count silently. **Rejected** under the "never silently wrong" rule. |
| Snapshot `size` | — | Semantic B (frozen at T0), not semantic A. Using it would redefine "count". **Rejected (contract).** |

---

## 6. Large-audience policy experiments (Path C)

Path C was measured for completeness. It is **not needed**, because B passes. No policy is chosen.

### 6.1 A smaller `cap` does not reduce the exact query's cost (1M REAL, InitPlan + covering)

| `cap` | C2 (A3) p50 / p95 | C3 (A5) p50 / p95 |
|---|---|---|
| 1,000 | 896 / 905 | 674 / 681 |
| 10,000 | 920 / 925 | 698 / 712 |
| 100,000 | 951 / 965 | 729 / 764 |
| 1,000,000 | 1,018 / 1,033 | 948 / 964 |

Set algebra must finish the union and the anti-joins before `LIMIT` applies. A cap saves at most 25–35 % (C3), and
`capped = true` still requires reading past the cap.

### 6.2 Strict statement timeout (1M REAL)

| Query | 1 s | 2 s | 15 s |
|---|---|---|---|
| Production A1, current policy | timeout (1,018 ms) | timeout (2,014 ms) | ok, 7,328 ms |
| A3 best | timeout (1,012 ms) | ok, 1,149 ms | ok, 1,070 ms |

A "1 s or error" policy would fail most 1M counts on this hardware.

### 6.3 Sampled estimate: `TABLESAMPLE BERNOULLI` over contacts, same predicate, 8 seeds

| Workspace | Sample | p50 / p95 ms | Max relative error |
|---|---|---|---|
| 100k | 0.5 % / 1 % / 5 % | 261 / 448 · 247 / 269 · 403 / 428 | 6.9 % · 7.7 % · 4.1 % |
| 500k | 0.5 % / 1 % / 5 % | 294 / 596 · 266 / 297 · 580 / 636 | 4.9 % · 2.3 % · 0.8 % |
| 1M | 0.5 % / 1 % / 5 % | 259 / 332 · 317 / 356 · 1,038 / 1,085 | 2.5 % · 1.4 % · 0.7 % |

`BERNOULLI` reads every page of `contacts`, so its cost floor is ~250 ms. Any estimate changes the semantic from
exact to approximate, which is a **contract change**.

### 6.4 Policy strategies (analytical, THEORETICAL — none chosen)

| Id | Strategy | Contract effect |
|---|---|---|
| P1 | Exact below a threshold, estimate above | Changes semantic A to approximate above the threshold |
| P2 | Exact with a strict timeout, `count: null` on timeout | New response shape (contract change) |
| P3 | Exact up to a lower cap (e.g. 1M), `capped` above | Changes the 5M "exact up to" guarantee |
| P4 | Asynchronous exact count (job + poll) | New API (contract change) |
| P5 | Cached exact count, invalidated on write | Equivalent to B with coarser invalidation; stale windows |
| P6 | Estimate in the editor, exact only at pre-flight | Pre-flight still needs exact-to-5M (§4.6 fails) |
| P7 | Relax the gate (p95 < N s) | Changes a performance target (human decision only) |

---

## 7. Correctness matrix

Every check compares against the pure core reference `captureMembers` from `@workeasy/audience-core`.

| Candidate | Randomized cases | Checks | Not found / empty / full | Mismatches |
|---|---|---|---|---|
| A1 production SQL | 300 | 244 | 56 / 93 / 22 | **0** |
| A3 set algebra | 300 + 200 | 244 + 183 | as above | **0** |
| A5 per-selector scans | 300 | 244 | as above | **0** |
| Unchunked bitmap (built offline) | 300 | 244 | as above | **0** |
| **Chunked bitmap, trigger-maintained** | **200** — random inserts, single- and multi-row deletes, list/tag soft-delete with membership delete, soft delete, erase, undelete; half with 8-bit chunks | 183 | 17 / 14 / 14; 76 cases span more than one chunk | **0** |
| Chunked bitmap after mixed bulk writes, 1M | 5 definitions | 5 | — | **0** |
| Chunked bitmap, 1M + 5M definitions vs exact SQL | 6 | 6 | — | **0** |

Not-found cases are a property of the existence check, which every candidate shares. That check is unchanged and was
verified in the previous audit (400 cases).

Every exact-matrix variant (C0–C4) returned C0's count in all 40 cells.

---

## 8. Security matrix

Every row ran as `workeasy_app` with forced RLS. Workspace B issued the operations against workspace A, in the same
org.

| Probe | A1 / A3 / A5 | Unchunked bitmap | Chunked bitmap |
|---|---|---|---|
| B counts A's sources | 0 | 0 rows visible (null) | 0 |
| B reads A's bitmap rows | n/a | 0 | 0 (sources and live) |
| B updates A's bitmap rows | n/a | 0 rows | 0 rows |
| B inserts a bitmap row labelled with A's org or workspace | n/a | **42501** (RLS `WITH CHECK`) | **42501** |
| B adds a membership to A's list (trigger path) | — | — | **23503** (composite FK), before any trigger |
| Requires RLS disabled, owner role, `BYPASSRLS`, or FK removal | no | no | **no** |

Additional notes:
- The InitPlan policy form keeps the identical predicate.
- Triggers are `SECURITY INVOKER`, so a write can maintain only bitmaps in the writer's own workspace.

---

## 9. Performance matrix (gate: p95 < 1 s at 1M; exact to 5M within the runtime 15 s timeout)

| Candidate | 1M p95 | 5M | Exact | Meets gate |
|---|---|---|---|---|
| C0 production | 7,173 ms | timeout | yes | **no** |
| C2 best exact, quiet rounds | 945–1,090 ms | 7–11 s, 2/6 timeouts | yes | **no** — no margin, unreliable at 5M |
| C2 best exact, all rounds | 1,090–6,129 ms | — | yes | **no** |
| Sampled 1 % | 356 ms | — | **no** (±1.4–7.7 %) | n/a — contract change |
| Unchunked bitmap | 6.0 ms | 30.9 ms | yes | yes, but rejected on write cost |
| **Chunked bitmap** | **2.7 ms** | **11.2 ms** | yes | **yes** (~370× margin at 1M) |

---

## 10. Operational complexity

| Concern | Direct exact (A) | Chunked bitmap (B) |
|---|---|---|
| New objects | InitPlan policy rewrite on 5 tables; 3 indexes (≈ 300 MB at 1M members) | 4 tables, 6 triggers, 4 functions, RLS policies, grants; ≈ 6.8 MB for 6.3M contacts across 2 workspaces |
| Backfill | Index build | contact_seq + bitmaps: 19 s (1M), 54 s (5M) for chunks; contact_seq plus unchunked build: 22.9 s (1M), 160 s (5M) |
| Steady-state cost | none on writes | Import chunk +31–47 %; bulk membership 1.4–5×; WAL +14–65 % per chunk |
| Locking | none new | Contact inserts serialize per workspace on `ws_counter`, held until commit. Membership writes serialize per (source, 16k-contact range). |
| Invariants to guard | none new | bitmap ≡ membership tables (§11) |
| Monitoring | query latency | + trigger presence check, + reconciliation result and drift alarm |
| Bit-width growth | — | Hard-deleted contacts leave zero bits; seq is never reused. Compaction is a per-workspace rebuild. |

---

## 11. Failure and recovery analysis (Path B)

| Failure | Effect | Detection | Recovery |
|---|---|---|---|
| Trigger bypassed: `TRUNCATE`, `ALTER TABLE … DISABLE TRIGGER`, `session_replication_role = replica`, `pg_restore --disable-triggers`, owner bulk load | Bitmap drifts, so the count is **wrong without an error** | Reconciliation (below); migration lint that the triggers exist and are enabled | Rebuild the workspace (≤ 54 s at 5M, MEASURED) |
| Bug in trigger logic | Same as above | Same, plus the randomized test suite in CI | Fix and rebuild |
| Writer transaction rolls back | Bitmap rolls back with it (same transaction) | — | none needed |
| Deadlock between concurrent membership writers locking chunks in different orders | One transaction aborts; nothing wrong is stored | PostgreSQL deadlock error | Import retries (hardening M-6). The implementation must lock (source, chunk) in ascending order (THEORETICAL; not exercised). |
| `ws_counter` contention: API contact creation during an import chunk | Waits up to one chunk transaction (~0.2–0.4 s, MEASURED chunk duration) | Lock-wait metrics | none |
| Rebuild in progress | Bitmap incomplete | Rebuild flag per workspace | `count` falls back to the exact SQL under the runtime timeout. It returns the exact value or a timeout error, **never a bitmap value**. |

**The "never silently wrong" requirement** is met only with all of these mechanisms:
1. Same-transaction triggers, the only maintenance path.
2. No `TRUNCATE` grant to the runtime role, and no owner-role write path in the application.
3. A reconciliation job per workspace that compares the bitmap count with the exact SQL count for a sample of
   definitions (plus `bit_count(live)` vs `count(contacts)`) and marks the workspace for rebuild on mismatch. Measured
   exact cost: ~1 s at 1M, 7–11 s at 5M, run off-peak with an elevated timeout.
4. A per-workspace `bitmap_valid` flag that `count` checks. Invalid means the exact SQL path is used, never the bitmap.

Without items 3–4, a trigger bypass can produce a silent wrong count. That must be part of the approved design, not
optional.

---

## 12. Recommendation

# **B — ADOPT DERIVED EXACT COUNT**

The design is the chunked (16,384-bit), trigger-maintained membership bitmap from §5.1, with the guards from §11.

**Why not A:** measured on this hardware, p95 never fell below 1 s over a full 60-sample cell. The best p50 is
~900 ms, leaving no margin, and the 5M exact count times out in a third of runs under the runtime timeout.

**Why not C:** B meets the gate with ~370× margin and stays exact. Every C strategy changes the contract or a target.

**Why not D:** both remaining unknowns are policy choices, not missing measurements: whether to accept the write cost,
and which hardware is the reference.

---

## 13. Contract impact

| Item | Impact |
|---|---|
| `AudienceResolution.count` signature, `AudienceCount` shape | **none** |
| Count semantic | **none.** It remains semantic A, live and exact, at statement time (the bitmap is transactionally consistent with the membership tables). |
| `cap` / `capped` | none (`capped = count > cap`) |
| Decision M (missing source ⇒ `AUDIENCE_SOURCE_NOT_FOUND`) | none — the existence check stays in SQL |
| Archived sources | none — archived lists keep their bitmap and count normally |
| Snapshot / capture / page / release / purge / T0 / capture key / cursor | none — capture does **not** use the bitmap |
| Tenant isolation, forced RLS, FK integrity | none — new tables carry the same forced RLS; FKs are unchanged |
| Campaign `estimate.audienceSize` | none |
| Contract wording "exact" vs "live estimate" (§2) | editorial, optional, human decision |

---

## 14. Migration impact (for a future, approved migration — none created here)

- New tables (§5.1 shape): FKs to `workspaces` / `contacts` / `lists` / `tags` with `ON DELETE CASCADE`, forced RLS
  policies, and `workeasy_app` grants. **No `TRUNCATE`.**
- Statement-level `AFTER` triggers with transition tables on `contacts` (`INSERT`, `UPDATE OF deleted_at, erased_at`),
  `list_memberships` (`INSERT`, `DELETE`) and `contact_tags` (`INSERT`, `DELETE`). The implementation must also
  cover `DELETE` on `contacts` (cascade cleanup of `contact_seq`). The prototype did not exercise it, because the app
  role has no hard-delete path.
- Backfill per workspace: 19–54 s at 1M–5M members (MEASURED), run online per workspace with `bitmap_valid = false`
  until done.
- Rollback: drop the triggers and tables. `count` reverts to the exact SQL path, so there is no data loss.
- Not required by B: the InitPlan policy rewrite and the covering indexes. They remain options for the reconciliation
  and fallback path, and for capture (D2), but are not part of this decision.

---

## 15. Phase 6.3 implementation plan (only after approval in §16)

1. Migration: tables, policies, grants, triggers, functions with ascending-order chunk locking, `bitmap_valid` flag.
   Tests: RLS matrix, FK cascade, trigger presence.
2. Backfill command, idempotent per workspace, with progress reporting.
3. `PrismaAudienceResolution.count`: existence check (unchanged), then the bitmap count when `bitmap_valid`, else the
   current exact SQL. No change to the public interface.
4. Reconciliation job plus drift alarm; mismatch sets `bitmap_valid = false` and schedules a rebuild.
5. Tests: port the randomized trigger correctness suite (≥ 200 cases, 0 mismatches) and the security probes from §8
   into the `audience-infra` test suite.
6. Benchmark gate re-run: count p95 at 1M and 5M, import chunk overhead, single-write WAL.
7. Gate G2 still also depends on the **capture** decision (D2, not implemented). This decision resolves only the count
   gate.

### 15.4 Artefacts removed and configuration restored

- Dropped the `bench` schema (tables, functions, policies).
- Dropped the indexes `bench_lm_cover`, `bench_ct_cover`, `bench_contacts_nonlive`.
- Deleted the benchmark workspaces.
- Deleted the harness directory `packages/audience-infra/bench-tmp/`.
- Confirmed that the five tenant policies carry their original (non-InitPlan) form.
- Confirmed `shared_buffers` = 128 MB with `postgresql.auto.conf` empty.
- Production source, migrations and contracts are unchanged (`git status` identical to the start of the phase, plus
  this document).

---

## 16. Explicit decision required from the human

1. **Approve recommendation B** — the chunked, trigger-maintained bitmap as the implementation of the exact count —
   **or** choose otherwise.
2. **Accept the measured write-path costs:**
   - import chunk +31–47 % database time (≈ 3–6 % of import wall time, EXTRAPOLATED);
   - bulk membership statements 1.4–5× slower;
   - per-workspace serialization of contact inserts;
   - WAL ≈ 2× for single membership writes.
3. **Accept the new invariant and its guards** (§11, items 1–4) as mandatory parts of the design.
4. **Reference hardware for the count gate.** All numbers come from a laptop with host stalls. Confirm whether this
   machine remains the reference, or name another. This affects the reading of Path A, but not B, which passes with
   ~370× margin.
5. **Optional:** reconcile the contract wording "exact" / "live estimate" (§2).

Until these decisions are made: D2 remains NOT IMPLEMENTED, G2 remains BLOCKED, and Phase 6.4 MUST NOT START.
