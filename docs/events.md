# Event model

The event model is defined before any business workflow is built. Phase 4 implements domain events; integration and
analytics events have their contracts and storage design fixed here and are built in Phases 9, 11 and 15.

## Three kinds of events. Do not mix them.

| | Domain events | Integration events | Analytics events |
|---|---|---|---|
| Purpose | Business facts inside Campaigns | Versioned public contracts for other Workeasy products and customer webhooks | High-volume measurement facts |
| Examples | `organization.created`, `membership.role_changed`, `consent.withdrawn` | `campaigns.contact.unsubscribed.v1` | `message.delivered`, `message.opened` |
| Written | In the **same transaction** as the state change (outbox) | Derived from domain/analytics events by a mapper | By ingestion workers, batched |
| Store | `domain_events` (Phase 4) | an outbox → bus; webhook delivery log | `engagement_events`, partitioned monthly (Phase 11) |
| Consumers | timeline, scoring, journeys, integration mapper | other services, customer endpoints | rollups, reports, dashboards |
| Guarantees | Exactly-once write, at-least-once delivery, ordered per aggregate | At-least-once, signed; consumers dedupe on `eventId` | Idempotent on the provider event id; may arrive late or out of order |
| Schema changes | `version` per type; old versions kept for replay | Version in the name (`.v1`); breaking change means a new name | Additive only |

**Causation.** An analytics event can *cause* a domain event: a hard-bounce fact causes `suppression.added`, linked by `causationId`.

**Timeline.** The contact timeline is a merged read over domain and analytics events for one contact.

## Envelope (all kinds)

| Field | Column | Notes |
|---|---|---|
| `eventId` | `id` | UUIDv7 |
| `eventType` | `type` | e.g. `workspace.created` |
| `eventVersion` | `version` | Payload schema version for that type |
| `organizationId` | `org_id` | Tenant; RLS key |
| `workspaceId` | `workspace_id` | Set when the aggregate is workspace-owned |
| `aggregateType` / `aggregateId` | `aggregate_type`, `aggregate_id` | The entity the fact is about |
| `occurredAt` | `occurred_at` | When it happened (provider time for callbacks) |
| `recordedAt` | `recorded_at` | When we stored it (DB default) |
| `actor` | `actor_type`, `actor_id` | user, api_key or system |
| `source` | `source` | api, worker, `webhook:<provider>`, import |
| `correlationId` | `correlation_id` | The request id (also returned as `X-Request-Id`) or job correlation id |
| `causationId` | `causation_id` | The event that caused this one |
| `idempotencyKey` | `idempotency_key` | Unique per organization when present |
| `payload` | `payload` | Validated against the catalogue schema for (type, version) |

## Implementation (Phase 4)

**Catalogue.** `apps/api/src/modules/events/catalogue.ts` holds each type with its version, aggregate and Zod payload schema. `appendDomainEvent()` validates payloads, so malformed events never reach storage.

**Writing.** Events are written through `inTenant(...).event(...)` in the same transaction as the change and its audit record (`apps/api/src/modules/tenancy/application/tenant-tx.ts`).

**Append-only:**
- Role `workeasy_app` has `SELECT, INSERT` only.
- A `BEFORE UPDATE` trigger rejects updates even for the owner.
- Retention is handled by partition or row deletion run as the owner (Phase 11).

**Dispatch.** Dispatch progress will be tracked in a separate `event_dispatches(event_id, consumer, dispatched_at)` table, never by updating the event (Phase 9).

**Phase 4 domain events.** `organization.created/updated/deleted`, `workspace.created/updated/archived/restored`,
`membership.added/role_changed/status_changed`, `workspace_membership.added/role_changed/removed`,
`invitation.created/revoked/accepted`, `role.created/updated/deleted`.

**Phase 5 domain events** (aggregate in brackets):
- [contact] `contact.created/updated/deleted/restored/erased`, `contact.subscription_changed`, `contact.identity_added/identity_removed`, `list.member_added/member_removed`, `contact.tagged/untagged`, `contact.topic_subscribed/topic_unsubscribed`, `consent.recorded`
- [list] `list.created/updated/archived/restored/deleted` · [tag] `tag.created/updated/deleted` · [topic] `topic.created/updated/archived/restored/default_changed` · [custom_field] `custom_field.created/updated/archived/restored/deleted` · [suppression] `suppression.added/lifted` (payload carries `contactId` when the target is a contact) · [import] `import.started/completed/failed`

Membership changes use the **contact** as aggregate, so a contact's timeline is a keyset query over `domain_events` by (workspace, aggregate). Suppressions are their own aggregate and show on the contact page's do-not-contact card rather than in the timeline. Bulk actions and imports write one event per affected contact in batches (`appendDomainEvents`) in the same transaction as the change. Payloads carry ids and changed field names, never personal data, so erasure does not need to rewrite events.

**Verified by test.** Creating an organization writes four domain events that share one correlation id (`apps/api/test/tenancy.test.ts`).

## Analytics events (Phase 11 design)

- **Partitioning.** `engagement_events` is range-partitioned by month on `occurred_at`. Indexes:
  - `(org_id, workspace_id, contact_id, occurred_at DESC)`
  - `(org_id, source_type, source_id, type)`
  - BRIN on `occurred_at`
- **Deduplication.** A unique constraint on a partitioned table must include the partition key, so dedupe uses a separate `event_dedupe(org_id, idempotency_key)` table.
- **Rollups.** Unique opens and clicks use first-touch flags on deliveries, never `COUNT(DISTINCT)` over raw events.
- **Bot traffic.** Machine opens are flagged (`is_machine`) and excluded from "human" metrics.
