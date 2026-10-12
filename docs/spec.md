# Workeasy Campaign — Product Specification

Status: v1.1. Revised by the foundation audit, which added provenance tags, corrected the soft-bounce score and
added the consent model from decision D3.
Sources:
- the product brief
- the Zoho Campaigns 2.0/3.0 official documentation, reviewed in October 2026
- product decisions D1–D3

Zoho is a functional reference only. Where we differ from Zoho, the documented Zoho rule is recorded and our behaviour
is stated separately.

## Provenance tags

Every major rule carries exactly one tag:

| Tag | Meaning |
|---|---|
| `[ZOHO_PARITY]` | Matches behaviour documented by Zoho. |
| `[OUR_IMPROVEMENT]` | Deliberately better than documented Zoho behaviour. The Zoho rule is quoted as **Zoho:** next to ours. |
| `[OUR_ORIGINAL_DESIGN]` | Not a Zoho feature. It comes from the product brief or from us, marked *(brief)* or *(ours)*. |
| `[NOT_VERIFIED]` | Zoho behaviour our research could not confirm. Do not cite it as Zoho behaviour. |

**Numbers.** Unless a limit is tagged `[ZOHO_PARITY]`, it is a **proposed default**, stored as plan or organization
configuration and never as a code constant. MUST means required for the module to ship.

---

## 0. Cross-cutting rules

- **Tenancy** `[OUR_ORIGINAL_DESIGN]` *(D1, D2)*:
  - The hierarchy is Platform → Organization → Workspace.
  - Every record has exactly one declared owner class: platform, organization, workspace, user or global. See `docs/tenancy.md`.
  - Isolation is enforced in services and by PostgreSQL row-level security.
- **Channels** `[OUR_ORIGINAL_DESIGN]` *(brief)*:
  - Email, SMS and WhatsApp share one pipeline: audience → eligibility → delivery → events.
  - No channel contains business logic.
- **Explainability** `[OUR_IMPROVEMENT]`:
  - Every automated decision stores a reason code that the UI shows. That covers excluded contacts, auto-pauses, journey branches and score changes.
  - **Zoho:** reasons are not documented.
- **Audit** `[OUR_ORIGINAL_DESIGN]`:
  - Security-relevant mutations write an append-only audit record in the same transaction (`docs/security.md`).
- **Events** `[OUR_ORIGINAL_DESIGN]`:
  - Domain, integration and analytics events are distinct, and all three are append-only (`docs/events.md`).
- **Identifiers and time:**
  - IDs are UUIDv7.
  - Times are stored in UTC.
  - Each workspace has a time zone, and contacts may have their own.

## M1. Authentication `[OUR_ORIGINAL_DESIGN]` *(brief; Zoho uses Zoho Accounts, not researched)*

Implemented in Phase 4; see `docs/identity.md`.

**Flows:**
- Register → verify email → create organization → first workspace.
- Sign in and sign out.
- Forgot and reset password; change password.
- List and revoke sessions.

**Identity-provider abstraction** *(D1)*:
- The platform depends on `AuthenticatedPrincipal` only.
- The local email + password provider can be replaced by Workeasy SSO (OIDC) without migrating organization or content data.

**Rules (proposed defaults):**
- **Passwords:** 10–256 characters, a blocklist of common passwords, Argon2id.
- **Email verification:** single use, valid 24 h.
- **Password reset:** single use, valid 1 h. A reset signs out every session.
- **Sessions:** 7 days idle and 30 days absolute; the token rotates hourly.
- **Throttling:** 5 failures per account in 15 min locks that account temporarily; 30 failures per IP in 15 min.
- **Anti-enumeration:** registration, forgot-password and resend always return the same response.

**Not yet built:** MFA, OAuth and SSO. The schema and contracts are ready for them (`user_identities`, `authMethods`).

## M2. Organization, workspaces, users, roles

**Structure** `[ZOHO_PARITY]` (Zoho has org → workspaces) `[OUR_ORIGINAL_DESIGN]` (the detailed rules) *(D2)*:
- Organizations contain workspaces.
- Contacts, audiences, campaigns, journeys, templates, assets and reports are **workspace-owned**.
- Members, roles, security, billing and the audit log are **organization-owned**.

**Workspace roles** — Manager, Editor and Viewer:
- `[ZOHO_PARITY]` Editor cannot send, and Viewer can only read.
- `[OUR_ORIGINAL_DESIGN]` Workspace admin and Analyst.

**Organization roles** `[OUR_ORIGINAL_DESIGN]`:
- Owner, Admin and Member.
- One explicit inheritance rule: `workspaces.access_all` gives workspace-admin rights in every workspace.

**Custom roles:**
- `[ZOHO_PARITY]` Per-module actions.
- `[OUR_IMPROVEMENT]` Anti-escalation: you can grant only what you hold.

**Ownership** `[OUR_ORIGINAL_DESIGN]`:
- An organization always keeps at least one active owner.
- Only owners can make or change owners.
- Admin endpoints cannot change your own membership.

**Approval policies** `[OUR_IMPROVEMENT]` *(planned for Phase 6)*:
- Rules decide when approval is needed, for example by role, audience size or topic.
- Any edit invalidates an earlier approval.
- They apply to every channel and to journeys.
- **Zoho:** approval is switched on per user, by an organization admin (2.0).

## M3. Dashboard `[OUR_ORIGINAL_DESIGN]` *(brief)*

- Every metric is shown at three levels: the value, the change against a baseline, and an insight with a recommended action.
- Insights come from deterministic rules first; AI phrasing is an enhancement.
- Dashboards read rollup tables only. p95 target: 300 ms.
- **Phase 4 ships:** a workspace home with a setup checklist and empty states. Metrics arrive with the analytics phase.

## M4. Contacts

- Subscription types: marketing, non-marketing and unsubscribed. Only marketing contacts receive marketing sends and count toward the plan `[ZOHO_PARITY]`.
- A contact who unsubscribed themselves can be resubscribed only by their own action `[ZOHO_PARITY]`.
- Status changes are capped at 3× the plan's contact count per month `[ZOHO_PARITY]`. Whether we adopt this cap is a pricing decision.
- Contacts with several identities (email, phone, WhatsApp), and merges that can be undone for 30 days `[OUR_ORIGINAL_DESIGN]`.
- A unified timeline of every event about a contact `[OUR_ORIGINAL_DESIGN]` *(brief)*.
- Proposed limits: 200 custom fields and imports of up to 1 M rows `[OUR_ORIGINAL_DESIGN]`.

**As built (Phase 5, `docs/audience.md`, `docs/imports.md`):**
- Identities: email, phone, WhatsApp and external ids with deterministic normalization (email: trim, NFC, lower-case; phone: E.164, never guessing a country). One address belongs to at most one contact per workspace.
- **No merges yet.** Conflicts (e.g. an import row whose email and phone belong to different contacts) are reported, never merged automatically. Reversible manual merge stays planned.
- Self-unsubscribe is sticky: staff, imports and bulk actions cannot reverse it (`422 SELF_UNSUBSCRIBED`).
- Custom fields: 12 types, up to 200 per workspace; key and type lock once a field holds data; used fields are archived, never deleted; select options are archived, never removed.
- Imports: up to 100,000 rows / 20 MB per file (configurable), mandatory dry run, chunked and resumable.
- Timeline: built from domain events (profile, identity, list, tag, topic, consent, import). Suppressions show on their own card. Message activity joins it in Phases 9–11.
- The 3× monthly status-change cap is **deferred** (decision in `docs/audit/phase-5-hardening-audit.md`): it is a Zoho plan/billing safeguard, our plans and usage metering do not exist until Phase 21, and nothing in Phase 5 depends on it.

## M5. Audience: lists, tags, suppression

- Lists and tags `[ZOHO_PARITY]`.
- Suppression by address, by email domain and by phone `[OUR_IMPROVEMENT]`:
  - **Zoho:** a Do-Not-Mail registry (2.0).
  - Domain-level suppression in Zoho is `[NOT_VERIFIED]`.
- Suppressed addresses never receive a send, whatever their consent.

**As built (Phase 5):** suppression per contact or per address (email, phone, WhatsApp), per channel or all channels; lifting needs a reason and keeps history. Address suppressions also block contacts created later with that address. **Domain-level suppression is not implemented** (Zoho behaviour `[NOT_VERIFIED]`). Lists support archive (frozen membership) and delete (memberships removed, contacts untouched). Tags are case-insensitively unique per workspace.

## M6. Segments

- **Structure:**
  - **Zoho** `[ZOHO_PARITY]`: criteria arranged in up to 10 groups, joined by AND/OR, with at most 50 criteria.
  - **Ours** `[OUR_IMPROVEMENT]`: an AST with AND/OR/NOT at any node, nested up to depth 5, with up to 100 conditions.
- Save a segment as a list `[ZOHO_PARITY]`.
- **Unused segments:**
  - **Zoho** `[ZOHO_PARITY]`: a segment unused for 60 days becomes inactive.
  - **Ours** `[OUR_IMPROVEMENT]`: flagged after 90 days, never disabled.
- Live counts are debounced and cached, with estimates first above 1 M contacts `[OUR_ORIGINAL_DESIGN]`.

## M7. Topics

- The hierarchy Brand → Category → Topic, a preference center, and per-topic unsubscribe `[ZOHO_PARITY]`.
- Topics per campaign:
  - **Zoho:** exactly one topic per campaign `[ZOHO_PARITY]`.
  - **Ours:** one or more topics, and a contact qualifies through any of them `[OUR_IMPROVEMENT]`.
- The Transactional topic is exempt from marketing opt-out but never from suppression `[OUR_ORIGINAL_DESIGN]`.

**As built (Phase 5):** Category → Topic inside each workspace; the workspace plays the Brand role. Every workspace gets a default **Marketing** topic, which cannot be archived; another active topic can be made default. Topic keys are immutable (column grant). Per-topic preferences are recorded as consent events. The preference centre UI arrives with forms (Phase 20).

## M8. Consent *(D3)*

Consent is **immutable, auditable evidence** with a **configurable retention policy**. There is no hard-coded
"keep forever" rule, and deleting a contact never silently deletes consent evidence.

**As built (Phase 5): see `docs/consent.md`.** Differences from the design below:
- Retention policy is per workspace (no organization default with overrides yet); defaults are 2190 days (6 years) after withdrawal and after erasure; NULL = keep indefinitely, an explicit choice.
- Changing it needs `consent.manage` only, not also `security.manage`.
- Erasure keeps the contact as a tombstone without personal data instead of nulling `contact_id`; evidence stays pseudonymous through `subject_fingerprint`.
- Event actions are `subscribed / unsubscribed / pending / confirmed / revoked`; `expired` and `reaffirmed` arrive with double opt-in and forms.
- The purge runs on demand (rate-limited, audited); scheduling is deferred to the BullMQ worker. Retention is measured from server time (hardening H-1).
- Pending consent expires after `pending_expiry_days` (derived on read; `CONSENT_EXPIRED`). Consent is bound to the address it was given for (hardening H-2).

### 8.1 Consent event (append-only) `[OUR_IMPROVEMENT]`

**Zoho:** a lawful basis per topic in GDPR mode. Its evidence model is not documented `[NOT_VERIFIED]`.

| Field | Meaning |
|---|---|
| `id`, `org_id`, `workspace_id` | Owner: the workspace that holds the contact. |
| `contact_id` | Nullable after erasure (see 8.3). |
| `subject_fingerprint` | Keyed hash (HMAC) of the normalized address. Lets evidence outlive erasure without storing PII. |
| `channel` | email, sms or whatsapp. |
| `topic_id` | Null means every topic on that channel. |
| `event` | granted, withdrawn, confirmed (double opt-in), expired or reaffirmed. |
| `previous_state` / `new_state` | none, pending, granted or withdrawn. |
| `lawful_basis` | consent, contract, legal_obligation, vital_interests, public_task or legitimate_interests. Required in GDPR mode. |
| `source` | form, import, api, preference_center, admin, sms_keyword, whatsapp_optin or double_opt_in. |
| `actor_type` / `actor_id` | contact, user, api_key or system. |
| `occurred_at` / `recorded_at` | When it happened, and when we stored it. |
| `ip_address`, `user_agent` | When captured from the contact's own browser or device. |
| `consent_text_version_id` | The exact wording the contact saw (versioned consent text). |
| `evidence` | Reference metadata: form id + version, page URL, import file id + row, API request id, double-opt-in confirmation id. |
| `correlation_id` | Ties the record to the request or job that created it. |

The current state per (contact, channel, topic) is a **projection**, updated in the same transaction. The events
are never updated.

### 8.2 Retention policy `[OUR_ORIGINAL_DESIGN]`

Each organization has a policy, with optional per-workspace overrides:

| Setting | Default | Notes |
|---|---|---|
| `retain_after_withdrawal` | `P6Y` (6 years) | Proposed default only. The legal basis is the organization's decision. Configurable ISO-8601 duration or `indefinite`. |
| `retain_after_contact_erasure` | `P6Y` | Evidence is kept pseudonymized (8.3). |
| `pending_double_opt_in_expiry` | `P7D` | Unconfirmed pending consent expires, with reason `expired`. |

- **Who can change it:** `consent.manage` + `security.manage`.
- **Audit:** every change to the policy is audited.
- **Purge job:** deletes only events past their retention, writes a tombstone count to the audit log, and never touches events still inside retention.

### 8.3 Contact deletion and erasure `[OUR_ORIGINAL_DESIGN]`

- **Soft delete:** consent events are untouched.
- **GDPR erasure:**
  - PII is removed from the contact.
  - Consent events keep `subject_fingerprint`, channel, topic, timestamps, basis, source and evidence references; `contact_id` is set to null.
  - Events are deleted only by the retention purge above.

### 8.4 Eligibility Engine

**As built (Phase 5): see `docs/eligibility.md`.** The engine evaluates **every** check and returns all failing reasons, most fundamental first `[OUR_IMPROVEMENT]` (a user fixing a contact needs every blocker). Codes as implemented: `CONTACT_DELETED`, `NOT_MARKETING`, `UNSUBSCRIBED`, `NO_ADDRESS`, `SUPPRESSED`, `CONSENT_MISSING` / `CONSENT_PENDING` / `CONSENT_WITHDRAWN` (was `NO_CHANNEL_CONSENT`), `TOPIC_NOT_SUBSCRIBED` (was `NO_TOPIC_SUBSCRIPTION`), `TOPIC_INACTIVE`. Reserved: `FREQUENCY_CAP`, `QUIET_HOURS`, `DUPLICATE`, `UNENGAGED`, `CHANNEL_UNAVAILABLE`, `EXCLUDED_BY_CAMPAIGN`. Requiring channel consent for marketing on every channel is our own product decision `[OUR_ORIGINAL_DESIGN]`, not Zoho behaviour: what we verified about Zoho is the subscription-type gate; whether Zoho requires per-channel consent is `[NOT_VERIFIED]`. Phase 5 hardening added `CONSENT_EXPIRED` and `CONSENT_ADDRESS_CHANGED` (address-bound consent); the frozen contract is `docs/eligibility.md`.

Original design: checks run in order, and the first failure is the recorded reason.

**Exclusions `[ZOHO_PARITY]`:**
- `NOT_MARKETING`
- `UNSUBSCRIBED`
- `SUPPRESSED` (bounced or complained)
- `NO_TOPIC_SUBSCRIPTION`
- `FREQUENCY_CAP`
- `UNENGAGED` (optional)

**Our additions:**
- `NO_ADDRESS` / `INVALID_ADDRESS` and `NO_CHANNEL_CONSENT` `[OUR_ORIGINAL_DESIGN]`
- `QUIET_HOURS`: deferred, not dropped `[OUR_ORIGINAL_DESIGN]`
- `DUPLICATE` `[ZOHO_PARITY]` (counted once)

Showing the order and the reason per contact is `[OUR_IMPROVEMENT]`.

**Frequency caps:**
- Per channel, daily/weekly/monthly limits plus a minimum interval `[ZOHO_PARITY]`.
- Exemptions require approval `[OUR_IMPROVEMENT]`.

**Double opt-in:**
- Double opt-in itself `[ZOHO_PARITY]`.
- 7-day expiry and a 48 h reminder `[OUR_ORIGINAL_DESIGN]` (Zoho's expiry is `[NOT_VERIFIED]`).

## M9. Contact scoring

- Engagement score per channel plus a fit score; the total is clamped to −999…999; decay over a relevance window `[ZOHO_PARITY]`.

**Default points.** Each default carries its source:

| Event | Default | Source |
|---|---|---|
| Email opened | +5 | brief |
| Email clicked | +10 | brief |
| WhatsApp read | +5 | Zoho |
| WhatsApp clicked | +12 | brief (**Zoho: +10**) |
| WhatsApp replied | +15 | Zoho |
| WhatsApp failed | −100 | Zoho |
| SMS clicked | +10 | Zoho |
| Form submitted | +20 | brief |
| Purchase | +50 | brief |
| Unsubscribed | −30 | brief |
| Email soft bounce | **−20** | Zoho (*corrected; the spec previously said −5, which had no source*) |
| Email hard bounce | −50 | Zoho |
| Spam complaint | −100 | brief and Zoho agree |

- Every value is a configurable default.
- Decay per rule `[OUR_IMPROVEMENT]`. **Zoho:** a single relevance window.
- Only admins can configure scoring `[ZOHO_PARITY]` (permission `scoring.manage`).

## M10. Campaign management

**Types:**
- Email (regular, A/B, RSS, follow-up), SMS and WhatsApp `[ZOHO_PARITY]`.
- Plain text is an email content mode `[OUR_ORIGINAL_DESIGN]`.

**States:**
- **Zoho** `[ZOHO_PARITY]`: drafts, scheduled, inprogress, sent, stopped, canceled, tobereviewed, reviewed, paused, intesting.
- **Ours** `[OUR_IMPROVEMENT]`: a 13-state machine with server-side transitions (`apps/api/src/modules/campaigns/domain/campaign-state.ts`). The UI receives `allowedActions` and never computes transitions.
- **Superseded (Phase 6 architecture review, pending approval):** the foundation's 13-state scaffold mixed form completeness into the lifecycle. Phase 6 adopts 7 states (`draft, scheduled, sending, paused, completed, cancelled, failed`) with readiness computed separately — `docs/contracts/phase-6-campaign.md` §2. The scaffold stays in place until milestone 6.1 replaces it.

**Actions** `[ZOHO_PARITY]`:
- Clone from a draft or a sent campaign.
- Cancel or reschedule before the send time.
- Pause while in progress.

**Deletion:**
- **Zoho:** deleting a campaign deletes its reports.
- **Ours** `[OUR_IMPROVEMENT]`: reports are archived for 90 days.

**A/B tests:**
- **Zoho:** cannot be stopped.
- **Ours** `[OUR_IMPROVEMENT]`: can be paused and stopped.

**Bounce threshold:**
- **Zoho** `[ZOHO_PARITY]`: above 5 % the campaign auto-pauses for 24 h; a second breach cancels it.
- **Ours** `[OUR_IMPROVEMENT]`: the threshold is configurable, and a breach sets `paused_by_system` for review.

**Complaint threshold:**
- **Zoho** `[ZOHO_PARITY]`: above 0.1 % the campaign is stopped/cancelled.
- **Ours** `[OUR_IMPROVEMENT]`: `paused_by_system` with an explanation.

**Pre-send review:**
- **Zoho:** a manual review of about 30 min.
- **Ours** `[OUR_IMPROVEMENT]`: automated validation with explained findings.

**Required to send:**
- A verified sender, at least one audience and a topic `[ZOHO_PARITY]`.
- A resolvable merge-tag fallback and an unsubscribe link `[ZOHO_PARITY]`.

**Recipients:**
- **Zoho** `[ZOHO_PARITY]`: up to 10 lists or segments.
- **Ours** `[OUR_IMPROVEMENT]` (proposed): up to 25.

**Test sends:**
- **Zoho** `[ZOHO_PARITY]`: up to 5 addresses (2.0).
- **Ours** `[OUR_IMPROVEMENT]` (proposed): up to 10.

**Scheduling:**
- Send now, at a set time, in recipient time zone, at optimal time (24 h window), or in batches `[ZOHO_PARITY]`.
- "Skip if the window has passed", a configurable optimal window and a coverage indicator `[OUR_IMPROVEMENT]`.

**Follow-ups:** to unopened, opened, clicked, or opened-but-not-clicked recipients `[ZOHO_PARITY]`.

**A/B testing:**
- **Zoho** `[ZOHO_PARITY]`:
  - 2 variants
  - test share at most 60 %
  - winner by open rate, click rate or manual choice
  - a tie extends the test by 30 min
- **Ours** `[OUR_IMPROVEMENT]`:
  - 2–5 variants
  - test size as a percentage or an absolute count
  - winners by human opens, clicks, CTOR, conversions or revenue
  - a two-proportion significance test at 95 %
  - a configurable fallback when the result is inconclusive
  - at least 100 recipients per variant in automatic mode (proposed)

## M11. Email builder, templates, assets

- **Editors:**
  - Drag-and-drop, HTML and plain text `[ZOHO_PARITY]`.
  - Saved sections, and separate desktop/mobile design `[ZOHO_PARITY]`.
  - Dynamic content rules per block `[ZOHO_PARITY]`.
- **Merge tags:**
  - **Zoho** `[ZOHO_PARITY]`: syntax `$[FNAME|fallback]$`.
  - **Ours** `[OUR_IMPROVEMENT]`: a sandboxed Liquid subset; Zoho syntax converts on import.
- Template versioning with diff, and a brand kit `[OUR_IMPROVEMENT]`. Zoho's template versioning is `[NOT_VERIFIED]`.
- **Asset size limits:**
  - **Zoho** `[ZOHO_PARITY]`: images 1 MB, files 10 MB.
  - **Ours** `[OUR_IMPROVEMENT]` (proposed): 5 MB and 20 MB.

## M12. Messaging engine

- Idempotent delivery per (message, contact) `[OUR_ORIGINAL_DESIGN]`.
- **Soft bounces:**
  - **Zoho** `[ZOHO_PARITY]`: retried for up to 5 days; about 7 soft bounces become a hard bounce.
  - **Ours** `[OUR_ORIGINAL_DESIGN]` (proposed): retries for 72 h; 5 consecutive soft bounces count as a hard bounce. Configurable.
- A hard bounce or complaint suppresses the address immediately `[ZOHO_PARITY]`.
- Bot opens are reported separately `[ZOHO_PARITY]`.
- Machine-open detection for Apple Mail Privacy Protection and security scanners `[OUR_IMPROVEMENT]`. Zoho's MPP handling is `[NOT_VERIFIED]`.
- One-click unsubscribe headers (RFC 8058) `[OUR_ORIGINAL_DESIGN]`, as Gmail and Yahoo require of bulk senders.
- Inbound provider callbacks are verified against the raw body, and the tenant is resolved from our routing table, never from the payload `[OUR_ORIGINAL_DESIGN]`. Implemented in Phase 4 as the `ChannelAdapter.verifyCallback` contract plus `app.resolve_provider_message`.

## M13. Journeys

- **Triggers** `[ZOHO_PARITY]`:
  - list, segment, form, email/WhatsApp action, date, tag, score
  - open trigger (API), cart, recurring schedule
- **Triggers we add** `[OUR_ORIGINAL_DESIGN]`: field changed and custom event.
- **Flow and action components** `[ZOHO_PARITY]`:
  - activity checks, if/else, multi-split, random split, merge
  - delay, wait-for-condition with timeout
  - list/tag/field/score/topic actions, webhook, internal notification, move to another workflow
- Goal node `[NOT_VERIFIED]` for Zoho 3.0 (2.0 had goals). Ours is a planned feature.
- **Lifecycle:**
  - **Zoho** `[ZOHO_PARITY]`: Draft → Active ⇄ Paused. Triggers are locked after launch.
  - **Ours** `[OUR_IMPROVEMENT]`: adds a draining state and immutable versions, with explicit migration of in-flight contacts. **Zoho:** deleting a step strands the contacts in it.
- **Re-entry:**
  - **Zoho** `[ZOHO_PARITY]`: on or off.
  - **Ours** `[OUR_IMPROVEMENT]`: a cooldown and a maximum number of entries.
- A per-contact debugger `[OUR_IMPROVEMENT]`.
- Tenant-scoped job execution `[OUR_ORIGINAL_DESIGN]`: implemented in Phase 4 as `defineTenantJob`.

## M14. Analytics and events

- **Formulas** `[ZOHO_PARITY]` (3.0):
  - open rate = opens / delivered
  - click rate = clicks / delivered
  - CTOR = clicks / opens
- Unique and total counts are both reported `[ZOHO_PARITY]`.
- **We add** `[OUR_IMPROVEMENT]`:
  - human vs. machine opens
  - breakdown by mailbox provider (ISP)
  - revenue attribution
  - time-of-day heatmaps
- Event taxonomy and envelope: `docs/events.md` `[OUR_ORIGINAL_DESIGN]`.

## M15. Deliverability

- SPF and DKIM verification, verified sender addresses, and rejection of free-mail domains as senders `[ZOHO_PARITY]`.
- DMARC report ingestion, warm-up schedules, configurable thresholds and a pre-send content score `[OUR_IMPROVEMENT]`. **Zoho:** DMARC is checked as a precondition only.

## M16. SMS

- **Zoho** `[ZOHO_PARITY]`:
  - DLT (India) and 10DLC (US) registration
  - splitting at 160 GSM / 70 Unicode characters
  - an opt-out link in workflows
- **Ours** `[OUR_IMPROVEMENT]`:
  - multiple tracked links (**Zoho:** one link)
  - STOP/START/HELP keywords (Zoho: `[NOT_VERIFIED]`)
  - transactional SMS (**Zoho:** promotional only)
  - quiet hours, defaulting to 21:00–08:00 local time
  - a two-way inbox

## M17. WhatsApp

- Meta template approval and component limits `[ZOHO_PARITY]`:
  - header 60 characters
  - body 800 characters with up to 10 variables
  - footer 60 characters
  - up to 10 buttons
- **We add** `[OUR_IMPROVEMENT]`:
  - handling of the 24 h service window (a Meta platform rule)
  - visibility of quality rating and messaging tier
  - opt-in enforced by the eligibility engine

## M18. Integrations, webhooks, public API

- **REST API:**
  - **Zoho** `[ZOHO_PARITY]`: verb-style endpoints.
  - **Ours** `[OUR_IMPROVEMENT]`: resource-oriented JSON, OpenAPI 3.1, cursor pagination, idempotency keys.
  - Phase 4 ships the browser API with these properties; the public API-key surface comes in Phase 15.
- **Rate limits:**
  - **Zoho** `[ZOHO_PARITY]`: 500 calls / 5 min, then a 30 min lockout.
  - **Ours** `[OUR_IMPROVEMENT]`: token buckets with `Retry-After` and no punitive lockouts.
- Signed, retried webhooks with replay `[OUR_IMPROVEMENT]`. Zoho's signing and retries are `[NOT_VERIFIED]`.

## M19. AI `[OUR_IMPROVEMENT]`

- **Zoho:** Zia content generation (3.0).
- **Scope** *(brief)*:
  - content
  - audience suggestions
  - optimization
  - insight narratives
- **Rules:** suggestions only; no data crosses tenants.

## M20. Forms

- Signup and pop-up forms, CAPTCHA via integration, double opt-in `[ZOHO_PARITY]`.
- Exit-intent and scroll triggers, Turnstile, honeypot, consent-text versioning `[OUR_IMPROVEMENT]`.

## M21. Administration, usage, billing readiness `[OUR_ORIGINAL_DESIGN]` *(brief)*

- Plans are data, not code.
- Usage counters per organization.
- An admin console.
- Data export and deletion requests (GDPR DSAR).
- **Phase 4 ships:** members, roles, security (sessions) and the audit log with export.

---

## Non-functional requirements `[OUR_ORIGINAL_DESIGN]`

| Area | Target (proposed) |
|---|---|
| UI | p75 LCP < 2.0 s; responsive ≥ 360 px; WCAG 2.2 AA |
| API | p95 < 200 ms CRUD |
| Sending | ≥ 1 M emails/hour/cluster |
| Events | ≥ 5 k/s ingest |
| Availability | 99.9 % API |
| Security | OWASP ASVS L2; isolation tested on every route (Phase 4: `apps/api/test/routes.test.ts`) |

## Build plan

1 Spec ✅ → 2 Architecture ✅ → 3 Monorepo ✅ → Foundation audit + fixes ✅ → 4 Identity + Org + Workspace + RBAC ✅ →
**5 Contacts + Audience ✅** → 6 Campaigns → 7 Email builder → 8 Templates + Assets → 9 Messaging engine → 10 Journeys →
11 Analytics + Events → 12 Deliverability → 13 SMS → 14 WhatsApp → 15 Integrations/Webhooks/API → 16 AI →
17 Performance + Security → 18 Testing → 19 Deployment.
