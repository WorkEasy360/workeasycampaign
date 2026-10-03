# Consent (Phase 5, decision D3)

Consent is **evidence**, not a flag. Every change is an append-only `consent_events` row recording who, when, how and
on what basis. The current state is a projection (`consent_states`, `contact_topic_preferences`) updated in the same
transaction. Evidence is kept for a **configurable** period. Nothing is hard-coded to "keep forever", and deleting a
contact never silently deletes its evidence.

Provenance: per-topic lawful basis is `[ZOHO_PARITY]`. Zoho's evidence model is `[NOT_VERIFIED]`. The append-only
event model and the retention policy are `[OUR_IMPROVEMENT]` / `[OUR_ORIGINAL_DESIGN]`.

## 1. What is kept separate

| Concept | Where | Changed by |
|---|---|---|
| Subscription type (marketing / non-marketing / unsubscribed) | `contacts.subscription_type` | staff, imports, the contact |
| **Channel consent** (email / sms / whatsapp) | `consent_events` → `consent_states` | staff with evidence, imports with evidence, the contact (later phases) |
| **Topic preference** | `consent_events` (topic-scoped) → `contact_topic_preferences` | staff, imports, the contact |
| Suppression | `suppressions` | staff, bounces/complaints (Phase 12) |

Eligibility (`docs/eligibility.md`) reads all four and never collapses them into one value.

## 2. Consent events (as built)

| Column | Meaning |
|---|---|
| `org_id`, `workspace_id`, `contact_id` | Owner. `contact_id` is NOT NULL: an erased contact stays as a tombstone row without personal data (§4), so evidence keeps its subject. |
| `channel` / `topic_id` | Exactly one scope: a channel (email, sms, whatsapp) or a topic (CHECK constraint). |
| `action` | `subscribed`, `unsubscribed`, `pending`, `confirmed`, `revoked` |
| `previous_state` → `new_state` | `none`, `pending`, `granted`, `withdrawn` (channels); `subscribed`, `unsubscribed` (topics) |
| `lawful_basis` | consent, contract, legal_obligation, vital_interests, public_task, legitimate_interests. Required when consent is given or confirmed by staff. |
| `source` | admin, form, import, api, paper, verbal (staff-entered) and contact-originated sources for later phases |
| `actor_type`, `actor_id` | contact, user, system, api_key |
| `subject_fingerprint` | HMAC-SHA256 (`DATA_FINGERPRINT_SECRET`) of the normalized address at the time. Survives erasure without storing the address. |
| `ip_address`, `user_agent` | Only when captured from the contact's own device (forms, Phase 20) |
| `consent_text_version`, `form_id`, `form_version` | Reserved for forms (Phase 20); null today |
| `evidence` | JSON reference metadata: staff note and reference, import id + row number, request id |
| `correlation_id`, `occurred_at`, `recorded_at` | Traceability |

**Immutability (defence in depth):**
- `workeasy_app` has `SELECT, INSERT` only on `consent_events`. There is no UPDATE grant and no DELETE grant.
- A `BEFORE UPDATE` trigger rejects updates even for the owner role.
- The only deletion path is the retention purge (§3), a `SECURITY DEFINER` function restricted to the caller's current workspace.
- Tested: `packages/db/test/audience-rls.test.ts`, `security-invariants.test.ts`.

There is **no API to edit or delete evidence**. A mistake is corrected by recording a new event.

## 3. Retention policy

One policy per workspace (`consent_retention_policies`). When none is saved, the defaults apply and the UI says so.

| Setting | Default | Meaning |
|---|---|---|
| `retain_after_withdrawal_days` | 2190 (6 years) | Evidence for a channel or topic whose current state is withdrawn/unsubscribed, once that withdrawal is older than this. `NULL` = keep indefinitely, an explicit choice. |
| `retain_after_erasure_days` | 2190 | Evidence of an erased contact, once the erasure is older than this. `NULL` = indefinitely. |
| `pending_expiry_days` | 7 | Stored now; applied when double opt-in arrives with forms (Phase 20). See Known limitations. |

The defaults are a proposal, not legal advice. The UI says to check them with a legal advisor.

- **Who:** `consent.read` to view; `consent.manage` to change the policy or run a purge. The spec proposed also requiring `security.manage`; Phase 5 uses `consent.manage` alone (admins hold it; editors and viewers do not). Revisit with the organization-level override.
- **Audit:** policy changes (`consent.retention_policy_updated`, before/after values) and purges (`consent.retention_purged`, deleted count).
- **Purge:** `POST …/consent/retention-purge` calls `app.purge_consent_evidence(workspace)`. It deletes only events past their retention, never evidence of currently granted consent, and returns a count. It is rate-limited and requires typing PURGE in the UI. A scheduled purge job arrives with the BullMQ worker.

## 4. Deletion and erasure

| Action | Contact row | Consent evidence |
|---|---|---|
| Soft delete (`DELETE /contacts/:id`) | `deleted_at` set; restorable | untouched |
| Erase (`POST /contacts/:id/erase`, type `ERASE`) | Tombstone: names, company, custom fields, identities, lists, tags and search text removed; `erased_at` set | untouched; already pseudonymous (fingerprint, no address); removed only by the retention purge |

Erasure is audited (`contact.erased`) without personal data.

## 5. Sticky self-unsubscribe `[ZOHO_PARITY]`

When **the contact** unsubscribes (`changed_by = contact`), staff, imports and bulk actions cannot re-subscribe them:
- Staff consent recording and subscription changes return `422 SELF_UNSUBSCRIBED`.
- Imports never change the subscription type of an existing contact. Consent or topic re-subscription for that contact is refused and reported as a warning on the row.
- Only a new action by the contact (preference centre or form, later phases) can re-subscribe.

Tested in `apps/api/test/audience.test.ts` and `apps/api/src/modules/audience/domain/audience-domain.test.ts`.

## 6. Recording consent from the UI

Contact → Consent → *Record change*. Staff choose what happened, the lawful basis, how consent was collected
(paper, verbal, web form, other), and enter evidence and an optional reference. The change is audited as
`consent.recorded_by_staff` and appears in the contact's history and timeline. Recording a state that already
holds is a no-op (`changed: false`); no duplicate evidence is written.

## Known limitations

- `pending_expiry_days` is stored but not applied yet. No flow creates pending consent except staff entry, and pending consent is already ineligible (`CONSENT_PENDING`).
- The organization-level policy with workspace overrides from the spec is simplified to per-workspace.
- Consent texts (versioned wording) arrive with forms; the columns already exist.
