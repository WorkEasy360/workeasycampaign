# Eligibility contract v1 (frozen at the end of Phase 5)

One function answers **"may we send this kind of message to this contact on this channel (for this topic)?"** for
every caller: the contact page today, campaigns, journeys and transactional sends later. Nothing else may decide it,
and no caller needs to know the audience tables to use it.

| Layer | Where |
|---|---|
| Domain rule (pure) | `@workeasy/audience-core` `eligibility.ts` → `evaluateEligibility(facts, request)` (moved unchanged in milestone 6.2) |
| Read-side port and service | `@workeasy/audience-core` `EligibilityEvaluator` over the `EligibilityFactsReader` port; adapter `PrismaEligibilityFactsReader` in `@workeasy/audience-infra` |
| API service | `EligibilityService.evaluate(tx, workspaceId, request)` in `application/suppression-eligibility.service.ts` (delegates to the port) |
| HTTP | `POST /v1/workspaces/{workspaceId}/eligibility/check` (permission `contacts.read`) |
| Types | `packages/shared/src/eligibility.ts`: `EligibilityRequest`, `EligibilityResult`, `EligibilityResponse`, `IneligibilityReason` |

## Request

```ts
interface EligibilityRequest {
  contactIds: string[];          // 1–100 contacts of THIS workspace
  channel: 'email' | 'sms' | 'whatsapp';
  purpose?: 'marketing' | 'transactional';   // default marketing
  topicId?: string;              // a topic of THIS workspace
}
```

## Response

```ts
interface EligibilityResponse {
  results: EligibilityResult[];  // one per contact found, in no guaranteed order
  notFound: string[];            // ids that are not contacts of this workspace
}
interface EligibilityResult {
  contactId: string; channel: Channel; purpose: MessagePurpose; topicId: string | null;
  eligible: boolean;
  reasons: { code: IneligibilityReason; message: string }[];  // ALL failing checks, most fundamental first
  addressIdentityId: string | null;  // the identity a message would be sent to (primary of the channel's kind)
}
```

- **Every** failing check is returned, not just the first `[OUR_IMPROVEMENT]`: a person fixing a contact needs every blocker. A campaign report can still group by `reasons[0]`.
- **No sensitive data:** results carry ids and reason codes only — never addresses, names or evidence. Messages are fixed strings. A sender loads the address for `addressIdentityId` itself at send time and must re-evaluate eligibility at send time.
- **Workspace mismatch:** contacts of another workspace (or organization) are invisible under RLS and appear in `notFound`, exactly like ids that never existed. A `topicId` that is not a topic of this workspace makes the **whole request** invalid.

## Errors

| Situation | Result |
|---|---|
| Invalid body (bad uuid, > 100 ids, unknown channel) | `400 validation_failed` with field errors |
| `topicId` unknown in this workspace, or a category | `400 validation_failed`, `fields.topicId` |
| Caller lacks `contacts.read` | `403` (audited) |
| Workspace not accessible | `404` |

## Reason codes

Codes are stable: never renamed or reused. New codes may be added (consumers must treat unknown codes as "not
eligible, reason unknown").

| Code | When | Purpose | Provenance |
|---|---|---|---|
| `CONTACT_DELETED` | contact soft-deleted or erased | all | OUR_ORIGINAL_DESIGN |
| `NOT_MARKETING` | subscription type non-marketing | marketing | ZOHO_PARITY |
| `UNSUBSCRIBED` | subscription type unsubscribed | marketing | ZOHO_PARITY |
| `NO_ADDRESS` | no identity of the channel's kind (email→email, sms→phone, whatsapp→whatsapp) | all | OUR_ORIGINAL_DESIGN |
| `SUPPRESSED` | active suppression of the contact, or of **any** of its addresses of that kind, for the channel or `all` | **all, transactional included** | ZOHO_PARITY (do-not-mail) + OUR_IMPROVEMENT (per channel, by address) |
| `CONSENT_MISSING` | no channel consent recorded | marketing | OUR_ORIGINAL_DESIGN |
| `CONSENT_PENDING` | double opt-in requested, not confirmed | marketing | OUR_ORIGINAL_DESIGN |
| `CONSENT_EXPIRED` | the pending request is older than the workspace's pending-expiry period | marketing | OUR_ORIGINAL_DESIGN |
| `CONSENT_WITHDRAWN` | consent withdrawn (blocks every address of the channel) | marketing | OUR_ORIGINAL_DESIGN |
| `CONSENT_ADDRESS_CHANGED` | consent was granted for an address that is no longer the primary one | marketing | OUR_ORIGINAL_DESIGN |
| `TOPIC_NOT_SUBSCRIBED` | a topic was given and the contact is not subscribed to it | marketing | ZOHO_PARITY |
| `TOPIC_INACTIVE` | the given topic is archived | all | OUR_ORIGINAL_DESIGN |

Reserved (codes fixed now, evaluated later): `FREQUENCY_CAP`, `QUIET_HOURS` (defers, does not drop), `DUPLICATE`,
`UNENGAGED`, `CHANNEL_UNAVAILABLE`, `EXCLUDED_BY_CAMPAIGN`.

### Product decisions (not Zoho behaviour)

- **Channel consent is required for marketing on every channel** `[OUR_ORIGINAL_DESIGN]`. This is our own decision, chosen as the safe default for GDPR and India's DPDP Act. What we verified about Zoho is the subscription-type gate (`NOT_MARKETING`, `UNSUBSCRIBED`); whether Zoho also requires per-channel consent is `[NOT_VERIFIED]`. A per-workspace "consent mode" can relax this later without changing the contract.
- **Consent is address-bound** `[OUR_ORIGINAL_DESIGN]` (`docs/consent.md` §2, questions 13–14).
- **Transactional** messages skip subscription, consent and topic checks but never suppression or deletion.
- **Domain-level suppression does not exist** (Zoho behaviour `[NOT_VERIFIED]`). Phase 6 must not assume it; a domain block today means suppressing each address.

## Service contract for later phases

```ts
// Inside the caller's own workspace-scoped transaction (inTenant), so RLS applies:
const { results, notFound } = await eligibility.evaluate(tx, workspaceId, { contactIds, channel, purpose, topicId });
```

- Loads facts set-based in a fixed number of queries per call (≤ 100 contacts). For a campaign audience, call it in batches of 100 inside the sender's chunked transactions. (v1.1 below raises the in-process limit only through the benchmark gate of decision D.)
- Pure function underneath: the same facts always give the same answer.

## Relationship to events

Eligibility is computed live from current state; it is **not** an event and emits none. Events that can change a
result: `contact.subscription_changed`, `contact.deleted/restored/erased`, `contact.identity_added/removed`,
`contact.primary_identity_changed`, `consent.recorded`, `contact.topic_subscribed/unsubscribed`,
`suppression.added/lifted`, `topic.archived/restored`. A consumer caching eligibility must invalidate on these, and
must re-evaluate at send time regardless.

## v1.1 — APPROVED (6.3.0) AND IMPLEMENTED (6.3.1)

**Status:** proposed by the Phase 6 architecture review (decision D-2, issues P5-2 and P5-4); approved and frozen at
the 6.3.0 decision freeze (decisions D, E, F in `docs/architecture/phase-6-campaign-engine.md` §15); implemented in
milestone 6.3.1 (`evaluateEligibility` in `@workeasy/audience-core`, `topicPolicy` on the shared request type and the
HTTP body, `TOPIC_UNSUBSCRIBED`, the in-process batch limit and `EligibilityEvaluator.evaluateInBatches`). Everything above stays exactly as frozen: v1.1 is **additive** — a caller that does not pass the new
field gets byte-for-byte v1 behaviour.

### Changes

| Change | Detail |
|---|---|
| Request field `topicPolicy?: 'require_subscription' \| 'block_unsubscribed'` (decision E — exactly this type; never narrowed to `'block_unsubscribed'` alone) | Omitted ⇒ **byte-for-byte v1**. `require_subscription` is the explicit name of the v1 policy (same output as omitting it); `block_unsubscribed` is the Campaigns policy. Only meaningful with `topicId` and `purpose: 'marketing'`; ignored for `transactional`. Accepted in-process and as an optional field of the HTTP body (OpenAPI enum). |
| New reason code `TOPIC_UNSUBSCRIBED` | Emitted **only** under `block_unsubscribed` when the contact explicitly unsubscribed from the topic. Under `require_subscription` an explicit unsubscribe still reports `TOPIC_NOT_SUBSCRIBED` (unchanged v1 output). Added to `ELIGIBILITY_REASONS` directly after `TOPIC_INACTIVE` and to the evaluated set; no existing code is renamed or reused; consumers treat an unknown code as "not eligible" (fail closed, Audience contract §3). |
| Service batch limit (decision D) | The HTTP endpoint stays **≤ 100** in every case. The in-process limit (`EligibilityEvaluator` / `EligibilityService.evaluate`) is set by a benchmark, not assumed: (1) measure 100, 500 and 1,000 ids with realistic facts, p50/p95/p99; (2) if 1,000 ids → p95 < 250 ms, the limit is 1,000; (3) otherwise the limit is the largest size that passes, the benchmark is documented, and callers with larger pages (Campaign Checkpoint A, 1,000 ids) split them into sub-batches internally. Results are identical whatever the batch size. A larger in-process call is a programming error (thrown), never a partial answer. **Outcome (6.3.10 benchmark, 2026-10-05, realistic facts, development machine):** 100 ids p50 100 / p95 114 / p99 168 ms; 500 ids p50 156 / p95 191 / p99 199 ms; 1,000 ids p50 245 / p95 316 / p99 357 ms. 1,000 fails the gate, 500 passes ⇒ **in-process limit = 500**; a 1,000-id Campaign page is evaluated as two sub-batches (`EligibilityEvaluator.evaluateInBatches`); HTTP stays 100. |

### Topic preference states

Phase 5 stores a topic preference as `subscribed`, `unsubscribed`, or **no row** (= `UNSET`). There is no other
state.

| Policy | `UNSET` | `SUBSCRIBED` | `UNSUBSCRIBED` |
|---|---|---|---|
| `require_subscription` (v1 default) | `TOPIC_NOT_SUBSCRIBED` | passes | `TOPIC_NOT_SUBSCRIBED` |
| `block_unsubscribed` (v1.1, used by all campaigns) | passes the **topic** check | passes | `TOPIC_UNSUBSCRIBED` |

**OUR PRODUCT DECISION** `[OURS]` — not verified Zoho behaviour. The Phase 5 code records the opt-in rule ("a
campaign reaches only subscribers of its topic") as `[ZOHO_PARITY]`; campaigns deliberately deviate from it because
Phase 5 never auto-subscribes contacts to topics (opt-in would exclude every newly imported, fully consented contact)
and because we require recorded channel consent, which a topic preference does not replace.

#### Hierarchy: a contact is eligible only if **every** gate passes

Eligibility is an AND of independent gates. Each gate can only **block**; no gate can grant permission that another
gate withholds. The topic gate is evaluated like every other gate and **cannot compensate** for any of the others.

| Order | Gate | Blocks with | Applies to |
|---|---|---|---|
| 1 | Contact exists | `CONTACT_DELETED` | all purposes |
| 2 | Administrative status | `NOT_MARKETING`, `UNSUBSCRIBED` (global unsubscribe) | marketing |
| 3 | Address for the channel | `NO_ADDRESS` (`INVALID_ADDRESS` reserved for delivery) | all purposes |
| 4 | Suppression | `SUPPRESSED` | **all purposes** |
| 5 | **Channel consent** — the only gate that establishes permission to send marketing | `CONSENT_MISSING`, `CONSENT_PENDING`, `CONSENT_EXPIRED`, `CONSENT_WITHDRAWN`, `CONSENT_ADDRESS_CHANGED` | marketing |
| 6 | Topic | `TOPIC_INACTIVE` (both policies); `TOPIC_NOT_SUBSCRIBED` (`require_subscription`); `TOPIC_UNSUBSCRIBED` (`block_unsubscribed`) | marketing (`TOPIC_INACTIVE`: all) |

Under `block_unsubscribed`:

- `SUBSCRIBED` passes gate 6 — and nothing else. It is a preference, not consent.
- `UNSUBSCRIBED` blocks (`TOPIC_UNSUBSCRIBED`).
- `UNSET` passes gate 6 — **`UNSET` is not evidence of consent.** A contact with an unset topic preference is
  eligible only if gates 1–5 all pass, in particular gate 5: recorded, unexpired, current-address channel consent
  for this channel. Consent on another channel does not count.

The order only fixes the order of reported reasons; all failing gates are reported.

### Truth table (purpose `marketing`, channel email, one topic)

Columns: **CC** = channel consent state for the current primary address; **Sub** = contact subscription type;
**Topic** = preference. Results list every reason, in the engine's order.

| # | Case | CC | Sub | Topic | Other | `block_unsubscribed` (campaigns) | `require_subscription` (v1) |
|---|---|---|---|---|---|---|---|
| 1 | Valid consent, unset topic | granted | marketing | UNSET | — | **eligible** | `TOPIC_NOT_SUBSCRIBED` |
| 2 | Valid consent, subscribed | granted | marketing | SUBSCRIBED | — | eligible | eligible |
| 3 | Valid consent, unsubscribed topic | granted | marketing | UNSUBSCRIBED | — | `TOPIC_UNSUBSCRIBED` | `TOPIC_NOT_SUBSCRIBED` |
| 4 | Missing consent, subscribed topic | none | marketing | SUBSCRIBED | — | `CONSENT_MISSING` | `CONSENT_MISSING` |
| 5 | Missing consent, unset topic | none | marketing | UNSET | — | `CONSENT_MISSING` | `CONSENT_MISSING`, `TOPIC_NOT_SUBSCRIBED` |
| 6 | Withdrawn consent, subscribed | withdrawn | marketing | SUBSCRIBED | — | `CONSENT_WITHDRAWN` | `CONSENT_WITHDRAWN` |
| 7 | Pending / expired request | pending / expired | marketing | UNSET | — | `CONSENT_PENDING` / `CONSENT_EXPIRED` | same + `TOPIC_NOT_SUBSCRIBED` |
| 8 | Global unsubscribe | granted | unsubscribed | SUBSCRIBED | — | `UNSUBSCRIBED` | `UNSUBSCRIBED` |
| 9 | Non-marketing contact | granted | non_marketing | SUBSCRIBED | — | `NOT_MARKETING` | `NOT_MARKETING` |
| 10 | Suppressed | granted | marketing | SUBSCRIBED | suppression (email or all) | `SUPPRESSED` | `SUPPRESSED` |
| 11 | Changed address | granted for previous primary | marketing | SUBSCRIBED | — | `CONSENT_ADDRESS_CHANGED` | `CONSENT_ADDRESS_CHANGED` |
| 12 | Archived topic | granted | marketing | SUBSCRIBED | topic archived | `TOPIC_INACTIVE` | `TOPIC_INACTIVE` |
| 13 | Deleted contact | granted | marketing | SUBSCRIBED | deleted | `CONTACT_DELETED` | `CONTACT_DELETED` |
| 14 | No email address | none | marketing | UNSET | no email identity | `NO_ADDRESS`, `CONSENT_MISSING` | `NO_ADDRESS`, `CONSENT_MISSING`, `TOPIC_NOT_SUBSCRIBED` |
| 14a | Consent recorded for **another channel only** (SMS granted, email none) | none (email) | marketing | SUBSCRIBED | — | `CONSENT_MISSING` | `CONSENT_MISSING` |
| 14b | Unsubscribed topic **and** missing consent | none | marketing | UNSUBSCRIBED | — | `CONSENT_MISSING`, `TOPIC_UNSUBSCRIBED` | `CONSENT_MISSING`, `TOPIC_NOT_SUBSCRIBED` |
| 14c | Global unsubscribe, unset topic | granted | unsubscribed | UNSET | — | `UNSUBSCRIBED` | `UNSUBSCRIBED`, `TOPIC_NOT_SUBSCRIBED` |
| 14d | Suppressed, unset topic | granted | marketing | UNSET | suppression | `SUPPRESSED` | `SUPPRESSED`, `TOPIC_NOT_SUBSCRIBED` |
| 14e | Changed address, unset topic | granted for previous primary | marketing | UNSET | — | `CONSENT_ADDRESS_CHANGED` | `CONSENT_ADDRESS_CHANGED`, `TOPIC_NOT_SUBSCRIBED` |
| 15 | Transactional purpose (not used by campaigns) | any | unsubscribed | UNSUBSCRIBED | not suppressed | eligible (topic, consent and subscription are not applied to transactional; `topicPolicy` ignored) | eligible |
| 16 | Transactional, suppressed | any | any | any | suppressed | `SUPPRESSED` | `SUPPRESSED` |

Campaigns are always `marketing`; rows 15–16 document the unchanged v1 transactional behaviour for other callers.

### Multiple topics (deferred to v1.2 together with `topicIds[]`, P5-3)

Rule fixed now so it is not invented later: with several topics, **any explicit unsubscribe from any selected topic
blocks** (`TOPIC_UNSUBSCRIBED`), because the message would also be about a subject the person refused. Under
`block_unsubscribed` an all-unset or partly subscribed selection passes; under `require_subscription` at least one
selected topic must be `SUBSCRIBED` and none `UNSUBSCRIBED`. Phase 6 campaigns use exactly one topic.

### Affected code, migration, regression tests

| Item | Detail |
|---|---|
| Code | `packages/shared/src/eligibility.ts` (request field, new code at the end of the evaluated list), `@workeasy/audience-core` `eligibility.ts` (facts: topic policy), `EligibilityService` (pass-through, batch limit), `eligibilityCheckRequest` (optional field), OpenAPI |
| Data migration | none (no stored data changes) |
| Consumers | the contact page eligibility widget (unchanged default), the HTTP endpoint (optional field), Campaigns (new) |
| Regression | every existing eligibility unit/API/E2E test passes unchanged; new tests: every truth-table row (1–16, 14a–14e) under both policies plus `topicPolicy` omitted; HTTP default equals v1 output for the same facts; batches of 1, 100, 101 and the adopted limit give results identical to single-contact calls, limit + 1 is rejected in-process; HTTP 100 accepted, 101 → 400 |
| Known comment defect | `packages/shared/src/eligibility.ts` describes an unknown topic as "a 422"; the frozen behaviour (this document, the audit, the code) is `400 validation_failed`. Corrected in 6.3.1; behaviour unchanged. |

## Tests

- Rules: `apps/api/src/modules/audience/domain/audience-domain.test.ts` (each reason, ordering, transactional exemptions, address binding, expiry).
- API: `apps/api/test/audience.test.ts`, `apps/api/test/audience-hardening.test.ts` (address change, expiry, foreign topic and contacts, no addresses in the response).
- E2E: consent makes a contact eligible; suppression makes it ineligible with exactly `SUPPRESSED` (`apps/e2e/tests/phase5.spec.ts`).
