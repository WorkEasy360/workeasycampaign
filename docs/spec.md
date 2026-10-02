# Workeasy Campaign — Reconciled Product Specification

Status: v1.0 (build step 1). Sources: the product brief (Parts 1–4, Modules 1–10), Part 1's capability list for
modules the brief does not detail, and a review of Zoho Campaigns 2.0/3.0 official documentation (Oct 2026).
Zoho is a functional reference only; every rule below is ours. "Zoho:" notes record the reference behaviour where we
deliberately differ.

Conventions: **MUST** = required for the module to ship. Limits are defaults, configurable per plan unless stated.

---

## 0. Cross-cutting rules

- **Tenancy.** Every record belongs to exactly one organization. Isolation is enforced in the service layer and by
  Postgres RLS (see `architecture.md` §4).
- **Channels.** Email, SMS and WhatsApp share one pipeline: audience → eligibility → delivery → events. No channel
  contains business logic.
- **Explainability.** Every automated decision (contact excluded, campaign paused, journey branch taken, score change)
  stores a machine-readable reason code shown in the UI. This is a core differentiator.
- **Audit.** Every mutation and security event is written to the audit log with actor, IP, user agent and diff.
- **Identifiers.** UUIDv7. Public API exposes the same IDs.
- **Time.** Stored in UTC; organization has a default time zone; contacts may have their own.

---

## M1. Authentication

Flows: sign up → email verification → (create org) → app; login; logout; forgot/reset password; change password;
session list + revoke; "remember this device" (30 days, skips MFA prompt only — never extends the session).

Rules:
- Passwords: min 10 chars, checked against a common/breached password list, Argon2id.
- Email verification token: single use, 24 h, hashed at rest. Unverified users can log in but cannot send.
- Reset token: single use, 1 h, invalidates all sessions on use.
- Session: idle timeout 7 days, absolute 30 days, rotated on privilege change.
- Brute force: 5 failures/15 min per account → progressive delay; 20/15 min per IP → block 15 min. Generic error
  messages (no account enumeration).
- Login state machine: `credentials_ok → (mfa_required → mfa_ok) → authenticated`. MFA factors (TOTP, WebAuthn),
  OAuth (Google/Microsoft) and SAML/OIDC SSO plug into `user_identities` / `user_mfa_factors` without schema changes.
- Org-level policy (enterprise): enforce MFA, enforce SSO, session lifetime.

## M2. Organization, users, roles

- One user may belong to several organizations (org switcher). Invitations by email, expire in 7 days.
- System roles (immutable, seeded): **Owner** (billing, delete org), **Admin**, **Manager** (create + send),
  **Editor** (create/edit, cannot send), **Analyst** (reports + export), **Viewer** (read-only).
- Custom roles: any subset of the permission catalogue. Permission granularity = `module.action`, actions from
  `read, create, update, delete, export, send/launch, approve, manage`.
- Org must always have ≥1 Owner. Owners cannot be removed by Admins.
- **Approval policies** (improvement over Zoho's per-user toggle): rules such as "campaigns by role X / to audience
  > N / on topic Y require approval by role Z". Any edit after approval invalidates it. Applies to email, SMS,
  WhatsApp and journey launch.
- Zoho: Workspaces inside orgs. We defer workspaces; the schema reserves a `workspace_id` seam on content tables.

## M3. Dashboard (command center)

Cards: campaigns sent / scheduled, active journeys, contacts (marketing / non-marketing / unsubscribed),
per-channel performance, deliverability health, engagement trend, revenue + conversions (when connected),
recent activity, upcoming sends, journey failures, integration health, domain health.

Every metric card has three layers: **value → change vs. baseline → insight + recommended action**
(e.g. "Open rate −18% vs. last 5 campaigns. 41% of recipients inactive >90 days. → Create re-engagement segment").
Insights come from a rules engine first (deterministic, testable), with AI phrasing as an enhancement.
Data comes only from rollup tables; dashboard p95 < 300 ms.

## M4. Contacts

- Fields: system (email, phone, WhatsApp number, first/last name, company, country, city, time zone, language,
  lifecycle stage, source, owner) + custom fields (text, number, decimal, boolean, date, datetime, picklist,
  multi-select, URL, email, phone). Max 200 custom fields/org.
- **Identity:** a contact may have multiple channel addresses; email and phone are unique per org (normalized,
  phone E.164). Merge duplicates with field-level survivorship; merge is audited and reversible for 30 days.
- **Subscription type** (Zoho-compatible semantics): `marketing`, `non_marketing`, `unsubscribed`. Only marketing
  contacts receive marketing sends and count toward plan limits. A self-unsubscribed contact can be resubscribed only
  by their own action (form or preference center).
- Lifecycle stage: subscriber → lead → MQL → SQL → customer → evangelist (configurable).
- Import: CSV/XLSX up to 1M rows, streamed; column mapping with saved presets; dedupe mode (skip/update/overwrite);
  lawful basis required when GDPR mode is on; dry-run with error report. Export: async, permission `contacts.export`,
  audited.
- **Timeline:** every event about the contact (created, field changed, list joined, consent granted/withdrawn,
  message sent/delivered/opened/clicked/bounced, WhatsApp read/replied, form submitted, purchase, score changed,
  journey entered/exited) in one filterable stream, with links to the source object.

## M5. Audience: lists, tags, suppression

- **Lists** are static groupings. A contact can be in many lists. "Save segment as list" snapshots membership.
- **Tags**: free-form labels, max 500/org, merge/rename supported.
- **Suppression**: org-wide per channel (email address, email domain, phone). Sources: hard bounce, complaint,
  manual, import, invalid. Suppressed addresses never send, regardless of consent. Global platform suppression
  (known spam traps, role addresses on request) is applied on top.

## M6. Segments

- Condition AST: groups with AND/OR, NOT on any node, nesting depth ≤ 5, ≤ 100 conditions (Zoho: 50 criteria /
  10 groups, flat).
- Condition sources: contact & custom fields, geography, demographics, email/SMS/WhatsApp behaviour
  (with time windows and counts, e.g. "opened ≥ 3 in last 30 days"), website events, purchases (count, amount,
  product, recency), CRM fields, tags, lists, topics, score, dates (relative/absolute, anniversaries), journey state.
- Live count: debounced (400 ms), cached by AST hash; > 1M contacts → estimate first, exact count async.
- Membership is evaluated on demand (send/preview) and incrementally for journey "entered/exited segment" triggers.
- Segments unused 90 days are flagged (not disabled).

## M7. Topics

- Hierarchy: Brand → Category → Topic. Defaults: Product Updates, Promotions, Newsletter, Events, Educational,
  Transactional (transactional is exempt from marketing opt-out but never from suppression).
- Per-contact, per-channel topic subscription. Hosted preference center (brandable) lets contacts manage topics and
  channels; every change is a consent event.
- A campaign targets one or more topics (Zoho: exactly one); a contact is eligible if subscribed to **any** of them.

## M8. Consent

`consent_records`: contact, channel, topic (nullable = all), status (granted/withdrawn/pending), lawful basis
(consent, contract, legal obligation, vital interest, public task, legitimate interest), source (form, import, API,
preference center, admin, keyword), consent text version, captured_at, withdrawn_at, evidence (IP, user agent,
form ID + version, page URL, double opt-in confirmation timestamp). Records are append-only.

**Double opt-in:** pending state, confirmation link valid 7 days, one reminder after 48 h, auto-expire with reason.
**Channel rules:** SMS honours STOP/UNSUBSCRIBE/START keywords; WhatsApp requires explicit opt-in.

### Eligibility Engine (shared by every send)

Evaluated per contact per message, in order, short-circuiting with a reason code:

1. `NOT_MARKETING` — subscription type ≠ marketing (skipped for transactional)
2. `UNSUBSCRIBED`
3. `NO_ADDRESS` / `INVALID_ADDRESS` for the channel
4. `SUPPRESSED` (address, domain or phone)
5. `NO_CHANNEL_CONSENT`
6. `NO_TOPIC_SUBSCRIPTION`
7. `FREQUENCY_CAP` (per-channel daily/weekly/monthly + min interval; exemptions per campaign/journey need approval)
8. `QUIET_HOURS` (SMS/WhatsApp in recipient local time → deferred, not dropped)
9. `DUPLICATE` within the same send
10. `UNENGAGED` (optional exclusion: no engagement in N days)

The pre-send review shows counts per reason; exclusions are stored per delivery and visible on the contact timeline.

## M9. Contact scoring

- Rules: event type (+ optional conditions, e.g. link URL contains, form ID) → points, with optional caps per
  period. Defaults: email open +5, click +10, WhatsApp read +5 / click +12 / reply +15, form submit +20,
  purchase +50, unsubscribe −30, soft bounce −5, hard bounce −50, spam complaint −100.
- Scores: engagement (per channel), fit (attribute rules), total = engagement + fit, clamped −999…999.
- Decay: per rule, a half-life or relevance window (default 90 days). Implemented by recomputing affected contacts
  nightly from the event log; real-time increments in between.
- Event-driven: score changes emit `contact.score_changed` (journey trigger, timeline, webhook).
- Configuring scoring requires `scoring.manage`.

## M10. Campaign management

Types: **Email** (regular, A/B, RSS, follow-up), **SMS**, **WhatsApp**. Plain-text is an email content mode, not a
type.

### State machine

```
draft ──configure──▶ configured ──content──▶ content_ready ──validate──▶ validated
  ▲                                                                     │
  └──────────────── edit (invalidates validation/approval) ─────────────┤
                                                       (approval policy)▼
                                     pending_approval ──approve──▶ approved/validated
validated ──schedule──▶ scheduled ──(time)──▶ queued ──▶ sending ──▶ completed
scheduled ──cancel──▶ draft            sending ──pause──▶ paused ──resume──▶ sending
sending/paused ──stop──▶ stopped (partial report kept)
sending ──auto-pause (bounce > 5% or complaints > 0.1%)──▶ paused_by_system ──review──▶ sending | stopped
A/B: sending(test) ──▶ awaiting_winner ──winner──▶ sending(remainder) ──▶ completed
any terminal state ──clone──▶ new draft
```

Rules:
- Deletion allowed in draft, stopped, completed (reports archived, not deleted, for 90 days). Zoho deletes reports.
- A/B campaigns **can** be paused/stopped (Zoho cannot).
- Validation checks: sender verified + domain authenticated (SPF/DKIM aligned), ≥1 audience, ≥1 topic, subject
  present, unsubscribe link present (marketing), links reachable, images ≤ limits, merge tags resolvable with
  fallbacks, spam/content score with explained issues, audience count within plan, SMS segment count, WhatsApp
  template approved.
- Recipients: up to 25 lists/segments + exclusion lists/segments.
- Scheduling: now; at time (tz); recipient time zone (fallback to org tz, optional "skip if window passed");
  optimal send time (per-contact model, configurable window up to 24 h, shows coverage); batches (N batches every
  X minutes, or throttle per hour).
- Follow-ups: target unopened / opened / clicked / opened-not-clicked / not-clicked-link-X after a delay.
- Test sends: up to 10 addresses, rendered as a chosen sample contact.
- Pre-send review page: audience breakdown by eligibility reason, rendered previews (desktop/mobile/dark), checks
  list, estimated send duration.

### A/B testing (improved)

Variants 2–5. Variable: subject, preheader, sender, content, or send time. Test size: % or absolute count (total
test share ≤ 60%). Winner metric: open (human opens only), click, CTOR, conversion, revenue. Winner: automatic
after duration with significance check (two-proportion z-test, 95% default); if inconclusive → configurable
fallback (best observed / variant A / manual). Minimum test group 100 recipients per variant for automatic mode.

---

## M11. Email builder, templates, assets

- Editors: drag-and-drop (blocks: section, columns 1–4, text, image, button, divider, spacer, social, video
  thumbnail-link, HTML, product, coupon, countdown, footer), HTML code editor with live preview, plain text
  (auto-generated from HTML, editable).
- Document model: JSON block tree → rendered to MJML-equivalent responsive HTML server-side. Dark-mode and mobile
  previews; per-block hide on mobile/desktop.
- Merge tags: `{{ contact.first_name | default: "there" }}` (Liquid-subset, sandboxed, no loops over unbounded data).
  Zoho syntax `$[FNAME|x]$` accepted on HTML import and converted.
- Dynamic content: per-block visibility rules using the segment condition AST.
- Brand kit: logos, colours, fonts, footer, social links; saved sections; template versioning with diff + restore.
- Template categories: system, organization, saved; locking for brand-controlled regions.
- Assets: images ≤ 5 MB (auto-optimized, CDN), files ≤ 20 MB; folders, tags, usage tracking ("used in 3 campaigns").

## M12. Messaging engine

As described in `architecture.md` §7. Additional rules:
- Sending is idempotent per (message, contact). Retries with exponential backoff for transient provider errors.
- Soft bounces retried up to 72 h; 5 consecutive soft bounces across sends → treated as hard bounce.
- Hard bounce / complaint → suppression immediately.
- Tracking: per-link wrapped URLs (signed), open pixel; machine opens (Apple MPP, scanners) flagged and excluded from
  "human opens". UTM auto-tagging configurable per org/campaign.
- List-Unsubscribe + List-Unsubscribe-Post (RFC 8058 one-click) on every marketing email.

## M13. Journeys / workflows

- Triggers: list joined/left, segment entered/exited, form submitted, tag added/removed, field changed, date field
  (with offset, yearly), message event (any channel), score threshold crossed, custom event/API, purchase,
  cart abandoned, recurring schedule. Multiple triggers per journey (OR).
- Flow nodes: wait (duration / until date / until weekday-time window), wait-for-event with timeout, if/else (AST),
  multi-way split, random % split, A/B, merge, goal (contact jumps to goal when met, from anywhere), exit.
- Action nodes: send email/SMS/WhatsApp, add/remove list, tag, topic, update field, update score, change
  subscription type, internal notification, webhook (with response branching + retries), CRM create/update,
  move to another journey.
- Entry rules: re-entry off / always / after cooldown; max entries per contact; "include contacts already matching"
  at launch.
- States: `draft → active → paused → active`, `active → draining (no new entries, in-flight continue) → archived`.
  Pausing offers: freeze in place, or drain. Each publish creates an immutable version; in-flight contacts stay on
  their version unless migrated with an explicit node mapping (Zoho strands them).
- Launch validation: every node configured and connected, referenced assets exist, sends have approved content.
- **Debugger:** per contact, the path taken with timestamps and evaluated condition values; per node, counts
  (entered, waiting, completed, failed) and error samples.
- Dependency safety: deleting a list/field/template used by an active journey is blocked with a list of users.

## M14. Analytics and events

- Metric definitions (fixed, documented in-product): delivery rate = delivered/sent; open rate = unique human opens /
  delivered; click rate = unique clicks / delivered; CTOR = unique clicks / unique opens; bounce, unsubscribe,
  complaint rates over delivered.
- Reports: campaign (overview, link click map, heatmap overlay, device/client/OS, geography, time-of-day,
  per-domain/ISP deliverability, A/B variants), journey (funnel per node), contact, list growth, topic subscriptions,
  channel comparisons, revenue attribution (last-click within configurable window).
- Exports CSV/XLSX; scheduled email reports.

## M15. Deliverability

- Sender identities (verified by link) and sending domains (SPF include, DKIM 2048-bit, DMARC presence + policy,
  return-path/custom bounce domain, tracking domain CNAME). Free-mail domains rejected as senders.
- DNS checks: periodic re-verification; alerts on regression.
- DMARC aggregate report ingestion (rua mailbox) → dashboard of pass/fail by source.
- Reputation dashboard: bounce, complaint, block rates by ISP; per-campaign health; Google Postmaster/Yahoo
  feedback loop ingestion where available.
- Automatic protections: configurable auto-pause thresholds (default bounce 5%, complaint 0.1%); new-domain
  warm-up schedules; list-quality scoring on import (role, disposable, syntax, MX check).
- Pre-send content score with explained findings.

## M16. SMS

- Providers via adapter (Twilio first). Sender ID / number registration status (DLT India, 10DLC US, toll-free).
- GSM-7 vs. UCS-2 detection, segment counter and cost estimate in the editor; multiple links allowed (shortened,
  tracked).
- STOP/START/HELP keywords handled automatically per locale; opt-out text appended for marketing.
- Quiet hours by recipient time zone (default 21:00–08:00) — deferred not dropped.
- Two-way inbound messages stored on the timeline; transactional SMS supported (topic = Transactional).

## M17. WhatsApp

- WhatsApp Cloud API adapter. Business account + phone number connection, quality rating and messaging tier shown.
- Templates: category (marketing / utility / authentication), header (text/image/video/document), body
  (variables), footer, buttons (quick reply, URL, call); Meta approval status synced via webhook; rejection reasons
  shown.
- Template messages outside the 24 h service window; free-form only within it. Inbound messages and button replies
  are events (journey triggers + timeline).
- Opt-in enforced by the eligibility engine.

## M18. Integrations, webhooks, public API

- **REST API v1:** resource-oriented JSON (`/v1/contacts`, `/v1/lists`, `/v1/segments`, `/v1/campaigns`,
  `/v1/journeys`, `/v1/templates`, `/v1/events`, `/v1/webhooks`…), cursor pagination, idempotency keys, bulk
  endpoints (up to 10k contacts/request, async job), OpenAPI 3.1 spec, generated TS SDK.
- Auth: org API keys (scoped, hashed, prefix-identifiable, last-used shown) and OAuth 2.0 for third-party apps.
- Rate limits: token bucket per key (default 100 req/s burst, 6000/min), `RateLimit-*` headers, 429 with
  `Retry-After` — no punitive lockouts.
- **Outbound webhooks:** any event type, HMAC-SHA256 signed with timestamp, retries with backoff for 24 h,
  delivery log with replay, auto-disable after sustained failure with alert.
- **Inbound:** custom events API, form endpoints, provider callbacks.
- Integrations framework: connector interface (auth, field mapping, sync direction, schedule, conflict policy).
  First connectors: HubSpot/Salesforce/Zoho CRM (contacts + field sync), Shopify (orders, carts, products),
  Zapier-style generic webhook.

## M19. AI

Provider-agnostic AI service (default: Anthropic Claude). All AI outputs are suggestions requiring user acceptance;
prompts never include data from other tenants; usage metered per org.
- Content: subject lines (with predicted performance), body drafts in brand voice, rewrite/shorten/translate,
  SMS/WhatsApp variants within length limits, alt text.
- Audience: suggested segments from natural language ("customers who bought twice but haven't opened in 60 days" →
  AST), lookalike criteria, churn-risk segments.
- Optimization: send-time model, A/B hypothesis suggestions, dashboard insight narratives, deliverability
  diagnosis ("why did Gmail bounces spike?").

## M20. Forms

Embedded, pop-up (timed/exit-intent/scroll), hosted landing page. Field mapping to contact/custom fields, topic
checkboxes, consent text versioning, double opt-in, reCAPTCHA/Turnstile + honeypot, rate limiting per IP,
submission analytics (views, conversions).

## M21. Administration, usage, billing readiness

- Usage counters: contacts (marketing), emails/SMS/WhatsApp sent, AI tokens, API calls, storage — per org per
  period; plan limits enforced in services with soft (warn) and hard (block) thresholds.
- Plans are data (limits + feature flags), not code. Billing provider integration (Stripe) is a later adapter.
- Admin console: users, roles, approval policies, API keys, webhooks, domains, integrations, security settings,
  audit log search/export, data export/deletion (GDPR DSAR).

---

## Non-functional requirements

| Area | Target |
|---|---|
| UI | p75 LCP < 2.0 s; interactions < 100 ms; fully responsive ≥ 360 px; WCAG 2.2 AA |
| API | p95 < 200 ms for CRUD; list endpoints paginated |
| Sending | ≥ 1M emails/hour per cluster horizontally; per-org fairness |
| Events | ingest ≥ 5k events/s; timeline visible < 5 s after event |
| Availability | 99.9% API; sends survive worker restarts (durable queues, idempotent jobs) |
| Security | OWASP ASVS L2; tenant isolation tested automatically on every endpoint |
| Data | backups with PITR; GDPR export/delete within 30 days |

## Build plan

1 Spec ✅ → 2 Architecture ✅ → 3 Monorepo → 4 Auth + Org + RBAC → 5 Contacts + Audience → 6 Campaigns →
7 Email builder → 8 Templates + Assets → 9 Messaging engine → 10 Journeys → 11 Analytics + Events →
12 Deliverability → 13 SMS → 14 WhatsApp → 15 Integrations/Webhooks/API → 16 AI → 17 Performance + Security →
18 Testing → 19 Deployment.
