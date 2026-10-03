# Eligibility engine (Phase 5)

One function answers "may we send this kind of message to this contact on this channel?" for every caller:
the contact page today, and campaigns, journeys and transactional sends later. Nothing else may decide this.

- Pure rule: `apps/api/src/modules/audience/domain/eligibility.ts` (`evaluateEligibility`)
- Fact loading (set-based, ≤ 100 contacts per call): `EligibilityService` in `application/suppression-eligibility.service.ts`
- Contract: `packages/shared/src/eligibility.ts`
- API: `POST /v1/workspaces/{ws}/eligibility/check` `{ contactIds, channel, purpose?, topicId? }` (`contacts.read`)

## Result

```ts
{ contactId, channel, purpose, topicId, eligible: boolean, reasons: [{ code, message }] }
```

**All** failing checks are returned, most fundamental first. The spec (M8.4) said "first failure only". We changed this
`[OUR_IMPROVEMENT]` because a user fixing a contact needs every blocker, not one at a time. Campaign reports can
still group by the first reason. Unknown or other-workspace contact ids come back in `notFound`, with no detail.

## Reason codes (stable, never renamed)

| Code | When | Applies to | Provenance |
|---|---|---|---|
| `CONTACT_DELETED` | contact soft-deleted or erased | all purposes | OUR_ORIGINAL_DESIGN |
| `NOT_MARKETING` | subscription type is non-marketing | marketing | ZOHO_PARITY |
| `UNSUBSCRIBED` | subscription type is unsubscribed | marketing | ZOHO_PARITY |
| `NO_ADDRESS` | no identity of the channel's kind (email → email, sms → phone, whatsapp → whatsapp) | all | OUR_ORIGINAL_DESIGN |
| `SUPPRESSED` | active suppression for the contact, or for any of its addresses, on this channel or `all` | **all, transactional included** | ZOHO_PARITY + OUR_IMPROVEMENT |
| `CONSENT_MISSING` | no channel consent recorded | marketing | OUR_ORIGINAL_DESIGN |
| `CONSENT_PENDING` | consent awaiting confirmation | marketing | OUR_ORIGINAL_DESIGN |
| `CONSENT_WITHDRAWN` | consent withdrawn | marketing | OUR_ORIGINAL_DESIGN |
| `TOPIC_NOT_SUBSCRIBED` | a topic was given and the contact is not subscribed to it | marketing | ZOHO_PARITY |
| `TOPIC_INACTIVE` | the given topic is archived | all | OUR_ORIGINAL_DESIGN |

Reserved for later phases (codes fixed now): `FREQUENCY_CAP`, `QUIET_HOURS` (defers, does not drop), `DUPLICATE`,
`UNENGAGED`, `CHANNEL_UNAVAILABLE`, `EXCLUDED_BY_CAMPAIGN`.

### Design decisions to confirm

- **Channel consent is required for marketing on every channel** `[OUR_ORIGINAL_DESIGN]`. This is stricter than Zoho, where a marketing-type contact on a list is mailable, and our research did not confirm per-channel consent there `[NOT_VERIFIED]`. It is the safe default for GDPR and India's DPDP Act. A per-workspace "consent mode" (e.g. legitimate interest for existing customers in some regions) can relax it later without changing callers.
- **Transactional** messages skip subscription, consent and topic checks but **never** suppression or deletion.
- **Address suppressions** match by normalized address, so they block a contact created later with that address.
- **Domain-level suppression** is not implemented. Whether Zoho supports it is `[NOT_VERIFIED]`.

## Tests

- Rule tests in `apps/api/src/modules/audience/domain/audience-domain.test.ts`: the eligible case, all reasons reported together and in order, channel vs `all` suppression, transactional exemptions, deleted/no-address/pending/withdrawn/archived-topic cases.
- API: eligibility after consent, topic and suppression changes; cross-workspace ids reported as not found (`apps/api/test/audience.test.ts`).
- E2E: consent makes a contact eligible; suppression makes it ineligible with exactly `SUPPRESSED` (`apps/e2e/tests/phase5.spec.ts`).
