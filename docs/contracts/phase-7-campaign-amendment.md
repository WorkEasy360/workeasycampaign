# Phase 7 campaign amendment — workflow, audience UX, scheduling

**Status:** ACTIVE · **Base:** `phase-6-campaign.md` (frozen). Everything here is additive; the lifecycle, the
transitions, the version and execution model and the locking rules are unchanged.

## §W Creation workflow and audience UX (milestone 7.4)

| # | Decision |
|---|---|
| W1 | **The steps show the server's quick check.** The steps are Details, Audience, Sender, Message, Schedule, then Review and send. Each step's status comes only from the campaign view's readiness findings for its sections; the client never decides readiness. "Review and send" is ready only when the server says `readiness = ready`. Each step moves focus to its section. |
| W2 | **Three audience notions, always labelled.** (a) *In the audience now (exact)*: the pre-flight count, live and exact up to the capture limit. (b) *Can receive it (estimate)*: eligibility measured on a uniform sample. (c) *Frozen audience*: the execution's recipients, fixed when sending started (`materializedAt`); later list changes are not included. The UI never presents an estimate as exact, or a live count as the frozen one. |
| W3 | **Sample recipients:** `GET /campaigns/{id}/audience-sample` returns at most 5 contacts of the live audience (a uniform sample, so it differs per call), with eligibility and reason codes. It returns display names only, never addresses. It needs `contacts.read` (it reveals who is in the audience), uses the same bounded resolution as pre-flight (degraded resolution gives `unavailable: true`, never an error), and is limited to 300 per user per hour. It reaches Audience only through ports (Resolution, Eligibility, Profiles.displayNames). |

**Evidence (MEASURED):** API `campaigns-audience-sample.test.ts`, 3 tests: names, eligibility and reasons, with no `@` anywhere in the response; an empty audience gives an empty sample; contacts.read is required (403); other organizations get 404. Web: the steps reflect server findings per section and move focus; the sample appears only on request and only with contacts.read.

## §D Scheduling (milestone 7.5) — closes contract §9.1 "due discovery is deferred"

| # | Decision |
|---|---|
| D1 | **Durable by construction.** The only schedule state is the execution row (`pending` + `send_at`) in PostgreSQL. Nothing lives in browser timers, frontend state, in-memory timers or process uptime. A scheduler tick (every `CAMPAIGN_SCHEDULER_INTERVAL_SECONDS`, 5–300, default 15, validated at boot) runs at process start and then periodically, and starts every due execution. A restart, a missed tick or downtime is caught up by the next tick, oldest first. |
| D2 | **Discovery** uses `app.due_campaign_executions(now, limit)`. It is SECURITY DEFINER with a pinned `search_path` and EXECUTE for the runtime role only, and returns `(org, workspace, execution, send_at)` of pending executions due now, through the partial index `(send_at) WHERE status = 'pending'`. It processes at most 500 per tick (the function caps at 1,000). |
| D3 | **Start remains the existing guarded transition.** Each due execution is dispatched to the ordinary `start` job inside its own tenant (RLS), with the correlation id of the scheduling request. `start` re-checks `status = pending` and `send_at ≤ now (+5 s tolerance)` under the campaign → execution lock. So **several schedulers may run at once** (several API instances or workers): a duplicate dispatch is a no-op, and an unschedule, reschedule or cancel that wins the lock is respected. |
| D4 | **Workspace time zone.** A new draft's schedule zone defaults to the workspace's time zone (tenancy setting `workspace.timezone`) instead of UTC. Users still pick any IANA zone; the server stores the UTC instant (unchanged). Per-recipient time zones are a FUTURE PRODUCT FEATURE (Phase 7 plan). |
| D5 | **Observability.** Each tick that finds work logs `campaign_scheduler_tick` with `due` and `maxLagMs` (how late the oldest due execution is); a tick failure logs `alert: campaign_scheduler_failed`. The metric and alert definitions come with milestone 7.12. |

**Evidence (MEASURED):** API `campaigns-scheduler.test.ts`, 8 tests, stable over 3 consecutive runs. A not-yet-due execution is untouched, and once due it is started and completes. After a process restart with an hour of downtime, everything overdue starts (lag reported). Two app instances ticking at once each start every execution exactly once (one `campaign.started` event, 0 duplicate recipients). Two simultaneous `start` calls give exactly one `started` and one `noop`. Unschedule, reschedule and cancel before the start are respected. A racing unschedule and tick never produce both outcomes. Each execution starts in its own tenant. The workspace time zone is the draft default.

**Not covered here:** with the in-process dispatcher, a started execution's `run` job lives in the process. A crash in the middle is recovered by the existing recovery sweep (contract §6.4). The durable queue is milestone 7.6.

## §U Unsubscribe (milestone 7.8a)

| # | Decision |
|---|---|
| U1 | **Signed link token** `u1.<ids>.<mac>` (about 90 characters): the organization, workspace and campaign-recipient ids as 48 bytes, plus an HMAC-SHA256 (SESSION_SECRET, purpose `unsubscribe-v1`) truncated to 128 bits. Ids only and unforgeable. It does not expire (unsubscribe links must keep working). It must fit one URL path segment; a first JSON-payload version did not (MEASURED: HTTP 414), hence the binary form. |
| U2 | **The `token` access policy.** `GET`/`POST /v1/unsubscribe/{token}` are authorized only by the token. Session cookies are ignored, so CSRF does not apply. The tenant comes from the token; everything is read in that tenant (RLS). An invalid token or a missing recipient is a plain 404. Limits: 300 GET and 120 POST per IP per hour. |
| U3 | **GET changes nothing** (link scanners and prefetchers open links). POST unsubscribes: JSON `{ scope: topic \| all }` from the confirmation page, or the RFC 8058 one-click form body `List-Unsubscribe=One-Click` (topic scope). It is idempotent (`changed: false` when already unsubscribed); a contact that is gone is not an error. |
| U4 | **Audience records it.** The new `ConsentRecorder` port (audience-core, additive) records it with actor `contact`, source `unsubscribe_link` or `list_unsubscribe`, and ids-only evidence (campaign, execution, recipient), through Audience's own consent rules and immutable history. The topic scope uses a topic preference; `all` withdraws the email channel. Future sends respect it through Eligibility (the next campaign skips the contact). |
| U5 | **Headers:** `List-Unsubscribe: <https://APP/api/v1/unsubscribe/TOKEN>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 2369/8058). The body link is the public page `/unsubscribe/TOKEN`. The provider delivery port adds both (milestone 7.7/7.8 assembly). |

**Evidence (MEASURED):** API `campaigns-unsubscribe.test.ts`, 5 tests: token tampering, truncation, wrong key and length ≤ 100; GET changes nothing; topic unsubscribe recorded with actor contact and ids-only evidence; idempotent; one-click form without session or CSRF and junk body 400; `all` withdraws the channel and the next campaign skips the contact; forged, wrong-key, cross-tenant and unknown-recipient tokens 404; a deleted contact gives 200 `changed: false`. `routes.test.ts`: every `token` route refuses a forged token with 404. Web page: 4 tests (no state change on open, both scopes, invalid link, failed submit).

## §S Sending domains and sender identities (milestone 7.8b)

| # | Decision |
|---|---|
| S1 | **Verified only from DNS.** A domain is verified only when all four checks pass on real DNS answers: ownership TXT `_workeasy.<domain>` = `workeasy-verification=<token>`; exactly one SPF record containing the provider's mechanism (`DELIVERY_SPF_INCLUDE`); a DKIM key or provider CNAME at `<DELIVERY_DKIM_SELECTOR>._domainkey.<domain>`; exactly one DMARC record. Without the provider settings, SPF and DKIM are `not_checked` and the domain stays pending, so it is never claimed verified. |
| S2 | **An outage never downgrades.** A DNS failure (timeout, SERVFAIL) is the check result `error`: the status stays as it was. A real record change (missing or wrong) makes a verified domain `failed` (verifiedAt cleared). Every status change is audited with the checks. Lookups are bounded (3 s × 2 tries), and verification is limited to 60 per user per hour. |
| S3 | **Input.** Public domains only: normalized to lower case; IPs, single labels and reserved names (`localhost`, `.local`, `.internal`, `.test`, `.example`, …) are refused. Local parts and display names are validated against header injection (no CR/LF, quotes or angle brackets), in the API and in database CHECKs. |
| S4 | **Readiness.** The chosen identity must exist (not deleted) and be on a verified domain. If not, the finding is `SENDER_NOT_VERIFIED`; no identity is `SENDER_NOT_CONFIGURED`. Both are errors once delivery is live and warnings in test mode (nothing reaches a real mailbox there). |
| S5 | **Tenancy and permissions.** Workspace-owned tables with forced RLS, soft delete, live names unique case-insensitively, and column-level UPDATE grants (the domain and its token cannot be changed). Reading needs `campaigns.read` (editors pick a sender); changing needs `deliverability.manage`. A domain with live identities cannot be removed. |

**Evidence (MEASURED):** unit `deliverability.test.ts`, 13 tests (every check outcome, CNAME DKIM, permerror SPF/DMARC, an outage never downgrades, unconfigured provider never verifies, input validation). API `senders.test.ts`, 4 tests: guidance records; verification from published records only; outage vs real change; validation and duplicates; identities verified through their domain; campaign readiness follows (warning → none → "no longer exists"); delete rules; viewer 403; other organizations 404; RLS hiding; no DELETE grant; no UPDATE of the domain column. Web: sending page 3 tests; sender picker in the draft editor.

**Environment-dependent (NOT RUN here):** verification of a real customer domain against public DNS (needs a domain under the operator's control). The resolver is the standard `node:dns` resolver; the logic is fully covered with a deterministic resolver.

## §R Sending rate (milestone 7.11)

Three limits apply to every hand-off; the slowest wins. All three are token buckets in PostgreSQL
(`send_rate_buckets`, shared by every worker process; RLS forced, no grants, functions `app.take_send_tokens` /
`app.refund_send_tokens` only).

| Limit | Set by | Bucket | Default |
|---|---|---|---|
| Provider account | `DELIVERY_RATE_PER_SECOND` | `provider:default`, burst = 1 s | none |
| Workspace fair share | `WORKSPACE_SEND_RATE_PER_SECOND` | `workspace:<id>`, burst = 1 s | none |
| Run | `PUT …/campaigns/{id}/executions/{executionId}/sending-rate` `{ maxPerHour: 1–1,000,000 \| null }` (`campaigns.send`; audited `campaign.sending_rate_changed`) | `execution:<id>`, burst ≈ 10 s (1 to the batch size) | none |

**Rules.**
- Tokens are taken in the claim transaction BEFORE recipients are claimed. A batch is never larger than what may be sent now.
- Tokens not used are refunded after the batch: recipients skipped at Checkpoint B, a batch stopped by provider back-pressure, or a pause or cancel since the claim.
- Without a token, the runner waits in-process up to 2 s. A longer wait (e.g. a 100/hour limit) frees the worker: the run continues as a durable delayed job (`SendRateWait`). This is not a failure: health stays `ok` and it does not count towards stalling.
- A run's limit may be set while the run is `pending`, `materializing`, `delivering` or `paused`, and applies from the next batch. A finished run → 422. It is a property of the run, not of the campaign version: the version stays frozen.
- Provider back-pressure (429 / Retry-After) is independent and still honoured (Phase 7.7). Pause and resume stay graceful: a paused run takes no tokens.
- Batch size: `deliveryBatch` (≤ 1,000, contract §6.3). Retries: transient failures at most 4 attempts with back-off; permanent failures are never retried (Phase 7.7 taxonomy).

**Evidence (MEASURED 2026-10-09):** `packages/db/test/send-rate.test.ts` and `apps/api/test/campaigns-sending-rate.test.ts`.
See docs/audit/phase-7-gate-c.md for results.

### §U.1 Unsubscribe link keys (Gate G, 2026-10-09)

Links are signed with `UNSUBSCRIBE_SECRET`. Production refuses to boot without it.

They used to be signed with `SESSION_SECRET`. Rotating that secret (the response to a session-secret leak) would have
broken every unsubscribe link in emails already delivered, and those links must keep working long after sending
(CAN-SPAM: at least 30 days).

**Rotation:** set a new `UNSUBSCRIBE_SECRET` and move the old value to `UNSUBSCRIBE_SECRETS_PREVIOUS`
(comma-separated). Links signed with any listed key verify; every key is checked in constant time. Outside production,
the session secret stands in.

Tested: `apps/api/src/config/config.test.ts` (required in production; rotation keeps old links valid; an unknown key fails).
