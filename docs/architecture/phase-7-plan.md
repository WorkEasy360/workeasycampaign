# Phase 7 plan — from Phase 6 to a releasable Campaigns product

**Status:** ACTIVE · **Started:** 2026-10-08 · **Progress accounting:** `docs/audit/progress-accounting.md`

Milestones run in order; each has an evidence gate (tests, docs, boundaries/typecheck/build) before the next starts.
The architecture, the frozen contracts and the bounded contexts are kept. Content and API changes are additive and
versioned, with a recorded contract amendment.

## Inventory at the start (MEASURED, 2026-10-08)

| Area | Exists | Missing |
|---|---|---|
| Jobs | `InlineJobDispatcher` (in-process, after commit) + recovery sweep; worker app with BullMQ/ioredis dependencies and a tenant-job envelope | durable queue; worker consumers; dead letters |
| Scheduling | `schedule` / `reschedule` / `unschedule` with IANA zone; executions `pending` with `send_at`; partial index for due discovery | due discovery and start at `send_at` (contract §9.1, deferred) |
| Templates | CRUD, clone, apply, save-as, search by name, optimistic version, soft delete | version history, restore, categories, audit of every change |
| Content | email.content.v2 blocks, merge tags (closed allowlist), renderer, preview | dynamic content, custom-field personalization, reusable blocks, device preview, test send |
| Sender | `fromName`, `replyTo`; `senderIdentityId` always null | sender identities, verified domains |
| Delivery | `CampaignDeliveryPort`, `NullDeliveryPort` (test mode) | provider adapters, outcome taxonomy, webhooks |
| Tracking / analytics | contracts, reference metric semantics; pipeline analytics | producers, engagement store, rollups |
| Suppression | Audience-owned `suppressions`, `provider_message_routes` tables | bounce/complaint/unsubscribe producers through Audience ports |
| Segments | — (the Audience contract rejects a `segment` selector) | an Audience feature, outside Campaigns |

## Environment dependencies (known now, reported per gate, never counted as passed)

| Dependency | Why it is external | Effect |
|---|---|---|
| Redis | Docker Desktop's engine fails (HTTP 500: WSL is not installed; installing needs admin rights and a reboot). No native Redis | BullMQ adapter tests need `REDIS_URL`; they are environment-gated and reported as NOT RUN until a Redis exists |
| Email provider account and credentials | not in the repository | provider adapters are validated with deterministic doubles and recorded fixtures; live validation is NOT RUN |
| Real DNS for a customer sending domain | needs a domain the operator controls | DNS verification logic runs against a resolver port (tested with doubles); live verification NOT RUN |
| Human screen-reader pass | needs a person with NVDA/JAWS/VoiceOver | Gate F stays open until it is done; the procedure is written |
| Production infrastructure (hosts, TLS, managed Postgres, object storage) | not available here | deployment artefacts and procedures are written; backup/restore is tested on the local cluster only |

## Milestones

### Gate B — core product
| # | Milestone | Scope |
|---|---|---|
| 7.1 | Templates | immutable version history, restore (as a new version), categories, search + filter + pagination, audit for every change, deleted-template protection, clone independence |
| 7.2 | Content v3 (contract amendment) | dynamic content (bounded conditions on contact fields, deterministic, no code, preview), custom-field and workspace merge fields (allowlisted), escaping in every context (text, attribute, URL, header), reusable saved blocks |
| 7.3 | Builder | device preview (mobile/desktop), condition editor, field picker with custom fields, saved blocks, test-send architecture (own verified address, through the delivery port; refused while delivery is disabled) |
| 7.4 | Creation workflow and audience UX | guided steps driven by server readiness, estimate vs exact vs frozen audience clearly labelled, sample recipients without unnecessary PII, confirmation |
| 7.5 | Scheduling | due discovery (definer function, partial index), scheduler tick (multi-instance safe, state only in PostgreSQL, catches up after downtime), reschedule/cancel races, workspace time zone default |

### Gate C — production infrastructure
| # | Milestone | Scope |
|---|---|---|
| 7.6 | Durable queue | BullMQ `JobDispatcher` + worker consumers, bounded retries with backoff, dead letters, graceful shutdown; inline dispatcher kept for tests and single-process development |
| 7.7 | Delivery adapters | outcome taxonomy (accepted, deferred, bounced, rejected, complaint, unknown; permanent vs transient), provider adapters behind the port, timeouts, idempotency, provider message ids |
| 7.8 | Sender identities and deliverability | sender identities, domain verification through a DNS resolver port (SPF, DKIM, DMARC guidance), List-Unsubscribe (RFC 8058 one-click), unsubscribe endpoint → Audience consent port |
| 7.9 | Webhooks and tracking producers | verified, deduplicated, order-independent webhook ingestion; open/click tracking (signed links); engagement events; bounce/complaint → Audience suppression port |
| 7.10 | Analytics | engagement metrics from rollups; unavailable vs zero vs not tracked; benchmarks 10k–1M |
| 7.11 | Throttling | workspace, campaign and provider rate limits; backoff on provider throttling |
| 7.12 | Observability | metrics endpoint, liveness/readiness/dependency health, graceful shutdown, alert definitions |
| 7.13 | Usage metering | usage events for billing (no pricing in the domain) |

### Gates D–H
| # | Milestone |
|---|---|
| 7.14 | Database hardening: temp-spill attribution, bitmap-rebuild lock deadline, snapshot-guard REVOKE, memory investigation |
| 7.15 | Gate D — adversarial security audit (every finding fixed with a regression test) |
| 7.16 | Gate E — scale 10k/100k/500k/1M, repeated, p50/p95/p99/max, failure injection |
| 7.17 | Gate F — accessibility: WCAG 2.2 AA automated + manual screen-reader pass |
| 7.18 | Gate G — operations: production config validation, deployment artefacts, backup/restore test, runbooks, alerts |
| 7.19 | Gate H — final matrix and release decision |

## Classified as FUTURE PRODUCT FEATURE (not release blockers for a Campaigns product)

| Feature | Why it is not a blocker | What is done now |
|---|---|---|
| Segments | Audience-owned; the frozen Audience contract has lists, tags and topics, which campaigns already target | — |
| Recipient-time-zone sending | contract §9.1 "per-recipient timing" is a later phase; workspace and campaign zones are supported | — |
| Journeys / automation | a separate bounded context; Campaigns must not depend on it | contracts only, no coupling |
| AI assistance | explicit user action only; needs a provider account | the disabled port and contracts stay; no AI is added for marketing |
| CRM, OAuth, external events integrations | outside Campaigns | the existing channel/webhook boundaries stay |
