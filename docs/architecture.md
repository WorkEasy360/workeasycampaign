# Workeasy Campaign — Architecture

Status: v0.1 (step 2 of the build plan). Will be revised after specification reconciliation (`docs/spec.md`).

## 1. Guiding principle

The platform is modelled around the customer, not around email:

```
Customer → Identity → Audience → Consent → Journey → Message → Delivery → Engagement → Event → Analytics → Optimization
```

Email, SMS and WhatsApp are **delivery channels** plugged into one communication pipeline. No business rule
(eligibility, consent, scheduling, throttling, tracking, scoring, reporting) may live inside a channel.

## 2. Stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere | One type system from DB to UI; shared validation schemas |
| Monorepo | pnpm workspaces + Turborepo | Fast incremental builds, shared packages |
| Web app | Next.js (App Router), React, Tailwind, shadcn/ui, TanStack Query | Mature, responsive, server components for fast first paint |
| API | NestJS (Fastify adapter) | Modules/DI suit a large domain; guards/interceptors for auth + tenancy |
| Workers | NestJS standalone apps consuming BullMQ queues | Same DI/container as API, independently scalable |
| Database | PostgreSQL 16 via Prisma | Relational core, JSONB for flexible attributes, RLS for tenant isolation |
| Queue / cache | Redis 7 + BullMQ | Delayed jobs, rate limiting, retries, flows |
| Validation | Zod (shared package) | Same schemas for API DTOs, forms and SDK |
| Analytics store | Postgres partitioned event table + rollup tables (phase 1); ClickHouse-ready interface (phase 2) | Avoid premature infra; keep a seam to swap |
| Object storage | S3-compatible (MinIO locally) | Assets, imports, exports |
| Local mail sink | Mailpit | Inspect sent mail in development |

## 3. Repository layout

```
apps/
  web/        Next.js frontend
  api/        NestJS HTTP API (REST, /v1 public API, webhooks ingress)
  worker/     NestJS workers (send, events, scoring, segments, journeys, imports)
packages/
  db/         Prisma schema, migrations, tenant-scoped client, seed
  shared/     Zod schemas, DTO types, permission catalogue, enums, utilities
  channels/   Channel adapter interface + email/sms/whatsapp providers
  config/     Shared tsconfig / eslint presets
docs/         Specification, architecture, ADRs
```

## 4. Multi-tenancy and isolation

Two independent layers — either alone must prevent cross-tenant access:

1. **Application layer.** Every request resolves an `AuthContext { userId, orgId, permissions }`. Repositories obtain
   a Prisma client via `db.forTenant(orgId)`; there is no un-scoped repository API for tenant data.
2. **Database layer.** Every tenant table has `org_id` and a PostgreSQL Row-Level Security policy
   `org_id = current_setting('app.org_id')::uuid`. The tenant client runs each operation inside a transaction that
   first executes `set_config('app.org_id', $1, true)`. The application DB role is not a table owner and cannot bypass
   RLS. A separate privileged role is used only by migrations and system jobs.

Composite indexes lead with `org_id`. IDs are UUIDv7 (time-ordered, index-friendly, non-guessable across tenants).

## 5. Identity, auth and RBAC

- Passwords: Argon2id. Breached/weak password checks at signup and change.
- Sessions: opaque random token in an `HttpOnly; Secure; SameSite=Lax` cookie; only the SHA-256 hash is stored
  (`sessions` table) so a DB leak does not leak sessions. Sessions are listable and revocable per device.
- "Remember device" issues a long-lived trusted-device record, not a longer session.
- CSRF: double-submit token for cookie-authenticated state-changing requests. Public API uses bearer API keys
  (hashed, prefixed, scoped) and is not cookie-authenticated.
- Rate limiting: Redis sliding window per IP + per account on auth endpoints; progressive lockout with audit events.
- MFA/OAuth/SSO-ready: `user_identities` (provider, subject) and `user_mfa_factors` tables exist from day one; login is
  a state machine (`password_ok → mfa_required → authenticated`) so factors can be added without rewriting.
- RBAC: permissions are string constants (`contacts.read`, `campaigns.send`, …) defined in `packages/shared`.
  Roles are per-organization sets of permissions; system roles (Owner, Admin, Marketer, Analyst, Viewer) are seeded and
  custom roles are supported. Authorization is enforced by a NestJS guard **and** re-checked in services for
  sensitive operations (send, delete, export).
- Audit log: append-only table written by an interceptor for every mutating call plus explicit security events
  (login, failed login, MFA change, role change, API key creation, export).

## 6. Domain model (core aggregates)

```
Organization ─┬─ Membership(User, Role)
              ├─ Contact ─┬─ ContactChannelAddress (email / phone / whatsapp; verified, status)
              │           ├─ ConsentRecord (channel, topic, lawful basis, source, version, evidence, withdrawn_at)
              │           ├─ TopicSubscription
              │           ├─ ContactScore (engagement, fit, per-channel, total; decayed)
              │           └─ custom field values (JSONB, typed by FieldDefinition)
              ├─ List / ListMembership       (static)
              ├─ Segment (condition AST)     (dynamic, materialized snapshots)
              ├─ Tag / Topic / Suppression
              ├─ Template / Asset
              ├─ Campaign ── Message(variant[]) ── Send (run) ── Delivery (per recipient)
              ├─ Journey ── JourneyVersion (graph) ── JourneyEnrollment
              ├─ Event (append-only, partitioned by month)
              ├─ SenderDomain / SenderIdentity (SPF/DKIM/DMARC status)
              ├─ Integration / Webhook / ApiKey
              └─ AuditLog / UsageCounter
```

## 7. Communication pipeline (channel-agnostic)

```
Campaign or Journey step
   │  produces
   ▼
Message (channel, content ref, topic, variants)
   │  audience resolution (lists ∪ segments − exclusions)
   ▼
Eligibility Engine  ── marketing status, consent(channel, topic), topic subscription,
   │                   channel address validity, suppression, unsubscribe, frequency caps,
   │                   quiet hours → produces per-contact decision + reason code
   ▼
Delivery records (one per contact×message; idempotent key)
   │  scheduled per recipient (immediate / at time / recipient TZ / optimal time / batches)
   ▼
send queue (BullMQ, per-org + per-provider rate limits)
   │
   ▼
Renderer (merge tags, dynamic content, link wrapping, tracking pixel — channel-capability aware)
   │
   ▼
ChannelAdapter.send()  ── EmailAdapter (SMTP/SES/…), SmsAdapter (Twilio/…), WhatsAppAdapter (Cloud API)
   │
   ▼
Provider callbacks / tracking hits → normalized Event → scoring, journeys, analytics, suppression
```

The `ChannelAdapter` interface is the only channel-specific code:

```ts
interface ChannelAdapter {
  channel: 'email' | 'sms' | 'whatsapp' | string;
  capabilities: { html: boolean; tracking: { opens: boolean; clicks: boolean }; templatesRequireApproval: boolean; maxBodyLength?: number };
  validateAddress(addr: string): AddressValidation;
  render(message: RenderInput): RenderedPayload;
  send(payload: RenderedPayload, ctx: SendContext): Promise<ProviderResult>;
  parseCallback(req: RawCallback): NormalizedEvent[];
}
```

Adding a new channel = implement the adapter + register it; eligibility, scheduling, analytics and journeys work
unchanged.

## 8. Events and analytics

- Single `events` table: `(org_id, id, contact_id, type, channel, source_type, source_id, occurred_at, props jsonb)`,
  range-partitioned by month. Types are a closed enum in `packages/shared` (e.g. `message.delivered`,
  `message.opened`, `message.clicked`, `message.bounced`, `consent.granted`, `contact.score_changed`, `purchase`).
- Ingestion is via a queue; consumers fan out to: contact timeline, scoring, journey triggers, rollups, webhooks.
- Rollups: per-campaign/per-day counters (unique + total) updated incrementally; dashboards never scan raw events.
- Machine-open detection (Apple MPP, security scanners) is flagged on the event and excluded from "human opens".

## 9. Segments

- Conditions are stored as a typed AST (AND/OR/NOT, nested) validated by Zod.
- A compiler turns the AST into parameterized SQL over contacts + pre-aggregated behavior tables
  (`contact_engagement_stats`) — never over raw events.
- Live counts in the builder are debounced, computed with `EXPLAIN`-guarded queries and cached by AST hash
  (Redis, short TTL). Large tenants get estimates first, exact counts asynchronously.
- Segments used by a send are snapshotted at send time for reproducible reporting.

## 10. Journeys / workflows

- A journey is a versioned DAG (trigger, condition, wait, action, split, goal, exit nodes).
- Enrollments are durable state machines in Postgres; waits are BullMQ delayed jobs keyed by enrollment+node
  (idempotent). Publishing a new version never mutates in-flight enrollments.
- Every step execution is logged (`journey_step_runs`) to power the visual debugger ("why did this contact go left?").

## 11. Reliability and performance

- Idempotency keys on delivery creation and on public API POSTs.
- Outbox pattern: domain changes and their events are written in the same transaction; a relay publishes to queues.
- Backpressure: per-org send concurrency, per-provider rate limits, automatic throttle on bounce/complaint spikes.
- Pagination is cursor-based everywhere. Imports/exports stream via object storage.

## 12. Security baseline

- OWASP ASVS L2 as the target. Helmet headers, strict CSP on the web app, HTML sanitization of user-supplied templates
  in preview, SSRF-safe fetchers for URL imports/webhooks, signed webhook payloads (HMAC-SHA256 with timestamp).
- Secrets (provider credentials) are encrypted at rest with envelope encryption (per-org data key).
- PII export/delete endpoints for GDPR requests.

## 13. Open decisions

- Development infrastructure: Docker Desktop vs. hosted Postgres/Redis (pending, see README).
- Email provider for production (SES / SendGrid / Postmark / own MTA) — the adapter seam keeps this open.
