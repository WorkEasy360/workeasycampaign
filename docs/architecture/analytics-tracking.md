# Campaign analytics and tracking architecture

**Status:** pipeline metrics (v1) and, since Phase 7.9/7.10 (2026-10-09), delivery outcomes and engagement from provider
webhooks and our unsubscribe endpoint, stored as events and per-execution rollups (§6). A first-party open pixel and click
redirect are NOT built (FUTURE PRODUCT FEATURE, §6.5). · **Date:** 2026-10-08, amended 2026-10-09 · **Related:** `docs/spec.md` M14,
`docs/events.md` (analytics events), `docs/contracts/phase-6-content-amendment.md` (renderer).

## 1. Principle: no fake metrics

A number is shown only when the system **measured** it. A metric that cannot be measured yet is reported as
`{ available: false, reason }` and rendered as "not tracked yet". It is never a 0 that a reader would take as "nobody
opened".

| Situation | API value | UI |
|---|---|---|
| Measured, possibly zero | `{ available: true, value: 0 }` | "0" |
| Not measurable in this deployment (no tracking or delivery) | `{ available: false, reason: 'tracking_not_enabled' }` | "Not tracked yet", with an explanation |
| Rate with a zero denominator | `{ available: false, reason: 'not_applicable' }` (7.10; `value: null` from v1 readers means the same) | "Not applicable" |
| The provider cannot report it | `{ available: false, reason: 'provider_unsupported' }` | "Not supported" |
| Nothing was handed to a provider | `{ available: false, reason: 'delivery_not_enabled' }` | "Unavailable" |

## 2. Metric definitions

### 2.1 Pipeline metrics: measured now, from Campaign-owned execution data

Their only source is `campaign_executions`. Its counts are maintained set-based by the runner and recomputed from recipient rows at completion (contract §6). Deleting contacts never changes them, since recipient rows are pseudonymous.

| Metric | Definition | Notes |
|---|---|---|
| Campaigns sent | executions with `status = 'completed'` whose `completed_at` falls in the period | one campaign can have several runs (re-schedules); runs are counted |
| Planned | Σ `planned` | recipients created as `pending` (eligible at capture) |
| Skipped | Σ `skipped` | not sent: ineligible at capture **or** at send time (Checkpoint B) |
| Skipped, by reason | Σ `skipped_by_reason[code]` | reason codes from Eligibility (e.g. `CONSENT_MISSING`, `SUPPRESSED`) |
| Sent | Σ `sent` | **accepted by the delivery port**. In test mode that is the NullDeliveryPort, so nothing reached a mailbox; the API says so (`deliveryMode`) |
| Failed | Σ `failed` | permanent send failure |
| Reach rate | sent / (planned + skipped) | the share of the captured audience that was sent to |

"Sent" is **not** "delivered". Delivered (accepted by the receiving mail server, i.e. no bounce) needs provider
callbacks (Phase 8), so it is reported as `available: false`.

### 2.2 Engagement and delivery-outcome metrics: defined now, measured later

They follow spec M14 (Zoho parity), with explicit denominators.

| Metric | Definition | Needs |
|---|---|---|
| Delivered | sent − bounced (hard + soft-final) | provider events (Phase 8) |
| Bounce rate | bounced / sent | provider events |
| Unique opens | contacts with ≥ 1 **human** open | open pixel (Phase 9); machine opens (Apple MPP, scanners) are counted separately |
| Open rate | unique human opens / delivered | delivered + opens |
| Unique clicks | contacts with ≥ 1 human click | link rewriting (Phase 9) |
| Click rate | unique human clicks / delivered | |
| CTOR | unique human clicks / unique human opens | |
| Unsubscribe rate | unsubscribes attributed to the campaign / delivered | unsubscribe endpoint (Phase 8) with campaign attribution |
| Complaint rate | complaints / delivered | provider feedback loops |

Both unique and total counts are kept (M14). Rates are computed from stored counts at read time and never stored, so a
corrected count never leaves a stale rate behind.

## 3. Tracking architecture: ports

Rendering is pure (`@workeasy/content`) and stays pure. Tracking attaches at the edges through ports; no layer skips
another (contract §9.1).

```text
renderEmail(content, data, ctx)                ← pure; no tracking knowledge
      │  ctx.links: LinkPolicy                  ← PORT (Phase 9): maps each safe href to a tracked redirect URL,
      │                                            or the identity (tracking off / per-link opt-out)
      │  ctx.openPixel: string | null           ← PORT output: a 1×1 image URL appended by the renderer, or none
      ▼
DeliveryPort.send(message, key)                ← exists (NullDeliveryPort in test mode); real adapter Phase 8
      │
provider ──callbacks──► ChannelAdapter.verifyCallback (exists, Phase 4) ──► DeliveryEventIngest (PORT, Phase 8)
                                                                               │  normalized MessageEvent
tracked redirect / pixel endpoint ─────────────────────────────────────────► TrackingEventIngest (PORT, Phase 9)
                                                                               │
                                                     analytics events (docs/events.md, append-only, batched)
                                                                               │
                                                     MetricsStore (PORT): per (campaign, execution) counters
                                                                               │
                                                     AnalyticsReader (this document §4) ◄── API / dashboard
```

| Port | Shape (sketch) | Owner | Phase |
|---|---|---|---|
| `LinkPolicy` | `wrap(href, { recipientId, linkIndex }): string` | Tracking | 9 |
| `DeliveryEventIngest` | `ingest(events: MessageEvent[])`, idempotent by provider event id | Delivery | 8 |
| `TrackingEventIngest` | `ingest(events: EngagementEvent[])`, bot classification at ingest | Tracking | 9 |
| `MetricsStore` | `increment(key, counters)` / `read(keys)`, idempotent per source event | Analytics | 9/11 |
| `AnalyticsReader` | `campaignMetrics(scope, ids, period)` | Analytics | **v1 now** (pipeline only) |

**Guarantees the ports must keep:**
- tenant from the routing table, never from the payload (M12);
- one recipient id per message, so attribution needs no contact lookup;
- pixel and redirect tokens are signed and carry no personal data;
- tracking respects the snapshot's `tracking: { opens, clicks }` flags, which are `false` in every version today.

## 4. Analytics v1 (implemented)

**Endpoint:** `GET /v1/workspaces/{ws}/campaigns/analytics?from=&to=` (`reports.read`). The period is UTC, at most 366 days, defaulting to the last 30 days.

**Response:**
- `pipeline` (§2.1, measured);
- `engagement` (§2.2: every metric `{ available: false, reason: 'tracking_not_enabled' }`);
- `deliveryMode` (so "sent" is never mistaken for real delivery);
- `perCampaign` (top 20 by sent, with the same pipeline metrics).

**Rules:**
- RLS-scoped to the workspace.
- Aggregates only: no recipient or contact data.
- Read-only.
- One indexed aggregate query plus one grouped query.

## 5. Tracking contracts in code (2026-10-08; inactive by design)

| Piece | Where | Status |
|---|---|---|
| Message events v1 (`sent`, `delivery_accepted`, `delivery_failed`, `bounced`, `complained`, `opened`, `clicked`, `unsubscribed`): strict, versioned, PII-free (ids, codes, timestamps, classifications only; a click carries the link's index, never its URL) | `packages/shared/src/tracking.ts` | implemented; no producer |
| Reference metric semantics: idempotent on `eventId`, order-independent, per recipient; machine opens never human; a human click implies an open; only hard bounces are undelivered; rates are `null` with a zero denominator | `apps/api/src/modules/campaigns/domain/message-metrics.ts` | implemented; the future MetricsStore must reproduce it |
| `MessageEventIngest` port, bound to `DisabledMessageEventIngest` (accepts nothing) · `LinkPolicy` port, with `UNTRACKED_LINKS` (identity) | `apps/api/src/modules/campaigns/application/tracking.ts` | bound; no endpoint; nothing recorded |

Tests: `message-metrics.test.ts` (14 tests: PII rejection, required fields, definitions, idempotency, order independence,
null rates, disabled ports).

**Not built (needs Phases 8/9):** persistence, provider callbacks, the pixel and redirect endpoints, and bot detection.

## 6. Engagement from provider feedback (Phase 7.9/7.10, implemented 2026-10-09)

### 6.1 Producers
| Source | Events | Where |
|---|---|---|
| Provider webhooks (signed, replay-safe; docs/architecture/delivery-providers.md §6) | delivered, deferred (soft bounce), bounced (hard), complained, unsubscribed, opened, clicked | `DeliveryWebhooksService` |
| Our unsubscribe endpoint (link and RFC 8058 one-click) | unsubscribed (one per recipient: event id `unsubscribe:<recipient>`) | `UnsubscribeService` |

### 6.2 Storage
- `message_events`: append-only facts, UNIQUE (provider, provider event id); ids, type, time and a short reason code only.
- `recipient_engagement`: per-recipient firsts (the earliest time wins whatever the arrival order), bounce state (soft → hard), complaint, unsubscribe.
- `execution_engagement`: per-execution unique counters, changed in the same transaction as a NEW event only.
- Every table has RLS forced by workspace; the runtime role can update fact columns only.

### 6.3 Reads
- `GET …/campaigns/analytics`: the v1 response plus `engagement`, `engagementBasis` and per-campaign engagement. The 14 engagement metrics are: delivered, delivery rate, bounced, bounce rate, deferred, unique opens, open rate, unique clicks, click rate, CTOR, unsubscribed, unsubscribe rate, complained, complaint rate.
- `GET …/campaigns/{id}/results` (`reports.read`): all completed runs together, the latest 10 runs one by one, and `lastEventAt`.
- Both sum the rollups of the same completed runs as the pipeline. Nothing is recomputed from recipient rows or raw events on a request, and rates are computed at read time.

Denominators: delivery and bounce rate over sent; open, click, unsubscribe and complaint rate over delivered; CTOR over
unique opens. "Rejected" is the pipeline's `failed`.

### 6.4 What is measured where
| Deployment | Delivered, bounces, complaints | Opens / clicks | Unsubscribes |
|---|---|---|---|
| Test delivery without a provider | not tracked | not tracked | not tracked |
| Provider, no webhook signing key | not tracked | not tracked | **counted** (our links) |
| Provider + `DELIVERY_WEBHOOK_SIGNING_KEY` | counted | `DELIVERY_TRACKING` off → not tracked; on → counted; provider unable → not supported | counted (ours + the provider's) |

Opens and clicks reported by the provider are NOT machine-filtered (Apple Mail Privacy Protection, link scanners).
`engagementBasis.opensIncludeAutomated` is true and the UI says open rates are an upper bound. Provider data therefore
does not meet the "human" definitions of §2.2. Meeting them needs first-party tracking with bot classification (§6.5).

### 6.5 Not built — FUTURE PRODUCT FEATURE
- A first-party open pixel and click redirect (`LinkPolicy`, signed tokens).
- Human versus machine classification.
- Total (non-unique) open and click counts.

Provider-reported opens and clicks satisfy "open events where supported" and "click events" (master prompt §16); the
items above refine their quality.

### 6.6 Evidence (MEASURED 2026-10-09)
- `domain/engagement.test.ts` (5): rates, a real zero against not applicable, not tracked, unsupported, tracking off.
- `delivery-webhooks.test.ts` (7), `provider-delivery.test.ts` (3), `campaigns-analytics.test.ts` (6), `campaigns-unsubscribe.test.ts`.
- Web: `campaign-results.test.tsx` (4), `campaign-outcomes.test.tsx` (3).
- Benchmark (`test/engagement-bench.test.ts`): docs/audit/phase-7-gate-c.md.
