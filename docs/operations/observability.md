# Observability — Workeasy Campaigns (Phase 7.12)

**Status:** implemented and tested in-process (`apps/api/test/health-metrics.test.ts`, `observability.test.ts`). Not yet
connected to a monitoring stack: wiring Prometheus or Alertmanager is a deployment step (Gate G).

## 1. Logs

Each line is one JSON object, built from allowlists (`apps/api/src/common/observability.ts`).

| Entry | Fields |
|---|---|
| `msg:"http"` (one per request) | `requestId`, `method`, `route` (template, never the URL or query), `status`, `durationMs`, `outcome`, `userId`, `orgId`, `workspaceId` |
| `msg:"job"` (one per job run) | `job`, `outcome`, `durationMs`, `correlationId` (= the request id that caused it), `orgId`, `workspaceId`, allowlisted payload ids, `attempt`, `code` |
| `alert:"…"` (error level) | `campaign_execution_stalled`, `campaign_delivery_provider_configuration`, `campaign_scheduler_failed`, `job_dead_lettered`, count reconciliation differences |

Never logged: e-mail addresses, names, message content, query strings, tokens, secrets, provider response text.

**Correlation.** A response carries `x-request-id`. The same id is on the request's log entry, its audit rows, its domain
events (`correlation_id`) and every job it caused (`correlationId`).

## 2. Metrics — `GET /metrics`

- Prometheus text format. Requires `Authorization: Bearer $METRICS_TOKEN`; without a configured token the route answers 404.
- Process-local: scrape every API and worker process and sum.
- Label values come from fixed vocabularies only (route templates, job names, outcome kinds): no ids, no personal data. This is tested.

| Series | Type | Labels | Master prompt §24 item |
|---|---|---|---|
| `workeasy_http_requests_total` | counter | route, method, status (class) | request failures |
| `workeasy_http_request_duration_seconds` | histogram | route, method | request latency |
| `workeasy_job_queue_jobs` | gauge (scrape) | job, status | queue depth |
| `workeasy_job_queue_oldest_due_seconds` | gauge (scrape) | job | job latency (waiting) |
| `workeasy_job_runs_total` / `workeasy_job_duration_seconds` | counter / histogram | job, outcome | job failures, job latency (running) |
| `workeasy_job_retries_total` / `workeasy_job_dead_letters_total` | counter | job | retries |
| `workeasy_campaign_deliveries_total` | counter | outcome (sent, failed, unknown, retry, requeued) | execution throughput, delivery failures |
| `workeasy_provider_failures_total` | counter | kind (taxonomy) | provider failures |
| `workeasy_campaign_execution_retries_total` | counter | reason | retries |
| `workeasy_campaign_execution_stalled_total` | counter | — | execution stuck |
| `workeasy_campaign_scheduler_lag_seconds` / `…_ticks_total` | gauge / counter | outcome | scheduler lag |
| `workeasy_webhook_events_total` / `workeasy_webhook_rejected_total` | counter | type, result / reason | webhook failures |
| `workeasy_database_ping_seconds` | gauge (scrape) | — | database latency (-1 = unreachable) |
| `workeasy_redis_ping_seconds` | gauge (scrape) | — | Redis latency (-1 = unreachable) |
| `workeasy_audience_count_maintenance_backlog` | gauge (scrape) | kind (rebuild, reconcile) | bitmap recovery backlog |

**Redis.** It is used ONLY as the shared HTTP rate-limit store across API instances (`REDIS_URL`, required in
production). Jobs, scheduling and recovery are in PostgreSQL (docs/architecture/durable-job-queue.md), so a Redis
outage never loses or delays campaign work. While Redis is unreachable, rate-limited routes fail CLOSED with
`503 service_unavailable` + `Retry-After`: login and other brute-force protections are never skipped. Routes without a
limit keep working, and readiness reports `rateLimitStore` as unavailable (tested: `health-metrics.test.ts`).

## 3. Health

| Probe | Meaning | Use for |
|---|---|---|
| `GET /health` | the process is up; checks no dependency | liveness. A database outage must not restart every pod. |
| `GET /health/ready` | PostgreSQL ping, the job queue when `JOB_QUEUE=postgres`, and the rate-limit store (Redis) when configured, with latencies. 503 naming the failed dependency, and from the moment shutdown begins (draining) | readiness and load-balancer membership |

**Graceful shutdown (SIGTERM):**
1. Readiness turns 503.
2. Nest shutdown hooks stop the scheduler and the sweeps.
3. The job runner stops claiming and waits for running jobs; their leases expire if the process is killed, and another runner resumes them from checkpoints.
4. HTTP closes.

## 4. Alerts

The rules are in `ops/monitoring/alerts.yml`, with one runbook section per alert (docs/runbooks/campaigns.md §6):

- queue backlog, dead letters;
- scheduler lag and failures;
- execution stuck;
- provider failure spike and configuration failure;
- retry storm;
- bounce spike, complaint spike;
- webhook failures;
- database saturation, Redis (rate-limit store) unavailable;
- API server errors;
- audience count-bitmap backlog.

They are severity `page` or `ticket`. There is no alert on single events that already retry by themselves.

## 5. Not covered here (FUTURE / deployment)

- Distributed tracing (OpenTelemetry): the correlation id covers request → events → jobs today.
- Dashboards: they belong to the monitoring deployment (Gate G).
- Database-side metrics (`pg_stat_statements`, connection saturation): the database exporter of the deployment.
