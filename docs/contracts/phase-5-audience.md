# Phase 5 audience contract — FROZEN

Frozen on 2026-10-03 after the hardening audit (`docs/audit/phase-5-hardening-audit.md`, decision
`READY_FOR_PHASE_6`). Phase 6 and later phases **depend on** what is listed here. They may extend it through
**versioned, additive** changes (new optional fields, new event versions, new reason codes, new endpoints). They must
not casually rewrite it: a breaking change needs an explicit decision recorded in this file.

## 1. Database entities (workspace-owned, RLS-forced, composite tenant keys)

| Entity | Contract |
|---|---|
| `contacts` | Never hard-deleted. Soft delete (`deleted_at`) and erasure tombstone (`erased_at`, personal data removed). `subscription_type` + `unsubscribed_by`. `version` for optimistic concurrency. |
| `contact_identities` | `(workspace, kind, provider, value_normalized)` unique. Kinds: email, phone, whatsapp, external(provider). One primary per kind; the primary is the send-to address. |
| `custom_field_definitions` | Key and type immutable once the field holds data; used fields archive, never delete. |
| `lists`, `list_memberships`, `tags`, `contact_tags` | Static grouping; archived lists are read-only. |
| `topics`, `contact_topic_preferences` | Category → Topic per workspace; topic `key` immutable; exactly one default topic, never archivable. |
| `consent_events` | Append-only evidence (no UPDATE/DELETE for runtime roles; update trigger; future dates refused). Deleted only by the retention purge. |
| `consent_states` | Authoritative channel-consent projection incl. `recorded_at` (server time) and `subject_fingerprint` (address binding). |
| `consent_retention_policies` | Per workspace; NULL = keep indefinitely. |
| `suppressions` | Never deleted; lifting is recorded. Target = contact XOR (kind + normalized address). Channel or `all`. |
| `contact_imports`, `contact_import_issues` | Import lifecycle and per-row issues (no cell contents). |

Phase 6 code must read audience data through the services below, not by querying these tables directly.

## 2. Public APIs

All under `/v1/workspaces/{workspaceId}/…`, documented in `docs/api/openapi.json` (66 audience operations): contacts
(+ identities, subscription, consent, topics, tags, timeline, bulk, count), lists, tags, topics, custom-fields,
suppressions, consent/retention-policy, consent/retention-purge, eligibility/check, imports. Error shape:
`{ error: { code, message, fields?, requestId } }`. Writes that create or act in bulk accept `Idempotency-Key`; edits
take `version` and return `409 version_conflict` when stale.

## 3. Eligibility contract v1

`docs/eligibility.md`. Phase 6 calls `EligibilityService.evaluate(tx, workspaceId, { contactIds ≤ 100, channel, purpose, topicId })`
inside its own workspace-scoped transaction, uses `addressIdentityId` to find the send-to address, and re-evaluates
at send time. Stable reason codes; unknown codes mean "not eligible".

## 4. Event contracts v1

`docs/events.md` §Audience event contract. Consumers deduplicate by event `id`; payloads carry no personal data.

## 5. Authorization model

Server-side only (`@WorkspaceAccess(permission)` on every route + RLS). Permissions: `contacts.read/create/update/delete/import`,
`custom_fields.manage`, `lists.read/manage`, `tags.read/manage`, `topics.read/manage`, `consent.read/manage`,
`suppression.read/manage`. Composite actions need every permission they exercise (bulk actions per action; import
options; contact creation with lists/tags). Built-in role mapping: `apps/api/src/modules/tenancy/domain/system-roles.ts`.
The UI only hides controls; it is never authoritative.

## 6. Consent semantics

`docs/consent.md` §2 (14 answered questions). In one line: channel consent is required for marketing, is
address-bound, expires when pending, can only be re-granted by the contact after a self-withdrawal, and its evidence is
immutable and retained per policy.

## 7. Suppression semantics

A suppression blocks **every purpose** (transactional included) on its channel (or all channels), for the contact or
for any contact holding the suppressed address — including contacts created later. Lifting needs a reason and is
audited. **No domain-level suppression** exists.

## 8. Identity semantics

Deterministic normalization (email: trim + NFC + lower-case, no dot/plus folding; phone/WhatsApp: E.164, a national
number needs an explicit default country; external: exact, per provider). Matching hierarchy for imports: normalize
every identity in the row → find each identity's owner → *duplicate in file* (skip) → *owners differ* (error, never
merged) → *owner deleted* (error) → *one owner* (update, attaching the row's new identities) → *no owner* (create).
**Contacts are never merged automatically.**
