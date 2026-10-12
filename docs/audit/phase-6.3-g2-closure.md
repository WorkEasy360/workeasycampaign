# Phase 6.3 — G2 Closure: Capture (D2) and Count (Chunked Bitmap)

```text
G2: PASS — CLOSED
Official progress: 35%
Phase 6.3: COMPLETE
Phase 6.4: NOT STARTED
```

| Item | Status |
|---|---|
| C1 (membership deadlock hardening) | **PASS** — §3 |
| D2 (capture performance) | **PASS** — §9; re-measured on the final code in §10.6 (62.5 s outlier retained and explained, §11) |
| Bitmap implementation | **PASS** — §10 |
| Exact count | **PASS** — 1M p95 ≤ 18.7 ms, 5M p95 ≤ 19.5 ms, 0 mismatches against independent SQL (§10.6) |
| **G2** | **PASS — CLOSED** (2026-10-07) — §11 |

**Dates:** 2026-10-06 (C1); 2026-10-07 (D2); 2026-10-06 (bitmap implementation); 2026-10-07 (G2 closed).
**Official progress:** 35 % (was 30 %; raised on closing G2).
**Phase 6.3:** COMPLETE.
**Phase 6.4:** NOT STARTED.

**Evidence labels.** **MEASURED** = observed on this machine in this work. **INFERRED** = derived from measured results.
**NOT MEASURED** = not observed. Unlabelled numbers in tables are MEASURED. Host: i7-1185G7 laptop, 8 GB RAM, NVMe,
Windows 11, PostgreSQL 16, `shared_buffers` 128 MB. **Reference hardware was not available** (condition C4): every
performance number is from this laptop.

## 1. Original G2 decision

Recorded in [phase-6.3-bitmap-online-rebuild-readiness.md](phase-6.3-bitmap-online-rebuild-readiness.md) §13:
**B — YES WITH CONDITIONS**, G2 BLOCKED / READY FOR HUMAN REVIEW.

The approved architecture:
- online rebuild with a per-workspace single rebuilder;
- states VALID / INVALID / REBUILDING plus a generation number;
- bitmap counts only in VALID, exact count otherwise;
- one chunk per short transaction;
- non-blocking chunk locking;
- generation compare-and-set;
- reconciliation;
- garbage collection of empty chunks;
- validation before bitmap lookup;
- RLS and tenant isolation unchanged.

## 2. Conditions

| Condition | Status | Evidence |
|---|---|---|
| O1 online rebuild algorithm | **IMPLEMENTED, VERIFIED** | §10.2, §10.4, §10.5 |
| O2 three-state machine | **IMPLEMENTED, VERIFIED** | §10.2, §10.4 (state routing) |
| O3 non-blocking chunk locking + concurrent benchmark | **IMPLEMENTED, MEASURED** | §10.5 |
| O4 garbage collection | **IMPLEMENTED, VERIFIED** | §10.4 |
| O5 reconciliation + scheduling + alerting | **IMPLEMENTED, VERIFIED** | §10.4 (worker job) |
| O6 count integration after validation | **IMPLEMENTED, VERIFIED** | §10.2, §10.4 |
| C1 membership deadlock hardening | **IMPLEMENTED AND VERIFIED** | §3 |
| C2 trigger/security verification on the production configuration | **VERIFIED** | §10.3 |
| C4 reference hardware / 5M gates | **5M gates measured on this laptop** (§10.6); reference hardware **not available** | — |
| C5 sequence-number storage | **separate table, as approved** (§4) | §10.6 storage |

## 3. C1 — membership concurrency hardening

This is existing membership hardening required before bitmap rollout. **It is not a bitmap defect.** The 17 deadlocks
in the readiness investigation were unique-index cycles between unordered, overlapping multi-row inserts into
`list_memberships`.

**Changes (application code only; no schema, grant or contract change):**

| File | Change |
|---|---|
| [lists-tags.service.ts](../../apps/api/src/modules/audience/application/lists-tags.service.ts) | `addToList`, `removeFromList`, `tagContacts`, `untagContacts` write rows in **ascending contact-id order**, de-duplicated. List add/remove members, list delete, tag/untag and tag delete run in `inTenantRetrying`. |
| [bulk.service.ts](../../apps/api/src/modules/audience/application/bulk.service.ts) | Each 500-contact bulk transaction runs in `inTenantRetrying`. |
| [import-processor.ts](../../apps/api/src/modules/audience/application/import-processor.ts) | An import chunk adds to its lists and tags in **ascending id order** (its own 3-attempt transient retry is unchanged). |
| [contacts.service.ts](../../apps/api/src/modules/audience/application/contacts.service.ts) | Contact creation inserts its list and tag memberships in ascending id order. |
| [tenant-tx.ts](../../apps/api/src/modules/tenancy/application/tenant-tx.ts) | `isRetryableConflict` (40P01, 40001, P2034, or the same wrapped as a cause) and `inTenantRetrying`: at most 3 attempts with a short jittered backoff, then rethrow. |

- **Idempotency:** a retried unit of work starts from a rolled-back transaction and re-reads the current memberships, so
  the same effect and events are produced once.
- **Tenant isolation:** unchanged (same `withTenant` context per attempt).
- **Membership semantics:** unchanged (same rows; only the insert order differs).

**Verification (MEASURED, [audience-membership-concurrency.test.ts](../../apps/api/test/audience-membership-concurrency.test.ts)):**

| Test | Result |
|---|---|
| SQL control, runtime role: 8 concurrent writers × 5 rounds of overlapping 1,500-contact inserts, **unordered** | **36 deadlocks** in 40 transactions |
| Same, **ascending order** | **0 deadlocks**, 0 errors |
| Real API: 20 concurrent requests (12 × add 1,000 members, 4 × bulk add, 4 × remove), overlapping and differently shuffled | all 200; **0 deadlocks** (`pg_stat_database`); final membership exactly as expected (2,650) |
| Retry helper | retries 40P01, 40001 and P2034 up to 3 attempts; rethrows after; non-conflict errors not retried |

## 4. C5 — sequence-number storage

The approved design keeps a `contact_seq` table: about 157 B per contact (MEASURED in the readiness investigation). The
alternative `bitmap_seq` column on `contacts` was rejected for the reasons recorded there (table rewrite under ACCESS
EXCLUSIVE, a client-forgeable value through the runtime INSERT grant, ORM exposure). **Implemented as approved:** the
separate table `audience_count_contact_seq` (MEASURED 259 MB at 1.06M contacts of one workspace plus 0.5M unpositioned
noise contacts; §10.6).

## 5. Implementation (summary)

See §10.1 (files) and §10.2 (design as implemented, including three measured refinements to the prototype).

## 6. Regression

§10.8.

## 7. Remaining limitations

§10.9.

## 8. Final recommendation

§11.

## 9. D2 — capture performance (implemented and verified)

### 9.1 Decision: MODIFY (adopt the audited "D2 + InitPlan + B3" design in full)

The task's D2 list was:
- set-algebra resolution;
- sorted 1,000-id chunks;
- FK and forced RLS kept;
- the partial live-contact index;
- statement-local `work_mem`;
- public API, T0, 5M limit and tenant isolation unchanged.

It omitted one part of the audited recommendation
([phase-6.3-performance-remediation.md](phase-6.3-performance-remediation.md) §14): the **InitPlan form of the Audience
RLS policies**. The measured 5M result (27–38.7 s) depended on it. Without it, D2 at 1M measured 6.9–7.1 s instead of
2.95 s, which made the 5M gate unlikely.

The InitPlan form is the identical predicate, `org_id = (SELECT app.current_org_id()) AND workspace_id = (SELECT
app.current_workspace_id())`, evaluated once per statement instead of once per row. Forced RLS and tenant isolation are
unchanged.

Two further modifications:
1. **The migration is additive.** It copies existing members into chunks and keeps `audience_snapshot_members`, which
   is no longer written or read, instead of dropping it.
2. **Page and purge derive the chunk span from the stored chunk sizes, not from configuration.** Every chunk but the
   last is full, so a snapshot stays readable whatever chunk size captured it.

### 9.2 Implementation

| Layer | Change |
|---|---|
| Migration [20261012000000_audience_snapshot_chunks](../../packages/db/prisma/migrations/20261012000000_audience_snapshot_chunks/migration.sql) | **Additive.** New `audience_snapshot_chunks` (composite FK to the snapshot, CHECKs for size 1–1,000 / chunk 0–4,999 / bounds, NOT NULL, `BEFORE UPDATE` reject trigger, forced RLS, `SELECT/INSERT/DELETE` for `workeasy_app` only). InitPlan form of the 7 Audience policies. `contacts_non_live_idx` (partial). Existing members copied into chunks. |
| Prisma schema | `AudienceSnapshotChunk` model. `prisma migrate diff` from a database built by all migrations to `schema.prisma` is **empty**, and all five migrations apply cleanly from an empty database. |
| [audience-resolution.ts](../../packages/audience-infra/src/audience-resolution.ts) | Count and capture: set algebra (∪ includes − ∪ excludes − non-live contacts), `work_mem` 64 MB and `enable_nestloop = off` for that statement only. Capture writes sorted chunks in the same single statement (T0 unchanged). Page: one statement, status plus a chunk range found by `last_contact`. Purge: lowest chunks, ≤ 10,000 ids per call. Test-only `chunkSize` seam. |
| audience-core | unchanged (no database logic) |
| Campaigns | unchanged (no database coupling; the public `AudienceResolution` API is unchanged) |
| Docs | Audience contract §9.4/§9.6 (storage, RLS form, grants, triggers, index); architecture ADR D-3 notes. |

### 9.3 Correctness (MEASURED)

| Test | Result |
|---|---|
| Randomized against the pure core reference: 400 workspaces with deleted, erased, every subscription type, consent granted/withdrawn, suppressions, topic preferences, contacts with and without an address, archived/deleted lists and tags, overlapping lists and tags, exclusions, empty and conflicting definitions. Chunk sizes 1/3/7/1000, page sizes 1/2/5/1000. | **0 mismatches.** 311 count + capture + full ordered paged comparisons; 89 matching errors (`AUDIENCE_DEFINITION_INVALID`, `AUDIENCE_SOURCE_NOT_FOUND`). |
| Size sweep 0, 1, 100, 1,000, 10,000, 100,000 | identical id lists, ascending |
| Exact SQL comparison against an independent row-by-row reference (both `EXCEPT` directions, duplicates, chunk order) at 100k, 500k, 1M and **5M** | all **0 / 0 / 0 / 0**; snapshot size = reference size (99,947 / 499,734 / 999,469 / **4,996,342**) |
| T0 and live checks | Snapshot unchanged after delete, erase, membership removal, suppression, consent withdrawal, topic opt-out and address removal. Eligibility changed live for each, but not for the membership removal (correct: eligibility is not about membership). Live count moved 12 → 10. |
| Existing audience-infra suites (capture keys, release, crash recovery, discovery, plans without statistics, isolation) | all pass, with purge expectations unchanged |

### 9.4 Performance (MEASURED, laptop, PostgreSQL 16, `shared_buffers` 128 MB; two independent runs)

| Gate | Target | 100k | 500k | 1M | 5M (4,996,342) |
|---|---|---|---|---|---|
| **Capture** | 1M ≤ 10 s; 5M ≤ 60 s | 161–192 ms | 1.03–1.10 s | **2.32–2.50 s** (p50 2.39 / 2.40 s) | **31.9 / 44.9 / 40.7 s** (p50 40.7 s, max 44.9 s); limit-scale run 4,997,344 members: **43.1 s** |
| **Page** (random positions, 1,000 ids) | p95 < 50 ms | p95 5.8–6.4 ms | p95 5.4 ms | p95 5.9 ms | p95 13.7 ms (max 142 ms) |
| Eligibility (batch 1,000) | p95 < 250 ms | p95 80–110 ms | — | — | — |
| Count (exact; not a D2 gate) | < 1 s at 1M | p95 0.26 s | p95 0.60 s | p50 1.02–1.23 s, p95 1.14 / 8.25 s | **timeout at 15 s** |

Capture detail:

| | 1M | 5M |
|---|---|---|
| Database statement time (server log) | — | 31,725 / 44,870 / 40,651 ms (> 99 % of wall; application overhead 15–216 ms) |
| WAL | 17.5–17.8 MB | 88.1–89.3 MB |
| Temp spill | 68–98 MB | 619 MB |
| Snapshot storage | 16.8 MB | — |
| Node RSS growth during capture | 0 MB | ≤ 3 MB |

Purge:

| | 1M | 5M |
|---|---|---|
| Calls | 99 | 499 |
| Per call | 2–3 ms | 3–4 ms |
| Total | 0.2–0.3 s | 1.5–1.9 s |

Before D2, the first 5M purge call failed at the 15 s timeout.

Full walk of 1M ids: 4.5 s, ascending, RSS growth ≤ 60 MB. Previous production design: 1M capture 35–70 s and 5M
capture 306.9 s.

### 9.5 Security (MEASURED; [audience-snapshots.test.ts](../../packages/db/test/audience-snapshots.test.ts), security-invariant suite)

- **RLS:** forced on all three snapshot tables. The InitPlan predicate is asserted exactly on exactly the Audience
  tables (now 12: the 8 of D2 plus the 4 bitmap tables, §10.3). The security-invariant suite passes.
- **Grants:** `workeasy_app` has SELECT/INSERT/DELETE on chunks; there is no UPDATE on any id or tenant key; reporting and
  identity roles have **0 privileges**.
- **Writes:** UPDATE of a chunk is refused for the app role (42501) and also for the owner (immutability trigger).
  TRUNCATE is refused.
- **Cross-workspace and cross-org:** workspace B reads 0 of A's chunks, and deletes 0. A chunk labelled with A's tenant
  is refused by RLS (42501). A chunk carrying B's labels but A's snapshot is refused by the composite FK (23503). An
  org-only context sees nothing.
- **Constraints:** empty chunk, more than 1,000 ids, chunk number outside 0–4,999, mismatched bounds, NULL ids and
  duplicate chunk number are all refused.

### 9.6 Regression (after D2)

| Gate | Result |
|---|---|
| typecheck / `lint:boundaries` / build | PASS |
| db / shared / web / audience-core | 95 / 4 / 40 / 86 passed |
| audience-infra | 44 passed, 6 skipped (opt-in scale) |
| API / worker | 373 passed, 1 skipped / 8 passed |
| E2E | 24 passed, twice |
| `git diff --check` | clean |

---

## 10. Bitmap exact count — implementation and evidence

### 10.1 Files

| Layer | Change |
|---|---|
| [schema.prisma](../../packages/db/prisma/schema.prisma) | Models `AudienceCountState`, `AudienceCountContactSeq`, `AudienceCountSourceChunk`, `AudienceCountDeadChunk` (+ relations on `Contact`, `Workspace`). `bits` is `String @db.VarBit`. |
| Migration [20261013000000_audience_count_bitmap](../../packages/db/prisma/migrations/20261013000000_audience_count_bitmap/migration.sql) | **Part A** generated by `prisma migrate diff` (4 tables, 2 unique indexes, 4 FKs). **Part B** hand-written: CHECKs, sequence, forced RLS (InitPlan), grants, maintenance functions, triggers (`ENABLE ALWAYS`), ownership and EXECUTE, every existing workspace INVALID. Additive: no existing table, column, grant or policy changed or dropped. |
| [bootstrap.ts](../../packages/db/scripts/bootstrap.ts) | Role `workeasy_audience_count` (NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT; `workeasy_owner` a member). DDL guard event triggers `audience_count_ddl_guard` / `audience_count_drop_guard` (superuser-installed; function owned by `workeasy_owner`). |
| [db/src/index.ts](../../packages/db/src/index.ts) | `system.workspacesWithCountMaintenance(reconcileBefore, limit)` → `app.audience_count_workspaces_due` (ids and state only). |
| [audience-resolution.ts](../../packages/audience-infra/src/audience-resolution.ts) | `count` = `countWithPath` minus the path: validation first, then ONE statement reading state + source existence + bitmap count; VALID → bitmap, otherwise the unchanged D2 exact query. Option `bitmapCount: false` (tests/benchmarks). |
| [count-bitmap.ts](../../packages/audience-infra/src/count-bitmap.ts) | `rebuildCountBitmap` (online driver: lease, positions, repair list, one position chunk per transaction with try-lock then bounded waits, skip/retry passes, lease renewal, verify + CAS; stage timings), `reconcileCountBitmap`, `gcCountBitmap`, `runCountMaintenance` (rebuild non-valid, reconcile valid ≥ every 24 h, GC, alert). |
| [audience-read-side.ts](../../apps/worker/src/audience-read-side.ts), [worker.module.ts](../../apps/worker/src/worker.module.ts) | `AudienceCountMaintenance` (interval, default hourly tick, no overlapping runs, logs; `alert` field on mismatch / verify failure / error) registered as `AudienceCountMaintenanceJob`. No scheduler framework. |
| Contracts | Audience contract §9.4 (count paths) and §9.6 ("Count bitmap"); [security.md](../security.md) roles and grants. Public `AudienceResolution` API, request and response schemas: **unchanged** (OpenAPI unchanged). |

### 10.2 Design as implemented

The approved design of the readiness documents, with these properties:

- **Data.** `audience_count_state` (state, generation, reason, lease token/expiry, last reconciliation time and
  result), `audience_count_contact_seq` (one global, never reused position per contact), `audience_count_source_chunks`
  (per list/tag and 4,096-position chunk), `audience_count_dead_chunks` (deleted or erased positions). CHECKs: state
  values, lease pair, `length(bits) = 4096`, non-negative chunk/seq.
- **Count.** `Σ bit_count(OR(include) & ~OR(exclude) & ~dead)` read in one statement with the state and the
  existence check; VALID only. Membership and liveness only — consent, subscription, suppression, topics and addresses
  stay live in Eligibility; T0 and capture unchanged.
- **Writers (triggers, writer's transaction).** Statement level on membership INSERT/DELETE and contact INSERT
  (transition tables); row level on contact liveness changes. Shared advisory lock per (source, chunk) / dead chunk in
  ascending order (C1 ordering); commutative `|` / `& ~`. 40P01, 40001 and 55P03 are re-raised (existing bounded
  retries apply); any other maintenance failure marks the workspace INVALID and the write succeeds. While a workspace
  is not VALID, rows without a position are skipped (the rebuild repairs them; verification gates VALID). Writes outside
  the matching tenant context, membership UPDATE, contact hard DELETE and TRUNCATE invalidate the affected workspaces.
  `ENABLE ALWAYS`; DDL guard.
- **Rebuild.** `begin_rebuild` (lease; generation + 1; REBUILDING) → `positions_missing` → `fill_positions` (keyset batches, only if needed) →
  `repair_list` → per position chunk `repair_chunk` in its own transaction → `finish_rebuild` = whole-bitmap verify +
  CAS on generation **and** lease token. A second rebuilder gets `busy`; an expired lease is taken over and the stale
  owner's finish is refused.
- **Reconciliation.** VALID only; verify in one statement; difference → INVALID (+ result recorded); time and result
  recorded only if the generation did not move meanwhile.
- **GC.** All-zero rows deleted under their chunk lock (try-lock) with a re-check; returns `{deleted, busy}`.

**Refinements found by measurement during this implementation** (no change to the approved protocol: same lock keys,
same shared/exclusive roles, same one-short-transaction-per-chunk rule, same verify + CAS):

| # | Prototype | Implemented | Why (MEASURED) |
|---|---|---|---|
| R-1 | contact INSERT trigger per row | per statement (transition table), positions allocated in id order | bulk creates/imports and owner loads: one pass per statement |
| R-2 | `fill_seq` scanned for unpositioned contacts per batch | keyset pass over `(org_id, workspace_id, id)` | the per-batch anti-join was quadratic |
| R-3 | repair per **(source, chunk)** with `EXISTS` | repair per **position chunk**: try-lock the dead key and every candidate (source, chunk) key of that chunk in ascending order (all or nothing), then derive every source's bits in one probe pass over the chunk's ≤ 4,096 positions; only locked rows are written; hash/merge joins off and custom plans | the planner turned `EXISTS` into a hashed sub-plan reading the **whole source** per chunk: 1M online rebuild under writers **928 s** (0.4 s per (source, chunk), IO-bound). A generic plan of the first rewrite took > 10 s per chunk. After R-3: **79 s** (§10.5) |
| R-4 | position pass on every rebuild | one hash anti-join first (`positions_missing`); the keyset pass runs only if some contact lacks a position; position batches get an explicit 120 s statement timeout (10,000 per batch) | at 5M the pass took 955 s although every contact had a position, and one 20,000 batch hit the runtime's 15 s statement timeout |

Lock waits in later passes (`lockWaitMs` 200 ms) stay below `deadlock_timeout` (1 s), so a cycle with a writer ends by
the rebuild's lock timeout, never by aborting the writer; transient lock conflicts on a chunk count as busy.

### 10.3 Security matrix (MEASURED; [packages/db/test/audience-count-bitmap.test.ts](../../packages/db/test/audience-count-bitmap.test.ts), 16 tests)

| Check | Result |
|---|---|
| `workeasy_audience_count` attributes | NOLOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE, NOCREATEDB, NOINHERIT; no CREATE on `app`/`public`; members: `workeasy_owner` only (not app, not reporting) |
| Table privileges (4 roles × 4 tables × 7 privileges) | app: SELECT on state, source and dead chunks **only**; maintenance role: exactly its write set; **reporting and identity: none** |
| Maintenance role on other tables | SELECT on `contacts`, `list_memberships`, `contact_tags` only |
| Runtime role direct writes | DELETE / TRUNCATE on all 4 tables, UPDATE state, INSERT/UPDATE chunks, SELECT positions, `nextval` → all **42501** |
| Forced RLS | all 4 tables: enabled + forced, `FOR ALL`, identical InitPlan predicate for USING and WITH CHECK |
| Cross-workspace / cross-tenant reads | workspace B sees only its own state and chunks; org-only context and a mismatched org/workspace pair see nothing |
| Functions | ≥ 25 `app.audience_count_*`: all data-touching ones SECURITY DEFINER; all `search_path = pg_catalog, …` pinned; **none executable by PUBLIC**; owner = `workeasy_audience_count` except the 5 cross-workspace ones (invalidate-workspaces, TRUNCATE / hard-delete / new-workspace triggers, discovery) owned by `workeasy_owner` |
| EXECUTE for app | exactly the 11 maintenance entry points; reporting / identity: 0; internal invalidation and verify functions refused (42501) |
| Confinement of every entry point | called in A: repair of B's chunk reads/writes nothing of B; reconcile, finish with a foreign token, renew, GC change nothing of B; B still verifies |
| Rebuild authorization | `begin_rebuild` without workspace context refused (42501); discovery returns ids + state only |
| Triggers | 13 triggers, all `ENABLE ALWAYS` (`A`) |
| DDL guard | both event triggers enabled; app cannot disable a trigger (42501); owner DISABLE/ENABLE → every workspace INVALID, generation bumped, reason `DDL: ALTER TABLE …` |
| Out-of-context writes | owner DELETE/INSERT of memberships invalidates only that workspace; a runtime session writing another workspace's rows is refused by RLS (42501) |
| TRUNCATE / hard DELETE | invalidate |
| Maintenance failure | (privilege revoked mid-flight) write succeeds, workspace INVALID with reason `maintenance failed: 42501 …` |
| Lock timeout in a writer | 55P03 re-raised to the caller; bitmap stays VALID |
| New workspace | starts VALID (empty) |

Existing suites: InitPlan policy set now asserted on 12 tables; security-invariant suite passes (every public table
forced RLS, runtime roles cannot bypass RLS, no tenant-key UPDATE).

### 10.4 Correctness (MEASURED)

Oracles: the pure core reference (owner read + `captureMembers`) and an **independent SQL count** (EXISTS / NOT EXISTS
over contacts — no set algebra, never the bitmap). Every bitmap count is also compared with the exact production query.

| Test ([audience-count-bitmap.test.ts](../../packages/audience-infra/test/audience-count-bitmap.test.ts), [API](../../apps/api/test/audience-count-bitmap.test.ts), [worker](../../apps/worker/test/audience-read-side.test.ts)) | Result |
|---|---|
| State routing | INVALID, REBUILDING (live lease) and missing state row → exact path; VALID → bitmap; both equal the references |
| Validation | missing source, conflicting and empty definitions: same error on both paths; a soft-deleted list (chunks still present) is `AUDIENCE_SOURCE_NOT_FOUND` |
| Cap | `cap: 10` → `{10, capped: true}` on both paths |
| Randomized: 24 workspaces (some > 4,096 positions), 4 random definitions each (one/multiple/overlapping lists, tags, exclusions), 6 rounds × 3 random writes (add, remove, create with membership, soft delete, restore, erase, move) through the runtime role | **0 mismatches** (bitmap = core = independent SQL = exact query) at every check; state stays VALID; each final reconciliation `ok` (**no false invalidation**) |
| API mutation matrix, 21 steps through the real routes (create with lists/tags, list member add/remove, tag/untag, bulk add/remove/tag/untag/suppress/unsubscribe/delete, delete, restore, erase, PATCH, archive, CSV import with lists/tags, tag delete, list delete) | after every step: VALID, answered by the bitmap, equal to the independent count; final reconciliation clean |
| List/tag deletion + GC | other counts exact; GC deletes the zero chunks, repeatable (second pass `{0, 0}`), another workspace's GC deletes nothing; reconciliation clean |
| GC vs a writer | a chunk held by a writer is skipped (`busy`), GC returns in < 2 s, a later run deletes it |
| Rebuild from empty | `published`, 0 chunks; an existing empty list counts 0 |
| Writes at a chunk boundary during the rebuild | published; exact |
| Concurrent rebuild requests / lease | two concurrent rebuilds under a live lease → both `busy`; after expiry exactly one publishes; the stale owner's finish → `superseded`, state stays VALID |
| Generation mismatch | an invalidation committed during the rebuild → `superseded`, INVALID although verification passed; the next rebuild publishes |
| Writers during rebuild (12k contacts, 3 writers) | published, **0 writer errors**, reconciliation clean, counts exact |
| Failure injection — 6 stages (below) | never served while stale; deterministic recovery |
| Corruption — 7 kinds | each detected (VALID → INVALID), counts exact meanwhile, maintenance run → VALID and exact |
| Reconciliation scheduling | not due within 24 h (timestamp unchanged); due after 25 h → reconciled, time and result recorded; a mismatch → exactly one `audience_count_reconcile_mismatch` alert with org/workspace ids, then rebuilt to VALID |
| Worker job | INVALID workspaces rebuilt (`rebuilt: 2`); overlapping run returns `null`; nothing due afterwards; stops cleanly |
| Migration with data | §10.7 |

**Failure injection** (9,000-contact workspace; before each stage a guard-bypassing corruption was detected by
reconciliation → INVALID; a writer ran during the failed rebuild and during recovery):

| Stage (crash point) | State after the crash | Served while stale? | Recovery | Writer errors | Generation |
|---|---|---|---|---|---|
| after `begin_rebuild` | REBUILDING | no (exact path, exact counts) | published, reconciliation clean | 0 | new > failed |
| after the first chunk | REBUILDING | no | published | 0 | new > failed |
| halfway | REBUILDING | no | published | 0 | new > failed |
| after the last chunk | REBUILDING | no | published | 0 | new > failed |
| during final verification (finish transaction dies) | REBUILDING | no | published | 0 | new > failed |
| right after VALID | VALID (correct) | n/a | published | 0 | new > failed |

**Corruption kinds detected:** flipped source bit, missing source chunk, extra source chunk, stale chunk, cleared dead
bit, stale dead bit, lost position.

### 10.5 Rebuild: online vs blocking (MEASURED; 4 concurrent writers through the runtime role)

Writers: membership add/remove of 50 contacts, contact create + membership, soft delete / restore. "Blocking" = the
same repair in ONE transaction holding every chunk lock to commit (comparison only; not used in production).

| Size | Rebuild | Duration | Writer p50 / p95 / p99 / max (ms) | Writer errors |
|---|---|---|---|---|
| 100k | idle (no writers) | 13.0 s (positions 9.1 s — first rebuild only) | — | — |
| 100k | **online** | 4.2 s | 8.1 / 27.9 / 54.3 / 99 | **0** |
| 100k | blocking | 2.5 s | 7.6 / 13.2 / 21.2 / **1,704** | 0 |
| 500k | idle | 116 s (positions 85.7 s) | — | — |
| 500k | **online** | 33.2 s | 8.4 / 15.2 / 22.8 / 129 | **0** |
| 500k | blocking | 37.6 s | 9.8 / 39.9 / 70.2 / **14,074** | **4** (P2028 transaction timeout) |
| 1M | idle | 147 s (positions 114 s) | — | — |
| 1M | **online** | **79.0 s** (repair 46.7 s) | 4.2 / 20.5 / 33.1 / 401 | **0** |
| 1M | blocking | 60.0 s | 4.2 / 10.9 / 31.1 / **15,107** | **8** (7 × 57014 statement timeout, 1 × P2028) |
| 1M (replicate) | idle / **online** / blocking | 152 s / **97.9 s** / 70.3 s | online 4.2 / 24.9 / 41.6 / 818; blocking max **15,085** | online **0**; blocking **8** (57014) |
| 1M (before R-3) | online | 928 s | 4.7 / 29.8 / 42.7 / 4,365 | 0 |
| 5M | idle, first install | 1,064 s (positions 909 s, repair 124 s, verify + CAS 29 s) | — | — |
| 5M (before R-4) | **online** | 2,228 s (positions pass 955 s although complete) | 4.5 / 29.3 / 41.1 / 923 | **0** (1.22M writes) |
| 5M | **online** (final code) | **432 s** (position check 23 s, repair 342 s, verify + CAS 63 s) | 4.3 / 27.2 / 37.2 / 3,316 | **0** (252k writes) |

Blocking was not run at 5M (comparison only; at 500k and 1M it already stalled writers up to 15 s). The single 3.3 s
writer outlier at 5M occurred while the rebuild's whole-bitmap verification (63 s of sequential reads) competed for
the 128 MB buffer pool; INFERRED I/O stall, not a lock wait (writers wait at most for one chunk's short repair
transaction, and no writer hit a timeout or an error).

Writer baseline without a rebuild: p99 7–46 ms (5M: p99 8.1 ms, max 95 ms). **Deadlocks:** `pg_stat_database.deadlocks` for the test database
stayed **0** across the whole series (and every suite); no writer saw 40P01; no lock timeout (55P03) reached a writer
in the online runs. The blocking errors are writers stalled behind held chunk locks (statement / transaction
timeouts), not deadlocks. INFERRED: online rebuild bounds writer impact; blocking rebuild does not.

### 10.6 Performance gates (MEASURED, final code)

Counts are the bitmap path after an online rebuild; "exact path" is the D2 query on the same data.

| Gate | Target | 100k | 500k | 1M | 5M |
|---|---|---|---|---|---|
| **Count (bitmap)** p95, 3 definitions | 1M < 1 s; 5M completes | 7.6–16.4 ms | 4.5–12.1 ms | **8.0–18.7 ms** | **9.6–19.5 ms** (13.1–45.2 ms in the run before R-4) |
| Count (exact path, for reference) | — | p95 0.32–0.39 s | p95 0.60–0.64 s | p95 1.2–8.0 s | **times out at 15 s** (P2010), full definition |
| **Bitmap = independent SQL** (3 definitions per size, both runs) | 0 mismatches | 0 | 0 | 0 | **0** — uncapped bitmap 5,047,663 / 1,024,675 / 531,386 = independent; the API returns 5,000,000 `capped` for the first |
| **Capture** (D2) | 1M ≤ 10 s; 5M ≤ 60 s | 0.17–0.20 s | 1.09–1.99 s | **2.47–4.77 s** | quiet: **14.9 / 15.4 / 30.3 s**; contended (autovacuum + checkpoints of the just-seeded tables): 23.6 / 38.7 / **62.5 s** |
| Capture exact compare (missing / extra / duplicates / order) | 0 | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 | **0/0/0/0** (4,996,342), both runs |
| **Page** p95 (random positions, 1,000 ids) | < 50 ms | 9.2–12.1 ms | 8.2–19.1 ms | 10.9–18.9 ms | quiet **7.6 ms**; contended 49.6 ms |
| **Eligibility** p95, batch 1,000 | < 250 ms | 73.4 / 179.5 / 232.6 ms (three runs; the highest under background load) | — | — | — |
| Reconciliation (whole-bitmap verify) | — | 0.3–0.8 s | 1.1–1.5 s | 2.5–2.7 s | 38.7–55.8 s |
| Storage | — | 190 source + 27 dead chunks | 918 + 131 | 1,831 + 261 (source table 10.7 MB; positions 260 MB) | 9,105 + 1,299 (source table 24.9 MB; positions 742 MB) |

**5M capture gate, all samples recorded.** The first final-code 5M run measured 23.6 / 38.7 / **62.5 s**. The server
log shows that run's captures started right after the 46-minute seed, during WAL-triggered checkpoints and three
autovacuum workers on `list_memberships`, `contacts` and `contact_identities`; the 62.5 s statement overlapped
both. The capture statement reads and writes no bitmap object, and the bitmap tables were empty at that moment
(positions are assigned later in that run), so INFERRED: host contention, not a bitmap regression. Re-measured on the
same data after `VACUUM (ANALYZE)` of the seeded tables: **14.9 / 15.4 / 30.3 s**, exact compare 0/0/0/0. Earlier D2
runs: 31.9 / 44.9 / 40.7 s and 43.1 s. Gate (≤ 60 s): **met in a quiet state; exceeded once (62.5 s) under concurrent
maintenance I/O on this laptop.**

**Crash recovery at 5M (real, not injected).** The host restarted during that run's first 5M rebuild (position fill,
4.43M of 5.32M contacts positioned). Found afterwards: REBUILDING, generation 5, lease expired. The count was answered
by the exact path (not served while stale); a normal rebuild took over the expired lease and published generation 6 in
433 s (positions 296 s for the rest); counts then matched the independent SQL.

### 10.6a Over-limit at full scale (MEASURED; `AUDIENCE_SCALE_LIMIT`)

The D2 run never exceeded the cap (4,997,344). This run seeded 5,336,323 contacts so that the audience is **over** the
limit, verified by the independent count, not by the bitmap.

| Check | Result |
|---|---|
| Members (independent SQL) | **5,016,144** (> 5,000,000) |
| Bitmap rebuild (first, idle) | published; 1,304 chunks; 1,744 s (positions 1,500 s — first rebuild only) |
| `count` | `{ count: 5,000,000, capped: true }`, **path bitmap**, 62 ms |
| `capture` | **`AUDIENCE_TOO_LARGE`** after 30.6 s |
| Left behind | **0** snapshot rows, **0** chunk members for the key |
| Bitmap state | unchanged by the rejected capture (VALID, generation 4 before and after) |

The lowered-limit atomic rejection test (audience-infra) is kept and passes.

### 10.7 Migration (MEASURED)

- Part A = `prisma migrate diff` output; after applying all migrations to a fresh database, `migrate diff` to
  `schema.prisma` is **empty**.
- **Empty database:** dev and test databases rebuilt by drop + bootstrap + `migrate deploy` (unreleased migration).
- **Existing database with data** (scratch database at the pre-bitmap migration state, 2 orgs × 5,000 contacts, list and
  tag memberships, 300 deleted, a chunked snapshot each): applied cleanly; snapshot rows, chunk rows, an md5 over every
  chunk's ids, contact and membership counts **identical before and after**; `audience_snapshot_members` **kept**;
  every workspace INVALID (`installed; awaiting first verified rebuild`); a rebuild through the runtime role published
  VALID with bitmap = exact (2,875 = 2,875; 2,811 = 2,811). Scratch databases dropped.
- The migration refuses to run without the maintenance role (bootstrap first).

### 10.8 Regression (MEASURED; fresh databases: drop + bootstrap + migrate deploy, then in order)

| Gate | Result |
|---|---|
| `pnpm typecheck` | PASS |
| `pnpm lint:boundaries` | PASS (281 modules, 1,137 dependencies, 0 violations) |
| `pnpm build` | PASS |
| `pnpm test` — db | **112 passed** (+17: bitmap security matrix 16, InitPlan policy set) |
| — shared / web / audience-core | 4 / 40 / 86 passed |
| — audience-infra | **63 passed** (+19 bitmap), 7 skipped (opt-in scale) |
| — API | **374 passed** (+1 API write matrix), 1 skipped (opt-in) |
| — worker | **9 passed** (+1 maintenance job) |
| `pnpm test:e2e` | run 1: **24 passed**; run 2: **24 passed** |
| `git diff --check` | clean |

`pg_stat_database.deadlocks` stayed 0 for the test database through the scale series and the suites.

**Closure re-run (2026-10-07, fresh databases):** security suites first (security-invariants, audience-count-bitmap, audience-snapshots: 3 files, **58 passed**), then typecheck PASS, `lint:boundaries` PASS (281 modules, 1,137 dependencies), `pnpm test` db **112** / shared **4** / web **40** / audience-core **86** / audience-infra **63 passed, 7 skipped** / API **374 passed, 1 skipped** / worker **9**, build PASS, E2E run 1 **24 passed**, run 2 **24 passed**, `git diff --check` clean — identical to the run above.

### 10.9 Limitations and observations

1. **Reference hardware not available** (C4). All numbers are from this laptop.
2. **First rebuild after installation** must give every existing contact a position: 114 s for 1.06M contacts and
   909 s for 5.3M (idle, MEASURED); later rebuilds skip this (one 23 s check at 5M). Counts use the exact path meanwhile.
3. **While a 5M workspace is INVALID or REBUILDING, its count is not available**: the exact fallback still times out at
   15 s for a 5M audience (D2, unchanged). An online rebuild at 5M takes ~7 min under writers (MEASURED). The count is
   never wrong — it fails with the existing timeout error rather than returning an approximation.
4. 5M capture: one sample of 62.5 s under concurrent autovacuum/checkpoint I/O (§10.6).
5. The bitmap is not served while a workspace is INVALID/REBUILDING; any guard-bypassing corruption (owner DML on the
   bitmap tables) stays VALID until the next reconciliation (≤ 24 h + run time), as accepted by the readiness decision
   (O5); it is alerted.
6. The runtime role can read the rebuild token (SELECT on state). INFERRED harmless: publishing still requires
   verification + generation CAS, and the runtime is trusted server code.
7. Benchmark seeding note (test harness only): with stale "0 rows" statistics on `contacts`, PostgreSQL's cached FK-check
   plan became a per-row sequential scan (50k identities 57 s); the benchmark seed now runs `ANALYZE contacts` first.
   Not a bitmap behaviour.

## 11. G2 decision

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | Exact bitmap count meets its performance gate | **MET** — 1M p95 8.0–18.7 ms (< 1 s); 5M completes, p95 9.6–19.5 ms | §10.6 |
| 2 | Correctness independently verified | **MET** — 0 mismatches against independent SQL at 100k / 500k / 1M / 5M (uncapped at 5M), randomized + API matrix + corruption + failure injection | §10.4, §10.6 |
| 3 | Online rebuild production-safe | **MET** — never blocks writers: 0 writer errors, 0 deadlocks, 0 lock timeouts at every size; writer p99 ≤ 54 ms; max 3.3 s once at 5M (I/O); blocking rebuild for comparison stalls writers 15 s with timeouts | §10.5 |
| 4 | Generation protection verified | **MET** — CAS on generation + lease token; invalidation during rebuild, stale owner, takeover, 6 failure stages, a real host crash | §10.4, §10.6 |
| 5 | Reconciliation verified | **MET** — 7 corruption kinds detected, no false invalidation, ≥ every 24 h in the worker, timestamp + result recorded, alert | §10.4 |
| 6 | Security / RLS passes | **MET** — 16-test matrix + existing invariants | §10.3 |
| 7 | Regression passes | **MET** | §10.8 |
| 8 | D2 remains within its performance gates | **MET** (quiet state; one 62.5 s outlier retained, classified as environmental contention) — 1M capture ≤ 4.8 s; 5M capture quiet 14.9–30.3 s, but 62.5 s once while autovacuum and checkpoints of the freshly seeded 5M tables ran; page p95 ≤ 19.1 ms (quiet 5M 7.6 ms; contended 49.6 ms); eligibility p95 73–233 ms | §10.6 |

**Review outcome (2026-10-07).** The open items of the review were decided: criterion 8 is accepted with the
outlier classified as environmental contention (below), and the temporary unavailability of a 5M count while its
bitmap is INVALID/REBUILDING (existing timeout error, never an approximation) is accepted as a known limitation
(§10.9).

> The 62.5 s 5M capture measurement is retained as an observed outlier. Server evidence showed WAL checkpoint and
> concurrent autovacuum activity during the measurement. Subsequent controlled quiet-state measurements were 14.9 s,
> 15.4 s and 30.3 s, all within the ≤ 60 s gate. The capture path did not access bitmap tables during the outlier.
> Therefore the outlier is classified as environmental contention rather than a product performance regression.

The 62.5 s sample stays in §10.6 with every other sample; no measurement was removed or replaced.

**Decision: G2 PASS — CLOSED.** All eight criteria are met (criterion 8 with the recorded, explained outlier).
**Official progress: 35 %.** **Phase 6.3: COMPLETE.** **Phase 6.4: NOT STARTED.** Nothing committed.

### 11.1 Final scorecard

| Area | Result | Evidence |
|---|---|---|
| **C1** | **PASS** | Ordered (ascending contact-id) membership writes and bounded deadlock/serialization retry; unordered control 36 deadlocks → ordered 0; 20 concurrent API requests 0 deadlocks (§3) |
| **D2** | **PASS** | 1M capture 2.47–4.77 s (≤ 10 s); 5M quiet-state capture 14.9 / 15.4 / 30.3 s (≤ 60 s); 62.5 s environmental outlier retained and explained; exact compare 0/0/0/0 at 100k / 500k / 1M / 5M (§10.6) |
| **Bitmap** | **PASS** | Migration `20261013000000_audience_count_bitmap`, 4 tables, maintenance functions and triggers, bootstrap role + DDL guard, adapter and worker job (§10.1–§10.2) |
| **Exact count** | **PASS** | Exact, never approximate: 1M bitmap p95 8.0–18.7 ms (< 1 s); 5M p95 9.6–19.5 ms (completes); > 5M returns 5,000,000 `capped` (5,016,144 members, 62 ms); independent SQL comparison 0 mismatches (§10.6, §10.6a) |
| **Online rebuild** | **PASS** | Writers keep operating at every size; 0 writer errors, 0 deadlocks, 0 lock timeouts; rebuild output verified (whole-bitmap verify + reconciliation clean) (§10.5) |
| **Generation safety** | **PASS** | Invalidation during rebuild → not published; stale rebuilder finishing late → refused; lease takeover; six failure-injection stages; real host crash mid-rebuild recovered (§10.4, §10.6) |
| **Reconciliation** | **PASS** | 7 corruption kinds detected → INVALID → repaired → VALID; no false invalidation; periodic worker execution (≥ every 24 h); `audience_count_reconcile_mismatch` alert; timestamp + result recorded (§10.4) |
| **GC** | **PASS** | Workspace-scoped; try-lock (skips chunks a writer holds, never queues); re-check before delete; repeatable; returns and logs `{deleted, busy}` (§10.4) |
| **Security** | **PASS** | Forced RLS (InitPlan predicate) on all bitmap tables; tenant confinement of every entry point; least-privilege grants (runtime read-only, reporting/identity none); SECURITY DEFINER with pinned `search_path`; no PUBLIC execute; DDL guard; security-invariant suite green (§10.3) |
| **Correctness** | **PASS** | Bitmap = independent SQL with 0 mismatches at 100k, 500k, 1M and 5M (uncapped at 5M); randomized (24 workspaces), API write matrix (21 steps), corruption and failure injection (§10.4, §10.6) |
| **Regression** | **PASS** | §10.8 |
