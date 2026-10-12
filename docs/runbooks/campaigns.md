# Runbook — Campaigns (test-mode execution, content, analytics)

**Scope:** operating the Campaigns module as built through Phase 6 plus the content amendment. **Production delivery is
disabled**: `CAMPAIGN_DELIVERY_MODE` is `disabled` by default, and `test` (the NullDeliveryPort, no I/O) is accepted only with
`NODE_ENV=test`. Nothing in this runbook sends real email.

## 1. Signals

The logs are one JSON object per line, built from allowlists (`apps/api/src/common/observability.ts`). They never contain
addresses, subjects, bodies, merge values or query strings.

| Log | Fields | Use |
|---|---|---|
| `{"msg":"http",…}` (logger `Http`) | requestId, method, route template, status, durationMs, outcome, userId, orgId, workspaceId | latency and error rates per route; find a request by the `x-request-id` the client saw |
| `{"msg":"job",…}` (logger `InlineJobDispatcher`) | job, outcome, durationMs, correlationId, orgId, workspaceId, ids.executionId | job throughput and failures; `correlationId` = the request id that scheduled the job |
| `{"alert":"campaign_execution_stalled",…}` | executionId | an execution exceeded its retry budget (§3.2) |
| `{"alert":"campaign_recovery_sweep_failed",…}` | err (message) | the recovery sweep itself failed (§3.3) |
| `{"alert":"campaign_job_invalid_envelope",…}` | job | a job envelope failed validation (a bug or tampering; the job did nothing) |
| `{"msg":"audience resolution recovery failed",…}` | workspaceId, err | the bitmap rebuild failed (§3.4) |

**Correlation:** request id → `domain_events.correlation_id` → `audit_logs.request_id` (system rows carry the scheduling
request's id) → job log `correlationId`.

## 2. Health of an execution

`GET /v1/workspaces/{ws}/campaigns/{id}/executions/{executionId}` returns `status`, `health` (`ok`, `retrying` or `stalled`),
the counts, `lastProgressAt` and `failure`. Progress comes only from server counts. The recipient list (`…/recipients`,
which needs `contacts.read`) shows each recipient's status and reason codes, by display name only.

## 3. Procedures

### 3.1 A campaign "does not start"
1. Check the capabilities (`GET …/campaigns/capabilities`). With `deliveryMode: disabled`, schedule and send are refused by design (`DELIVERY_NOT_AVAILABLE`).
2. Run pre-flight on the campaign. `ELIGIBILITY_ESTIMATE_UNAVAILABLE` (degraded audience resolution) is retryable: the client is told `Retry-After: 30` and a bitmap rebuild was requested (§3.4).
3. A later send time stays `pending` by design. Due discovery is the Phase 8 scheduler; today only send-now starts immediately.

### 3.2 `campaign_execution_stalled`
- **Cause:** infrastructure failures exceeded the job retry budget, for example a database outage during delivery.
- **State:** the execution keeps its lease-protected cursor. No recipient is duplicated, because each claim is keyset-based and every write is idempotent.
- **Action:** fix the underlying failure. The recovery sweep (every 15 min, and at process start) re-dispatches the execution, which resumes from the committed cursor. Verify that `health` returns to `ok` and `lastProgressAt` advances.

### 3.3 `campaign_recovery_sweep_failed`
The sweep discovers work through `app.workspaces_with_campaign_recovery` and then runs per workspace under RLS. Check
database connectivity and the function's grants. The sweep retries on its next interval and is safe to run repeatedly.

### 3.4 Degraded audience resolution
- **Symptom:** pre-flight reports the estimate unavailable, and schedule answers `409 PREFLIGHT_UNAVAILABLE` (retryable).
- **Cause:** the count bitmap is invalid or rebuilding, and the exact query exceeded its 1 s budget.
- **What happens:** a deduplicated rebuild is requested automatically.
- **If a rebuild fails** (`audience resolution recovery failed`), check for long-held locks on `list_memberships` or `contact_tags`. A rebuild statement waits for them: its lock waits have no deadline, so it holds a pool connection meanwhile (known; audit `phase-6.10-6.12` §3.3). Release the lock and the next pre-flight requests a new rebuild.

### 3.5 Template or content problems
Content problems are readiness findings, with JSON pointers to the field. Templates answer `422` with one field error per
problem. A stored template or version that fails validation on read is a defect: it surfaces as a 500 with a request id
and is never served. Investigate the row; never "fix" a stored version (they are immutable, and the database rejects
updates).

### 3.6 Rate limits (`429` with `Retry-After`)
Per user per hour:

| Route | Limit |
|---|---|
| preview | 600 |
| pre-flight | 60 |
| analytics | 300 |
| recipient pages | 1,200 |
| template writes | 600 |

These limits are intentionally generous for interactive use. A client hitting them is looping.

### 3.8 A scheduled campaign did not start on time
- **How it works:** every API instance runs a scheduler tick (`CAMPAIGN_SCHEDULER_INTERVAL_SECONDS`, default 15 s) that starts every pending execution whose `send_at` has passed. The schedule lives only in the database, so a restart or downtime is caught up by the next tick (contract amendment §D).
- **Check:** the log line `campaign_scheduler_tick` (`due`, `maxLagMs`). A `maxLagMs` that keeps growing means ticks are failing (look for `campaign_scheduler_failed`) or no instance is running.
- **Do not** start executions by hand in the database. Fix the failure and the next tick starts everything overdue, oldest first. Several instances ticking at once is safe.

### 3.7 A cancelled campaign still has open recipients
- **Expected:** cancel returns at once; the finalize job then turns every pending or queued recipient into `cancelled` in chunks of 1,000 (MEASURED: 67,000 in 6.3 s; 717,000 in 129 s — audit 6.13 §3.1). Until then the recipient list shows them as open.
- **If it does not progress:** look for `job campaign.execution.finalize failed` in the job log. A failed finalize is re-dispatched by the recovery sweep (every 15 min, and at process start), and finalize is idempotent.
- **Do not** update recipient rows by hand. A statement-timeout failure (`57014`) in finalize was a defect fixed in 6.13 (a plan that depended on table statistics); if it recurs, capture the plan and statistics (`pg_class.reltuples`) before running `ANALYZE`, and treat it as a defect.

## 4. Memory and capacity notes (MEASURED, audit 6.9 §9.1)

- **Live memory:** constant. At most +4 MB at 500k recipients.
- **Peak heap at default V8 settings:** up to about 120 MB at 500k. This is uncollected garbage during materialization.
- **For a dedicated worker:** set `--max-old-space-size` deliberately. Capacity is bounded per page and per batch (1,000), never per audience.

## 5. Things that must never be done

- Enabling a delivery mode other than `disabled` or `test`. `live` is rejected by config until the delivery phase.
- Disabling RLS, or running the API with the owner role.
- Editing `campaign_versions` rows (immutable) or deleting recipients of a running execution.
- Logging request URLs, bodies, or merge data while debugging. Use the request id.

## 6. Alerts (Phase 7.12; rules in `ops/monitoring/alerts.yml`)

Each alert names what to check first. Metrics: docs/operations/observability.md.

### 6.1 JobQueueBacklog

Jobs wait more than 5 minutes.

- Check `workeasy_job_queue_jobs` by status. Many `queued`: no process with the `jobs` role is running, or all of them are busy. Many `running`: jobs are slow — look at `workeasy_job_duration_seconds` by job.
- Confirm worker processes (`PROCESS_ROLES` contains `jobs`) are up and their logs show `msg:"job"` entries.
- Scale workers out (several runners claim disjoint jobs; `JOB_CONCURRENCY` ≤ 32 per process) or fix the slow dependency (usually the database: §6.12).
- Never delete queue rows by hand: jobs are idempotent and resume from checkpoints.

### 6.2 JobDeadLetters

A job exhausted its retries.

- Find the `alert:"job_dead_lettered"` log entry: it names the job, its ids and the error code (never payload values).
- Fix the cause. Then, for a campaign run, use resume or the recovery sweep (§3.2). For an import, the user retries the import. Dead letters are kept for diagnosis and purged by retention.

### 6.3 CampaignSchedulerLag

Scheduled campaigns start late.

- Same procedure as §3.8. Confirm a process with the `scheduler` role is running and `workeasy_campaign_scheduler_ticks_total{outcome="ok"}` increases.
- Lag with healthy ticks means the start jobs are queued behind others: see §6.1.

### 6.4 CampaignSchedulerFailing

The scheduler tick fails repeatedly.

- Look for `alert:"campaign_scheduler_failed"` logs. It is almost always the database (§6.12). Due runs are picked up by the next successful tick: nothing is lost, only delayed.

### 6.5 CampaignExecutionStuck

A run exhausted its retries.

- Follow §3.2 (`campaign_execution_stalled`).

### 6.6 ProviderFailureSpike

Hand-offs fail at the provider.

- Break `workeasy_provider_failures_total` down by kind. `transient`: provider outage (status page); runs retry by themselves. `unknown`: timeouts — those recipients are final `unknown` and are never resent (no duplicates); check network latency to the provider.
- Pause the affected campaigns if the outage is long; resume continues from the checkpoint.

### 6.7 ProviderConfigurationFailure

The provider refuses every send.

- Credentials, sending domain or account problem (401/403/404, SMTP 535), or a sender whose domain is no longer verified (`SENDER_NOT_VERIFIED`). Runs wait: no recipient is failed or lost.
- Fix the provider account or DNS (Settings → Sending). The waiting runs complete with nothing duplicated once sends succeed.

### 6.8 RetryStorm

Sustained retries.

- Correlate with §6.6/§6.7 (provider) and §6.12 (database). Retries back off exponentially by design; a storm means a dependency is failing, not that the retry policy is wrong.
- Do not raise retry limits or shorten back-off to "push through".

### 6.9 BounceSpike

Hard bounces above 5% of deliveries.

- Find the campaigns concerned (Campaign → Results). The usual cause is a stale or imported list.
- Pause campaigns that are still sending. Bounced addresses are already suppressed automatically (`hard_bounce`, source system).
- Review the list source with the customer before resuming.

### 6.10 ComplaintSpike

Complaints above 0.1% of deliveries.

- Pause the campaigns concerned. Complaining addresses are suppressed automatically (`complaint`).
- Check consent evidence for the audience (Audience → contact consent history).
- Persistent complaints endanger the shared sending reputation: escalate to the account owner.

### 6.11 WebhookFailures

Provider webhooks refused or failing.

- `reason="signature"`: the signing key in `DELIVERY_WEBHOOK_SIGNING_KEY` does not match the provider's, or the webhook URL is being probed.
- `reason="replay"`: a captured signature was reused with another body. Treat it as an attack, check the source IPs in the access logs (route only, no bodies).
- 5xx: the provider retries for a while. Fix the cause (usually the database) before its retry window ends, or the feedback for that window is lost.

### 6.12 DatabaseSaturation

PostgreSQL slow or unreachable.

- Check connections, locks and long transactions (`pg_stat_activity`), and disk/IO.
- Readiness turns 503 while the database is unreachable, so load balancers stop routing. Runs hold no lock across hand-offs and resume from checkpoints.
- Capacity notes: §4.

### 6.13 ApiServerErrors

More than 2% server errors.

- Group `workeasy_http_requests_total{status="5xx"}` by route. Logs carry `requestId` per request (the same id is in the response header `x-request-id`).
- Correlate with §6.12.

### 6.14 AudienceCountBitmapBacklog

Count bitmaps wait for a rebuild.

- Audience estimates fall back to the exact (slower) query and may report "estimate unavailable" for very large workspaces (§3.4). The count maintenance job (worker) rebuilds them.
- Check that it runs and is not failing (`job_dead_lettered` for the count maintenance job).

### 6.15 RedisUnavailable

The shared rate-limit store is unreachable.

- Rate-limited routes (sign-in, invitations, webhooks, …) answer `503 service_unavailable` with `Retry-After`. They fail closed on purpose: brute-force protection is never skipped. Readiness reports `rateLimitStore` unavailable.
- Campaign sending, scheduling and recovery are unaffected: they live in PostgreSQL.
- Restore Redis (connectivity, memory, eviction). Counters are short-lived fixed windows; nothing needs repair afterwards.
- The email provider retries refused webhooks for hours; feedback received during the outage arrives afterwards.
