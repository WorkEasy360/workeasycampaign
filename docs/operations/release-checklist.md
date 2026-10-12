# Release checklist — Workeasy Campaigns

Use it for every production release. Every step is a yes/no check; stop at the first "no".
References: deployment (docs/operations/deployment.md), backup and restore (backup-restore.md), alerts and runbooks
(docs/runbooks/campaigns.md §6).

## 1. Before the release window

- [ ] CI (`.github/workflows/ci.yml`) is green on the release commit. That covers the audit, boundaries, migrations from empty, typecheck, build, every test suite and E2E with accessibility.
- [ ] Release notes list the migrations in this release. All are additive (expand/contract); none edits an applied one.
- [ ] Secrets exist in the secrets manager for every variable in docs/operations/deployment.md §2:
  - [ ] `SESSION_SECRET`, `DATA_FINGERPRINT_SECRET` and `UNSUBSCRIBE_SECRET`, each at least 32 random characters;
  - [ ] the database role URLs (runtime roles only for running services);
  - [ ] `REDIS_URL`;
  - [ ] SMTP;
  - [ ] `METRICS_TOKEN`.
- [ ] `TRUST_PROXY` is the load balancer's address range (CIDR); hop counts are refused.
- [ ] `JOB_QUEUE=postgres`.
- [ ] API: `PROCESS_ROLES=http`. Campaign worker: `PROCESS_ROLES=jobs,scheduler`.
- [ ] `CAMPAIGN_DELIVERY_MODE` is unset (`disabled`) for the first deployment. Live sending is enabled later, by configuration only, after §6.
- [ ] A backup or snapshot was taken, and its restore was proven within the last 30 days (`scripts/backup-restore-drill.mjs` or a platform restore test).

## 2. Images (first time and whenever the Dockerfile changes)

Measured locally on 2026-10-10: all four targets build, and `scripts/container-smoke.sh` passes 17/17. Repeat on the
build machine for every release.

- [ ] Run `docker build --target <migrate|api|worker|web> -t workeasy-<target> .` for each target and confirm it succeeds.
- [ ] Smoke infrastructure: a disposable PostgreSQL and Redis.
  - [ ] `docker run -d --name we-smoke-pg -e POSTGRES_PASSWORD=<throwaway> -p 55432:5432 postgres:16`
  - [ ] `docker run -d --name we-smoke-redis -p 56379:6379 redis:7`
  - [ ] `pnpm db:bootstrap`, with `DATABASE_ADMIN_URL` and the four role URLs exported for port 55432 (throwaway passwords). Bootstrap then writes nothing to `.env`.
  - [ ] `docker run --rm -e DATABASE_OWNER_URL=… workeasy-migrate` reports "All migrations have been successfully applied".
- [ ] `bash scripts/container-smoke.sh` reports 0 failed. It covers health and readiness, the web proxy to the runtime `API_URL`, headers, auth refusal, non-root, keep-alive, both workers staying up, and SIGTERM shutdown.
- [ ] `docker run --rm -e NODE_ENV=production workeasy-api` exits with "Invalid configuration" (fail fast).
- [ ] Started with a full staging configuration, `api` answers `GET /health` 200 and `GET /health/ready` 200.
- [ ] The campaign worker (`api` image, `PROCESS_ROLES=jobs,scheduler`) has its HTTP health check disabled or overridden: it has no HTTP listener. Watch its logs for "Worker started" and the job metrics instead.
- [ ] `web` serves `/login`, and `/api/v1/me/context` is proxied to the API (401 when signed out).
- [ ] Containers run as the non-root `workeasy` user (`docker exec … id`).

## 3. Deploy (in this order)

1. [ ] Migrations: run the `migrate` image once with `DATABASE_OWNER_URL` only. It exits 0.
2. [ ] Campaign workers: rolling update. Old processes finish their current job on SIGTERM (grace of 30 s or more).
3. [ ] API: rolling update. New instances join only when readiness is 200.
4. [ ] Web: rolling update.
5. [ ] Audience worker: restart.

## 4. Smoke test (within 15 minutes)

- [ ] `GET /health/ready` is 200 on every API instance, and the checks show the database, job queue and Redis as ok.
- [ ] `/metrics` scrapes with the token, and `workeasy_campaign_scheduler_ticks_total{outcome="ok"}` increases.
- [ ] Sign in; open the dashboard, contacts, campaigns and Settings → Usage. There are no 5xx responses (`workeasy_http_requests_total{status="5xx"}`).
- [ ] Create a draft campaign; pre-flight runs and shows readiness. Do NOT send to real recipients.
- [ ] Alerts are loaded (`ops/monitoring/alerts.yml`) and none is firing.
- [ ] No `alert:` entries in the error logs since the deploy.

## 5. Rollback

**Trigger:** a smoke test fails, the 5xx rate rises, a page-level alert fires, or data looks wrong.

1. [ ] Roll the API, workers and web back to the previous images. Schema changes are additive, so the previous release runs on the new schema; do NOT roll migrations back.
2. [ ] Campaign runs need no action: they continue from their checkpoints in PostgreSQL after the rollback, and no recipient is sent twice.
3. [ ] If data was damaged, follow docs/operations/backup-restore.md §3. Restore into a NEW database and keep the damaged one for investigation.
4. [ ] Record the incident (backup-restore.md §5).

## 6. Before enabling real sending (Gate H, separate change)

- [ ] Provider account created; API key and webhook signing key are in the secrets manager.
- [ ] `DELIVERY_SPF_INCLUDE`, `DELIVERY_DKIM_SELECTOR` and `DELIVERY_WEBHOOK_SIGNING_KEY` are configured. The webhook URL `https://<api>/v1/webhooks/mailgun` is registered at the provider.
- [ ] The first customer sending domain is verified in Settings → Sending domains (ownership, SPF, DKIM and DMARC all pass).
- [ ] Controlled smoke test to an internal mailbox only:
  - [ ] the message is delivered;
  - [ ] a `delivered` webhook is recorded;
  - [ ] the one-click unsubscribe works and is visible in the contact's consent history;
  - [ ] a hard bounce to a test address is suppressed;
  - [ ] the campaign results match.
- [ ] Only then: set `CAMPAIGN_DELIVERY_MODE=live`, `DELIVERY_PROVIDER=mailgun`, `MAILGUN_API_KEY` (and `MAILGUN_BASE_URL` for EU) on the API and campaign workers, and restart them. Boot refuses live mode while any required setting is missing.
- [ ] Send the first real campaign to an internal list. Watch `workeasy_provider_failures_total`, the bounce and complaint alerts, and the campaign results before sending to customers.

## 7. SMS and WhatsApp (separate, per channel; real messages only to internal numbers)

**SMS (Twilio):**
- [ ] Twilio account; a phone number or Messaging Service enabled for your destination countries. Complete the sender registration your countries require (e.g. US A2P 10DLC, India DLT templates).
- [ ] Advanced Opt-Out enabled on the Messaging Service (recommended: Twilio then tells Workeasy which replies are STOP/START, including custom keywords).
- [ ] Configure: `SMS_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (secret), `TWILIO_FROM` or `TWILIO_MESSAGING_SERVICE_SID`, and `TWILIO_STATUS_CALLBACK_URL=https://<api host>/v1/webhooks/twilio`. Restart. Capabilities now report SMS available.
- [ ] In Twilio, set the number's (or Messaging Service's) **incoming message** webhook to the SAME URL, `POST https://<api host>/v1/webhooks/twilio`. Without it, STOP replies are blocked by Twilio but NOT recorded in Workeasy consent. The URL must match `TWILIO_STATUS_CALLBACK_URL` exactly, because the signature covers it.
- [ ] Smoke test: an internal list of 1–2 team phones with SMS consent recorded.
  - [ ] Send now.
  - [ ] Confirm the text arrives with "Reply STOP to opt out.".
  - [ ] Campaign results show Delivered = number of phones.
  - [ ] `workeasy_webhook_events_total{type="delivered"}` increases.
  - [ ] `workeasy_webhook_rejected_total` does NOT increase. If it does, the callback URL differs from the one Twilio calls.
  - [ ] From one test phone, reply STOP.
    - [ ] That contact's SMS consent history shows "unsubscribed" (source `sms_stop`).
    - [ ] A second send skips the phone.
    - [ ] Reply START: consent is granted again (source `sms_start`).

**WhatsApp (Meta Cloud API):**
- [ ] Meta Business account, WhatsApp Business account, a phone number (its Phone number ID), and a system-user access token with `whatsapp_business_messaging`.
- [ ] A marketing template approved in WhatsApp Manager. Note its exact name, language and parameter count.
- [ ] Configure: `WHATSAPP_PROVIDER=meta`, `WHATSAPP_ACCESS_TOKEN` (secret), `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET` (secret, from the app's Basic settings), and `WHATSAPP_VERIFY_TOKEN` (any random string). Restart.
- [ ] In the Meta app, set the WhatsApp webhook: callback `https://<api host>/v1/webhooks/whatsapp`, verify token = `WHATSAPP_VERIFY_TOKEN`, subscribed to `messages`. Meta's "Verify and save" must succeed.
- [ ] Smoke test: an internal list with WhatsApp consent.
  - [ ] Send the template.
  - [ ] Confirm it arrives on WhatsApp with the parameters filled in.
  - [ ] Results show Delivered, and Opened once read.
  - [ ] Optional: on the test phone, use the template's "Stop promotions" option and send again. The send is refused (131050) and the contact's WhatsApp consent shows "unsubscribed" (source `whatsapp_opt_out`).

Real delivery for all channels still requires `CAMPAIGN_DELIVERY_MODE=live` (§6), and live mode requires the email provider settings even if you only want SMS or WhatsApp.
