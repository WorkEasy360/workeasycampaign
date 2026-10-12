# AI and billing readiness

**Status:** AI: contracts and ports only (no model is called). Usage metering: IMPLEMENTED (Phase 7.13, 2026-10-09, §2.1).
Billing (plans, prices, invoices, payment): not built, by design.

The goal is that both capabilities can be added later without touching Campaign domain logic and without any path that bypasses
validation, permissions or tenancy.

## 1. AI content assistance

| Piece | Where |
|---|---|
| Request, suggestion and response contracts | `packages/shared/src/ai.ts` (`aiAssistRequest`, `aiSuggestionSchema`, `aiAssistResponse`) |
| Port `ContentAssistant`, bound to `DisabledContentAssistant` (`available: false, reason: 'ai_not_enabled'`) | `apps/api/src/modules/campaigns/application/readiness-ports.ts` |
| Contract tests | `packages/shared/src/readiness.test.ts` |

**Kinds:** subject, preheader, rewrite, tone (friendly, formal, concise, enthusiastic), spam-risk advice. Campaign recommendations and
segment suggestions follow the same pattern later; they need read models that do not exist yet.

**Safety rules, fixed by the contract:**

1. **The input is ids only.** The server loads the draft the caller can already edit, with its RLS scope. There is no free-form prompt and no contact data (the strict request schema rejects both), and no cross-tenant content.
2. **The output is a suggestion in existing shapes.** Text for the subject or preheader, `email.content.v2` draft blocks, or advice codes. Raw HTML cannot be expressed.
3. **Suggestions are never applied automatically.** The user applies a suggestion, and it then goes through the ordinary draft update: `expectedVersion`, permissions, readiness (merge-tag allowlist, link and image rules), canonicalization and rendering.
4. **Prompts and model I/O are a separate AI context.** It has its own retention, PII redaction, rate limits, and usage metering (`ai.tokens`, §2).

## 2. Usage metering (billing readiness)

| Piece | Where |
|---|---|
| Meters and the `usage.record.v1` contract (append-only, idempotent on `recordId`) | `packages/shared/src/usage.ts` |
| Port `UsageRecorder`, bound to `DisabledUsageRecorder` | `readiness-ports.ts` |

| Meter | Kind | Owner | Source fact |
|---|---|---|---|
| `contacts.active` | gauge (daily) | Audience | live contacts (count via an Audience port) |
| `campaign.executions` | counter | Campaigns | `campaign.started` (one record per execution id) |
| `messages.sent` | counter | Delivery (Phase 8) | real delivery acceptances only; **test mode never meters** |
| `templates.active` | gauge | Campaigns | live templates |
| `storage.bytes` | gauge | Audience imports / assets | stored upload bytes |
| `ai.tokens` | counter | AI context | model usage |

**Boundary:** owning contexts emit usage facts. A billing context aggregates them per organization and period and
applies plans and limits. Campaigns never computes prices, quotas or entitlements. Enforcing a plan limit later goes
through a capability check (an "entitlements" port answering allowed/denied with a reason code), the same way delivery
capability works today.

A failure to record usage must never fail the business operation that produced it. Records are idempotent, so they
can be retried.

### 2.1 Implementation (Phase 7.13)

**Ledger.** `usage_records`:
- Append-only: the runtime role may only insert and read.
- Idempotent on `record_id`.
- RLS by organization; a write must match the transaction's workspace.

Counters are written in the SAME transaction as their fact, like an audit row. A run is metered exactly once, never lost
and never doubled; a duplicate start is a no-op.

| Meter | Written by | Record id |
|---|---|---|
| `campaign.executions` | execution start transaction | `campaign.executions:<execution>` |
| `messages.sent` | delivery outcome transaction, **live mode only** (the null port and the provider port against a test double never meter) | `messages.sent:<execution>:<first sent recipient of the batch>` |
| `templates.active`, `contacts.active`, `storage.bytes` | daily snapshot (`UsageService.snapshotAll`, scheduler role, hourly, first snapshot of the UTC day wins), per active workspace | `<meter>:<workspace>:<YYYY-MM-DD>` |
| `ai.tokens` | not emitted (AI not enabled) | — |

`contacts.active` and `storage.bytes` are counted by Audience through the `AudienceUsage` port (the owner of those
tables). Storage covers stored import files.

**Read API.** `GET /v1/organizations/{orgId}/usage?from=&to=` (`billing.manage`):
- counters summed over the period;
- gauges at each workspace's latest snapshot in the period;
- a per-workspace breakdown.

The web page is Settings → Usage. It shows quantities only.

**Automation usage** has no meter: journeys are not built (master prompt §20). The meter is added with them.

**Evidence (MEASURED 2026-10-09):**
- `apps/api/test/usage.test.ts`: exactly-once run metering; test mode never meters messages; the live helper; idempotent daily gauges; the summary, its permission and isolation; append-only and RLS for the runtime role.
- `apps/web/.../settings/usage/usage.test.tsx`.
- `messages.sent` end to end: NOT TESTED (live delivery is refused by configuration).
