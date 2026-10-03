# Eligibility contract v1 (frozen at the end of Phase 5)

One function answers **"may we send this kind of message to this contact on this channel (for this topic)?"** for
every caller: the contact page today, campaigns, journeys and transactional sends later. Nothing else may decide it,
and no caller needs to know the audience tables to use it.

| Layer | Where |
|---|---|
| Domain rule (pure) | `apps/api/src/modules/audience/domain/eligibility.ts` → `evaluateEligibility(facts, request)` |
| Service | `EligibilityService.evaluate(tx, workspaceId, request)` in `application/suppression-eligibility.service.ts` |
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

- Loads facts set-based in a fixed number of queries per call (≤ 100 contacts). For a campaign audience, call it in batches of 100 inside the sender's chunked transactions.
- Pure function underneath: the same facts always give the same answer.

## Relationship to events

Eligibility is computed live from current state; it is **not** an event and emits none. Events that can change a
result: `contact.subscription_changed`, `contact.deleted/restored/erased`, `contact.identity_added/removed`,
`contact.primary_identity_changed`, `consent.recorded`, `contact.topic_subscribed/unsubscribed`,
`suppression.added/lifted`, `topic.archived/restored`. A consumer caching eligibility must invalidate on these, and
must re-evaluate at send time regardless.

## Tests

- Rules: `apps/api/src/modules/audience/domain/audience-domain.test.ts` (each reason, ordering, transactional exemptions, address binding, expiry).
- API: `apps/api/test/audience.test.ts`, `apps/api/test/audience-hardening.test.ts` (address change, expiry, foreign topic and contacts, no addresses in the response).
- E2E: consent makes a contact eligible; suppression makes it ineligible with exactly `SUPPRESSED` (`apps/e2e/tests/phase5.spec.ts`).
