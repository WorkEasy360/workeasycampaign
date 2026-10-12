# Phase 6.10–6.12 — Campaign events and audit, campaign UI, end-to-end flows — implementation and audit record

**Status:** 6.10 **PASS** · 6.11 **PASS** · 6.12 **PASS** (gate: two consecutive full E2E runs) · **Date:** 2026-10-08 ·
**Delivery:** TEST MODE ONLY (`CAMPAIGN_DELIVERY_MODE=test`, NullDeliveryPort). Production delivery is NOT enabled.

Evidence labels: **MEASURED** (observed here), **INFERRED** (reasoned), **NOT TESTED**. Host: Windows 11 laptop,
PostgreSQL 16 local, Node 24.19.

---

## 1. 6.10 — Domain events and audit

| Item | Implementation |
|---|---|
| Events | All campaign events go through the transactional outbox (`appendDomainEvent`), in the same transaction as the state change. Runner events carry `origin.source = 'campaign_runner'` |
| Correlation | Every request id becomes the correlation id. Send-now: the user's command events and the runner's system events share one correlation id. The recovery sweep reuses the id of the execution's `campaign.scheduled` event |
| Audit actions (new) | `campaign.returned_to_draft`, `campaign.version_restored`, `campaign.execution_started`, `campaign.execution_completed` (with counts), `campaign.execution_failed` (`outcome: 'failure'`). Runner audits use the system actor (`principal: null`) |
| Isolation | `domain_events`: workspace-scoped within the organization (Phase 5 RLS policy). `audit_logs`: organization-scoped (Phase 4). Both are by design |
| Contract | `docs/events.md` (campaign section IMPLEMENTED); `docs/contracts/phase-6-campaign.md` §"Audit actions (6.10)" |

**Tests** (`apps/api/test/campaigns-events-audit.test.ts`, 9 tests):
- catalogue integrity and strict payload schemas;
- attribution per request id;
- one correlation id across user and system events;
- audit completeness, including `execution_failed`;
- a PII scan of payloads;
- RLS: another organization sees nothing; another workspace in the same org sees 0 events but does see the org's audits;
- audit read authorization.

MEASURED: 9/9, repeated; re-run 2026-10-08 together with the keep-alive test, 11/11.

## 2. 6.11 — Campaign UI

**Pages:**
- `/campaigns`: list with status tabs and counts, search, channel filter, show deleted, Load more, and the create dialog.
- `/campaigns/[id]`: draft editor and Review rail for drafts; execution and history panels otherwise.

**Rule:** the UI renders server fields only (`allowedActions`, `blockedActions` reason codes, findings, capabilities, execution counts). It derives no counts and no permissions of its own.

| Area | Behaviour |
|---|---|
| Editing | Save sends a PATCH with only the changed fields plus `expectedVersion`. A conflict shows "Changed by someone else" and keeps the user's edits. Dirty state is tracked against a base snapshot, so a restore refreshes the form |
| Readiness | Findings are grouped and link to their fields. The estimate shows its sample size. The unavailable state is honest ("temporarily unavailable … recovery requested") and never shows an invented number. The cooldown follows `Retry-After` |
| Lifecycle | Schedule and send-now stay visible when blocked, disabled, with the reason in plain language (`aria-describedby`). Every destructive action has a confirmation. Schedule shows the estimate and both time zones and sends an idempotency key |
| Execution | Shows "Sent N of P planned" from server counts, with a progressbar (`aria-value*`), stalled / retrying / failure explanations, skip reasons, a timeline and earlier runs |
| History | Version snapshots, and restore with `expectedVersion` |

**API additive change:** `executionSummary.lastProgressAt` (a nullable UTC instant). OpenAPI was regenerated (`docs/api/openapi.json`).

**Defects found and fixed during 6.11:**
- restore did not refresh the form;
- two axe `definition-list` violations;
- raw reason codes were shown to users;
- dialog autofocus did not work with native `showModal`;
- labels were not associated with custom-id fields.

**Tests:** web 61/61 (MEASURED, 2026-10-08), including 7 list tests and 14 detail tests. The detail tests include the restore-refresh regression and the mapping of blocked-reason codes.

## 3. 6.12 — End to end

- `apps/e2e/tests/phase6.spec.ts`: all 21 flows, through the real web app, API and test database (test delivery mode).
- `apps/e2e/tests/phase6-a11y.spec.ts`: axe WCAG A/AA on every campaign screen and dialog, plus keyboard safety.

**Fixtures seeded through the owner connection** (documented in the spec header):
- a running execution, used for pause and resume;
- degraded audience resolution: the bitmap invalidated, plus an `ACCESS EXCLUSIVE` lock on `list_memberships` that is released in `finally`.

### 3.1 Full-suite runs (45 tests: Phases 4, 5 and 6)

| Run | Result | Note |
|---|---|---|
| 1–4 | intermittent hang | Latent Phase 5 defect (§3.2); fixed |
| 5 | 45/45 PASS (1.6 min) | |
| 6 | 1 failed, 41 passed, 3 not run (5.8 h) | **Void, environmental** (§3.3) |
| 7 | 45/45 PASS (1.7 min) | |
| **8** | **45/45 PASS (2.5 min)** | consecutive pair, with keep-awake |
| **9** | **45/45 PASS (1.9 min)** | consecutive pair, with keep-awake |

The gate is met by runs 8 and 9 (MEASURED).

### 3.2 Defect: keep-alive socket reuse after an early 413 (Phase 5, latent)

**Symptom:** an upload rejected while it was still streaming (413) was answered before its body was fully read. The server kept draining the declared remainder. The web proxy reused the socket, so the next request was swallowed as the rest of that body and hung.

**Fix:** `ErrorFilter` sends `connection: close` when `!req.raw.complete`.

**Regression test:** `apps/api/test/http-connection.test.ts`. It fails without the fix and passes with it (MEASURED). A second test checks that complete requests keep their keep-alive connection.

### 3.3 Run 6 investigation: Modern Standby, not a race

Run 6 failed flow 20 (degraded resolution) after 5.8 h.

The Windows System event log (Kernel-Power, MEASURED) shows:
- standby entered at **03:12:42** (lid closed) while flow 20 was in progress;
- exit at **08:56:47**.

The API's errors were logged at 08:56:48. They were Prisma "expired transaction" errors with 20,645,582 ms elapsed, which is the standby window. A diagnostic run hung the same way, and that hang also matches a standby (12:02:29 → 12:12:28).

**Controlled reproduction** (an API-level diagnostic: invalidate the bitmap, hold the lock, run preflight, then send-now):
- 7 of 7 runs correct while the machine was awake: preflight returned 200 with the estimate unavailable; send-now returned `409 PREFLIGHT_UNAVAILABLE` in about 1.1 s; nothing was scheduled (MEASURED).
- `pg_locks` showed the preflight's exact query cancelled by its 1 s budget, as designed.
- The only session still waiting was the background bitmap rebuild's repair statement.

**Also checked:** Prisma interactive transactions keep their pooled connection until an in-flight query ends; an expired transaction does not hand out a busy connection (MEASURED, separate experiment).

**Conclusion:** run 6 is void. No test was skipped or weakened.

**Follow-up (reliability milestone, not a 6.12 defect):** while `list_memberships` is held under a long-lived exclusive lock, the rebuild's repair statement has no lock or statement deadline. It keeps one pooled connection for the duration of the lock, beyond its 10 s transaction timeout (INFERRED from `audience_count_repair_chunk`, which resets `lock_timeout` to 0; observed holding a connection in the diagnostic).

## 4. Gates (2026-10-08)

| Gate | Result |
|---|---|
| Package boundaries + dependency-cruiser | PASS: 325 modules, no violations (MEASURED) |
| Typecheck (all packages) | PASS (MEASURED) |
| API build; web production build (in the E2E web server) | PASS (MEASURED) |
| Web unit tests | 61/61 (MEASURED) |
| 6.10 + keep-alive API tests | 11/11 (MEASURED) |
| E2E full suite ×2 consecutive | 45/45, 45/45 (MEASURED) |
| Production delivery | NOT ENABLED (by design) |
