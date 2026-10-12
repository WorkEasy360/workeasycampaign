# Phase 6.3 — Chunked Bitmap Count: Production-Readiness Investigation

> **Final status (2026-10-07): G2 PASS — CLOSED; Phase 6.3 COMPLETE; official progress 35 %.** Statements below that
> G2 is blocked are the status at the time of this investigation. Final evidence and scorecard:
> [phase-6.3-g2-closure.md](phase-6.3-g2-closure.md) §10–§11.
>
> **Implementation follow-up (2026-10-06).** Implemented in production (migration
> `20261013000000_audience_count_bitmap`; role `workeasy_audience_count` and the DDL guard event triggers via
> `pnpm db:bootstrap`). The mutation inventory (§2) is maintained by triggers as designed, and every route is covered
> by an API test (21 write steps, [phase-6.3-g2-closure.md](phase-6.3-g2-closure.md) §10.4). Differences from this
> document: the contact INSERT trigger is statement level; writes outside the matching tenant context, membership
> UPDATE and contact hard DELETE invalidate the workspace; the maintenance functions are owned by the NOLOGIN,
> NOBYPASSRLS role (§3 option), with only cross-workspace invalidation, the TRUNCATE / new-workspace triggers and
> discovery owned by the schema owner. Evidence: g2-closure §10. This document remains the investigation record.

**Status:** investigation record. No production schema, migration, trigger, grant, RLS policy or application code was
changed. All prototypes ran in the disposable `workeasy_test` database, in a `bench` schema with a temporary
`bench_bitmap_maint` role, and were removed afterwards.
**Date:** 2026-10-05.
**Predecessor:** [phase-6.3-count-architecture-decision.md](phase-6.3-count-architecture-decision.md), which recommended
B: ADOPT DERIVED EXACT COUNT.
**Successor:** [phase-6.3-bitmap-online-rebuild-readiness.md](phase-6.3-bitmap-online-rebuild-readiness.md), which
resolves the online-rebuild condition left open here (C3).

**Evidence labels.**

| Label | Meaning |
|---|---|
| **MEASURED** | Observed in this investigation. |
| **INFERRED** | Follows from code or measured facts by reasoning. |
| **ESTIMATED** | Computed from measured numbers. |
| **NOT MEASURED** | No evidence. |

Unlabelled numbers are MEASURED.

**Environment.** Windows 11 laptop (i7-1185G7, 8 GB RAM, NVMe), PostgreSQL 16.15 with `shared_buffers` 128 MB. Every
test ran as the **real runtime login role `workeasy_app`** (NOBYPASSRLS, `statement_timeout` 15 s,
`idle_in_transaction_session_timeout` 30 s) with forced RLS. API tests drove the **real NestJS application in-process**:
real routes, services, Prisma client and import processor.

**Host caveat (MEASURED).** One concurrency run stalled for 838 s. The Windows System log shows Modern Standby entered at
21:07:01 IST and exited at 21:21:09, the exact second the stalled statement completed. That run's wall-clock figure is
excluded. A keep-awake process was used for all later runs.

---

## 1. Executive decision

**APPROVE B WITH CONDITIONS.** The conditions are in §15–16. When this investigation closed, condition C3 (rebuild
without blocking writers) was still open. It was handed to the online-rebuild investigation, which decides it.

- **Correctness.** Every production mutation path was executed through the real API and checked against the production
  exact count and the pure core reference: 0 mismatches.
  - 3 × 658 = 1,974 checks, at K = 16,384, 4,096 and 64.
  - These include 3 × 150 = 450 randomized API operations.
  - Rollback, aborted transaction, savepoint and an injected trigger failure all left the bitmap exact.
- **Security.**
  - The earlier `42501` came from the prototype test issuing `DELETE FROM lists`. The runtime role has never been granted
    that, and production never hard-deletes lists. The trigger path never touches `lists`.
  - The least-privilege design gives the runtime role read-only access to bitmap tables. Writes go only through
    SECURITY DEFINER functions owned by a NOLOGIN, NOBYPASSRLS maintenance role with a pinned `search_path` and no
    PUBLIC EXECUTE.
  - Every cross-tenant probe was refused.
- **Reliability.**
  - Bitmap reads are served only when the workspace state is VALID; otherwise the production exact query runs.
  - TRUNCATE, DDL (including `DISABLE TRIGGER`) and reconciliation mismatches all invalidate.
  - **Unguarded trigger disabling produced a silently wrong count (MEASURED).** The guards closed it.
- **Write cost (MEASURED, interleaved A/B, K = 4,096):**
  - single add-to-list +0.52 ms;
  - 250-row import chunk +29 ms (+13 %);
  - 500-row bulk add +3 ms, bulk remove +2.8 ms, bulk delete +61 ms;
  - erase +1.3 ms.
- **New concurrency behaviour (MEASURED):**
  - Writers to the same (source, chunk) now serialize for the holder's transaction.
  - **A new deadlock** between import list order and erase. It does not corrupt data, but it fails the erase request.
- **Blocking rebuild is not acceptable (MEASURED).** At 1M it took 63–119 s, and writers hit the 15 s statement timeout
  (12 and 24 errors in two runs). This is condition C3.
- **Chunk size: K = 4,096.** K = 65,536 is rejected.

---

## 2. Production mutation inventory

Every path below comes from the repository code. All run as `workeasy_app` inside `inTenant` (`Database.withTenant`) at
READ COMMITTED. Bitmap rows are written by the triggers in §4.

| # | Mutation (entry point) | Transaction | Tables changed | Bitmap trigger | Bitmap rows affected |
|---|---|---|---|---|---|
| 1 | Create contact (`POST /contacts`, `ContactsService.create`) | 1 | `contacts` INSERT ×1; `contact_identities`; `list_memberships` createMany ×1 statement; `contact_tags` createMany ×1; events | contact insert (row); memberships insert (statement) | `contact_seq` +1; one source chunk per listed list or tag |
| 2 | Update contact, subscription, identity add/remove/primary, touch | 1 | `contacts` non-liveness columns | liveness trigger `WHEN` false | none |
| 3 | Soft delete (`DELETE /contacts/:id`) | 1 | `contacts.deleted_at` | liveness | 1 dead chunk |
| 4 | Restore (`POST /contacts/:id/restore`); an erased contact cannot be restored | 1 | `contacts.deleted_at = NULL` | liveness | 1 dead chunk |
| 5 | Erase (`POST /contacts/:id/erase`) | 1 | DELETE `list_memberships` (by contact); DELETE `contact_tags`; DELETE identities; UPDATE `contacts` (`deleted_at`, `erased_at`) | memberships delete ×2 statements; liveness (only if previously live) | ≤ one chunk per list/tag of the contact; 1 dead chunk |
| 6 | List create, update, archive, restore | 1 | `lists` | none | none (archived lists are counted normally) |
| 7 | List delete (`DELETE /lists/:id`) | 1 | DELETE all memberships of the list; soft-delete UPDATE `lists` | memberships delete | every chunk of the list (cleared) |
| 8 | Tag create, update | 1 | `tags` | none | none |
| 9 | Tag delete (`DELETE /tags/:id`) | 1 | DELETE `contact_tags` of the tag; soft-delete UPDATE `tags` | memberships delete | every chunk of the tag |
| 10 | Add members (`POST /lists/:id/members`, ≤ 1,000 ids) | 1 | `list_memberships` createMany (skipDuplicates) | memberships insert | ≤ ⌈1,000 / K⌉-ish chunks of 1 list |
| 11 | Remove members (`DELETE /lists/:id/members`, ≤ 1,000) | 1 | deleteMany | memberships delete | same |
| 12 | Tag or untag one contact (`PUT`/`DELETE /contacts/:id/tags/:tagId`) | 1 | `contact_tags` 1 row | memberships | 1 chunk |
| 13 | Bulk add_to_list, remove_from_list, tag, untag (`POST /contacts/bulk`; ≤ 10,000 per request, by ids ≤ 1,000 or filter) | 1 per 500 contacts | createMany or deleteMany, 500 rows | memberships | chunks of 1 source |
| 14 | Bulk delete (same route) | 1 per 500 | `contacts.deleted_at` ×500 | liveness ×500 (row level) | dead chunks |
| 15 | Bulk unsubscribe, bulk suppress, consent, topics, suppressions | 1 per 500 | `contacts.subscription_*`, `suppressions`, consent tables | none | none (not part of the membership count) |
| 16 | Import chunk (`ImportProcessor.applyChunk`; 250 rows per transaction; one import per workspace by advisory lock; retries 40001, 40P01 and expired transactions up to 3×) | 1 per 250 rows | per row: `contacts` INSERT, identities, `contacts.search_text` UPDATE; then one `list_memberships` createMany **per list in options order**; one `contact_tags` createMany per tag; `contact_imports` | contact insert per row; memberships per statement | 250 `contact_seq` rows; chunks of each listed source |
| 17 | Import, update mode | 1 per 250 | profile UPDATE plus membership adds | memberships | as 16 |
| 18 | Workspace create | 1 | `workspaces` | workspace insert (owner-definer) | state row `valid` (an empty workspace) |
| 19 | Organization delete, consent retention purge, snapshot capture/release/purge | — | organizations, consent events, snapshot tables | none | none |
| 20 | Owner, superuser or out-of-band SQL (migrations, data fixes, TRUNCATE) | — | any | TRUNCATE trigger; DDL event trigger; an owner write without tenant context **fails closed**: `new row violates row-level security policy for table "contact_seq"`, raised inside the trigger (MEASURED, follow-up phase) | all workspaces → INVALID, or the write is refused |

**Paths that do not exist:**
- **No hard delete.** The app role has no DELETE on `contacts`, `lists` or `tags`, and every FK is `ON DELETE RESTRICT`,
  so cascades never fire.
- **No list or tag undelete.**
- **No restore of an erased contact** (`requireLiveContact`).

No code outside the audience module writes memberships or liveness. That was checked for the worker, the campaigns module
and `audience-infra`.

---

## 3. Permission and role analysis

### 3.1 The 42501 (MEASURED)

| Probe as `workeasy_app` | Without prototype | With prototype |
|---|---|---|
| `DELETE FROM lists …` | 42501 permission denied for table lists | 42501 (identical) |
| `DELETE FROM tags …` / `DELETE FROM contacts …` | 42501 | 42501 |
| Production list-delete path (DELETE memberships, then soft-delete UPDATE of the list) | ok | ok |
| Bitmap functions whose source references `lists` or `tags` | — | none |

**Cause.** The previous prototype's correctness probe ran `DELETE FROM lists`. Production grants the runtime role
`SELECT, INSERT, UPDATE(columns)` on `lists`, deliberately without DELETE, because lists are soft-deleted. The error came
from the probe's privilege check, before any trigger ran.

### 3.2 Least-privilege design (MEASURED in the prototype)

| Principal | Privileges |
|---|---|
| `workeasy_app` (runtime) | SELECT on chunk tables and the state table (for the count). EXECUTE only on `reconcile()` and `rebuild()`, which act on the current workspace only. No INSERT, UPDATE, DELETE or TRUNCATE on any bitmap table. No access to `contact_seq`. |
| Maintenance role (prototype: `bench_bitmap_maint`) | NOLOGIN, NOSUPERUSER, **NOBYPASSRLS**, NOINHERIT. SELECT on `contacts`, `list_memberships`, `contact_tags`; nothing on `lists` or `tags`; no write on any public table. SELECT/INSERT on `contact_seq`; SELECT/INSERT/UPDATE on chunk and state tables. **No DELETE anywhere.** |
| Trigger and maintenance functions | SECURITY DEFINER, owned by the maintenance role, `SET search_path = pg_catalog, pg_temp`, every object schema-qualified, `REVOKE ALL … FROM PUBLIC`. |
| Owner-owned (BYPASSRLS) definer functions | Only two, each justified: (1) TRUNCATE invalidation, which has no tenant context and can only be triggered by the owner; (2) creating the state row for a new workspace, whose id is not yet the session's tenant. Plus the DDL event-trigger function (§6). |

- **Why SECURITY DEFINER.** With invoker triggers, the runtime role would need direct write access to the bitmap tables,
  and an application bug or injected SQL could then corrupt its own workspace's bitmap undetected. With definer
  functions, a direct write is refused (MEASURED: 42501).
- **RLS inside the functions.** The functions run as a NOBYPASSRLS role on FORCE RLS tables. Their reads and writes are
  confined to `app.current_org_id()` / `app.current_workspace_id()`, the same GUCs the API sets. Cross-tenant writes
  fail `WITH CHECK` (MEASURED).
- **Trigger EXECUTE.** The runtime role needs no EXECUTE on trigger functions; the triggers still fire (MEASURED in every
  mutation test).

---

## 4. Trigger correctness

**Design.**

| Element | Detail |
|---|---|
| Sequence numbers | `contact_seq` gives one sequence number per contact from a global sequence. There is no per-workspace counter row (the earlier prototype's hot row is removed). |
| `src_chunks` | Keyed by (source_id, chunk): K-bit membership chunks, stored only when non-zero. |
| `dead_chunks` | Keyed by (workspace_id, chunk): bit = deleted or erased. A new live contact needs **no** bitmap write. |
| Count | `Σ bit_count(OR(include) & ~OR(exclude) & ~dead)`, computed in **one statement** together with the state and the production source-existence check (decision M). |
| Membership triggers | Statement level with transition tables. They update (source, chunk) rows in sorted order with commutative `|` / `& ~` on the latest row version (READ COMMITTED re-evaluation), so no update is lost. |
| Contact triggers | Row level: insert (sequence number), and `UPDATE OF deleted_at, erased_at` guarded by a `WHEN` clause that fires only when liveness changes. |
| Internal inconsistency | A missing sequence number or missing chunk sets the workspace INVALID in the same transaction rather than writing a wrong bit. |

**Results (MEASURED).**

| Test (real API unless noted) | Checks | Mismatches |
|---|---|---|
| Mutation matrix: 26 steps covering every path in §2, at K = 16,384 | 208 | 0 |
| Same at K = 4,096 | 208 | 0 |
| Same at K = 64 (small workspaces span dozens of chunks) | 208 | 0 |
| Randomized API sequence: 150 operations × 3 runs, 3 random definitions after each operation | 1,350 | 0 |
| Rollback tests, × 3 runs (below) | 6 × 3 | 0 |
| Reconciliation at the end of each run | — | srcDiff 0, deadDiff 0, seqMissing 0 |

Each check compares three things: the designed count, the production adapter `PrismaAudienceResolution.count`, and the
pure core `captureMembers` over owner-read rows. **Of the 1,974 checks, 947 were numeric counts served from the bitmap;
1,027 were `AUDIENCE_SOURCE_NOT_FOUND` agreements** (definitions that reference deleted lists or tags).

Rollback tests:
- An explicit rollback: the bitmap counted 50 inside the transaction and 501 after rollback, unchanged.
- An aborted transaction (FK error after the trigger had applied changes).
- A savepoint rollback followed by commit.
- An **injected failure inside the bitmap update**, via a CHECK constraint that made the trigger raise. The API returned
  500, memberships stayed at 614 → 614, and the bitmap was unchanged.

---

## 5. Concurrency analysis

**Can two concurrent transactions update different bits in the same chunk safely?** Yes, and without lost updates. The
second writer blocks on the chunk row (or on the per-chunk advisory lock in the online design) until the first commits.
It then applies its commutative bit operation to the latest row version. MEASURED: add+add, add+remove, delete+delete and
delete+restore on one chunk all ended with verify = 0 differences.

**The cost** is new serialization. Measured with T1 holding its transaction for 1 s:

| Interleaving | Today | Bitmap (K = 4,096) |
|---|---|---|
| add + add, same list, same chunk | 7 ms | 1,018 ms |
| add + remove, same list | 2 ms | 1,020 ms |
| two soft deletes, same dead chunk | 4 ms | 1,011 ms |
| delete + restore | 6 ms | 1,008 ms |
| remove + add of the **same** contact | 1,016 ms | 1,041 ms (same as today: unique index) |
| writes to different lists | 6 ms | 10 ms |
| contact creations (no hot row) | — | 11 ms |

At API level the effect disappears, because production transactions are short. The same-chunk and different-list cases
are within noise (MEASURED):

| 8 concurrent API writers (200 single adds) | Same list, same chunk p50 / p95 | 8 different lists p50 / p95 |
|---|---|---|
| Today | 71 / 114 ms | 86 / 102 ms |
| K = 4,096 | 69 / 103 ms | 67 / 81 ms |

API add/remove on the same list during an import: p50 17 ms, max 42 ms, 0 errors.

**Deadlock (MEASURED, new).** An import adds to lists one statement per list, in **options order**. An erase deletes
all of a contact's memberships in one statement, and the trigger locks chunks in **sorted** order. When an import's
options list Z before X and Z > X, the erase is aborted with **40P01**. Today the same interleaving succeeds (memberships
are independent rows). No corruption results (verify = 0), but an API erase is not retried. **Condition C1** requires
deterministic source order in every multi-source writer (sort list and tag ids in the import loops) and a 40P01 retry in
the API transaction wrapper.

**Other cases (MEASURED, 0 mismatches):**
- List delete racing a membership insert into the same list: the insert lands in a soft-deleted list. That is an existing
  application race; the bitmap matches the memberships, and the count reports the source as not found.
- Two imports in one workspace: the second `start` is refused with 409 (existing lock).
- Reconciliation during writes: 0 false mismatches in 25 runs × 2.
- Rebuild during writes: correct, but writers were blocked for its whole duration (§9).

**Can a rebuild race with a trigger update?** Not with a lock protocol. Without one, a rebuild can lose a concurrent
delta (INFERRED: `INSERT … ON CONFLICT DO UPDATE SET bits = EXCLUDED.bits` overwrites with values computed from an older
snapshot). The blocking design (per-workspace exclusive lock) is correct but blocks writers (§9). The per-chunk online
design is in the successor document.

---

## 6. Validity state machine (as designed here; refined in the successor)

States: **VALID**, **INVALID**, **REBUILDING**. A missing state row is treated as INVALID.

| Event | Transition | Evidence |
|---|---|---|
| Install or migration | all existing workspaces → INVALID | MEASURED |
| New workspace | → VALID (empty) | MEASURED |
| Trigger detects an internal inconsistency | → INVALID, same transaction | design |
| Trigger raises an unexpected error | the user's write aborts; nothing changes | MEASURED (injected) |
| TRUNCATE of contacts, memberships or tags | all → INVALID | MEASURED |
| DDL on audience tables (ALTER TABLE incl. DISABLE/ENABLE TRIGGER, CREATE/DROP TRIGGER) | all → INVALID (event trigger) | MEASURED |
| `session_replication_role = replica` (superuser) | triggers still fire (`ENABLE ALWAYS`) | MEASURED |
| Reconciliation mismatch | → INVALID | MEASURED |
| Rebuild | INVALID → REBUILDING → VALID only after verification | MEASURED |
| Crash or restart | state is transactional; unchanged | MEASURED |
| Restore from backup | physical/PITR and single-snapshot `pg_dump` are consistent; a partial or data-only restore must invalidate all workspaces (runbook) | INFERRED |
| Failover to a physical replica | same WAL, so consistent | INFERRED |

**Silent-staleness hole (MEASURED).** Without the event trigger, an owner ran `DISABLE TRIGGER`, the app wrote 100
memberships, and the trigger was re-enabled. The state stayed VALID and the count returned **200,000 instead of
200,100**, through the bitmap. Reconciliation detected it (srcDiff 19) and set INVALID. With the event trigger, the
`DISABLE TRIGGER` statement itself set INVALID and every count was correct. **Condition C2**: the event trigger,
`ENABLE ALWAYS` triggers, the TRUNCATE trigger and scheduled reconciliation are mandatory.

---

## 7. Reconciliation design

- **What it compares.** `verify()` compares every stored chunk with a fresh derivation from the membership and contact
  tables, in **one statement** (one MVCC snapshot, no locks). It also counts contacts without a sequence number.
- **Outcome.** Equality means the bitmap is exact. A mismatch sets INVALID.
- **Cost (MEASURED).** 26 s at 1M on this host, under the maintenance function's `work_mem` of 128 MB.
- **Concurrent writes.** Safe (MEASURED: 0 false positives, 50 runs).
- **Cadence, batching, locking, failure handling** and the sequence diagram are in the successor document §8.

---

## 8. Fallback design

The count path is `AudienceResolution.count`, behind the adapter's existing definition validation:

```text
definitionErrors(def)                          → error (unchanged)
one statement: state, existence (decision M), bitmap value
  missing source                               → AUDIENCE_SOURCE_NOT_FOUND (unchanged)
  state = VALID                                → bitmap count
  state ≠ VALID or missing                     → production COUNT_SQL (exact, runtime 15 s timeout)
  exact query fails                            → the same error the API returns today (no stale, cached,
                                                  approximate or estimated value is ever returned)
```

**Degraded mode = today's behaviour.** While a workspace is not VALID, a 1M count takes about 7 s and a 5M count can
time out, exactly as the exact query does today (measured in the predecessor documents). The public API and the contract
are unchanged.

**Validation must come first (MEASURED, harness lesson).** A test harness that skipped `definitionErrors` returned a
number for a definition the production adapter rejects (`AUDIENCE_DEFINITION_INVALID`: the same list included and
excluded). The bitmap path must sit **inside** the adapter, after the existing validation.

---

## 9. Failure recovery

| Scenario | Bitmap afterwards | State | Recovery | Evidence |
|---|---|---|---|---|
| PostgreSQL restart with a writer open (trigger already applied) | exact (writer rolled back) | unchanged (VALID) | none | MEASURED |
| Client process crash mid-transaction | exact | VALID | none | MEASURED |
| Trigger exception | exact (whole write rolled back) | unchanged | none; the API returns 500 | MEASURED |
| Blocking rebuild killed (`pg_terminate_backend`) | partial work rolled back | REBUILDING (committed before) → exact path serves | rerun the rebuild (5.3 s at 300k) | MEASURED |
| Reconciliation killed | unchanged | unchanged | rerun | MEASURED |
| Install fails midway (single transaction) | nothing installed | — | rerun; app writes unaffected | MEASURED |
| Installed, not yet backfilled | empty | INVALID → exact path | backfill (12.2 s at 300k) | MEASURED |
| First count after restart (300k workspace) | — | — | 86 ms, then ~3 ms | MEASURED |

---

## 10. Write performance

### 10.1 Interleaved A/B at SQL level

Method:
- **Statement shapes:** exactly the production services' statements.
- **Workspace:** 1M contacts.
- **Rounds:** 12 interleaved rounds, triggers off (A) and on (B), with alternating order.
- **Samples:** each one a rolled-back transaction.
- **Values:** p50 in ms; WAL = median bytes per sample.

| Operation | Today | K = 4,096 | K = 16,384 | K = 65,536 |
|---|---|---|---|---|
| Single add-to-list | 0.25 | 0.77 (+0.52); WAL 424 → 1,272 B | 0.83 (+0.56); WAL 1,832 B | 0.88; WAL **9,928 B** |
| Bulk add chunk (500) | 12.7 | 15.7 (+3.0) | 18.9 (+6.3) | 31.6 (+19.6) |
| Bulk remove chunk (500) | 3.7 | 6.5 (+2.8) | 20.3 (+16.6) | 23.2 (+19.7) |
| Bulk delete chunk (500) | 14.4 | 75.7 (+61) | 57.8 (+45) | **663.7 (+650)** |
| Single soft delete / restore | 0.46 / 0.27 | 0.58 / 0.45 | 0.60 / 0.46 | 1.58 / 1.58 |
| Erase (memberships + tags + contact) | 0.92 | 2.26 (+1.34); WAL 1.1 → 4.3 KB | NOT MEASURED (harness picked a contact with no memberships) | NOT MEASURED |
| Import chunk (250 rows, 2 lists + 1 tag) | 228 | 258 (+29, +13 %); WAL +31 % | 267 (+31) | 295 (+99) |

**Interpretation.**
- **Imports:** the end-to-end chunk interval of a real API import is 2.1–5.8 s on this host (MEASURED, W2). Adding 29 ms
  per chunk is about 1 % of import time (ESTIMATED).
- **Bulk requests:** a 10,000-contact request is 20 transactions of 500, so it adds about 60 ms (add/remove) or about
  1.2 s (delete) (ESTIMATED).
- **Bulk delete** is the most expensive case: 500 row-level liveness triggers per transaction.

### 10.2 API-level runs (single runs; machine noise dominates)

API runs on a 1M workspace, today versus each K, measured:
- single add latency and WAL, and single add at SQL level;
- a real 2,500-row import, with per-chunk intervals, WAL and PostgreSQL CPU;
- bulk add of 1k, 10k, 50k and 200k, and bulk remove of 10k and 50k, through the real bulk API;
- single soft delete, restore, erase, and a 10k bulk delete;
- 8 concurrent writers.

Differences between modes were inside run-to-run variance. For example, single add at SQL level was 18 ms p50 in one
4,096 run against about 1.7 ms in every other run, and import chunk p95 ranged from 3.4 s to 26.7 s. **WAL record
counts** were the stable signal:

| Operation | Today | K = 4,096 | K = 16,384 |
|---|---|---|---|
| Import (WAL records per chunk) | 15,707 | 14,980 | 16,024 |
| Bulk add 50k (WAL records) | 504,307 | 554,164 | 560,669 |
| Bulk delete 10k (WAL records) | 125,327 | 143,685 | 159,547 |

PostgreSQL CPU per operation was within noise. The raw per-mode results were in the disposable harness output and are
summarized here.

### 10.3 Storage (MEASURED, 6.43M contacts across 1M and 5M workspaces)

| | K = 4,096 | K = 16,384 | K = 65,536 |
|---|---|---|---|
| Source chunks | 13.6 MB (19,736 rows) | 7.7 MB | 6.9 MB |
| Dead chunks | 1.1 MB | 0.3 MB | 0.3 MB |
| `contact_seq` (uuid PK + unique seq + FK) | **1.01 GB** | 1.01 GB | 1.01 GB |

`contact_seq` costs about 157 bytes per contact and dominates the storage. A production design could store the sequence
number as a column on `contacts` (INFERRED; not measured).

---

## 11. Chunk-size comparison

| | K = 4,096 | K = 16,384 | K = 65,536 |
|---|---|---|---|
| Count 1M p95 (REAL, MULTIEX) | 7.5 / 7.4 ms | 8.1 / 8.8 ms | 59.6 / 18.9 ms |
| Count 5M p95 (REAL, SINGLE, MULTIEX) | 39.4 / 10.1 / 19.9 ms | 32.4 / 18.9 / 63.0 ms | 21.3 / 6.7 / 13.4 ms |
| First count after rebuild | 5–195 ms | 5–115 ms | 12–537 ms |
| Single-write WAL | 1,272 B | 1,832 B | 9,928 B |
| Bulk delete chunk | +61 ms | +45 ms | +650 ms |
| Import chunk | +29 ms | +31 ms | +99 ms |
| Hot-chunk span | 4,096 contacts | 16,384 | 65,536 |
| Blocking rebuild 1M / 5M | 54–62 / 290 s | 40–80 / 250 s | 94–99 / 344 s |

**Choice: K = 4,096.** It is the smallest tested chunk and has the best overall write profile: lowest single-write WAL,
the smallest serialization domain, and bulk and import costs at or near the lowest. It counts 5M in under 40 ms p95,
about 25× inside the 1 s gate. K = 65,536 is rejected for its write amplification (bulk delete ×50, single-write WAL ×23).

---

## 12. Tenant isolation (MEASURED, real runtime role)

| Attempt (from the context shown) | A → B (same org) | A → C (other org) | Missing workspace context | Forged org A + workspace C | Forged org C + workspace A |
|---|---|---|---|---|---|
| Read target bitmap rows / dead rows / state | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| Count the target's sources | 0, sources not found | 0, not found | 0, not found | 0, not found | 0, not found |
| UPDATE, INSERT or DELETE target bitmap rows; TRUNCATE | 42501 | 42501 | 42501 | 42501 | 42501 |
| Write `contact_seq`; call `invalidate`; call a trigger function | 42501 | 42501 | 42501 | 42501 | 42501 |
| `rebuild()` | rebuilds **only the caller's own** workspace | same | 42501 (no context) | 42501 | 42501 |
| Membership into the target's list | 42501 (RLS) / 23503 (FK) | 42501 / 23503 | 42501 | 42501 / 23503 | 42501 / 23505 † |
| DISABLE TRIGGER; `session_replication_role` | 42501 | 42501 | 42501 | 42501 | 42501 |

† A pre-existing property of the production `list_memberships` primary key, not introduced by the bitmap: an insert of a
pair that already exists reports a unique violation before the FK check, given both UUIDs.

The database trusts the session's tenant GUCs, exactly as for every existing table. Authorization of the tenant context
remains the API's responsibility; nothing here weakens it.

---

## 13. Migration strategy (design; no migration created)

The requested order ("backfill → verify → mark valid → enable triggers") would lose every write made between backfill and
trigger enablement. The safe order is:

```text
1. one transaction: create tables (+ RLS, grants, functions), install triggers ENABLE ALWAYS + TRUNCATE trigger +
   DDL event trigger, insert state = INVALID for every existing workspace
   → from this commit every write is maintained; nothing is trusted yet
2. per workspace (online rebuild, successor doc): REBUILDING → repair chunks → verify → VALID (generation CAS)
3. the count read path already serves only VALID workspaces; it can ship before or after backfill
```

| Workspace size | Backfill (blocking rebuild, MEASURED) | Notes |
|---|---|---|
| 0 contacts | immediate (state VALID on creation) | MEASURED |
| 100k | ≈ 5 s | ESTIMATED from 300k = 5.3–12 s |
| 1M | 40–80 s at K = 16,384; 54–62 s at K = 4,096 | blocking; the online figure is in the successor document |
| 5M | 250–344 s | blocking |
| > 5M logical audience | the bitmap counts any size; `capped = n > cap`; capture still rejects with `AUDIENCE_TOO_LARGE` | INFERRED |
| Large workspace with an active import | **blocking rebuild stalls import chunks**: Prisma transaction timeout 10 s, 3 retries | INFERRED from measured durations → **C3** |

---

## 14. Risks

| Risk | Severity | Status |
|---|---|---|
| Blocking rebuild stalls writers (15 s timeouts) and imports | high | **open → C3** (successor) |
| Import-versus-erase deadlock (40P01; erase not retried) | medium | condition C1 |
| Silent staleness if triggers are bypassed without the guard | high | closed by C2 (MEASURED) |
| Event triggers need superuser to create; managed-PostgreSQL support must be confirmed | medium | condition C2a |
| `contact_seq` storage (~157 B per contact) | low–medium | condition C5 |
| Same-chunk serialization (bounded by short production transactions) | low | MEASURED acceptable at API level |
| Bulk delete +61 ms per 500 contacts | low | accepted, or optimise in implementation |
| Laptop-only evidence; Modern Standby stalls | medium | condition C4 |
| Contract wording "exact" vs "live estimate" | — | human decision, unchanged |

---

## 15. Open decisions (human)

1. Accept the measured write costs (§10).
2. Accept the mandatory guards (§6), including event triggers in the target PostgreSQL deployment.
3. Accept the `contact_seq` storage, or choose the alternative of a column on `contacts`.
4. Name the reference hardware for the performance gates.
5. Optionally reconcile the contract wording; it is unchanged here.

---

## 16. Final recommendation

**APPROVE B WITH CONDITIONS:**

| | Condition |
|---|---|
| C1 | Deterministic source lock order in every multi-source writer (sort list and tag ids in the import loops), plus a 40P01 retry in the API transaction wrapper, plus a regression test for the measured deadlock. |
| C2 | Guards: `ENABLE ALWAYS` triggers, the TRUNCATE trigger, the DDL event trigger, and scheduled reconciliation. C2a: confirm event-trigger support in the production PostgreSQL. |
| C3 | Rebuild must not block application writers (no writer timeouts during rebuild). **Open when this investigation closed. Decided in [the online-rebuild document](phase-6.3-bitmap-online-rebuild-readiness.md): YES WITH CONDITIONS O1–O6.** |
| C4 | Re-measure count and write costs on the reference hardware before enabling the read path. |
| C5 | Settle the `contact_seq` storage design. |
| C6 | The bitmap read path lives inside `PrismaAudienceResolution.count`, after `definitionErrors`, with the exact query as the only fallback. |

G2 stays **BLOCKED** pending C3 and human review. Phase 6.4 was not started.
