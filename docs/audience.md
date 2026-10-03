# Audience (Phase 5)

The audience subsystem is the authoritative source of contacts for campaigns, journeys, segments, forms, imports,
SMS and WhatsApp. Everything in this document is **workspace-owned** and protected by PostgreSQL row-level security,
unless stated otherwise (see `docs/tenancy.md`).

Related documents: [consent.md](consent.md) · [eligibility.md](eligibility.md) · [imports.md](imports.md)

## 1. Six separate concepts

Collapsing these into a single status is the classic mistake. Each one has its own storage and its own rules.

| Concept | Question it answers | Storage | Who changes it | Provenance |
|---|---|---|---|---|
| **Administrative status** (subscription type) | Is this a marketing contact at all? | `contacts.subscription_type`: `marketing` · `non_marketing` · `unsubscribed`, plus `unsubscribed_by` | Admins, the contact, the system | `[ZOHO_PARITY]` (3.0 subscription types) |
| **Channel consent** | May we send marketing on this channel? | `consent_events` (immutable evidence) → `consent_states` projection per (contact, channel) | Recorded with evidence | `[OUR_IMPROVEMENT]` (Zoho: lawful basis per topic; evidence model `[NOT_VERIFIED]`) |
| **Topic preference** | Which subjects does the contact want? | `consent_events` (topic-scoped) → `contact_topic_preferences` projection | Admins (as entered evidence), the contact (future preference center) | `[ZOHO_PARITY]` (topics, per-topic unsubscribe) |
| **Suppression** | Must we never send on this channel, whatever else is true? | `suppressions` (rows never deleted; lifting is recorded) | Admins, the system (bounces and complaints, Phase 9) | `[ZOHO_PARITY]` (Do-Not-Mail registry) + `[OUR_IMPROVEMENT]` (per channel, by contact or by address) |
| **Identity** | How do we reach this contact? | `contact_identities` (email, phone, WhatsApp, external) | Admins, imports, API | `[OUR_ORIGINAL_DESIGN]` |
| **Eligibility** | Can this message go to this contact *now*? | Computed only, never stored (`EligibilityService`) | — | `[OUR_IMPROVEMENT]` |

**Self-unsubscribe is sticky.** A contact who unsubscribed themselves can only be resubscribed by their own action:
- `[ZOHO_PARITY]` for the subscription type.
- `[OUR_IMPROVEMENT]`: the same rule also applies to channel consent and topic preference.

An admin attempt fails with `422` and reason `SELF_UNSUBSCRIBED`. Nothing can silently resubscribe a contact.

## 2. Contact

| Field | Notes |
|---|---|
| `id`, `org_id`, `workspace_id` | Workspace-owned. `(org_id, workspace_id, id)` is unique and is the target of every child foreign key. |
| `first_name`, `last_name`, `company`, `timezone` (IANA), `locale` (BCP 47) | Optional profile fields |
| `subscription_type`, `subscription_changed_at`, `unsubscribed_by` | Administrative status (§1) |
| `custom_fields` (jsonb) | Values keyed by the custom field's **immutable** machine key |
| `source`, `source_ref` | `manual`, `import` (ref = import id), `api` or `form` |
| `search_text` | Lower-case name plus every identity value; trigram-indexed for search. Maintained by the service in the same transaction. |
| `created_at`, `updated_at`, `version` | `version` supports optimistic concurrency |
| `deleted_at` | Soft delete; restorable |
| `erased_at` | GDPR erasure: personal data removed and the row kept as a tombstone, so consent evidence stays referentially intact |

**Invariant** `[OUR_ORIGINAL_DESIGN]`: a live contact always has at least one email or phone identity. The
last one cannot be removed.

## 3. Identities and normalization

`contact_identities(kind, provider, value, value_normalized, is_primary)`.
Uniqueness is **(workspace, kind, provider, value_normalized)**: one address belongs to at most one contact per
workspace, and the same address can exist in another workspace.

| Kind | Normalization (deterministic) | Notes |
|---|---|---|
| `email` | trim → Unicode NFC → lower-case whole address; must be a valid address ≤ 254 chars | Gmail-style dot/plus folding is **not** applied, because it would merge genuinely different mailboxes `[OUR_ORIGINAL_DESIGN]` |
| `phone` | E.164 via libphonenumber (`+919876543210`). A national format needs a default country (ISO-3166 alpha-2); without one it is rejected. | `[OUR_ORIGINAL_DESIGN]` |
| `whatsapp` | Same as phone (a WhatsApp ID is a phone number) | Separate kind, because WhatsApp opt-in is separate from SMS |
| `external` | Trimmed, case preserved; `provider` names the system (e.g. `crm:hubspot`) | For future CRM sync |

**Rules:**
- **Primary identity:** the first identity of each kind is primary. Changing it is an explicit action.
- **No automatic merge.** When an identity already belongs to another contact, the API answers `409 IDENTITY_CONFLICT` and names the other contact. The import records a row-level conflict.
- **No reassignment in one step.** Moving an identity means removing it from one contact and adding it to the other: two audited actions.
- **Merging contacts** is not part of Phase 5. When it is built it will be explicit, audited and reversible.

## 4. Custom fields

`custom_field_definitions(key, label, description, type, required, options, validation, position, status, key_locked)`

| Type | Stored as | Validation |
|---|---|---|
| `text` | string | max length (default 255) |
| `long_text` | string | max length (default 10 000) |
| `number` | integer | safe integer; optional min/max |
| `decimal` | number | finite; up to 6 decimals; optional min/max |
| `boolean` | boolean | true/false (imports accept yes/no/1/0/true/false) |
| `date` | `YYYY-MM-DD` | real calendar date |
| `datetime` | ISO-8601 UTC | parsed and stored as UTC |
| `email` | normalized email | as in §3 |
| `phone` | E.164 | as in §3 |
| `url` | string | `http`/`https` only (no `javascript:` or `data:`) |
| `single_select` | option key | must be an active option |
| `multi_select` | option keys (unique) | each must be an active option |

**Rules** (all `[OUR_ORIGINAL_DESIGN]`):
- **Machine key** `^[a-z][a-z0-9_]{1,39}$`, not a reserved word (`email`, `phone`, `first_name`, …). The API and imports use the key, never the label.
- **Key locking:** the key locks the moment any contact stores a value, and is then **immutable**. The type can change only while unlocked.
- **Archived fields:**
  - values are kept and shown read-only;
  - the field is not writable and cannot be required;
  - it is excluded from new imports;
  - it can be restored.
- **Deletion:** only for fields never used. Used fields are archived instead.
- **Select options** are `{ key, label, archived }`. Option keys are immutable; options are archived, never removed.
- **Required:** a required field is enforced on create/update through the API and the UI, and on import.
- **Limit:** at most 200 fields per workspace (proposed default).

## 5. Lists, tags, topics

| | Lists | Tags | Topics |
|---|---|---|---|
| Purpose | Static audience grouping | Flexible classification | Communication preferences |
| Membership | `list_memberships` (PK list + contact) | `contact_tags` (PK tag + contact) | `contact_topic_preferences` (PK contact + topic, status) |
| Uniqueness | Name per workspace, case-insensitive, among non-deleted | Name per workspace, case-insensitive, among non-deleted | `key` per workspace |
| Lifecycle | active ⇄ archived (read-only), soft delete removes memberships | active ⇄ archived, soft delete removes tag links | active ⇄ archived, never deleted (consent evidence references it) |
| Provenance | `[ZOHO_PARITY]` | `[ZOHO_PARITY]` | `[ZOHO_PARITY]` hierarchy, with our mapping below |

**Topic hierarchy:**
- **Zoho's model** `[ZOHO_PARITY]`: Brand → Category → Topic.
- **Our mapping** `[OUR_ORIGINAL_DESIGN]`: **Brand = workspace**, which keeps brands isolated. Categories are topics with `kind = category`. Topics may have one category parent.

**Default "Marketing" topic** (every workspace gets one at creation; existing workspaces are back-filled by the migration):
- `[ZOHO_PARITY]`: the default topic cannot be archived while it is the only active topic.
- `[OUR_ORIGINAL_DESIGN]`: exactly one topic is the default; another active topic can be made default.
- `[OUR_ORIGINAL_DESIGN]`: new contacts are **not** auto-subscribed to any topic. Subscriptions are explicit and recorded as evidence.

## 6. Suppression

`suppressions(channel, contact_id | (identity_kind, value_normalized), reason, source, note, created_*, lifted_*)`

| Aspect | Rule |
|---|---|
| Channels | `email`, `sms`, `whatsapp`, or `all` |
| Target | A contact (follows the contact's addresses) **or** an address. Address suppression survives contact deletion and re-creation, and applies before the contact even exists. |
| Reasons | `manual`, `hard_bounce`, `complaint`, `compliance`, `unsubscribe_request`, `invalid_address`. Phase 5 records `manual`/`compliance`/`unsubscribe_request`; bounces and complaints come from Phase 9. |
| Lifting | Lifting writes `lifted_at`/`lifted_by`/`lift_reason`. The row is never deleted, so history is preserved. Lifting a `complaint` suppression requires `suppression.manage` + a reason. |
| Precedence | Suppression beats consent. Transactional messages are blocked by suppression too (spec M7). |
| Domain-level suppression (`@example.com`) | `[NOT_VERIFIED]` in Zoho. **Not implemented** in Phase 5; a planned `[OUR_IMPROVEMENT]`. |

## 7. Search, filters, pagination

- **Endpoint:** `GET /v1/workspaces/{ws}/contacts?q=&listId=&tagId=&topicId=&subscriptionType=&suppressed=&consent=&includeDeleted=&sort=created|updated&order=desc|asc&limit&cursor`
- **Pagination:** keyset over `(sort_key, id)`; the cursor is opaque. Counts are a separate `GET …/contacts/count` with the same filters.
- **Search:** `q` (≥ 2 chars) matches `search_text` with `ILIKE '%q%'`, served by a trigram GIN index.

## 8. Indexes and why they exist

| Index | Serves |
|---|---|
| `contacts (workspace_id, created_at DESC, id DESC)` | Default contact list and keyset pagination |
| `contacts (workspace_id, updated_at DESC, id DESC)` | "Recently updated" sort |
| `contacts (workspace_id, subscription_type)` | Subscription filter and eligibility batches |
| `contacts USING gin (search_text gin_trgm_ops)` | Substring search on names, emails and phones |
| `contact_identities UNIQUE (workspace_id, kind, provider, value_normalized)` | Duplicate prevention; lookup by address (imports, API, callbacks) |
| `contact_identities (workspace_id, contact_id)` | Loading a contact's identities |
| `list_memberships PK (list_id, contact_id)` + `(workspace_id, contact_id)` | List → members; contact → lists |
| `contact_tags PK (tag_id, contact_id)` + `(workspace_id, contact_id)` | Tag filter; contact detail |
| `contact_topic_preferences PK (contact_id, topic_id)` + `(workspace_id, topic_id, status)` | Contact detail; "subscribers of topic" (campaigns) |
| `consent_states PK (contact_id, channel)` + `(workspace_id, channel, state)` | Eligibility; consent filter |
| `consent_events (workspace_id, contact_id, occurred_at DESC)` | Consent history |
| `consent_events (workspace_id, recorded_at)` | Retention purge scans |
| `suppressions UNIQUE (workspace_id, active_key)` + `(workspace_id, contact_id)` + `(workspace_id, identity_kind, value_normalized)` | One active suppression per target; eligibility lookups |
| `domain_events (org_id, aggregate_type, aggregate_id, recorded_at)` (Phase 4) | Contact timeline |

Query plans for the main paths are checked in `packages/db/test/audience-queries.test.ts`.

## 9. Events and audit

**Domain events** (no personal data in payloads; ids only):
- `contact.*` (created, updated, deleted, restored, erased, subscription changed, identity added/removed)
- `list.*` (`list.member_added` / `list.member_removed` use the contact as aggregate)
- `tag.*`, `contact.tagged` / `contact.untagged`
- `topic.*`, `contact.topic_subscribed` / `contact.topic_unsubscribed`
- `consent.recorded`
- `suppression.added` / `suppression.lifted`
- `custom_field.*`
- `import.*`

**Aggregates:** membership facts (list, tag, topic) use the **contact** as their aggregate, so the contact timeline is a
single indexed query over `domain_events`. There is no second activity system. Full catalogue: `docs/events.md`.

**Audit records** cover the sensitive actions:
- erasure
- suppression added and lifted
- staff-recorded consent
- bulk operations (one record per action, with the selection and counts)
- import started, completed, failed and cancelled
- custom-field archive and delete
- consent retention-policy changes and purges
- access denied (Phase 4 mechanism, now also for audience routes)

## 10. Permissions (server-side)

| Permission | Allows |
|---|---|
| `contacts.read` / `contacts.create` / `contacts.update` / `contacts.delete` | Contacts and identities; `contacts.delete` also covers erase |
| `contacts.import` | Imports |
| `lists.read` / `lists.manage` | Lists and list membership |
| `tags.read` / `tags.manage` | Tags and tagging |
| `topics.read` / `topics.manage` | Topic definitions |
| `consent.read` / `consent.manage` | Consent history, recording, retention policy, topic preferences |
| `suppression.read` / `suppression.manage` | Do-not-contact registry |
| `custom_fields.manage` | Field definitions (reading them only needs `contacts.read`) |

**Built-in roles take their permissions from code, not from the snapshot stored with the role.** Adding a permission to
the catalogue therefore reaches every existing organization's Workspace admin, Manager, Editor, Analyst and Viewer
immediately. This also fixes a latent Phase 4 issue: system roles stored a snapshot of their permissions at
organization creation.
