# Durable job queue — decision record and design (milestone 7.6)

**Status:** DECIDED 2026-10-09 by the product owner · **Supersedes:** the "Worker: NestJS standalone + BullMQ 5 (ioredis
5)" line of `docs/architecture.md` for background jobs. Redis stays for production rate limits only.

## 1. Decision

Background jobs (campaign execution `start` / `run` / `finalize` / `release`, audience imports) run on a **PostgreSQL
job queue**. Rows are claimed with `FOR UPDATE SKIP LOCKED`; runs are leased with heartbeats; retries are bounded with
backoff; and jobs that keep failing become dead letters.

### Alternatives considered

| Option | For | Against | Outcome |
|---|---|---|---|
| **PostgreSQL queue** | Testable on this host; can be enqueued **in the same transaction** as the state change (no lost hand-off); one fewer production dependency for correctness; the job volume is low (one `run` job batches a whole execution) | Polling cost (bounded: indexed claim, idle back-off); throughput lower than Redis (not needed at this volume) | **Chosen** |
| BullMQ + Redis, portable Redis downloaded to the host | Matches the earlier architecture line | Running an unvetted third-party binary on the owner's machine; enqueue still after commit (needs an outbox anyway) | Not chosen |
| BullMQ + Redis, untested here | Matches the earlier architecture line | Could not pass a gate honestly (no Redis to test against) | Not chosen |

## 2. Model

`job_queue` (infrastructure table, **no grants to the runtime role**; every access goes through SECURITY DEFINER
functions with a pinned `search_path`):

| Column | Meaning |
|---|---|
| `id`, `name` | job id; registered job name |
| `org_id`, `workspace_id` | the tenant, taken from the **database session's tenant context** at enqueue (never from the payload). The payload's own tenant must match it |
| `payload` | the job envelope `{ tenant, actor, correlationId, payload }`: ids only, no personal data (import actors carry the user id only) |
| `status` | `queued` → `running` → `done`; or `queued` again (retry); or `dead` |
| `attempts`, `max_attempts` | an attempt is counted when it is claimed |
| `run_after` | not before (delays and retry back-off) |
| `lease_owner`, `lease_until` | the runner that holds it; extended by heartbeats; an expired lease makes it claimable again |
| `dedupe_key` | optional; at most one queued/running job per key |
| `last_error` | an error **code** only (at most 200 characters), never a message with values |

Functions:
- `app.enqueue_job(name, payload, run_after, max_attempts, dedupe_key)` runs inside the caller's tenant transaction, so a job is created atomically with the state change when the caller wants that.
- `app.claim_jobs(worker, names[], limit, lease_seconds)`: due queued jobs plus running jobs whose lease expired, oldest first. Ids are locked first, then updated by id. It never uses `UPDATE … WHERE id IN (SELECT … SKIP LOCKED)` (the finalize defect, audit 6.13 §2).
- `app.extend_job_lease(id, worker, seconds)` is the heartbeat; `app.complete_job(id, worker)`; `app.fail_job(id, worker, code, retry_in_seconds, permanent)`. All of them act only on a job whose lease this worker holds.
- `app.job_queue_stats()` gives depth per status and name plus the age of the oldest due job (metrics, 7.12). `app.purge_jobs(before)` removes finished jobs (retention).

## 3. Runtime

- **Dispatcher:** `PgJobDispatcher implements JobDispatcher`. `dispatch(name, data, { delayMs?, dedupeKey? })` enqueues in its own short transaction under the envelope's tenant. Existing after-commit call sites keep working, and the recovery sweep remains the safety net for a crash between commit and enqueue. New code can enqueue inside its transaction.
- **Runner:** `PgJobRunner` polls `claim_jobs` for registered names (concurrency per process, idle back-off), runs the handler, heartbeats every lease/3, then completes or fails. A `PermanentJobError` (or an invalid envelope) goes straight to `dead`. Otherwise back-off is exponential with jitter, capped, until `max_attempts`.
- **Processes:** the same API image runs with `PROCESS_ROLES=http,jobs,scheduler` (default: all). A dedicated worker deployment is `PROCESS_ROLES=jobs,scheduler`. `JOB_QUEUE=postgres` is required in production (config validation); `inline` is for tests and single-process development only.
- **Retries inside campaign execution** move from in-process timers to the queue (`delayMs`), so a retry survives a restart.
- **Graceful shutdown:** stop claiming; wait for in-flight jobs up to a deadline. An unfinished job's lease expires and it is retried; handlers are idempotent and resumable (contract §6, §10).

## 4. Guarantees to prove (tests, 7.6 gate)

1. Enqueue → claim → complete. Retries honour `run_after`; the attempt budget gives `dead`; permanent errors go straight to `dead`.
2. Two runners never run the same job at once (SKIP LOCKED under concurrency).
3. A crashed runner's job is reclaimed after its lease expires, and a heartbeat prevents reclaiming a live job.
4. Tenancy: the runtime role cannot read or change `job_queue` directly; enqueue takes the tenant from the session and refuses a payload for another tenant.
5. End to end: a send-now campaign completes through the PostgreSQL queue, including a crash mid-run and a restart.
6. No personal data in job rows (the import envelope carries the user id only).

## 5. Evidence (milestone 7.6 gate, MEASURED 2026-10-09)

| Guarantee (§4) | Test | Result |
|---|---|---|
| 1 Lifecycle: run_after, attempt budget → dead, permanent → dead | `packages/db/test/job-queue.test.ts` (lifecycle); `apps/api/test/job-queue-runtime.test.ts` (back-off + dead letters through the runner) | PASS |
| 2 Concurrent claimers never share a job | 40 jobs, 4 concurrent claims from 2 connections → 40 distinct | PASS |
| 3 Lease expiry and heartbeat; a dead runner cannot record an outcome | DB test (heartbeat true/false, reclaim attempt 2) + runtime test (a "ghost" runner dies holding the campaign run job; the campaign completes once, 0 duplicate recipients) | PASS |
| 4 Tenancy: no direct access; tenant from the session; payload tenant checked | DB test (SELECT/UPDATE/DELETE/INSERT denied; mismatched tenant and missing context refused) | PASS |
| 5 End to end, crash and restart | runtime tests: send-now through PostgreSQL jobs; restart before any job ran → the next process completes it | PASS |
| 6 No personal data in job rows | runtime test: import job actor `{ type: 'user', id }`; no `@` in any job payload | PASS |
| Configuration | `config.test.ts`: production refuses `JOB_QUEUE=inline`; roles parsing; bounds | PASS |

Found along the way (fixed, recorded):
- **`FOR UPDATE` inside `UNION`** is refused by PostgreSQL. It was caught on the first call; `claim_jobs` was replaced by a new migration (`20261024000001`), and applied migrations were not edited.
- **API test files were not typechecked**, so a test double had drifted from `JobDispatcher` and failed only at run time. Test directories of api, db and worker are now part of `pnpm typecheck` (3 small annotations fixed; 0 errors).
- **The full API suite after the change:** 38 of 39 files passed (585 tests). The lifecycle file failed in setup because of that test double; after the fix it passed 26/26.
