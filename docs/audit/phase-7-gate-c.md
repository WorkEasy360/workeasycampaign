# Gate C — Production infrastructure (Phase 7.6–7.13): audit record

**Result: PASS (2026-10-09).** Official progress 65 % → 80 % (docs/audit/progress-accounting.md).

Owner definition: "Provider delivery, webhooks, scheduler, suppression, observability and recovery complete." Real
provider-account and customer-DNS validation are environment-dependent. They are Gate H items, not counted here:
everything here is implemented and proven against deterministic doubles.

## 1. Scope delivered

| Milestone | What | Evidence |
|---|---|---|
| 7.6 Durable queue | PostgreSQL job queue (leases, heartbeats, back-off, dead letters); process roles | `job-queue.test.ts` (db 9), `job-queue-runtime.test.ts` |
| 7.7 Providers | Outcome taxonomy; Mailgun and SMTP adapters; production delivery port | `packages/channels` (29), `campaigns-delivery-outcomes`, `provider-delivery` |
| 7.8 Unsubscribe and deliverability | Signed unsubscribe (RFC 8058); dedicated, rotatable key (`UNSUBSCRIBE_SECRET`); sending domains (DNS); sender identities | `campaigns-unsubscribe`, `senders`, `config.test.ts` |
| 7.9 Webhooks | Raw-body HMAC; single-use token per body; deduplication; order-independent rollups; bounce/complaint → Audience suppression; provider unsubscribe → consent | `delivery-webhooks.test.ts` (7) |
| 7.10 Analytics | Rollup-based engagement; distinct reasons (not tracked, unsupported, not applicable, unavailable); per-campaign results; UI | `engagement.test.ts`, `campaigns-analytics`, web results/outcomes tests |
| 7.11 Sending rate | Provider, workspace and per-run token buckets in PostgreSQL, shared by workers; UI control | `send-rate.test.ts` (db 6), `campaigns-sending-rate.test.ts` (3) |
| 7.12 Observability | Token-protected `/metrics` (no ids or PII in labels); readiness with dependencies (DB, queue, Redis) and draining; Redis outage fails closed (503); 15 alerts with runbooks | `health-metrics.test.ts`, `observability.test.ts`, `ops/monitoring/alerts.yml` |
| 7.13 Usage metering | Append-only ledger, exactly once with the fact; live sends only; daily gauges (stored import bytes only); org usage API and page | `usage.test.ts` (6), web usage test |
| Live delivery (owner-authorized 2026-10-09) | Implemented, OFF by default; boot requires provider, webhook and DNS settings; per-customer domain; sender verification blocking | `delivery-live.test.ts` (2), `config.test.ts`, channels |

## 2. Defects found and fixed during the Gate C regression (each with a regression test)

| Defect | Fix | Test |
|---|---|---|
| WCAG 1.4.1: an in-sentence link distinguishable by colour only (draft editor) | always underlined | E2E axe (phase6-a11y, phase6-content) |
| `storage.bytes` counted import files already deleted | counts only imports still holding their file | `usage.test.ts` (cancel → 0) |
| Redis outage: rate-limited routes answered 500 | 503 + Retry-After (fail closed); readiness names it; Redis metric and alert | `health-metrics.test.ts` (Redis down) |
| Unsubscribe links signed with `SESSION_SECRET` (a rotation would break delivered emails) | `UNSUBSCRIBE_SECRET` with previous keys | `config.test.ts` |
| `app.audience_snapshot_guard()` executable by PUBLIC | additive REVOKE migration | `security-invariants.test.ts` (no PUBLIC function) |
| fastify 5.11.3: 7 advisories (incl. X-Forwarded spoofing under hop-count trust); csv-parse advisory | fastify 5.12.5 (pnpm override), csv-parse 7.0.3; `TRUST_PROXY` hop counts refused | `pnpm audit --prod`: no known vulnerabilities; `config.test.ts` |
| Live mode: the UI would have claimed "test mode"; sender problems were never blocking (`liveDelivery` not passed) | no banner in live mode; `liveDelivery` wired into views and pre-flight | `campaigns.test.tsx` (mutation-checked), `delivery-live.test.ts` |
| Interaction-heavy web tests CPU-bound near their 5 s budget (timer tick per keystroke) | `userEvent.setup({ delay: null })`: same events, no artificial waits (no timeout raised) | 4 files |

## 3. Final regression (final source, 2026-10-09; awake runner, 0 standby events in every window)

| Step | Result |
|---|---|
| Migrations from an EMPTY test database | 27 of 27 applied (6.7 s); security invariants pass |
| Package boundaries | PASS (448 modules, 2,198 dependencies; 0 violations) |
| Typecheck (9 packages) | PASS |
| Build (all) | PASS |
| `packages/db` | 140 passed |
| `packages/shared` | 62 passed |
| `packages/audience-core` | 86 passed |
| `packages/channels` | 29 passed |
| `packages/content` | 120 passed |
| `packages/audience-infra` | 81 passed, 7 skipped (opt-in scale tests) |
| `apps/web` | 115 passed (see §4) |
| `apps/api` | 678 passed, 10 skipped (opt-in benchmarks) |
| `apps/worker` | 9 passed |
| E2E run 1 / run 2 (incl. axe WCAG 2.1 A/AA on every screen, Phase 7 screens) | **60 / 60** and **60 / 60** |
| `git diff --check`, `.only`, unconditional skips | clean; every skip is an opt-in benchmark switch |
| Secrets in source | none (`.env` git-ignored) |
| Dependency audit (production) | no known vulnerabilities |

## 4. Conditions recorded (not hidden)

1. **Web suite under load.**
   - 115/115 when run as a suite on the final code.
   - In two full sequential runs (r11, r12b) on a battery-throttled CPU, right after the heavy database suites, 5 and 12 interaction-heavy tests exceeded their 5 s budget or a 1 s `findBy`. Each passes standalone.
   - Cause: CPU throttling (laptop discharging) plus parallel jsdom workers. No code change, and no timeout raised.
   - Action: CI runs the suite on dedicated runners; run the regression on AC power.
2. **audience-infra intermittent timing.** 1 failure in 4 full runs today: a bitmap-repair chunk transaction exceeded 10 s once.
   - Two hypotheses tested and NOT confirmed (cold statistics; stale statistics). It passes unchanged.
   - Production impact is bounded: the maintenance job retries, and estimates fall back to the exact path.
   - Classified ACCEPTABLE PRE-PRODUCTION, monitored by the `AudienceCountBitmapBacklog` alert.
3. **Benchmarks (MEASURED, 0 standby):**
   - Engagement, 10k–1M: 318–347 webhook events/s per process (p95 ≤ 66 ms); analytics and results p50 10–15 ms, flat with size.
   - Execution: Gate E record (docs/audit/phase-7-release-gates.md).

## 5. Not in Gate C (stated, not waived)

- Real Mailgun account, live webhooks, customer DNS → Gate H.
- Docker images not built (no container engine on this host) and CI not yet run → Gate G.
- Organization-wide and domain-level suppression; first-party open/click tracking with bot classification → FUTURE PRODUCT FEATURE (need product decisions; frozen Audience contract).
