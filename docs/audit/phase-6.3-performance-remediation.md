# Phase 6.3 — Performance Remediation Investigation

> **Final status (2026-10-07): G2 PASS — CLOSED; Phase 6.3 COMPLETE; official progress 35 %.** The capture
> recommendation (D2 + InitPlan + B3) was implemented (migration `20261012000000_audience_snapshot_chunks`) and the
> count gate was met by the derived exact bitmap (migration `20261013000000_audience_count_bitmap`). The measurements
> and the "G2 BLOCKED — PERFORMANCE" verdict below are the status at the time of this investigation. Final evidence:
> [phase-6.3-g2-closure.md](phase-6.3-g2-closure.md) §9–§11.

Status: investigation only. **No production code, schema, policy, contract or migration was changed.** Every
alternative was measured in rolled-back transactions or in a disposable `bench` schema that has been dropped. Date:
2026-10-05.

## 1. Executive Summary

The current Phase 6.3 design fails two Gate G2 performance gates on the development machine:
- **capture**: 1M takes 35–70 s against a gate of ≤ 10 s;
- **count**: 1M p95 is 7–8.5 s against a gate of < 1 s.

The investigation found that most of the cost has three causes, all measured:

1. **One row per captured contact** in `audience_snapshot_members`. At 1M, the member insert alone takes 31–33 s,
   and most of that comes from the per-row composite FK check, per-row RLS `WITH CHECK`, per-row B-tree maintenance
   and ≈ 210–280 MB of WAL. The same insert as sorted 1,000-id chunks (**candidate D2**, FK and RLS kept) takes
   1.2–1.3 s and writes ≈ 20 MB of WAL.
2. **Per-row evaluation of the RLS predicate.** `app.current_org_id()` / `app.current_workspace_id()` expand to
   `current_setting()` calls that are evaluated once per scanned row of every Audience table. The **same predicate**
   written as `(SELECT app.current_org_id())` is evaluated once per statement (InitPlan) and roughly halves count
   and capture time.
3. **Resolution SQL shape and memory.** Dedup by sort spills at `work_mem` 4 MB, and liveness reads every contact of
   the workspace. A set-algebra resolution (**B3**), a tiny partial index of non-live contacts, and
   `work_mem = 64MB` for the one bulk statement remove the spills and the full contact scan.

| At 1M members | Production today | Best measured combination |
|---|---|---|
| Capture | 42.6 s p50 | **2.95 s p50** (gate ≤ 10 s: PASS) |
| Count | 6.7 s p50 | **1.21 s p50 / 1.59 s p95** (gate < 1 s: **FAIL**) |
| Page | 13 ms p95 | 11.5 ms p95 (D2) (gate < 50 ms: PASS) |

The best combination is D2 storage, the InitPlan policy form, the non-live partial index, B3 resolution and
statement-local `work_mem` 64 MB.

**5M was measured** (4,996,342 members; seeding took 9 minutes using key-order inserts).

- **Production design:**
  - Count through the adapter **fails** at the 15 s runtime statement timeout (93–108 s when the timeout is lifted).
  - Capture succeeds in **306.9 s**, i.e. at the frozen 300 s statement-timeout boundary.
  - **The first purge call fails** at the 15 s statement timeout, so the snapshot cannot be released.
- **Best candidate:** captures 5M in **27.0–38.7 s** (gate ≤ 60 s: PASS); count is 11.6–26.8 s (FAIL).

**Configuration check (benchmark-only, reverted):** with `shared_buffers` raised from 128 MB to 2 GB, the best 1M
count is 1,023 ms p50 / 1,081 ms p95 — still above the 1 s gate on this machine. Production SQL stays at 6.5 s.

**G2 can not be approved on this evidence.** The count gate is not met by any measured design. The design that
meets the capture gate changes the frozen snapshot storage (Audience contract §9.6), changes existing Phase 5 RLS
policies, and adds an index to an existing Audience table. All three need human approval (stop conditions 1 and 6).
Phase 6.4 must not start.

## 2. Baseline

**Environment:**
- **Machine:** Intel i7-1185G7 (4 cores / 8 threads), 8 GB RAM, Micron 2650 NVMe, Windows 11.
- **PostgreSQL:** 16.15, defaults except `shared_buffers` 128 MB and `max_wal_size` 1 GB (configuration file).
- **Other settings:** `work_mem` 4 MB, `random_page_cost` 4, `effective_io_concurrency` 0, 2 parallel workers per
  gather.
- **JIT:** not available in this build (`pg_jit_available() = false`), so it plays no part in any timing below.
  Linux builds usually have JIT; it would need re-measuring there.
- **Noise:** the machine shows large run-to-run variance. Many p95 values are 3–5× their p50 (stalls of 10–25 s),
  so tables report p50 and p95, and decisions rely on repeated runs, never on one favourable run.

**Dataset** (reproducible, seeded in key order — same distribution as the Phase 6.3 benchmark; only insertion order
differs, which made seeding 2–3× faster):

| Workspace | Contacts | Notes |
|---|---|---|
| noise (other organization) | 300,000 | shares every table |
| w100k / w500k / w1m | 106,326 / 531,632 / 1,063,264 | 5 include lists, every contact in one and 20 % also in a second; tag 10 %; exclusion list 5 %; 1 % deleted |
| w1m extras | — | sparse list (10 %), second exclusion list (2 %), exclusion tag (1 %), archived list (4 %), deleted list (memberships removed) |
| stale | 531,632 | seeded **after** `ANALYZE` (its ids are absent from the statistics) |

Definitions measured:
- **REAL:** 5 lists + tag, minus the exclusion list. ≈ 94 % of contacts.
- **SPARSE:** the sparse list minus the exclusion list. 106k.
- **MULTIEX:** REAL minus 3 exclusion sources. 968k.
- **ARCHIVED:** archived list + one list. 245k.

**Phase 6.3 benchmark figures (previous report):**

| Metric | Result | Gate |
|---|---|---|
| Capture at 1M | 35–70 s | ≤ 10 s |
| Count p95 at 1M | 7.4–8.5 s | < 1 s |
| Page p95 | 12–26 ms | < 50 ms |
| Eligibility at 1,000 ids | unstable | p95 < 250 ms |
| 5M | not measured | ≤ 60 s |

## 3. COUNT investigation

Each candidate was measured as `workeasy_app` under forced RLS, with 1 warm-up and 5 timed plain executions, plus
one `EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS)` (plans kept in the investigation log). Every candidate returned
**exactly the baseline audience** in every case.

| Case | B1 production | B1 nested loops allowed | B2 EXISTS | B3 set algebra | B4 set algebra + NOT EXISTS |
|---|---|---|---|---|---|
| w100k REAL | 526 / 566 | 916 / 961 | 295 / 380 | 437 / 470 | 372 / 466 |
| w500k REAL | 4,259 / 4,764 | 3,701 / 3,940 | 1,284 / 1,732 | 1,977 / 12,477 | 1,578 / 1,840 |
| w1m REAL | 6,918 / 17,286 | 6,938 / 22,391 | 7,266 / 23,325 | 4,135 / 4,176 | 4,080 / 18,167 |
| w1m SPARSE (106k) | 2,717 / 2,744 | 2,102 / 2,376 | 1,130 / 1,148 | 1,448 / 9,454 | 784 / 806 |
| w1m MULTIEX (968k) | 6,895 / 22,305 | 7,061 / 23,626 | 7,002 / 23,017 | 4,297 / 20,864 | 4,249 / 21,144 |
| w1m ARCHIVED (245k) | 3,377 / 16,772 | 3,376 / 3,571 | 1,365 / 1,401 | 1,130 / 1,235 | 1,599 / 10,798 |
| stale statistics (500k) | 2,899 / 14,755 | 2,696 / 3,024 | 2,051 / 10,378 | 1,250 / 1,391 | 3,003 / 13,938 |

All values are p50 / p95 in ms, as `workeasy_app`. JIT is unavailable in this build, so the B1 "JIT off" rows were
identical to B1.

**Diagnosis of the 1M production count**, from its `EXPLAIN ANALYZE`, in pipeline order:
1. **Memberships scan:** a parallel sequential scan of all memberships of all tenants. It keeps 1.28M rows and
   discards 2.06M, and evaluates the RLS predicate (two `current_setting()` calls cast to uuid) on every row.
   69k pages were read, almost all from the OS cache: 540 MB against 128 MB of shared buffers.
2. **Union dedup:** done by an external sort that spills 27 MB at `work_mem` 4 MB.
3. **Join hash:** 1.06M contacts in 16 batches, spilled.
4. **Liveness join:** a bitmap heap scan of all 1.06M workspace contacts, again with the per-row RLS filter.

Cardinality was badly under-estimated: 551k unique and 204k joined rows were estimated, against 1.06M and 1.05M
actual. The RLS selectivity guesses cause this, and they size hashes too small.

The time is not planning (≈ 10 ms) and not JIT (unavailable). It is volume (≈ 1.3M membership rows plus 1M
contacts), per-row RLS function evaluation, and spills.

Alternatives:
- **B2 (EXISTS from contacts)** wins small and sparse audiences, but at 1M it probes 4.2M buffers and loses.
- **B3 (set algebra)** never joins the full contact table: liveness needs only the few non-live contacts, which is
  equivalent because every membership references a contact of the same workspace (composite FK). B3 is the most
  robust candidate: best or near-best everywhere, and the only one fast under stale statistics. One caveat remains:
  without an index it still reads all workspace contacts to find the 1 % that are non-live (≈ 2 s at 1M, visible in
  its plan).
- **Without RLS** (owner, evidence only), B3 counts 1M in 1.56 s, 500k in 0.53 s and 100k in 0.10 s. RLS
  evaluation therefore costs 2.5–4× on count. B1 as the owner is not comparable, because without RLS its contact
  join has no workspace filter and scans every tenant.

## 4. CAPTURE investigation

The capture was decomposed in rolled-back `workeasy_app` transactions from one materialized resolution. Times are
per step in ms, with WAL; two runs at 500k and 1M.

| Step | 100k | 500k | 1M |
|---|---|---|---|
| Production capture (one statement) | 2,072 (24 MB) | 14,980 / 31,276 (120–179 MB) | 43,450 / 46,520 (211–284 MB) |
| Resolve + dedupe into temp table (no WAL) | 546 | 3,819 / 2,760 | 6,005 / 6,067 |
| Insert members: FK + RLS (production shape) | 1,280 | 26,188 / 6,194 | 30,829 / 32,929 |
| Insert members: no FK, RLS | 748 | 3,107 / 3,500 | 6,173 / 6,218 |
| Insert members: FK + InitPlan policy | 1,001 | 4,418 / 22,223 | 10,405 / 31,417 |
| Insert members: FK, no RLS (owner) | 846 | 4,368 / 4,641 | 30,480 / 11,511 |
| Insert members: no FK, no RLS (owner) | 326 | 1,527 / 2,107 | 5,217 / 5,557 |
| **Insert chunked (D2): FK + RLS** | **98 (1.8 MB)** | **558 / 541 (8 MB)** | **1,270 / 1,181 (18–21 MB)** |

`EXPLAIN (ANALYZE, WAL)` of the production statement shows the member-FK trigger at 0.53 s (100k), 3.4 s (500k)
and 6.7 s (1M), with one call per member. At 500k it writes 125 MB of WAL in 1.01M records.

**Dominant costs at 1M**, in order:
1. **Writing one row per member**, about 25 of the 43 s. This breaks down further as:
   - per-row FK checks, which add 24–27 s over the no-FK insert;
   - per-row B-tree and heap writes and WAL, ≈ 5–6 s even without FK and RLS;
   - per-row RLS `WITH CHECK`.
2. **Resolution:** ≈ 6 s, of which RLS evaluation and spills are the larger part.

Snapshot-row insertion is negligible: 1 FK call, < 20 ms.

## 5. Storage experiments

| Representation | Capture (insert) at 1M | Storage at 1M | WAL at 1M | Page p95 (1,000 ids) | Full walk 1M | Purge 1M |
|---|---|---|---|---|---|---|
| **D1** — row per contact (production) | 31–33 s | 115 MB heap + 131 MB index | 211–284 MB | 13.1 ms | 10.7 s | 100 calls, 193 s (first call 11.4 s, max 67.6 s) |
| **D2** — sorted 1,000-id chunks `uuid[]`, `PRIMARY KEY (snapshot_id, chunk_no)`, same FK, same forced RLS | 1.2–1.3 s | 0.14 MB heap + 18 MB TOAST | 18–21 MB | 11.5 ms | 6.8 s | 100 calls, 0.57 s (p95 11 ms) |

End-to-end D2 capture statement, with the same semantics as production (single statement and T0, missing-source
check, size limit, `ON CONFLICT` idempotency), at 1M:

| Variant | D2 capture p50 / p95 |
|---|---|
| Current policies | 9.5 / 25.8 s |
| + B3 resolution | 6.9 / 7.1 s |
| + InitPlan policy | 3.7 / 3.8 s |
| + partial index + `work_mem` 64 MB | **2.95 / 2.99 s** |

At 500k the same combination is 1.2 s.

How D2 holds the snapshot properties:
- **Determinism:** chunk k holds positions k·1,000 … k·1,000+999 of the ascending order. A page of ≤ 1,000 ids
  spans at most two chunks and is read in one statement together with the snapshot's release status.
- **Crash recovery:** the purge keeps the same semantics. It locks the snapshot row, marks it released once, deletes
  ≤ 10 chunks (= 10,000 ids) per call, and sets `purged_at` in the transaction that observes no chunk left.
- **Concurrent reads:** chunks are immutable rows.
- **Memory:** one row is ≈ 16 KB, stored in TOAST.

The paged D2 result equalled D1 at 100k, 500k and 1M, and D2 equalled the reference in all 352 randomized
non-error cases (§12).

**D3 was not investigated.** No measurement pointed to a representation with an advantage over D2. Unlogged
tables, for example, would lose crash safety, which resume requires.

## 6. FK experiment (E1 vs E2)

| | 100k | 500k | 1M |
|---|---|---|---|
| Member insert with FK (RLS on) | 1,280 ms | 6,194–26,188 ms | 30,829–32,929 ms |
| Member insert without FK (RLS on) | 748 ms | 3,107–3,500 ms | 6,173–6,218 ms |

Page and purge are unaffected by the FK (it is checked on insert only). Concurrency is unaffected: an FK check
takes a `FOR KEY SHARE` lock on the parent row inserted by the same transaction.

**What the FK guarantees that would be lost without it:**
1. Every member row references an existing snapshot. An orphan member, for example one written by a buggy or
   partial code path, is rejected by the database.
2. The member's `org_id` / `workspace_id` equal its snapshot's. A member labelled with one workspace can't point at
   another workspace's snapshot, even for a role that bypasses RLS.
3. A snapshot row can't be deleted while members exist (`ON DELETE RESTRICT`). The grants already forbid deleting
   snapshots, so this is defence in depth.

**D2 keeps the FK** at one check per 1,000 ids, so none of these guarantees has to be given up. This experiment
supports D2, not removing the FK.

## 7. RLS experiment (F)

Staged with the same predicate in two evaluation forms. A superuser `ALTER POLICY` was applied inside a transaction
that was always rolled back, and the queries ran as `workeasy_app` (`SET LOCAL ROLE`).

| At 1M (p50) | Current per-row predicate | InitPlan form `(SELECT app.current_…())` |
|---|---|---|
| B1 count | 6,835 ms | 3,528 ms |
| B2 count | 8,593 ms | 1,566 ms |
| B3 count | 4,661 ms | 2,129 ms |
| Production capture | 49,692 ms | 20,676 ms |

At 500k: B2 1,075 → 701 ms, B3 1,216 → 847 ms, capture 11,428 → 7,927 ms.

**Share of cost:**
- **Count:** RLS is a large share, not a small one. Owner (no RLS) B3 at 1M is 1.56 s against 4.1–4.7 s as the
  app. Most of that gap is per-row predicate evaluation, which the InitPlan form removes while keeping RLS.
- **Capture:** the RLS share is smaller than the FK's.

**Tenant isolation is not weakened by the InitPlan form.** It is the identical predicate over the same session
settings, evaluated once per statement. (Within one statement the settings cannot change through the application,
which never runs user SQL.) It was **not** applied to production. It would change the existing Phase 5 policies of
seven tables, so it requires approval.

## 8. Index / planner analysis (G)

**Proposed index:**

| Field | Value |
|---|---|
| Index | `contacts (workspace_id) WHERE deleted_at IS NOT NULL OR erased_at IS NOT NULL` |
| Query improved | B3 resolution (count and capture): liveness by `EXCEPT` non-live contacts |
| Before | bitmap heap scan of all 1.06M workspace contacts to find 10.6k non-live, ≈ 2 s at 1M (B3 plan) |
| After | 1M B3 count 1,691 → 1,207 ms p50 with InitPlan, and 1,207 ms with `work_mem` 64 MB, p95 1.59 s |
| Write overhead | only on soft delete or erasure (rare); none on create, update or import of live contacts |
| Storage overhead | proportional to non-live contacts only (≈ 1 % here) |
| Reason | the only full-table read left in B3 that is not membership volume |

**Rejected or not proposed:**
- `list_memberships` / `contact_tags`: the existing primary keys `(list_id, contact_id)` / `(tag_id, contact_id)`
  serve every access path. The sequential scan chosen for REAL is correct, because 5 lists cover most rows. No
  index proposed.
- A live-contacts partial index `(workspace_id, id) WHERE deleted_at IS NULL …` (decision E candidate): B3 makes it
  unnecessary, and it would be as large as the table.
- Snapshot members: the primary key serves paging and purge. No index proposed.

**Planner findings:**
- Cardinality under RLS is under-estimated by 2–5×, which causes small hashes and spills.
- `work_mem` 4 MB spills every 1M dedup.
- With nested loops allowed, the plans on stale statistics are the known quadratic risk; production already
  disables them for these statements.
- Statement-local `work_mem` 64 MB removes all spills: B1 count at 500k goes from 1,532 to 977 ms with InitPlan.
- JIT: unavailable in this build.

## 9. Purge analysis (H)

| Size | D1 first call | D1 per call p50 / p95 / max | D1 total | D1 WAL | D2 total | D2 WAL |
|---|---|---|---|---|---|---|
| 100k | 431 ms | 194 / 431 / 431 ms | 2.2 s (10 calls) | 5.9 MB | 45 ms | 0.06 MB |
| 500k | 1,843 ms | 881 / 1,843 / 11,000 ms | 55.7 s (50 calls) | 31.7 MB | 276 ms | 0.29 MB |
| 1M | 11,415 ms | 921 / 3,612 / 67,649 ms | 193.5 s (100 calls) | 141 MB | 569 ms | 0.58 MB |

These were measured on a clean, vacuumed baseline.

**Findings:**
- **D1 purge calls can exceed the 10 s default interactive-transaction timeout** that a release caller gets from
  `withTenant`: 1 call at 500k, 2 at 1M.
- Earlier in this investigation, with a bloated members table, a 1M purge call took 14.3 s and the release failed.
  The bloat was 2.9 GB of heap and 1.9 GB of index, with 28.9M dead tuples, left by rolled-back captures.
- **Rolled-back or failed captures also leave dead member rows**, so bloat is not only a purge-time effect.
- Each purge leaves dead tuples equal to the deleted members until (auto)vacuum.

**D2 keeps every required property**, verified in the purge harness:
- the snapshot row is locked before lifecycle mutation;
- release is idempotent;
- ≤ 10,000 members (10 chunks) are deleted per call;
- `purged_at` is set only when none remain.

It reduces purge work about 300× and leaves 1,000× fewer dead tuples. Within D1, no lifecycle-preserving change
removed the per-row cost; it is inherent to one row per member.

## 10. Eligibility benchmark (decision D)

**Dataset:** the 1.06M-contact workspace with an email identity per contact. For a 5,000-contact sample: consent
event and state (1 in 7 withdrawn), topic preference (50 % set, 10 % of those unsubscribed), and a suppression on
5 %. Calls use `topicPolicy = block_unsubscribed` through `EligibilityEvaluator` + `PrismaEligibilityFactsReader`
inside `withTenant` (`workeasy_app`). Each batch size ran 3 interleaved rounds × 200 measured calls (20 warm-up
calls per round).

| Batch | Round 1 p95 | Round 2 p95 | Round 3 p95 | All rounds p50 / p95 / p99 / max | Gate p95 < 250 ms |
|---|---|---|---|---|---|
| 100 | 15.4 | 14.8 | 12.8 | 8.3 / 14.6 / 17.5 / 20.3 ms | pass, stable |
| 500 | 37.8 | 38.2 | 42.0 | 28.8 / 39.3 / 44.5 / 56.3 ms | pass, stable |
| 1,000 | **563.7** | 74.5 | 221.5 | 62.2 / **264.7** / 706.4 / 46,036 ms | **fail**, unstable |

1,000 ids pass in some rounds and fail in others, and their tail includes multi-second stalls. 500 is stable in
every round, with a maximum of 56 ms. Taken together with the two Phase 6.3 runs, the evidence supports the
conservative in-process limit already in force, **500** (decision D, unchanged). Decision D is not rewritten.

## 11. 5M benchmark

**Measured on this machine.** The audience is 4,996,342 members, just under the 5,000,000 limit, from 5,315,257
contacts with the same distribution. Seeding took 537 s with key-order inserts; the earlier aborted attempt used
random-order inserts and was still loading contacts after 37 minutes.

| Measurement | Result |
|---|---|
| Production `count` through the adapter, production timeout (runtime role, 15 s) | **failed** after 15.2 s — statement timeout (`P2010`) |
| Production count SQL, timeout lifted (V0 B1) | 107.8 s, 93.3 s |
| B3 count, current policy (V0) | 45.7 s, 44.9 s |
| B1 / B3 count, InitPlan + index + `work_mem` 64 MB (V3) | 44.3 / 23.5 s and 26.8 / 11.6 s |
| Production `capture` through the adapter (300 s statement / 330 s transaction) | **succeeded in 306.9 s**: 4,996,342 members committed; the statement ran at the 300 s limit |
| Production purge, first `releaseByKey` call | **failed** after 15.0 s — statement timeout. The call rolls back, so the 5M snapshot cannot be released by the current design on this hardware |
| Over-limit at full scale (adapter limit = size − 1) | `AUDIENCE_TOO_LARGE` after 61.0 s; **0 snapshots committed** (atomic) |
| Best candidate (D2 + B3 + InitPlan + index + `work_mem` 64 MB), staged and rolled back | **38.7 s, 27.0 s** (gate ≤ 60 s: PASS) |
| Best candidate page (50 random cursors × 1,000 ids) | p50 19.9 / 33.1 ms, max 31.1 / 74.6 ms |

```text
EXTRAPOLATION — NOT MEASURED
D2 purge of a 5M snapshot: 500 calls × ≈ 5 ms ≈ 3 s (measured 1M: 100 calls, 0.57 s; linear in chunks).
```

## 12. Correctness matrix

**Harness:**
- 400 randomized cases from a deterministic seed.
- **Contacts per case:** 5–64, with ≈ 10 % deleted and 5 % erased.
- **Sources per case:** 1–6 lists (20 % archived, 5 % deleted, density 5–100 %, some empty) and 0–3 tags
  (5 % deleted).
- **Definitions:** random mixes of lists and tags, single or multiple includes and excludes, overlapping sources,
  duplicate membership across sources.

The reference is the pure core model `captureMembers` from `@workeasy/audience-core`, which is independent of SQL.

| Candidate | Cases compared | Mismatches |
|---|---|---|
| Production `count` (B1) | 400 (incl. 48 deleted-source cases → `AUDIENCE_SOURCE_NOT_FOUND`) | 0 |
| Production `capture` + paging (random page sizes 1–7) | 400 | 0 |
| B2 count | 352 | 0 |
| B3 count | 352 | 0 |
| B4 count | 352 | 0 |
| D2 chunked capture + multi-chunk paging (chunk size 3) | 352 | 0 |

That is 2,208 checks with 0 mismatches. At scale, every count candidate equalled the baseline audience in all 33
measured cases (§3), and the D2 walk equalled D1 at 100k, 500k and 1M.

## 13. Security matrix

**Production** (unchanged code, full suite re-run; §16):
- `packages/db/test/audience-snapshots.test.ts`: RLS forced, identical `USING` / `WITH CHECK`, exact grants,
  cross-workspace read/update/delete/lock/insert refused, immutability.
- `packages/audience-infra` resolution tests: foreign snapshot ids, foreign keys and foreign cursors fail; released
  snapshots return `AUDIENCE_SNAPSHOT_NOT_FOUND`; recovery never crosses tenants.

**D2 candidate**, on forced-RLS disposable tables as `workeasy_app`:

| Check | Result |
|---|---|
| A pages its own live snapshot | 1 row ✓ |
| A pages its own released snapshot | 0 rows ✓ |
| B reads A's chunks / snapshot row | 0 rows ✓ |
| B pages A's snapshot (foreign id / cursor) | 0 rows ✓ |
| B inserts a chunk or snapshot labelled with A | `42501` refused ✓ |
| B releases (updates) A's snapshot | 0 rows ✓ |
| B purges (deletes) A's chunks | 0 rows ✓ |
| B locks A's snapshot row | 0 rows ✓ |
| A's snapshot intact afterwards | ✓ |

**InitPlan policy form:** the same predicate, so it has the same isolation (§7). It was measured only, never
applied.

## 14. Recommendation

**ADOPT CANDIDATE "D2 + InitPlan + B3"**, as a proposal for approval. It is not implemented, and it does not by
itself satisfy G2.

```text
Recommended architecture:
  1. Snapshot storage D2: sorted 1,000-id chunks (audience_snapshot_chunks: org_id, workspace_id, snapshot_id,
     chunk_no, first_contact, last_contact, contact_ids uuid[]; PK (snapshot_id, chunk_no); composite FK to the
     snapshot; forced workspace RLS; SELECT/INSERT/DELETE for workeasy_app; no UPDATE) replacing
     audience_snapshot_members. Purge = ≤ 10 chunks (10,000 ids) per call.
  2. RLS policies of the Audience tables in InitPlan form (identical predicate).
  3. Partial index contacts (workspace_id) WHERE deleted_at IS NOT NULL OR erased_at IS NOT NULL.
  4. Resolution SQL in set-algebra form (B3) and work_mem = 64MB for the count/capture statement only (code only).
Why: removes per-row FK/RLS/B-tree/WAL cost of capture and purge, per-row predicate evaluation, the full-contact
  liveness scan and spills; every invariant preserved.
Measured improvement (1M): capture 42.6 s → 2.95 s; count 6.7 s → 1.21 s p50 (still above 1 s); purge 193 s → 0.6 s;
  WAL per capture 211–284 MB → 18–21 MB; storage 246 MB → 18 MB; page p95 13.1 → 11.5 ms.
Correctness proof: 2,208 randomized checks vs the core reference, 0 mismatches; scale walks identical to D1.
Security impact: none weakened — FK kept, forced RLS kept (same predicate), same grants shape; D2 matrix 11/11.
Migration complexity: one additive migration (new chunk table, RLS, grants), adapter capture/page/release rewritten
  against it, policy ALTERs on 7 existing tables, one new index; no data migration (snapshots are transient: drain or
  release in-flight snapshots before switching); public AudienceResolution API unchanged.
Rollback strategy: forward-only in production; before any Campaign consumer exists (6.5+), drop the new table and
  restore the previous adapter commit; policy ALTERs are reversible statement by statement; the index can be dropped.
Contract impact: Audience contract §9.6 (member table → chunk table; same semantics), decision I wording (grants on the
  new table), decision A purge unit (10 chunks = 10,000 ids, unchanged limit); RLS policy text of existing Phase 5
  tables (predicate unchanged). Public AudienceResolution API: unchanged.
```

**Count.** No measured design reaches < 1 s at 1M on this machine; the best is 1.21 s p50 / 1.59 s p95. The
remaining cost is reading and deduplicating ≈ 1.3M membership rows. Even with 2 GB of shared buffers (benchmark-only, reverted) the best 1M count is 1.02 s p50 / 1.08 s p95, and 5M
counts run 11.6–26.8 s. They exceed the 15 s runtime statement timeout that `count` runs under (decision K).

The count gate therefore needs one of:
- **(a)** a re-measurement on production-like hardware;
- **(b)** an approved revision of the count target or of how `count` is served for very large audiences, for
  example an elevated statement-local timeout for `count`, or an estimate above a threshold;
- **(c)** further investigation.

All three are decisions, not implementation. Separately, the **current design's 5M purge failure** (§11) is an
operability defect that D2 removes.

## 15. Contract impact

**No frozen contract was changed by this investigation.**

Adopting the recommendation would change:
- Audience contract §9.6 (physical member storage) and its wording in decisions A and I;
- the RLS policy text of seven existing tables;
- an index on an existing Audience table.

The public `AudienceResolution` API, T0 semantics, the 5,000,000 limit, the lifecycle, ownership and eligibility
semantics would all stay unchanged. Per stop conditions 1 and 6, implementation is stopped pending approval.

## 16. G2 recommendation

```text
G2 BLOCKED — PERFORMANCE
```

- **Current design:** fails the capture and count gates.
- **Best candidate:** meets the capture gate at 1M (and at 5M: 27.0–38.7 s), but not the count gate, and it requires contract
  changes that need approval.

Phase 6.4 must not start.

## Appendix — method and artefacts

- **Harness:** a disposable directory (`packages/audience-infra/bench-tmp/`), deleted at the end of the
  investigation. Each experiment logged JSON results and full text plans. The SQL of every candidate is given in this
  document or in the investigation record.
- **Isolation of alternatives:**
  - in a disposable schema `bench`, dropped at the end;
  - or staged by the local superuser inside transactions that were always rolled back (`ALTER POLICY`,
    `CREATE INDEX`), with queries executed as `workeasy_app` via `SET LOCAL ROLE`.
- **Production data:** none existed; this was the disposable test database.
- **Not measured:** DB CPU per backend (Windows has no per-backend CPU accounting in this setup); memory beyond
  spills and Node RSS.

## Appendix B — Candidate SQL (exactly as measured)

Parameters: `$1` include list ids, `$2` include tag ids, `$3` exclude list ids, `$4` exclude tag ids (all `uuid[]`),
`$5` cap + 1. B1 is the production `COUNT_SQL` / `CAPTURE_SQL` in `packages/audience-infra/src/audience-resolution.ts`.

**B2 — EXISTS from the workspace's live contacts**
```sql
SELECT count(*)::int AS n FROM (
  SELECT 1 FROM contacts c
  WHERE c.workspace_id = app.current_workspace_id() AND c.deleted_at IS NULL AND c.erased_at IS NULL
    AND (EXISTS (SELECT 1 FROM list_memberships l WHERE l.contact_id = c.id AND l.list_id = ANY($1::uuid[]))
         OR EXISTS (SELECT 1 FROM contact_tags t WHERE t.contact_id = c.id AND t.tag_id = ANY($2::uuid[])))
    AND NOT EXISTS (SELECT 1 FROM list_memberships l WHERE l.contact_id = c.id AND l.list_id = ANY($3::uuid[]))
    AND NOT EXISTS (SELECT 1 FROM contact_tags t WHERE t.contact_id = c.id AND t.tag_id = ANY($4::uuid[]))
  LIMIT $5) capped
```

**B3 — set algebra** (equivalent because every membership row references a contact of the same workspace through
the composite FK, so "member and not non-live" = "live member")
```sql
SELECT count(*)::int AS n FROM (
  SELECT contact_id FROM (
    (SELECT contact_id FROM list_memberships WHERE list_id = ANY($1::uuid[])
     UNION SELECT contact_id FROM contact_tags WHERE tag_id = ANY($2::uuid[]))
    EXCEPT
    (SELECT contact_id FROM list_memberships WHERE list_id = ANY($3::uuid[])
     UNION SELECT contact_id FROM contact_tags WHERE tag_id = ANY($4::uuid[])
     UNION SELECT id FROM contacts WHERE workspace_id = app.current_workspace_id() AND (deleted_at IS NOT NULL OR erased_at IS NOT NULL))
  ) s LIMIT $5) capped
```
In capture, the same set algebra replaces the `m` CTE:
`m AS MATERIALIZED (SELECT contact_id FROM inc EXCEPT SELECT contact_id FROM exc EXCEPT SELECT id FROM contacts WHERE workspace_id = app.current_workspace_id() AND (deleted_at IS NOT NULL OR erased_at IS NOT NULL))`.

**B4 — set algebra, liveness by anti-join**
```sql
SELECT count(*)::int AS n FROM (
  SELECT s.contact_id FROM (
    (SELECT contact_id FROM list_memberships WHERE list_id = ANY($1::uuid[])
     UNION SELECT contact_id FROM contact_tags WHERE tag_id = ANY($2::uuid[]))
    EXCEPT
    (SELECT contact_id FROM list_memberships WHERE list_id = ANY($3::uuid[])
     UNION SELECT contact_id FROM contact_tags WHERE tag_id = ANY($4::uuid[]))
  ) s
  WHERE NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = s.contact_id AND (c.deleted_at IS NOT NULL OR c.erased_at IS NOT NULL))
  LIMIT $5) capped
```

**D2 — chunk table (as benchmarked in the disposable schema)**
```sql
CREATE TABLE bench.chunks (org_id uuid NOT NULL, workspace_id uuid NOT NULL, snapshot_id uuid NOT NULL, chunk_no int NOT NULL,
  first_contact uuid NOT NULL, last_contact uuid NOT NULL, contact_ids uuid[] NOT NULL,
  PRIMARY KEY (snapshot_id, chunk_no),
  FOREIGN KEY (org_id, workspace_id, snapshot_id) REFERENCES bench.snapshots (org_id, workspace_id, id),
  CHECK (cardinality(contact_ids) BETWEEN 1 AND 1000));
-- forced RLS, policy USING/WITH CHECK (org_id = app.current_org_id() AND workspace_id = app.current_workspace_id());
-- GRANT SELECT, INSERT, DELETE ON bench.chunks TO workeasy_app.
```
Capture: the production statement with its member `INSERT` replaced by:
```sql
INSERT INTO bench.chunks (org_id, workspace_id, snapshot_id, chunk_no, first_contact, last_contact, contact_ids)
SELECT app.current_org_id(), app.current_workspace_id(), s.id, g.k, g.ids[1], g.ids[cardinality(g.ids)], g.ids
FROM s CROSS JOIN (SELECT k, array_agg(contact_id ORDER BY contact_id) AS ids
                   FROM (SELECT contact_id, (row_number() OVER (ORDER BY contact_id) - 1) / 1000 AS k FROM m) x GROUP BY k) g
```
Page ($1 snapshot, $2 last contact id of the previous page or the zero uuid, $3 limit ≤ 1,000):
```sql
WITH k AS (SELECT coalesce((SELECT chunk_no FROM bench.chunks WHERE snapshot_id = $1::uuid AND last_contact > $2::uuid
                            ORDER BY chunk_no LIMIT 1), -1) AS k)
SELECT x::text AS contact_id FROM bench.chunks c, k, unnest(c.contact_ids) x
WHERE c.snapshot_id = $1::uuid AND c.chunk_no BETWEEN k.k AND k.k + 1 AND x > $2::uuid
  AND EXISTS (SELECT 1 FROM bench.snapshots s WHERE s.id = $1::uuid AND s.released_at IS NULL)
ORDER BY x LIMIT $3
```
Purge (one call, in one transaction): lock the snapshot row `FOR UPDATE`; set `released_at`/`release_reason` if
unset; `SELECT min(chunk_no)`; `DELETE … WHERE snapshot_id = $1 AND chunk_no < min + 10`; if no chunk remains, set
`purged_at`.

**InitPlan policy form** (identical predicate, evaluated once per statement)
```sql
ALTER POLICY <table>_workspace ON public.<table>
  USING (org_id = (SELECT app.current_org_id()) AND workspace_id = (SELECT app.current_workspace_id()))
  WITH CHECK (org_id = (SELECT app.current_org_id()) AND workspace_id = (SELECT app.current_workspace_id()));
-- tables measured: contacts, list_memberships, contact_tags, lists, tags, audience_snapshots, audience_snapshot_members
```

**Non-live partial index**
```sql
CREATE INDEX … ON public.contacts (workspace_id) WHERE deleted_at IS NOT NULL OR erased_at IS NOT NULL;
```

**Statement-local memory** (count/capture statement only, restored afterwards like the capture timeout):
`SELECT set_config('work_mem', '64MB', true)`.
