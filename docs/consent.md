# Consent (Phase 5, decision D3; hardened and frozen)

Consent is **evidence**, not a flag. Every change is an append-only `consent_events` row recording who, when, how and
on what basis. The current state is a projection (`consent_states`, `contact_topic_preferences`) updated in the same
transaction. Evidence is kept for a **configurable** period. Nothing is hard-coded to "keep forever", and deleting a
contact never silently deletes its evidence.

**Provenance**
- Verified parity `[ZOHO_PARITY]`: subscription types; a contact who unsubscribed themselves cannot be resubscribed by an administrator (subscription type); per-topic subscriptions; a lawful basis per topic in GDPR mode.
- Our product decisions `[OUR_ORIGINAL_DESIGN]` / `[OUR_IMPROVEMENT]`: channel consent as a separate concept; consent **required** for marketing on every channel; the append-only evidence log; extending the sticky self-unsubscribe rule to channel consent and topic preferences; address-bound consent; derived pending expiry; the retention policy.
- Not verified `[NOT_VERIFIED]`: Zoho's evidence model, its pending/double opt-in expiry, and whether it requires per-channel consent. Do not cite these as Zoho behaviour.

## 1. What is kept separate

| Concept | Where | Changed by |
|---|---|---|
| Subscription type (marketing / non-marketing / unsubscribed) | `contacts.subscription_type` + `unsubscribed_by` | staff, the contact (later phases) |
| **Channel consent** (email / sms / whatsapp) | `consent_events` → `consent_states` | staff with evidence, imports with evidence, the contact (later phases) |
| **Topic preference** | `consent_events` (topic-scoped) → `contact_topic_preferences` | staff, imports, the contact (later phases) |
| Suppression | `suppressions` | staff, bounces and complaints (Phase 12) |

Eligibility (`docs/eligibility.md`) reads all four and never collapses them into one value.

## 2. Consent semantics — the answers

| # | Question | Answer (as implemented and tested) |
|---|---|---|
| 1 | What is valid consent? | Channel state `granted`, **recorded for the contact's current primary address of that channel**. Staff-recorded grants need a lawful basis plus evidence (a note or reference). A grant needs an address of the channel's kind to exist. `pending` (double opt-in requested) is not consent. Neither is a request that has `expired`. |
| 2 | What is an explicit unsubscribe? | Action `unsubscribed` → state `withdrawn`. It is recorded **even when no consent existed** (evidence that the person said no), with `changed_by` = who recorded it. `revoked` is a withdrawal by staff/system (compliance) and is a no-op when nothing was granted or requested. |
| 3 | Can staff reverse a self-unsubscribe? | **No.** If the contact withdrew themselves (`changed_by = contact`), any grant, request or confirmation by `user`, `system` or `api_key` returns `422 SELF_UNSUBSCRIBED`. The same rule applies to the subscription type and to topics. A withdrawal *entered by staff* on someone's behalf (`changed_by = user`) can be followed by a new staff-recorded grant **with evidence**: that is recording a new consent the person gave, and it is audited. |
| 4 | Can imports reverse it? | **No.** Imports run as the importing user. Consent and topic subscriptions refused by the rule above become row warnings. Imports never change the subscription type of an existing contact. |
| 5 | Can APIs reverse it? | **No.** Every HTTP route records actor `user`. A future public API acts as `api_key`, which the rule treats like staff. |
| 6 | Can the contact subscribe again? | **Yes**, through their own new consent action (actor `contact`: preference centre, form, double opt-in confirmation). No such entry point exists yet (forms arrive in Phase 20), so today a self-unsubscribe is permanent. |
| 7 | Is consent channel-specific? | **Yes.** One state per (contact, channel). Email consent says nothing about SMS. |
| 8 | Is consent topic-specific? | Topic preference is separate from channel consent and per topic. A marketing message needs **both** channel consent and, when the message names a topic, a subscription to that topic. |
| 9 | How is history preserved? | `consent_events` is append-only: `workeasy_app` has `SELECT, INSERT` only (no UPDATE/DELETE grant), a `BEFORE UPDATE` trigger rejects updates even for the owner role, timestamps cannot lie in the future (CHECK constraint), and there is no API to edit or delete evidence. Mistakes are corrected by recording a new event. |
| 10 | Which record is authoritative for eligibility? | The **projection** (`consent_states`, `contact_topic_preferences`), written in the same transaction as each event. The event log is the proof; eligibility never replays it. |
| 11 | What happens when evidence expires (retention)? | The purge deletes evidence older than the policy (§4). The projection is **not** deleted, so a withdrawn contact stays withdrawn and ineligible after its evidence is gone. |
| 12 | What happens when consent is revoked? | State `withdrawn`; eligibility reports `CONSENT_WITHDRAWN` for **every** address of that channel. Only a new grant changes it, and only the contact may grant again if they withdrew themselves. |
| 13 | What happens when the contact's email or phone changes? | Consent is **bound to the address it was given for** (`consent_states.subject_fingerprint`, a keyed hash). When the primary address of the channel changes, the old consent no longer counts: eligibility reports `CONSENT_ADDRESS_CHANGED` and the contact page shows "given for a previous address". Switching back makes it count again. A **withdrawal** is not address-bound: it blocks every address of the channel. Changing the primary emits `contact.primary_identity_changed`. |
| 14 | Can consent for one identity affect another? | **No** for grants (see 13): consent for `a@x` never covers `b@x`, even on the same contact. Withdrawals intentionally cover all addresses of the channel (the safe direction). Identities are never shared between contacts (unique per workspace), so consent cannot leak across contacts. |

## 3. Consent events (as built)

| Column | Meaning |
|---|---|
| `org_id`, `workspace_id`, `contact_id` | Owner. `contact_id` is NOT NULL: an erased contact stays as a tombstone row without personal data (§5), so evidence keeps its subject. |
| `channel` / `topic_id` | Exactly one scope: a channel or a topic (CHECK constraint). |
| `action` | `subscribed`, `unsubscribed`, `pending`, `confirmed`, `revoked` |
| `previous_state` → `new_state` | Stored states: `none`, `pending`, `granted`, `withdrawn` (channels); `subscribed`, `unsubscribed` (topics). |
| `lawful_basis` | consent, contract, legal_obligation, vital_interests, public_task, legitimate_interests |
| `source` | admin, form, import, api, paper, verbal and (later) contact-originated sources |
| `actor_type`, `actor_id` | contact, user, system, api_key |
| `subject_fingerprint` | HMAC-SHA256 (`DATA_FINGERPRINT_SECRET`) of the channel and normalized address at the time. Survives erasure without storing the address. |
| `ip_address`, `user_agent` | Only when captured from the contact's own device (forms, Phase 20). Staff entries store null: the staff member's IP is in the audit log instead. |
| `consent_text_version`, `form_id`, `form_version` | Reserved for forms (Phase 20) |
| `evidence` | JSON reference metadata: staff note and reference, import id + row number, request id |
| `occurred_at` | When it happened according to the evidence. May be in the past (paper form), never in the future (API validation and `CHECK (occurred_at <= recorded_at + 5 min)`). |
| `recorded_at` | Server time the evidence was stored. |

The projection `consent_states` stores the effective-state inputs: `state`, `changed_by`, `lawful_basis`,
`changed_at` (= the evidence date), **`recorded_at`** (server time, used for expiry and retention) and
**`subject_fingerprint`** (the address the state applies to).

## 4. Pending expiry `[OUR_ORIGINAL_DESIGN]`

Pending consent is part of the active design: staff can record "consent requested", and double opt-in forms will
use it in Phase 20. A pending request older than the workspace's `pending_expiry_days` (default 7), measured from its
**server** `recorded_at`, is **expired**:

- Eligibility reports `CONSENT_EXPIRED`; the contact page shows "Request expired".
- `confirmed` is refused (`INVALID_TRANSITION`): an old confirmation link cannot turn into consent.
- A new request or a new grant starts over; an unsubscribe records a withdrawal.

Expiry is **derived on read** (`effectiveChannelState`), not written by a job. It is exact at every moment, needs no
scheduler, and never modifies evidence. The stored state stays `pending`; no `expired` event is written.

## 5. Retention policy

One policy per workspace (`consent_retention_policies`). With no row, the defaults apply and the UI says so.

| Setting | Default | Meaning |
|---|---|---|
| `retain_after_withdrawal_days` | 2190 (6 years) | Evidence for a channel/topic whose current state is withdrawn/unsubscribed, once that withdrawal has been **on record** (server time) for longer than this. Only events recorded no later than the withdrawal are eligible. `NULL` = keep indefinitely. |
| `retain_after_erasure_days` | 2190 | Evidence of an erased contact, once the erasure is older than this. `NULL` = indefinitely. |
| `pending_expiry_days` | 7 | See §4. |

The defaults are a proposal, not legal advice; the UI says to check them with a legal advisor.

**What retention applies to:**

| Record | Retention / purge | Mutable? |
|---|---|---|
| Consent evidence (`consent_events`) | Yes — only via `app.purge_consent_evidence`, only past the policy | Never updated |
| Consent projections (`consent_states`, `contact_topic_preferences`) | **Not purged** (they are what keeps a withdrawn contact withdrawn) | Updated by new events only |
| Audit log (`audit_logs`) | Not covered by this policy. Organization-level retention is Phase 17/19 work | Append-only |
| Domain events / contact timeline (`domain_events`) | Not covered. Payloads contain ids only (no personal data), so they do not need erasure. Retention by partition is Phase 11 work | Append-only |
| Import issues (`contact_import_issues`) | Not covered. They contain row numbers, codes and messages, never cell contents | Dry-run issues are replaced by each new dry run |
| Import files | Deleted when the import completes or is cancelled; abandoned uploads after 24 h; failed imports after 7 days (`docs/imports.md`) | — |
| Idempotency records | 24 h | — |

**Changing the policy** affects only future purges. Shortening it makes more evidence purgeable at the next purge;
it never deletes anything by itself. Every change is audited with before/after values.

**Scope decision:** per workspace only. An organization-level default with workspace overrides is **deferred**: every
workspace already gets the documented default, and nothing in the current architecture needs an organization-wide
value. It can be added later without changing the purge function's contract.

**Who:** `consent.read` to view; `consent.manage` to change the policy or run a purge. (The spec proposed
`security.manage` as well; Phase 5 uses `consent.manage` alone. Built-in roles with it: Workspace admin, Manager.)

**Purge:** `POST …/consent/retention-purge` → `app.purge_consent_evidence(workspace)`, a `SECURITY DEFINER` function
that refuses any workspace other than the caller's current context, deletes only events past their retention, never
evidence behind a currently granted state, returns a count, and is audited (`consent.retention_purged`). Rate-limited;
the UI requires typing PURGE.

**Scheduling is deferred** (decision recorded in the hardening audit): retention only *permits* deletion, nothing in
Phase 5 requires evidence to be deleted on a schedule, and the purge is idempotent and safe to repeat. A scheduled
per-workspace purge will be a BullMQ tenant job calling the same function when the worker runs queues (Phase 9).

## 6. Deletion and erasure

| Action | Contact row | Consent evidence |
|---|---|---|
| Soft delete | `deleted_at` set; restorable | untouched |
| Erase (type `ERASE`) | Tombstone: names, company, custom fields, identities, lists, tags and search text removed; `erased_at` set | untouched and already pseudonymous; removed only by the retention purge |

Erasure is audited (`contact.erased`) without personal data. Address-level suppressions keep their normalized address
after erasure on purpose: a do-not-contact request must keep working (legitimate interest; documented in
`docs/security.md`).

## 7. Recording consent from the UI

Contact → Consent → *Record change*: what happened, lawful basis, how it was collected, evidence and an optional
reference. Audited as `consent.recorded_by_staff`; shown in the history and timeline. Recording a state that already
holds is a no-op (`changed: false`); no duplicate evidence is written.
