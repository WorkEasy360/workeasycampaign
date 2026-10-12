# Deployment — Workeasy Campaigns (Gate G)

**Status:**
- Procedure written against the actual configuration and code.
- Configuration fail-fast is TESTED (`apps/api/src/config/config.test.ts`).
- The backup → restore drill is TESTED locally (docs/operations/backup-restore.md).
- Container images and a cloud environment are NOT TESTED: this host has no working container engine. They are a deployment-environment task.

## 1. Processes

| Process | Command | Roles / purpose | Scale |
|---|---|---|---|
| Web | `pnpm --filter @workeasy/web exec next start --keepAliveTimeout 65000` (after `next build`; keep-alive above the load balancer idle timeout, which must be < 65 s), `API_URL` = internal API address, read at START (src/proxy.ts; one image works for any API address) | UI; same-origin `/api/*` proxy to the API | 2+ instances behind the load balancer |
| API | `node apps/api/dist/main.js` with `PROCESS_ROLES=http` | HTTP API only | 2+ instances; stateless (sessions in PostgreSQL, rate limits in Redis) |
| Campaign worker | `node apps/api/dist/main.js` with `PROCESS_ROLES=jobs,scheduler` (no HTTP listener) | durable job queue runner, campaign scheduler, recovery sweeps, daily usage snapshots | 1+ (runners claim disjoint jobs; schedulers are safe to run several, starts are guarded in the database) |
| Audience worker | `node apps/worker/dist/main.js` | Audience count-bitmap maintenance | 1 |

```text
                 HTTPS (load balancer, TLS; TRUST_PROXY = its CIDR)
                          │
             ┌────────────┴────────────┐
             ▼                         ▼
   Web (Next.js, 2+)  ──/api/*──▶  API (PROCESS_ROLES=http, 2+) ◀── provider webhooks (/v1/webhooks/mailgun, signed)
                                       │          │
                     Redis (rate limits only)     │
                                       ▼          ▼
                  ┌──────── PostgreSQL 16 (all state: tenants, campaigns, job queue, schedules, leases,
                  │           sending-rate buckets, usage ledger, audit; RLS forced, runtime roles only) ────────┐
                  ▼                                                                                          ▼
   Campaign worker (same API image, PROCESS_ROLES=jobs,scheduler, 1+)                  Audience worker (apps/worker, 1)
     jobs · scheduler · recovery sweeps · usage snapshots ──▶ Email provider (Mailgun; live mode only)
```

PostgreSQL 16 holds all state. That includes the job queue, schedules, leases, sending-rate buckets and the usage ledger.
No in-memory timer or process is authoritative. Redis holds only HTTP rate-limit counters.

## 2. Configuration (environment)

The API refuses to boot in production when something required is missing or unsafe (`NODE_ENV` defaults to
`production`):

- `APP_URL` must be https.
- `SESSION_SECRET` and `DATA_FINGERPRINT_SECRET` must be at least 32 characters and not the development values.
- `FILE_STORE_DIR`, `TRUST_PROXY` (never `true` or a hop count), `REDIS_URL` and `MAIL_FROM` are required, with `MAIL_TRANSPORT=smtp`.
- `JOB_QUEUE` must be `postgres` (the in-process queue is refused).
- An unknown `PROCESS_ROLES` value fails boot.
- An invalid `RATE_LIMIT_OVERRIDES`, `DELIVERY_*` or `METRICS_TOKEN` value fails boot.
- `CAMPAIGN_DELIVERY_MODE=test` is refused outside `NODE_ENV=test`. `CAMPAIGN_DELIVERY_MODE=live` boots only with `DELIVERY_PROVIDER`, `MAILGUN_API_KEY`, `DELIVERY_WEBHOOK_SIGNING_KEY`, `DELIVERY_SPF_INCLUDE` and `DELIVERY_DKIM_SELECTOR` (docs/architecture/delivery-providers.md §7).

| Variable | Process | Notes |
|---|---|---|
| `DATABASE_URL`, `IDENTITY_DATABASE_URL` | API, workers | runtime roles `workeasy_app` / `workeasy_identity` (no superuser, no RLS bypass) |
| `DATABASE_OWNER_URL` | migrations only | `workeasy_owner`; never given to a running process |
| `SESSION_SECRET`, `DATA_FINGERPRINT_SECRET` | API, campaign worker | secrets manager. Rotating `SESSION_SECRET` signs everyone out, invalidates pagination cursors **and outstanding unsubscribe links**: rotate with care |
| `APP_URL`, `TRUST_PROXY`, `PORT`, `LOG_LEVEL` | API | `TRUST_PROXY` = the load balancer's address range (CIDR), e.g. `10.0.0.0/8`; hop counts are refused |
| `REDIS_URL` | API | shared rate-limit store |
| `FILE_STORE_DIR` | API, campaign worker | shared volume for in-progress CSV imports (files are deleted when an import ends) |
| `MAIL_*`, `SMTP_*` | API | account e-mails (verification, invitations, reset) |
| `JOB_QUEUE=postgres`, `PROCESS_ROLES`, `JOB_CONCURRENCY` | API, campaign worker | see §1 |
| `CAMPAIGN_SCHEDULER_INTERVAL_SECONDS` | campaign worker | default 60 |
| `CAMPAIGN_DELIVERY_MODE` | API, campaign worker | unset = `disabled` (no sending). `live` = real sending; boot refuses it without the provider settings below |
| `DELIVERY_PROVIDER`, `MAILGUN_API_KEY`, `MAILGUN_BASE_URL` | API, campaign worker | `mailgun`; the key is a secret; base URL `https://api.mailgun.net` (US, default) or `https://api.eu.mailgun.net` (EU) |
| `DELIVERY_SPF_INCLUDE`, `DELIVERY_DKIM_SELECTOR` | API | the provider's DNS requirements (without them no sending domain can verify) |
| `SMS_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` or `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_STATUS_CALLBACK_URL` | API, campaign worker | SMS (docs/contracts/phase-7-messaging-amendment.md). The auth token is a secret. The callback URL is the exact public https URL of `/v1/webhooks/twilio` |
| `WHATSAPP_PROVIDER=meta`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_API_VERSION` | API, campaign worker | WhatsApp. The token and app secret are secrets. The webhook URL is `https://<api>/v1/webhooks/whatsapp` |
| `DELIVERY_WEBHOOK_SIGNING_KEY` | API | provider webhook key; unset = webhooks off (404) |
| `DELIVERY_TRACKING` | API, campaign worker | `opens`, `clicks` or both; default off |
| `DELIVERY_RATE_PER_SECOND`, `WORKSPACE_SEND_RATE_PER_SECOND` | campaign worker | provider account limit; per-workspace fair share |
| `METRICS_TOKEN` | API, campaign worker | bearer token for `/metrics`; unset = no endpoint |
| `RATE_LIMIT_OVERRIDES` | API | e.g. an office behind one NAT |

Secrets are never logged: logs are built from allowlists (docs/operations/observability.md §1).

## 3. Database setup and migrations

1. **Once per environment:** `pnpm db:bootstrap` with `DATABASE_ADMIN_URL`. It creates the roles (no superuser at runtime), the databases, and the schema ownership.
2. **Every release:** `pnpm db:migrate` (`prisma migrate deploy`) as `workeasy_owner`, BEFORE the new code starts.
3. **Migrations are additive** (expand → contract):
   - an applied migration is never edited;
   - a column or table is removed only in a later release, once no running code uses it.

   Old code therefore keeps working on the new schema during a rolling deploy.
4. **Rollback.** There are no down migrations.
   - Roll the CODE back: the previous release runs on the expanded schema.
   - A destructive mistake is recovered from backup (docs/operations/backup-restore.md).
   - Never run hand-written DDL against production.

Proven locally from an empty database: all 27 migrations in 6.7 s (2026-10-09, Gate C regression r9).

### PostgreSQL settings

Measured 2026-10-10: on a cluster with default settings (`max_wal_size` 1 GB, `shared_buffers` 128 MB), a 1M-recipient
campaign triggered a WAL checkpoint every 20–30 s, and page transactions slowed during those windows (p95 1,055 ms in
one run; the target is < 1 s). For production, start from:

| Setting | Value | Why |
|---|---|---|
| `max_wal_size` | 4–8 GB | Bulk recipient inserts generate WAL quickly; checkpoints should be time-driven, not size-driven |
| `checkpoint_timeout` | 15 min | Fewer, smoother checkpoints (with `checkpoint_completion_target` 0.9, the default) |
| `shared_buffers` | ~25 % of RAM | The default 128 MB cannot hold the working set of a large campaign |
| `work_mem` | 16–32 MB | Audience capture sorts and hashes; avoids temp-file spills |
| `log_temp_files` | 0 | Any spill to disk is logged with its statement |
| `log_autovacuum_min_duration` | 10 s | Shows long autovacuum runs next to slow pages |

Managed PostgreSQL services usually expose these as parameter groups.

## 4. Release order

1. Take a backup (or confirm the last automated one and WAL archiving).
2. Run the migrations.
3. Deploy the campaign workers. They finish their current job on SIGTERM; unfinished leases expire and are resumed elsewhere.
4. Deploy the API (rolling): readiness gates traffic.
5. Deploy the web.
6. Smoke test:
   - `GET /health/ready` is 200 on every API instance;
   - `/metrics` scrapes;
   - sign in;
   - open a campaign;
   - `workeasy_campaign_scheduler_ticks_total{outcome="ok"}` increases.

## 5. Probes and shutdown

- **Liveness** `GET /health`.
- **Readiness** `GET /health/ready`: database, job queue, Redis. It is 503 naming the failed dependency, and from the first moment of shutdown.
- **SIGTERM:**
  1. readiness turns 503;
  2. the scheduler and sweeps stop;
  3. the job runner stops claiming and waits up to 25 s for running jobs;
  4. HTTP closes.

  Give the process at least 30 s of termination grace.

## 6. Monitoring

Scrape `/metrics` of every API and campaign-worker process and load `ops/monitoring/alerts.yml`. Each alert has a
runbook section (docs/runbooks/campaigns.md §6). Add the database exporter of the platform for connection and
saturation metrics.

## 7. External steps before real sending (Gate H)

These are not in this repository; they need accounts and DNS access.

1. Create the provider account (Mailgun). Store its API key in the secrets manager.
2. Configure `DELIVERY_SPF_INCLUDE` and `DELIVERY_DKIM_SELECTOR` from the provider.
3. Point the provider's webhooks at `https://<api>/v1/webhooks/mailgun`. Set `DELIVERY_WEBHOOK_SIGNING_KEY` to the provider's webhook signing key.
4. For each customer domain: publish the records shown in Settings → Sending domains, then verify.
5. Validate end to end with a test account: delivered, bounce, complaint and unsubscribe events arrive and are reflected in campaign results and Audience suppression.
6. Only then set `CAMPAIGN_DELIVERY_MODE=live` (API and campaign workers) and restart. Leave it unset until the controlled smoke test has passed.
