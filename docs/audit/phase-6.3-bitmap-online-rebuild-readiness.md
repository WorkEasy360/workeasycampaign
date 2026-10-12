# Phase 6.3 — Bitmap Online Rebuild: Final Readiness Investigation

> **Final status (2026-10-07): G2 PASS — CLOSED; Phase 6.3 COMPLETE; official progress 35 %.** Statements below that
> G2 is blocked are the status at the time of this investigation. Final evidence and scorecard:
> [phase-6.3-g2-closure.md](phase-6.3-g2-closure.md) §10–§11.
>
> **Implementation follow-up (2026-10-06).** Conditions O1–O6 are implemented (g2-closure §2, §10). The algorithm of §3
> is kept — lease + generation bump, one short transaction per chunk, exclusive chunk locks by try-lock then bounded
> waits with skip/retry, writers on shared chunk locks, whole-bitmap verify + compare-and-set (now on generation **and**
> lease token). One measured refinement: the repair unit is a **position chunk** (the dead key and every candidate
> (source, chunk) key of that chunk locked together, all or nothing, ascending), because per-(source, chunk) repair with
> `EXISTS` became a hashed sub-plan that read each whole source per chunk (1M online rebuild under writers 928 s; after
> the refinement 79 s, writer p99 33 ms, 0 errors). The six failure-injection stages, CAS, takeover and corruption
> detection were re-run on the production code: never served while stale (g2-closure §10.4–§10.5). This document
> remains the investigation record.

**Status:** investigation only. No production schema, migration, trigger, RLS policy, grant or application code was
changed. Prototypes ran in the disposable `workeasy_test` database (`bench` schema, temporary `bench_bitmap_maint`
role) and were removed at the end (§12).
**Date:** 2026-10-06.
**Inputs:**
- [phase-6.3-bitmap-production-readiness.md](phase-6.3-bitmap-production-readiness.md) — condition C3, "rebuild must not
  block writers";
- [phase-6.3-count-architecture-decision.md](phase-6.3-count-architecture-decision.md);
- [phase-6.3-performance-remediation.md](phase-6.3-performance-remediation.md);
- the frozen decisions in [phase-6-campaign-engine.md](../architecture/phase-6-campaign-engine.md) §15–16;
- the contracts [phase-5-audience.md](../contracts/phase-5-audience.md) and [phase-6-campaign.md](../contracts/phase-6-campaign.md);
- the repository code.

The repository has no separate "Phase 6.3 implementation report" file. The 6.3 implementation evidence lives in the two
6.3 audits above. The production-readiness document was written at the start of this phase from evidence measured
earlier, and is labelled that way.

**Evidence labels.**

| Label | Meaning |
|---|---|
| **MEASURED** | Observed in this investigation. |
| **INFERRED** | Reasoned from code or measured facts. |
| **ESTIMATED** | Computed from measurements. |
| **NOT MEASURED** | No evidence. |

**Environment.** Windows 11 laptop (i7-1185G7, 8 GB RAM, NVMe), PostgreSQL 16.15 with `shared_buffers` 128 MB. Writers
connect as the **real runtime login role `workeasy_app`** (`statement_timeout` 15 s; forced RLS). Every operation is one
transaction using the production services' statement shapes, and one **real API import** (`ImportProcessor`, through
the in-process NestJS app) ran during the online rebuild. A keep-awake process prevented Windows Modern Standby.

---

## 1. Executive summary

**Decision: B — YES WITH CONDITIONS** (§13–14). The online rebuild is safe: it never produced an incorrect bitmap and
never served a stale one as VALID during a rebuild. It removes the blocking rebuild's write outage. One measured weakness
(tail latency of long writes during a rebuild) and two unmeasured items remain as explicit conditions.

- **Previous mismatch explained (Part A).** It was a harness defect: a self-contradictory test definition, and a bitmap
  read path that skipped `definitionErrors`. Separately, the reference query timed out under the 15 s role limit. The
  bitmap itself was exact (verify 0/0/0).
- **Algorithm (Part B).**
  - Per-chunk online repair under exclusive chunk advisory locks, matched by shared chunk locks in the triggers (no
    workspace lock).
  - A new state, REBUILDING, carries a **generation number**. VALID is set only by verify plus a generation
    compare-and-set in one transaction.
  - 12 timing cases plus 3 extra cases are argued in §5.
- **Real-mutation run, 1M (Part C/E).**
  - 51,423 writer operations of 12 kinds plus a real API import, while the online rebuild repaired a deliberately
    corrupted bitmap.
  - **0 statement timeouts and 0 bitmap-attributable errors.**
  - 17 pre-existing unique-index deadlocks between unordered bulk inserts; 0 involved bitmap locks.
  - Exact afterwards (3/3).
  - The blocking rebuild, on the same mix: **4 statement timeouts, max 15.0 s**.
- **Failure injection (Part D).** Killed before the first chunk, after it, halfway, after the final chunk, during
  validation, and right after VALID: **never VALID while stale (6/6)**, deterministic recovery, 0 writer errors.
  - The generation CAS rejected a rebuild invalidated mid-way.
  - A second rebuilder was refused.
- **Reconciliation (Part I).** 7/7 corruption kinds detected; **0 false mismatches** in 37 runs under 60,817
  concurrent writer operations.
- **K = 4,096 confirmed; K = 64 boundary stress clean.**
- **Negative results.**
  - Tail latency of long write transactions rose during the online rebuild (import chunk p99 0.6 → 3.4 s, max 4.7 s).
  - Online rebuild under heavy growth took 23 min.
  - An all-guard bypass stays stale until a reconciliation completes.
  - Rebuild cost initially scaled with history (zero chunks); fixed in the prototype.

---

## 2. Previous failure analysis (Part A)

The previous online-rebuild run reported "invariant mismatch 1 of 2", and its next phase crashed. Re-running it with the
reference timeout raised (investigation only) and full mismatch details recorded separated three causes.

| Category | Finding | Evidence |
|---|---|---|
| **Bitmap correctness** | **Correct.** `verify()` (stored = fresh derivation) had srcDiff 0, deadDiff 0, seqMissing 0 after the online rebuild and after the corrupted-bitmap repair. | MEASURED |
| **Reference timeout** | The production exact query, used as the reference, hit the runtime role's 15 s `statement_timeout` (`57014`) at 1M under concurrent writers, which crashed the following phase. Reference marked NOT MEASURED; re-run with a 600 s investigation-only timeout. Reference durations then: **5.1–16.4 s** after the blocking rebuild and **23.5–30.9 s** after the online rebuild (the workspace had grown to about 2M contacts). | MEASURED |
| **Harness failure** | **The "mismatch" was a harness defect.** The test definition included list S4 **and** excluded S4. The production adapter and the core reference both answered `AUDIENCE_DEFINITION_INVALID`. The harness's bitmap read path had skipped `definitionErrors()`, so it returned a number (826,489). | MEASURED |

**Consequence for production (condition O6).** The bitmap read path must run **inside** `PrismaAudienceResolution.count`,
after the existing `definitionErrors` validation, never beside it. The harness now validates first; every later run used
corrected definitions.

### 2.4 Host stall (earlier run)

An 838 s stall in an earlier concurrency run matched Windows Modern Standby to the second: entered at 21:07:01 IST,
exited at 21:21:09. The runtime role's 15 s statement timeout did not fire while the host was asleep. All runs in this
document used a keep-awake process; no stall recurred.

---

## 3. Online rebuild algorithm (Part B)

Derived from the prototype that was measured. Each step is one short transaction unless stated otherwise.

```text
R0  pg_try_advisory_lock(workspace rebuild key)            session level: one rebuilder per workspace;
                                                            released automatically if the rebuilder dies
R1  G := begin_rebuild()                                    state := REBUILDING, generation := generation + 1 (= G)
                                                            → from this commit, counts use the exact query
R2  fill_seq()                                              sequence numbers for contacts that lack one
                                                            (ON CONFLICT DO NOTHING)
R3  P := repair_pairs()                                     stored NON-ZERO chunks ∪ chunks derived from memberships
                                                            and dead contacts (no bits built; one snapshot)
R4  for each (source, chunk) / dead chunk in P:             ONE TRANSACTION PER CHUNK:
       pg_advisory_xact_lock(chunk key)                       exclusive per-chunk lock (waits for in-flight writers)
       recompute the chunk from COMMITTED data                new statement ⇒ new READ COMMITTED snapshot
       overwrite the stored chunk                             (INSERT … ON CONFLICT DO UPDATE SET bits = EXCLUDED.bits)
    commit (releases the chunk lock)
R5  finish_rebuild(G):                                      one transaction:
       v := verify()                                          stored = fresh, one statement, one snapshot
       if v ok:  UPDATE state SET VALID
                  WHERE generation = G AND state = REBUILDING ← generation compare-and-set
       else:     UPDATE state SET INVALID, generation + 1  WHERE generation = G
R6  pg_advisory_unlock(workspace rebuild key)
```

**Trigger protocol (always on):** before a statement-level membership trigger changes chunk (source, c), or a contact
trigger changes dead chunk c, it takes `pg_advisory_xact_lock_shared(chunk key)`. Chunks are processed in ascending
(source, chunk) order, then the update is applied as a commutative `|` / `& ~` to the latest row version. There is no
per-workspace lock: writers to different chunks never wait for each other or for the rebuild.

---

## 4. State machine (Part G)

Three states, plus a monotonically increasing **generation**. A missing state row is treated as INVALID. A separate
RECONCILING state is **not justified**: reconciliation is read-only until it finds a mismatch, and its outcome is a
transition to INVALID.

| State | Serve bitmap count? | Exact count | Mutations | Rebuild | After a crash | How incomplete work is identified |
|---|---|---|---|---|---|---|
| **VALID** | **yes** | no | allowed; triggers maintain | allowed (e.g. compaction): R1 moves it to REBUILDING first | unchanged (transactional) | n/a |
| **INVALID** | **no** | **yes** | allowed; triggers keep maintaining deltas | required | unchanged | state = INVALID |
| **REBUILDING** | **no** | **yes** | allowed; triggers maintain; repaired chunks stay exact | in progress (one rebuilder via R0) | stays REBUILDING; the rebuilder's session lock is released | REBUILDING with no holder of the rebuild lock (`pg_try_advisory_lock` succeeds) ⇒ abandoned; restart from R1 with a new generation |

| Transition | Trigger |
|---|---|
| (none) → VALID | workspace created (empty) |
| (none) → INVALID | installation / backfill start |
| any → INVALID (+ generation) | TRUNCATE trigger; DDL event trigger; trigger-detected inconsistency; reconciliation mismatch; failed rebuild verification |
| INVALID or VALID → REBUILDING (+ generation) | R1 |
| REBUILDING → VALID | R5, only if `verify()` passes **and** the generation is unchanged since R1 |

**Safety rule (Part H).** Counts are served from the bitmap **only** in VALID. The state, the existence check and the
bitmap value are read in **one statement**. VALID is only ever written by R5, after a verification and a successful
generation CAS. Any doubt — a missing row, REBUILDING, INVALID — falls back to the exact query.

---

## 5. Concurrency argument (Parts B and H)

Facts the argument uses:

| | Fact |
|---|---|
| (a) | A writer's membership or contact rows and its bitmap delta are in the **same transaction**: both commit or neither does. |
| (b) | The writer takes the chunk's shared lock **before** applying its delta. R4 takes the same chunk's exclusive lock **before** recomputing. |
| (c) | R4 recomputes in a **new statement after acquiring the lock**, so its READ COMMITTED snapshot includes every transaction that committed before the lock was granted. |
| (d) | Deltas are commutative bit operations on the latest row version, so concurrent deltas never overwrite each other. |
| (e) | Membership and contact rows of an uncommitted writer are invisible to R4. |

| # | Writer timing | Outcome | Why |
|---|---|---|---|
| 1 | Commits before R4 takes the chunk lock | correct | Its rows are visible to R4's snapshot (c); the recomputation includes it and overwrites any earlier stale value. |
| 2 | Starts before R4 and commits while R4 is waiting | correct | The writer holds the shared lock (b), so R4 waits for its commit; then case 1 applies. |
| 3 | Arrives while R4 holds the chunk lock | correct | The writer's statement inserts its rows (invisible to R4, e), then its trigger blocks on the shared lock. R4 commits a value without the writer's change; the writer then applies its delta onto the repaired row (d). |
| 4 | Waits for R4 and runs after R4 commits | correct | Same as 3: the delta lands on the repaired chunk. |
| 5 | Delete (soft delete or erase) during the rebuild | correct | Dead chunk: same protocol with the dead-chunk lock (cases 1–4). Erase also deletes memberships, which is case 8. |
| 6 | Restore during the rebuild | correct | Dead-chunk clear (`& ~`) under the same protocol. |
| 7 | Membership add during the rebuild | correct | Cases 1–4. |
| 8 | Membership remove during the rebuild | correct | Removed rows that are uncommitted are still visible to R4 as present (e), so R4 sets the bit; the writer's `& ~` then clears it (3, 4). If the writer rolls back, the row still exists and the bit stays set. |
| 9 | Import modifies many rows | correct | An import chunk is cases 1–4 repeated per chunk. Imports take shared locks in sorted (source, chunk) order **within a statement**; R4 holds one exclusive chunk lock at a time and nothing else, so no cycle can include R4. Measured: a real API import completed during the online rebuild. |
| 10 | The rebuild crashes after some chunks | **safe** | The state stays REBUILDING (committed in R1), so the exact query serves counts. Repaired chunks are exact and maintained; unrepaired ones may be stale but are never served. Recovery restarts from R1 with a new generation. |
| 11 | The rebuild crashes around the validity change | **safe** | R5's verify and CAS are one transaction: a crash before commit leaves REBUILDING; after commit, VALID was set only after verification. |
| 12 | Trigger failure during the rebuild | safe | An unexpected trigger error aborts the writer's whole transaction (a). A detected inconsistency (missing sequence number or chunk) invalidates with a generation bump, so the CAS in R5 fails and the workspace stays INVALID. |
| — | Invalidation (DDL, TRUNCATE, reconciliation) during the rebuild | safe | The generation changes, so R5's CAS updates 0 rows and the rebuild cannot set VALID (MEASURED §7). |
| — | Two rebuilders | safe | R0 lets one proceed. Even without R0, chunk repairs are idempotent and serialized per chunk, and only the latest generation can win the CAS (MEASURED §7). |
| — | A new chunk appears after R3 | correct | It is created by a trigger delta onto an empty row. The only way it could be wrong is if committed memberships existed that the derivation missed — but then they existed at R3 and the chunk would be in P. |

**Remaining assumption.** Every write path goes through the triggers (guaranteed by `ENABLE ALWAYS`, the TRUNCATE trigger
and the DDL event trigger). A superuser who bypasses all three is detected only by reconciliation.

---

## 6. Mutation matrix under online rebuild (Part C)

**Run (MEASURED).**
- **Workspace:** 1M contacts (1,068,947 seeded, plus 5 lists and 2 tags). Seeded with the prototype absent; the bitmap
  was then built, deliberately **corrupted** (40 chunks zeroed), detected by reconciliation (VALID → INVALID,
  srcDiff 40), and repaired by the online rebuild **while 4 writers ran the full mutation mix and a real API import ran**.
- **Writers:** each issues the 12 operation kinds below in rotation, one transaction per operation, using production
  statement shapes, as the runtime role with the 15 s statement timeout.
- **Growth:** the writers grew the workspace to about 2M contacts during the run (import chunks and list churn), which is
  why this rebuild enumerated 58,104 chunk pairs.

| Operation | Baseline, no rebuild (30 s): p50 / p99 / max ms | During online rebuild: p50 / p99 / max ms | Ops during rebuild | Errors |
|---|---|---|---|---|
| add membership | 1.99 / 22.2 / 45.0 | 2.23 / 29.6 / 238 | 4,285 | 0 |
| remove membership | 1.79 / 14.6 / 21.6 | 2.05 / 15.3 / 118 | 4,286 | 0 |
| bulk add 500 | 109 / 178 / 203 | 172 / 1,229 / 2,227 | 4,287 | **17 × 40P01** † |
| bulk remove 500 | 51.9 / 85.8 / 86.3 | 84.5 / 611 / 1,962 | 4,286 | 0 |
| contact soft delete | 2.35 / 18.6 / 36.6 | 2.91 / 44.2 / 232 | 4,285 | 0 |
| restore | 1.96 / 6.81 / 7.86 | 2.38 / 25.0 / 167 | 4,285 | 0 |
| erase (memberships + tags + contact) | 5.15 / 16.0 / 16.5 | 6.32 / 48.5 / 604 | 4,285 | 0 |
| tag | 2.50 / 8.49 / 19.1 | 3.02 / 20.7 / 361 | 4,285 | 0 |
| untag | 1.64 / 3.99 / 4.94 | 1.86 / 12.9 / 65.4 | 4,285 | 0 |
| contact create (+ list + tag) | 4.85 / 31.2 / 31.8 | 5.51 / 59.0 / 492 | 4,285 | 0 |
| import chunk 250 (sorted sources) | 445 / 608 / 616 | 568 / 3,400 / 4,673 | 4,285 | 0 |
| list create + fill 200 + delete | 81.1 / 121 / 151 | 114 / 709 / 1,417 | 4,284 | 0 |
| **all** | 3.79 / 496 / 616 | 5.40 / 1,004 / 4,673 | **51,423** | **17 (0.033 %)** |
| real API import (2,500 rows, 2 lists + 1 tag) | — | completed, 2,500 created | — | 0 |

† **All 17 deadlocks are unrelated to the bitmap (MEASURED from the PostgreSQL log).** In every case, two `bulk add 500`
statements waited on each other's transaction "while inserting index tuple … in relation list_memberships". These are
unique-index conflicts between two unordered, overlapping 500-row `INSERT … ON CONFLICT DO NOTHING` statements. **0 of
17 involved an advisory lock or a bitmap row.**
- The same pattern exists today: production bulk add sends contact ids in request or filter order.
- Triggers lengthen these transactions (bulk add p50 109 → 172 ms during the rebuild), which widens the window.
- Remedy: insert in ascending contact-id order. That extends condition C1.

**Writer error budget** (defined for the decision): **zero** statement timeouts (57014) and **zero** errors attributable
to bitmap maintenance or the rebuild.

| Error class | Measured |
|---|---|
| 57014 (statement timeout) | 0 |
| Bitmap- or rebuild-attributable errors | 0 |
| Deadlocks (all pre-existing unique-index type) | 17 |

**Budget met.**

**Tail latency during the online rebuild rose materially.**
- **Long transactions:** import-chunk p99 608 ms → 3.4 s (max 4.7 s); bulk add p99 178 ms → 1.2 s.
- **Single-row operations:** p99 stayed ≤ 59 ms; maxima reached 118–604 ms.
- **Likely mechanism (INFERRED):** PostgreSQL lock-queue fairness. While a rebuild waits for an exclusive chunk lock
  behind a long writer (for example a 0.5–4 s import chunk), later shared-lock requests on that chunk queue behind the
  rebuild. A writer can therefore wait for "the longest concurrent holder + one repair". Per-chunk repair transactions
  were p50 7.2 ms, p99 137 ms, max 9.4 s (that maximum includes lock waits).
- **Remedy (condition O3; not measured):** acquire the chunk lock with a short `lock_timeout`, skip and revisit that chunk
  later, so the rebuild never queues ahead of writers.

**Final correctness after the run** (writers stopped; reference = production exact query, 600 s investigation timeout):

| Definition | Bitmap | Reference (duration) | Equal |
|---|---|---|---|
| 1 list | 217,606 | 217,606 (23.5 s) | ✓ |
| 4 lists + tag − list | 1,985,657 | 1,985,657 (27.8 s) | ✓ |
| tag + list − tag | 1,484,503 | 1,484,503 (30.9 s) | ✓ |

Final state: VALID, generation 4, verify srcDiff 0, deadDiff 0, seqMissing 0. **0 mismatches.**

---

## 7. Failure injection (Part D)

**Run (MEASURED).**
- **Workspace:** 200k contacts, K = 4,096, initial online build of 392 chunks in 32 s.
- **Before each stage:** 25 chunks were zeroed (a guard-bypassing corruption), reconciliation detected it
  (VALID → INVALID), and an online rebuild was started under 2 writers running every mutation kind except the two growth
  operations.
- **Injection:** the rebuild's backend was killed (`pg_terminate_backend`) at the stage named.
- **Then:** the state and the bitmap were checked, and a full recovery rebuild was run under writers.

| # | Failure point | State after failure | Bitmap at that moment | Served while stale? | Recovery (rebuild under writers) | Writer errors |
|---|---|---|---|---|---|---|
| 1 | before first chunk (after the rebuild lock) | INVALID (g2) | stale | **no** | VALID, verified (10.5 s) | 0 |
| 2 | after first chunk | REBUILDING (g5) | stale | **no** | VALID, verified (136 s) | 0 |
| 3 | halfway (197 chunks done) | REBUILDING (g8) | stale | **no** | VALID, verified (136 s) | 0 |
| 4 | after final chunk (401 done) | REBUILDING (g11) | correct | **no** | VALID, verified (220 s) | 0 |
| 5 | during final validation (`finish_rebuild` killed) | REBUILDING (g14) | correct | **no** | VALID, verified (51 s) | 0 |
| 6 | immediately after VALID | VALID (g17) | correct | n/a (correct) | VALID, verified (53 s) | 0 |
| 7a | during reconciliation, bitmap correct | VALID | correct | no | — | — |
| 7b | **during reconciliation, bitmap corrupted** | **VALID** | **stale** | **yes, until the next reconciliation** | the rerun found srcDiff 10 → INVALID → rebuild → VALID | — |
| 8 | generation CAS: invalidation committed during a rebuild | INVALID (g23); `finish_rebuild` returned `casLost: true`, `becameValid: false` although verify passed | — | no | the next rebuild became VALID (g24) | — |
| 9 | two rebuilders started 200 ms apart | the second refused ("another rebuild holds the lock"); the first became VALID | correct | no | — | — |

**Recovery is deterministic.** A failed rebuild always leaves INVALID or REBUILDING, and the recovery is the same
procedure every time: a new generation, a full repair, then verify + CAS. Writes continued throughout with **0 errors**.
After the series, all three definitions matched the exact reference (45,117 / 163,154 / 49,413).

**Negative result (7b).** If a corruption bypasses **every** guard (`ENABLE ALWAYS` triggers, the TRUNCATE trigger, the
DDL event trigger), the bitmap stays VALID and stale until a reconciliation run **completes**. Killing reconciliation
extends that window to the next successful run. This window is inherent to detection by reconciliation, so its length
must be bounded by cadence and alerting (condition O5).

---

## 8. Reconciliation (Part I)

**Detection method.** `verify()` derives every (source, chunk) and dead chunk fresh from the membership and contact
tables and compares the result with the stored rows (non-zero rows only), in **one statement**: one MVCC snapshot, no
locks. It also counts contacts without a sequence number. `reconcile()` acts only on VALID workspaces; any difference
sets INVALID and bumps the generation.

**Detection matrix (MEASURED).** 200k workspace, K = 4,096. Each corruption was injected directly as superuser, i.e. it
bypassed every guard.

| Corruption | Reconcile result | State afterwards | Count path afterwards |
|---|---|---|---|
| wrong bit (one bit flipped in one chunk) | srcDiff 1 | INVALID | exact |
| missing chunk row (deleted) | srcDiff 1 | INVALID | exact |
| extra chunk row (source that does not exist) | srcDiff 1 | INVALID | exact |
| stale chunk (all zero) | srcDiff 1 | INVALID | exact |
| stale dead bit (live contact marked dead) | deadDiff 1 | INVALID | exact |
| missing `contact_seq` row | srcDiff 1, seqMissing 1 | INVALID | exact |
| state row missing (workspace unknown to the bitmap) | skipped ("missing") | missing ⇒ treated as INVALID | exact |

Each case was then repaired by an online rebuild (VALID, verified).

**Concurrency (MEASURED).**
- 37 reconciliation runs back to back while 4 writers ran every mutation kind: 60,817 writer operations, 0 writer
  errors, **0 false mismatches**.
- Earlier runs added 25 + 25 runs with 0 false mismatches.
- Duration: quiet 2.2 s at 200k, 26 s at 1M (previous run).

**Operational design (from the measurements).**

| Aspect | Design |
|---|---|
| Cadence | every VALID workspace at least every 24 h, plus after every invalidating event and on demand. The cadence bounds the stale window of an all-guard bypass (§7, case 7b). |
| Batching | one workspace per job; workspaces ordered by last reconcile time; at most N concurrent per database (N = 1 on this hardware) |
| Locking | none (read-only snapshot) |
| Timeout | elevated, transaction-local (`SET LOCAL statement_timeout`, like capture): about 30 s at 1M on this host; 5M NOT MEASURED (ESTIMATED 2–3 min by linear scaling) |
| Retry | on failure or kill, retry with backoff; a killed run changes nothing (MEASURED) |
| Failure handling | a mismatch → INVALID → online rebuild job enqueued |
| Concurrency with imports | safe (MEASURED during writer load and an API import) |
| Tenant isolation | runs as the runtime role in the workspace context; RLS-confined (MEASURED in the production-readiness document §12) |
| Observability | per run: workspace, duration, srcDiff, deadDiff, seqMissing, result; alert on any mismatch (a bypass happened) and on reconciliation age above the cadence |
| Maximum repair duration | detection ≤ cadence; repair = online rebuild (1M: 273–433 s under 4 writers without growth; 23 min while the workspace doubled under writes). Counts stay correct throughout via the exact fallback. |

```mermaid
sequenceDiagram
  participant J as Worker job
  participant S as bitmap_state
  participant B as bitmap chunks
  participant W as App writers (triggers)
  J->>S: reconcile(): read state (VALID?)
  J->>B: verify(): stored = fresh? (one snapshot, no locks)
  W->>B: deltas continue (per-chunk shared locks)
  alt mismatch
    J->>S: INVALID, generation+1   (counts → exact query)
    J->>J: pg_try_advisory_lock(rebuild key)
    J->>S: begin_rebuild(): REBUILDING, generation = G
    loop each chunk (one short tx)
      J->>B: exclusive chunk lock → recompute → overwrite
      W-->>B: writers on that chunk wait ≤ one repair, then apply deltas
    end
    J->>S: finish_rebuild(G): verify; VALID only if ok AND generation = G
  else equal
    J->>S: no change
  end
```

---

## 9. Blocking vs online (Part E)

Same 1M workspace, same writer mix (4 writers, full 12-operation mix), K = 4,096, 40 corrupted chunks repaired in each
case. Blocking = the per-workspace-lock rebuild from the production-readiness document. Online = §3. MEASURED.

| Metric | Blocking | Online |
|---|---|---|
| Rebuild duration | **21.5 s** | **1,376 s** (58,104 pairs; the workspace grew from ~1M to ~2M contacts during it) |
| Writer operations during the rebuild | 454 | 51,423 |
| Writer errors | **4 × 57014 (statement timeout)** | **0 × 57014**; 17 × 40P01, all pre-existing unique-index type (§6) |
| Writer p50 | 4.14 ms | 5.40 ms |
| Writer p95 | 417 ms | 573 ms |
| Writer p99 | **6,364 ms** | 1,004 ms |
| Max writer latency | **15,025 ms** (the timeout) | 4,673 ms (import chunk); single-row ops ≤ 604 ms |
| Single add / remove, max | 6,364 / 6,183 ms | 238 / 118 ms |
| Correctness afterwards | exact (3/3 definitions) | exact (3/3 definitions) |
| Failure recovery | rerun (blocks again) | deterministic, non-blocking (§7) |

Baselines without a rebuild (30 s each, the same mix) were 0 errors, p99 586 ms (blocking design) and 496 ms (online
design). The difference is the trigger lock protocol, and it is within noise.

**Verdict.** The online rebuild removes the write outage: 0 timeouts against 4. Its costs are a much longer rebuild
(during which counts fall back to the exact query) and higher tail latency for long write transactions while it runs.
The rebuild-duration comparison is not like-for-like: the online run repaired a workspace that roughly doubled under
writes during the run. The previous run, in which the workspace did not grow, took 273–433 s at 1M under 4 writers.

---

## 10. K = 4,096 evidence (Part F)

The chunk-size study was not reopened. From the production-readiness document §11 (MEASURED): K = 4,096 has the lowest
single-write WAL (1,272 B), a 4,096-contact serialization domain, a 5M count p95 ≤ 40 ms, and import overhead of +29 ms
per chunk. K = 65,536 is rejected.

Online-rebuild evidence in this phase (MEASURED):

| Run | K | Workspace | Result |
|---|---|---|---|
| Part E (1M, full mix + API import) | 4,096 | 1M → ~2M | online rebuild VALID and verified; 0 timeouts; 3/3 definitions exact |
| Part D (failure injection) | 4,096 | 200k | every stage safe; deterministic recovery; 3/3 exact |
| Part I (reconciliation) | 4,096 | 200k | 7/7 corruption kinds detected; 0 false mismatches in 37 concurrent runs; 3/3 exact |
| **Boundary stress** | **64** | 20k | 6,622 chunk pairs repaired online in 80.6 s under 4 writers + API import; **0 writer errors**; VALID and verified; 3/3 exact (10,461 / 205,194 / 203,102). Blocking rebuild at K = 64: exact, 0 errors (992 ms). |

**Efficiency findings (MEASURED, design input):**
- Enumerating stored **all-zero** chunks (left behind by deleted lists and tags) made rebuilds scale with workspace
  history (263k stored rows, 2,155 non-zero, in one run). Enumeration now takes non-zero stored rows plus derived rows,
  which is correct by the argument in §5 (a zero row is correct unless the derivation says otherwise).
- Production should also **garbage-collect** all-zero chunks of deleted sources (condition O4).

---

## 11. Security and isolation

The online design adds functions (`repair_pairs`, `repair_src`, `repair_dead`, `fill_seq`, `begin_rebuild`,
`finish_rebuild`) and advisory locks. It adds **no grants on tables**.

- **Functions:** SECURITY DEFINER, owned by the NOLOGIN/NOBYPASSRLS maintenance role, `search_path` pinned,
  `REVOKE ALL FROM PUBLIC`. EXECUTE is granted to the runtime role, so the worker can run rebuild and reconciliation.
- **Scope:** every function acts on `app.current_workspace_id()` under forced RLS. A caller can repair, rebuild or
  invalidate **only its own workspace**, exactly like `rebuild()` in the production-readiness isolation matrix (§12
  there, MEASURED).
- **Advisory-lock keys** are derived from source ids, workspace ids and chunk numbers. A collision across tenants only
  causes extra waiting, never data access (INFERRED).
- **Lock-wait denial of service:** a workspace can only cause waits on its own chunk keys or on colliding keys. The
  per-chunk hold time is short (§9).
- The tenant-isolation matrix of the production-readiness document applies unchanged: 0 cross-tenant reads, and 42501
  or 23503 for every cross-tenant write.

---

## 12. Remaining risks

| # | Risk | Evidence | Severity | Mitigation / condition |
|---|---|---|---|---|
| R1 | Tail latency of long write transactions during an online rebuild (import chunk p99 3.4 s, max 4.7 s; bulk add p99 1.2 s) | MEASURED | medium | O3: lock_timeout-and-skip chunk locking; re-measure |
| R2 | Online rebuild is slow under heavy writes (23 min while the workspace doubled; 273–433 s at 1M without growth); counts use the exact query meanwhile (1M ≈ 5–31 s; 5M can time out, as today) | MEASURED | medium | accepted degraded mode, or rebuild off-peak; O4 (zero-chunk GC) |
| R3 | Stale window if a corruption bypasses every guard: VALID and wrong until a reconciliation completes | MEASURED (7b) | medium | O5: cadence and alerting; the guards (C2) make this superuser-only |
| R4 | Concurrent unordered bulk inserts deadlock on the unique index (pre-existing; more likely with longer transactions) | MEASURED (17 / 51,423) | low–medium | C1 extended: insert in ascending contact-id order + 40P01 retry |
| R5 | Import-versus-erase source-order deadlock | MEASURED (production-readiness document) | medium | C1 |
| R6 | Reconciliation and rebuild at 5M | NOT MEASURED (online) | medium | measure in implementation (C4) |
| R7 | Laptop-only evidence; Modern Standby stalls | MEASURED caveat | medium | C4: reference hardware |
| R8 | Advisory-key collisions cause extra waits | INFERRED | low | 64-bit hashes; accepted |
| R9 | `contact_seq` storage ~157 B per contact | MEASURED | low–medium | C5 |
| R10 | Event triggers need superuser to install; managed-PostgreSQL support unknown | NOT MEASURED | medium | C2a |

---

## 13. Production-readiness decision (Part J)

# **B — YES WITH CONDITIONS**

**Can the bitmap be rebuilt while normal application writes continue, without producing an incorrect bitmap,
unacceptable writer blocking, or an unsafe validity state?**

- **Incorrect bitmap: no.** Every online rebuild ended exact: 1M with full mix, 200k × 9 failure/recovery cycles, K = 64
  stress, and 7 corruption repairs, under concurrent writers and a real API import. The per-case argument is in §5.
- **Unsafe validity state: no.** The bitmap was never served while stale in any rebuild failure stage (6/6). The
  generation CAS blocked a concurrent invalidation, and a second rebuilder was refused. The one stale-but-VALID case (7b)
  is an all-guard bypass awaiting reconciliation, which is inherent to detection and bounded by cadence.
- **Writer blocking: no outage**, but tails rise. The writer error budget was met (0 timeouts, 0 bitmap- or
  rebuild-attributable errors in 51,423 + 5,035 + 60,817 + Part D operations), against 4 timeouts for the blocking
  rebuild.

**Why not A.** The remaining blocker is **R1**. Long write transactions saw multi-second tail latency during the rebuild
(import chunk max 4.7 s, versus 0.6 s baseline). The likely cause is lock-queue fairness, and the proposed fix (O3) is
NOT MEASURED. Two smaller items also remain: zero-chunk GC (O4), and online rebuild/reconciliation at 5M plus reference
hardware (C4) are NOT MEASURED.

**Why not C or D.** The algorithm's safety properties are demonstrated, not assumed. The open items are bounded,
testable refinements that change neither the architecture, the state machine nor the contract.

---

## 14. Exact conditions for implementation

Online rebuild (this document):

| | Condition | Acceptance test |
|---|---|---|
| **O1** | The algorithm exactly as §3: session rebuild lock; `begin_rebuild` with a generation bump; per-chunk short transactions under an exclusive chunk advisory lock, matched by shared chunk locks in every trigger (no workspace lock); `finish_rebuild` = verify + generation CAS in one transaction. | Re-run the Part D matrix (6 stages + CAS + two rebuilders): never served while stale; deterministic recovery. |
| **O2** | The state machine §4: VALID / INVALID / REBUILDING plus generation. Bitmap served only in VALID, read with state and existence in one statement; a missing row means INVALID. | Unit and integration tests on every transition. |
| **O3** | Rebuild chunk locks taken with a short `lock_timeout` (e.g. 100–250 ms): on timeout, skip the chunk and revisit it later, so the rebuild never queues ahead of writers. | Re-run Part E: writer p99 during the rebuild ≤ 2 × baseline per operation, 0 × 57014. |
| **O4** | Enumerate non-zero stored chunks plus derived chunks only; garbage-collect all-zero chunks of deleted sources. | Rebuild time proportional to live data, not history. |
| **O5** | Reconciliation: VALID-only; one-statement verify; ≤ 24 h cadence plus event-driven runs; alerts on mismatch and on reconciliation age. | Part I matrix (7 kinds) + 0 false positives under writes. |
| **O6** | The bitmap read path inside `PrismaAudienceResolution.count`, **after** `definitionErrors`, with the existing exact query as the only fallback. | The Part A harness defect must be impossible: a test with an invalid definition gets `AUDIENCE_DEFINITION_INVALID` on every path. |

Carried from the production-readiness document:

| | Condition |
|---|---|
| **C1** | Deterministic lock order: sorted source ids in multi-source writers; sorted contact ids in bulk inserts; 40P01 retry in the API transaction wrapper. |
| **C2** | Guards: `ENABLE ALWAYS` triggers, TRUNCATE trigger, DDL event trigger. **C2a**: confirm event-trigger support in production PostgreSQL. |
| **C4** | Re-measure on reference hardware, including online rebuild and reconciliation at 5M. |
| **C5** | Settle the `contact_seq` storage design. |

Contracts unchanged: AudienceResolution API, T0, the 5,000,000 limit, eligibility semantics, tenant isolation, snapshot
lifecycle. The "exact" / "live estimate" wording remains a human decision.

**Phase 6.4: NOT STARTED.** **G2: BLOCKED / READY FOR HUMAN REVIEW.**
