# Phase 6 campaign contract — v1

**Status: FROZEN FOR IMPLEMENTATION, pending human approval of the decisions listed in
`docs/architecture/phase-6-campaign-engine.md` §2.** Nothing in this document is implemented yet. When Phase 6 is
built and hardened, this file becomes the frozen contract that Phases 7–15 depend on; changes after that are
versioned and additive only.

Related contracts: Audience v1 + proposed v1.1 extensions (`docs/contracts/phase-5-audience.md` §9),
Eligibility v1 + proposed v1.1 (`docs/eligibility.md` §"Proposed v1.1"), campaign events
(`docs/events.md` §"Campaign event contract v1").

Provenance: `[VERIFIED]` = Zoho behaviour recorded as `[ZOHO_PARITY]` in `docs/spec.md`; `[OURS]` = our design;
`[INFERENCE]` = reasoned, not verified.

---

## 1. Concepts

| Concept | Kind | One-line definition |
|---|---|---|
| Campaign | Aggregate root (table `campaigns`) | A workspace-owned, single-channel marketing communication: editable draft + lifecycle status |
| CampaignVersion | Immutable entity (table `campaign_versions`) | A frozen snapshot of the draft, created when the campaign is committed to send |
| CampaignExecution | Entity (table `campaign_executions`) | One run of one version: send time, progress, checkpoint, outcome |
| CampaignRecipient | Entity (table `campaign_recipients`) | One contact selected by one execution: work item, idempotency unit, outcome |
| Message | Value object inside draft/version | Channel-typed content (`messages[]`, one `default` variant in Phase 6) |
| AudienceDefinition | Value object inside draft/version | Include/exclude selectors resolved through Audience Resolution v1 |
| AudienceSnapshot | **Audience-owned**, referenced by id from the execution | The audience fixed at one instant (T0) by Audience Resolution `capture`; transient; released per §6.4 (after materialization commits, cancellation, failure, or by the recovery sweep) |
| Schedule | Value object inside draft/version; resolved to `send_at` on the execution | When to send |
| Readiness | Computed, never stored | Result of cheap pre-flight checks on the current draft |
| Pre-flight | Computed, never stored | Full check including audience size and eligibility estimate |

## 2. Campaign lifecycle (authoritative)

### 2.1 States

| State | Meaning | Draft editable | Terminal |
|---|---|---|---|
| `draft` | Being prepared; may be incomplete | yes | no |
| `scheduled` | A version and a `pending` execution exist; waiting for `send_at` | no | no |
| `sending` | The execution is `materializing` or `delivering` | no | no |
| `paused` | A user paused the running execution | no | no |
| `completed` | All recipients of the execution reached a final status | no | **yes** |
| `cancelled` | A user cancelled; already-sent messages stay sent | no | **yes** |
| `failed` | The execution stopped for a **configuration** reason; never for infrastructure or per-recipient reasons | no | no (return to draft) |

No other state exists in Phase 6. In particular there is no `pending_approval`, `approved`, `rejected`,
`awaiting_winner` or `paused_by_system`: their behaviour is not built, so they are not states. They will be added as
**additive** enum values together with their behaviour (§13). Consumers must treat unknown states as "not editable,
not sendable".

Campaign `status` is stored for querying but is a **projection**: it is written only by the domain, in the same
transaction as the draft or execution change that implies it.

| Execution status | Campaign status |
|---|---|
| (no active execution, never committed or unscheduled) | `draft` |
| `pending` | `scheduled` |
| `materializing`, `delivering` | `sending` |
| `paused` | `paused` |
| `completed` / `cancelled` / `failed` | `completed` / `cancelled` / `failed` |

### 2.2 Commands, preconditions, actors, effects

Every command: (1) authorizes, (2) locks the campaign row (`SELECT … FOR UPDATE`), (3) checks `expectedVersion`
where required, (4) evaluates the pure transition function, (5) writes, events and audit in **one transaction**.
Lock order is always campaign → execution → recipients.

| Command | From → To | Actor / permission | Preconditions | Events | Reversible | Repeat behaviour |
|---|---|---|---|---|---|---|
| `create` | — → `draft` | user `campaigns.create` | channel enabled (§9) | `campaign.created` | delete | Idempotency-Key |
| `update` | `draft` → `draft` | user `campaigns.update` (+ composite read permissions, §8) | `expectedVersion` matches | `campaign.updated` | edit again | stale → 409 |
| `schedule` | `draft` → `scheduled` | user `campaigns.send` | `expectedVersion`; **delivery capability** (§9.3); pre-flight has no errors | `campaign.version_created`, `campaign.scheduled` | `unschedule` | Idempotency-Key replays the same version and execution |
| `reschedule` | `scheduled` → `scheduled` | user `campaigns.send` | delivery capability; new time valid; execution still `pending` | `campaign.rescheduled` | yes | same time → no-op |
| `unschedule` | `scheduled` → `draft` | user `campaigns.send` | execution still `pending` | `campaign.unscheduled` | schedule again (new version) | already `draft` → no-op |
| `start` | `scheduled` → `sending` | **system** (scheduler at `send_at`; immediately for send-now) | execution `pending`, `send_at` ≤ now, start-time checks pass | `campaign.started` | no | conditional update: second starter no-ops |
| `start` (config broken) | `scheduled` → `failed` | system | start-time check or audience capture fails (§6.1) | `campaign.failed` | `return_to_draft` | once |
| `pause` | `sending` → `paused` | user `campaigns.send` | — | `campaign.paused` | `resume` | already `paused` → no-op |
| `resume` | `paused` → `sending` | user `campaigns.send` | delivery capability | `campaign.resumed` | `pause` | already `sending` → no-op |
| `cancel` | `scheduled`/`sending`/`paused` → `cancelled` | user `campaigns.send` | — | `campaign.cancelled` | **no** | already `cancelled` → no-op |
| `complete` | `sending` → `completed` | system | execution `delivering`, no non-final recipient | `campaign.completed` | **no** | conditional; emitted once |
| `fail` | `sending` → `failed` | system | configuration failure mid-run (§11) | `campaign.failed` | `return_to_draft` | once |
| `return_to_draft` | `failed` → `draft` | user `campaigns.update` | — | `campaign.returned_to_draft` | — | already `draft` → no-op |
| `clone` | any → new `draft` | user `campaigns.create` | source readable | `campaign.created` (`clonedFrom`) | delete copy | Idempotency-Key |
| `delete` | `draft`/`completed`/`cancelled`/`failed` → soft-deleted | user `campaigns.delete` | not `scheduled`/`sending`/`paused` | `campaign.deleted` | `restore` | already deleted → no-op |
| `restore` | soft-deleted → previous status | user `campaigns.delete` | — | `campaign.restored` | `delete` | not deleted → no-op |

"No-op" responses are `200` with the current `CampaignView`; they emit nothing and write no audit record.
For commands that carry `expectedVersion`, step (3) precedes every transition outcome: a stale version is
`409 version_conflict` even when the matrix would answer ∅, ✗, `CAMPAIGN_NOT_EDITABLE` or `CAMPAIGN_ACTIVE`. Commands without a
version (pause, resume, return_to_draft, restore) and system transitions go straight to step (4).

### 2.3 Transition matrix (complete)

Rows = current state, columns = command. ✓ = allowed (preconditions above), ✗ = `409 INVALID_TRANSITION`,
∅ = idempotent no-op, — = not a user command.

| State \ Command | update | schedule | reschedule | unschedule | pause | resume | cancel | return_to_draft | clone | delete | restore | start (sys) | complete (sys) | fail (sys) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| draft | ✓ | ✓ | ✗ | ∅ | ✗ | ✗ | ✗ | ∅ | ✓ | ✓ | ∅ | — | — | — |
| scheduled | ✗¹ | ✗ | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ | ✓ | ✗² | ∅ | ✓ | — | ✓ |
| sending | ✗ | ✗ | ✗ | ✗³ | ✓ | ∅ | ✓ | ✗ | ✓ | ✗² | ∅ | ∅ | ✓ | ✓ |
| paused | ✗ | ✗ | ✗ | ✗³ | ∅ | ✓ | ✓ | ✗ | ✓ | ✗² | ∅ | — | — | ✓⁴ |
| completed | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | ∅ | — | ∅ | — |
| cancelled | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ∅ | ✗ | ✓ | ✓ | ∅ | — | — | — |
| failed | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ | ∅ | — | — | ∅ |

¹ `422 CAMPAIGN_NOT_EDITABLE` ("unschedule to edit"). ² `422 CAMPAIGN_ACTIVE` ("cancel or unschedule first").
³ Too late: the execution has started; use pause or cancel. ⁴ Only on `resume`'s re-check (topic archived, channel or
delivery capability disabled while paused). Audience-source changes never fail a running execution: its audience
was fixed at capture.

### 2.4 Races between competing commands

| Race | Resolution |
|---|---|
| Edit (A) vs schedule (B) | Both carry `expectedVersion`; the second to commit gets `409 version_conflict`. B snapshots exactly the version it saw. |
| Two schedules | Same Idempotency-Key → replay; different keys → the second fails the `expectedVersion` check first (`409 version_conflict`, the first bumped the version); only a request carrying the current version reaches transition evaluation and sees `scheduled` → `409 INVALID_TRANSITION`. |
| Unschedule vs system start at `send_at` | Campaign row lock serializes. If start won, unschedule → `409` (use pause/cancel). If unschedule won, start finds no `pending` execution and no-ops. |
| Cancel vs start | Same; cancel after start cancels the running execution. |
| Pause vs complete | If complete won, pause → `409 INVALID_TRANSITION`; if pause won, completion waits for resume. |
| Pause vs materialization page | Each page locks the execution row and re-reads status before writing; a paused execution writes nothing more. |
| Two system starters | Conditional `UPDATE … WHERE status = 'pending'` + lease; exactly one wins. |

### 2.5 `allowedActions` and `blockedActions`

Every `CampaignView` contains, computed server-side from status + permissions + capabilities + cheap readiness:

```ts
type CampaignAction = 'update' | 'schedule' | 'send_now' | 'reschedule' | 'unschedule' | 'pause' | 'resume'
  | 'cancel' | 'return_to_draft' | 'clone' | 'delete' | 'restore';
allowedActions: CampaignAction[];                                   // the UI renders exactly these as enabled
blockedActions: { action: CampaignAction; reason: string }[];      // lifecycle-legal but blocked, e.g. DELIVERY_NOT_AVAILABLE, READINESS_ERRORS, PERMISSION_DENIED
```

The frontend never derives actions from `status`. The server re-checks every command regardless.

## 3. Readiness and pre-flight

### 3.1 Contract

```ts
type FindingSeverity = 'error' | 'warning' | 'info';
type FindingSection = 'details' | 'topic' | 'audience' | 'sender' | 'message' | 'schedule' | 'channel' | 'delivery';
interface ReadinessFinding {
  code: string;                 // stable, from §3.2
  severity: FindingSeverity;
  section: FindingSection;
  field?: string;               // JSON pointer into the draft, e.g. "/messages/0/content/subject"
  message: string;              // user-facing; never contains personal data
  details?: Record<string, string | number | boolean>;
}
interface CampaignReadiness {                       // in every CampaignView (cheap, synchronous)
  readiness: 'ready' | 'not_ready';                 // 'ready' = no errors
  readinessFindings: ReadinessFinding[];
}
interface PreflightResult extends CampaignReadiness { // POST /preflight (adds expensive checks)
  checkedAt: string;
  sections: Record<FindingSection, 'pass' | 'warning' | 'error'>;
  estimate: {
    audienceSize: number; audienceSizeCapped: boolean;          // live, exact up to the 5,000,000 capture limit; capped ⇒ AUDIENCE_TOO_LARGE
    eligibleEstimate: number; sampleSize: number;               // eligibility evaluated on a uniform sample ≤ 2,000
    topReasons: { code: string; share: number }[];               // share of the sample, 0–1
  } | null;                                                      // null when the audience definition is invalid
}
```

Readiness runs structural checks only (no audience counting, no eligibility). Pre-flight runs everything. The same
engine runs at `schedule` (blocking: any error → `422 PREFLIGHT_FAILED` with the findings) and at `start` (blocking:
configuration errors → execution `failed`).

**Fact sources (implemented in 6.7):** every Audience fact comes through a port, never a table read — topic status from
Audience Resolution v1.1 `topicStatus` (`TOPIC_UNAVAILABLE` for not found, archived or category); source status from
v1 `validate`; `audienceSize` (exact, live) and the uniform sample of ≤ 2,000 contact ids from v1.1 `sample`
(`docs/contracts/phase-5-audience.md` §9.9 — no snapshot is created for pre-flight); eligibility from Eligibility v1.1
(`evaluateInBatches`, channel email, purpose marketing, `topicPolicy: 'block_unsubscribed'` when the topic is
available, otherwise channel rules only). `eligibleEstimate = round(eligible / sampleSize × audienceSize)`;
`topReasons` = the 5 most frequent reason codes, share of the sample (a contact counts once per code). Sample ids
never leave the service: the result, findings, audit rows, events and logs carry counts and shares only.

### 3.2 Findings (Phase 6)

| Code | Severity | Section | Readiness | Pre-flight | Start |
|---|---|---|---|---|---|
| `NAME_MISSING` | error | details | ✓ | ✓ | — |
| `CHANNEL_NOT_AVAILABLE` | error | channel | ✓ | ✓ | ✓ |
| `TOPIC_MISSING` | error | topic | ✓ | ✓ | — |
| `TOPIC_UNAVAILABLE` (deleted, archived or a category) | error | topic | — | ✓ | ✓ |
| `AUDIENCE_EMPTY_DEFINITION` | error | audience | ✓ | ✓ | — |
| `AUDIENCE_TOO_MANY_SOURCES` (> 25 include or > 25 exclude) | error | audience | ✓ | ✓ | — |
| `AUDIENCE_SOURCE_CONFLICT` (same source included and excluded) | error | audience | ✓ | ✓ | — |
| `AUDIENCE_SOURCE_NOT_FOUND` | error | audience | — | ✓ | ✓ (capture) |
| `AUDIENCE_TOO_LARGE` (> 5,000,000 members, Audience §9.6) | error | audience | — | ✓ | ✓ (capture) |
| `AUDIENCE_SOURCE_ARCHIVED` | warning (members are frozen, still sendable) | audience | — | ✓ | — |
| `AUDIENCE_EMPTY` (0 members) | error | audience | — | ✓ | — |
| `NO_ELIGIBLE_RECIPIENTS` (estimate 0) | error | audience | — | ✓ | — |
| `LOW_ELIGIBLE_SHARE` (estimate < 50 %) | warning | audience | — | ✓ | — |
| `SENDER_NOT_CONFIGURED` | warning in Phase 6, error from Phase 8 | sender | ✓ | ✓ | — |
| `REPLY_TO_INVALID` | error | sender | ✓ | ✓ | — |
| `SUBJECT_MISSING`, `SUBJECT_TOO_LONG` (> 200) | error | message | ✓ | ✓ | — |
| `BODY_MISSING`, `BODY_TOO_LONG` (> 100,000 chars) | error | message | ✓ | ✓ | — |
| `SCHEDULE_IN_PAST` (> 1 min ago), `SCHEDULE_TOO_FAR` (> 365 days), `TIMEZONE_INVALID` | error | schedule | ✓ | ✓ | — |
| `DELIVERY_NOT_AVAILABLE` (§9.3) | error | delivery | ✓ | ✓ | ✓ |
| `ELIGIBILITY_ESTIMATE_UNAVAILABLE` (§3.3; added 2026-10-07, `details.retryAfterSeconds`) | error | audience | — | ✓ | — |

Later phases add codes (e.g. `UNSUBSCRIBE_LINK_MISSING`, `SENDER_UNVERIFIED`, `MERGE_TAG_UNRESOLVED`); codes are
never renamed.

### 3.3 Degraded mode — fast audience resolution unavailable (approved 2026-10-07)

Pre-flight never runs an unbounded audience query. Facts come from Audience Resolution v1.2
(`docs/contracts/phase-5-audience.md` §9.10): `sampleWithin(…, { size: 2000, exactBudgetMs: 1000 })`.

| Situation | Pre-flight (`POST …/preflight`) | `schedule` / send-now |
|---|---|---|
| Bitmap VALID (normal) | normal result | normal |
| Bitmap not valid, exact query fits the 1 s budget | normal result (exact) | normal |
| Bitmap not valid, exact query exceeds the budget | **200**, `estimate: null`, error finding `ELIGIBILITY_ESTIMATE_UNAVAILABLE` (section audience, `details.retryAfterSeconds` = 30) → readiness `not_ready`; topic, source and draft findings still reported; Audience recovery requested | if that finding is the only error: **409 `PREFLIGHT_UNAVAILABLE`** + `Retry-After: 30` + the finding — retryable; **no** version, **no** execution, campaign state unchanged; Audience recovery requested. With other errors as well: the ordinary 422 `PREFLIGHT_FAILED` with all of them |

Rules: the estimate is never fabricated or silently omitted (the finding says why it is missing); a degraded audience
state is never a 500 (infrastructure failures still are); a campaign is never frozen into a version without an
authoritative audience check; recovery is Audience-owned, deduplicated per workspace (one rebuild at a time across
processes), and never blocks the request. Interactive budget: exact query ≤ 1 s, whole degraded pre-flight p95 < 2 s
(MEASURED: 1M p95 1,265 ms; `docs/audit/phase-6.7-6.8-preflight-lifecycle.md` §12).

## 4. CampaignVersion

### 4.1 Snapshot schema `campaign.version.v1`

Stored in `campaign_versions.snapshot` (JSONB), validated by a Zod schema in `packages/shared` on write **and** read.

```ts
interface CampaignVersionSnapshotV1 {
  schema: 'campaign.version.v1';
  channel: 'email';                                    // v1: email only
  purpose: 'marketing';                                // campaigns are never transactional
  topic: { topicIds: [string];                         // exactly one in v1 (multi-topic = v2)
           policy: 'block_unsubscribed' };             // Eligibility v1.1 topicPolicy (D-2)
  audience: AudienceDefinitionV1;                      // docs/contracts/phase-5-audience.md §9
  sender: { senderIdentityId: string | null;           // null in Phase 6; verified identity required from Phase 8
            fromName: string | null;                   // ≤ 100 chars, control chars stripped
            replyTo: string | null };                  // normalized email or null
  messages: [{ variantKey: 'default'; content: EmailContentV1 }];   // array so A/B adds variants (v2)
  tracking: { opens: false; clicks: false };           // literal false in v1: tracking is not built (Phase 9)
  compliance: { unsubscribeLink: 'required';           // enforced by the Phase 7 renderer / pre-flight
                listUnsubscribeHeader: 'required' };   // Phase 8 delivery
  personalization: { mode: 'none' };                   // v1 renders text verbatim; merge tags: 'merge_tags_v1' in campaign.version.v2 (content amendment)
  schedule: { mode: 'now' | 'at'; sendAt: string | null; timezone: string };   // IANA zone; sendAt is the UTC instant
  abTest: null;                                        // reserved
}
interface EmailContentV1 {
  schema: 'email.content.v1';
  subject: string;                                     // 1–200 chars
  preheader: string;                                   // 0–200 chars
  body: { format: 'text'; text: string };              // 1–100,000 chars; no HTML, no rendering in v1; stored trimmed of
                                                       // leading/trailing whitespace — the same value readiness validates
}
```

**Compatibility rules.** A stored snapshot is never rewritten. Any change to its shape creates a new schema id
(`campaign.version.v2`, `email.content.v2`), and the domain keeps **upcasters** (`v1 → v2 → …`) so every historical
version stays readable forever. Optional additions within v1 are not allowed — a reader must be able to rely on the
exact v1 shape. The draft on `campaigns` uses the same value types but every field may be partial/null.

### 4.2 Lifecycle of versions

| Question | Rule |
|---|---|
| Created when | Inside the `schedule` command (including send-now), in the same transaction as the execution. `reason`: `scheduled` or `sent_now`. (Future: `submitted_for_approval`, §13.) |
| Scheduling fails | The transaction rolls back: no version, no execution, no event. Pre-flight errors return `422 PREFLIGHT_FAILED` before anything is written. |
| Editable after unschedule | Yes: unschedule returns the campaign to `draft`; the draft is unchanged (it equals the last version); the version stays in history. The next schedule creates version N+1. |
| Rescheduling | Changes only the execution's `send_at` and the draft's schedule field; version and execution unchanged; pre-flight re-runs schedule checks only. The version's `schedule` records the *original* intent; the execution's `send_at` is authoritative. |
| Cloning | Creates a new campaign whose draft is a copy of the source draft or of a chosen version's snapshot. Executions and recipients are never copied. |
| Retention | Every version is kept for the life of the campaign, including while soft-deleted. |
| Immutability (DB) | `workeasy_app` has `SELECT, INSERT` only; `BEFORE UPDATE` trigger `app.reject_update()`; no DELETE. |
| Immutability (app) | The repository exposes no update method; snapshots are deep-frozen after parse. |
| Integrity | `content_hash` = SHA-256 of the canonical JSON (sorted keys) of the snapshot; recomputed and compared in tests. |
| Numbering | `number` starts at 1 per campaign; `UNIQUE (campaign_id, number)`; assigned under the campaign row lock. |

## 5. CampaignExecution

### 5.1 State machine

```text
pending ──start──▶ materializing ──(materialization complete)──▶ delivering ──(all recipients final)──▶ completed
   │                   │    ▲                                       │   ▲
   │ unschedule/cancel │pause│resume                           pause │   │ resume
   ▼                   ▼    │                                       ▼   │
cancelled           paused ─┘  (paused remembers which phase to return to)          any non-terminal ──cancel──▶ cancelled
                                                                                    pending/materializing/delivering/paused ──config failure──▶ failed
```

| Status | Meaning |
|---|---|
| `pending` | Created by `schedule`; waiting for `send_at` |
| `materializing` | **Started.** Capturing the audience snapshot, then evaluating it page by page and recording recipients |
| `delivering` | **Materialization complete.** Recipients are handed to delivery (Phase 8) |
| `paused` | User paused; `paused_phase` = `materializing` or `delivering` |
| `completed` / `cancelled` / `failed` | Terminal |

- **Started** = the committed transition `pending → materializing` (`started_at`).
- **Audience fixed** = commit of the snapshot capture (`captured_at` = T0).
- **Materialization complete** = the committed transition `materializing → delivering` after the last snapshot page
  (cursor `null`), with final `planned`/`skipped` counts (`materialized_at`).

### 5.2 Uniqueness (reviewed)

| Constraint | Purpose | Compatible with |
|---|---|---|
| `UNIQUE (version_id) WHERE run_kind = 'one_time'` | A one-time version runs at most once | Retries (same execution, checkpointed), reschedule (same execution), A/B (variants live inside one execution), future recurring campaigns (`run_kind = 'recurring'`, unique per `(version_id, occurrence_key)`) |
| `UNIQUE (campaign_id) WHERE status IN ('pending','materializing','delivering','paused')` | At most one active execution per campaign | Everything above |
| `UNIQUE (campaign_id, run_number)` | Human-readable run order | — |

A strict 1:1 version↔execution (as first proposed) would block recurring campaigns; `run_kind` keeps the guarantee
where it matters without that limitation. Phase 6 only creates `one_time`.

## 6. Materialization and eligibility checkpoints

### 6.0 The pipeline (one definition, used by every document)

```text
1. Audience Resolution — capture   one statement, at T0 = capturedAt: who is in the audience (membership only)
        ↓
2. Eligibility — Checkpoint A      per page of the snapshot: may each contact be messaged now?
        ↓
3. CampaignRecipient               eligible → pending (+ addressIdentityId); ineligible → skipped (+ reason codes)
        ↓
4. Eligibility — Checkpoint B      fresh, immediately before hand-off to the provider (Phase 8)
        ↓
5. Provider delivery               ChannelAdapter.send with idempotency key = recipient id (Phase 8)
```

Stages 1–3 are Phase 6. Stages 4–5 are Phase 8; their contract is fixed here (§6.3, §10.3).

**Amendment 2026-10-07 (milestone 6.9, Gate G3 test mode; product-owner instruction "Checkpoint B: immediately before
delivery attempt … never deliver merely because the contact was eligible earlier"):** Checkpoint B is implemented in
Phase 6 with exactly the semantics of §6.3, and the test-mode `NullDeliveryPort` is reached ONLY through it:
`pending → queued` (claim) → Checkpoint B (fresh) → `skipped_at_send` | `sending` → `NullDeliveryPort` (outside any
transaction, key = recipient id) → `sent` / back to `queued` / `failed` (§10.3). The earlier wording ("marks
`pending` recipients `sent` without Checkpoint B") is superseded; the `pending → sent` recipient transition is
unused. Phase 8 replaces only the delivery port (render + `ChannelAdapter`). Count semantics: `skipped` =
`skipped` at Checkpoint A + `skipped_at_send` at Checkpoint B (`skippedByReason` counts both); `planned` = recipients
created `pending` at materialization.

### 6.1 Algorithm

```text
start(executionId)                                       -- transaction S1 (short)
  lock campaign, lock execution; require status = pending and send_at <= now
  run start-time checks (§3.2 "Start" column); configuration error → execution failed, campaign failed; stop
  execution.status = materializing; started_at = now()
  emit campaign.started; commit; enqueue materialize job

materialize job (worker tenant-job envelope)
  if execution.audience_snapshot_id is null:
    snapshot = AudienceResolution.capture(scope, version.audience, captureKey = executionId,
                                          owner = { kind: 'campaign_execution', id: executionId })  -- transaction S2,
                                                                                               -- holds no campaign locks
      capture error AUDIENCE_SOURCE_NOT_FOUND | AUDIENCE_TOO_LARGE → transaction S3: execution failed (configuration)
    transaction S3 (short): lock execution; if status != materializing → stop (release follows §6.4)
                            set audience_snapshot_id, captured_at = snapshot.capturedAt, audience_size = snapshot.size
  loop                                                   -- one transaction PER PAGE
    lock execution row FOR UPDATE; if status != materializing → stop (paused or cancelled)
    page = AudienceResolution.page(scope, snapshotId, { cursor: materialization_cursor, limit: 1000 })
    results = Eligibility.evaluate(page.contactIds, channel, 'marketing', topicId, topicPolicy)   -- Checkpoint A
              -- in sub-batches of the adopted in-process limit if it is below 1,000 (decision D); same results
    INSERT recipients ON CONFLICT (execution_id, contact_id) DO NOTHING
    execution.materialization_cursor = page.cursor; counts += inserted; last_progress_at = now(); renew lease
    commit
    if page.cursor is null:
      transition materializing → delivering (materialized_at); emit campaign.audience_materialized; commit
      release per §6.4 (reason 'materialized')
      stop
```

- **Started** = commit of S1 (`started_at`). **Audience fixed** = commit of S2 (`captured_at` = T0, always after
  `started_at`). **Materialization complete** = commit of the `materializing → delivering` transition.
- A crash between S2 and S3 is harmless: the next attempt calls `capture` with the same `captureKey` and receives the
  committed snapshot.

### 6.2 Rules

| Concern | Rule |
|---|---|
| Audience consistency | Exactly the audience at T0 (Audience contract §9.1–9.2): membership changes after T0 never change it; compliance changes after T0 are applied by Checkpoints A and B |
| Transaction size | Capture: one statement in its own transaction (target 1 M in ≤ 10 s). Pages: ≤ 1,000 contacts per transaction (target < 1 s) |
| Checkpoint | `materialization_cursor` + counts committed with each page; a crash resumes from the last committed page over the same snapshot |
| Duplicates | Snapshot primary key (one row per contact) **and** `UNIQUE (execution_id, contact_id)`; a re-run page inserts nothing |
| Overlapping lists/tags | Captured once per contact |
| Progress | `audience_size` known after capture; `planned`, `skipped`, `skipped_by_reason` updated per page; never `COUNT(*)` for the UI |
| Pause | Takes effect at the next page boundary (or after the capture statement); `paused_phase = materializing`; snapshot and cursor kept |
| Resume | Same execution, same snapshot, from `materialization_cursor`; resume checks: topic still active, channel enabled, delivery capability — a failure → execution `failed` (configuration) |
| Cancel | Stops at the next page boundary; `pending` recipients → `cancelled` in chunks of 1,000; snapshot released per §6.4 |
| Source list/tag deleted after T0 | No effect (snapshot holds the members) |
| Source deleted between schedule and T0 | Capture fails → execution `failed` (`AUDIENCE_SOURCE_NOT_FOUND`) |
| Contact deleted/erased after T0 | Checkpoint A: `skipped` (`CONTACT_DELETED`); after its page: Checkpoint B `skipped_at_send` |
| Concurrent workers | Execution row lock per page + lease (`lease_owner`, `lease_until`); capture idempotent per `captureKey` |
| Transient errors | Page retried up to 3 times (0.5 s, 1 s, 2 s), then the job up to 5 times (1, 2, 4, 8, 16 min), then `health = stalled` (§11) |

### 6.3 Eligibility checkpoints

| | Checkpoint A — materialization | Checkpoint B — before provider hand-off |
|---|---|---|
| Phase | 6 | 8 (contract fixed now); **implemented in 6.9 for test mode** (amendment §6.0) |
| Input | snapshot page (≤ 1,000 ids) | batch of claimed `queued` recipients (≤ 1,000) |
| Call | `Eligibility.evaluate(ids, channel, 'marketing', topicId, 'block_unsubscribed')` from the frozen version, in sub-batches of the adopted in-process limit if it is below 1,000 (decision D; identical results) | same parameters, **fresh** data, same sub-batching |
| Eligible | recipient `pending` with `address_identity_id` | proceed to render and send to the `addressIdentityId` returned **now** (the recipient row is updated if it changed) |
| Ineligible | recipient `skipped` + reason codes (final) | recipient `skipped_at_send` + reason codes (final) |
| Eligibility unavailable (error/timeout) | page retried (transient) | **fail closed**: nothing sent; batch back to `queued` with backoff |

Behaviour when something changes after Checkpoint A (enforced by Checkpoint B):

| Change | Result at Checkpoint B |
|---|---|
| Channel consent withdrawn, pending request expired | `skipped_at_send` (`CONSENT_WITHDRAWN` / `CONSENT_EXPIRED`) |
| Topic unsubscribe | `skipped_at_send` (`TOPIC_UNSUBSCRIBED`) |
| Global unsubscribe | `skipped_at_send` (`UNSUBSCRIBED`) |
| Suppression added | `skipped_at_send` (`SUPPRESSED`) |
| Primary address changed, consent not re-given | `skipped_at_send` (`CONSENT_ADDRESS_CHANGED`) |
| Primary address changed and consent re-given for it | sent to the new address |
| Contact deleted or erased | `skipped_at_send` (`CONTACT_DELETED`) |
| Contact merge | merges do not exist; a future merge feature must define recipient handling before it ships |
| A `skipped` contact becomes eligible | not re-added in this execution |

### 6.4 Audience snapshot lifecycle

The snapshot belongs to the Audience context; **the execution decides when it is no longer needed**. Nothing in this
section changes the consistency model (Audience §9.1–9.2) or eligibility.

**Release rule (single guard).** A snapshot may be released only when its execution can never read it again:

```text
releasable(execution) ⇔ execution.materialized_at IS NOT NULL                       -- materialization committed
                      OR execution.status IN ('completed', 'cancelled', 'failed')   -- terminal, never re-enters materializing
```

The release procedure (identical for every trigger below):

```text
transaction R1 (short):
  lock execution row FOR UPDATE                  -- the same lock every materialization page takes
  if not releasable(execution) → stop            -- e.g. still materializing or paused in the materializing phase
  r = AudienceResolution.releaseByKey(scope, captureKey = execution.id, reason)
                                                 -- marks released (first reason kept) and purges ≤ 10,000 members;
                                                 -- idempotent; { released: false, … } if nothing was ever captured
  execution.snapshot_released_at = coalesce(snapshot_released_at, now())
  commit
while r.membersRemaining:                        -- purge continuation (decision A); no execution lock needed:
  transaction Pn: r = AudienceResolution.releaseByKey(scope, execution.id, reason); commit
                                                 -- the snapshot is already released and is never read again
-- a crash anywhere in this loop leaves released_at set and purged_at NULL; purge recovery (sweep) resumes it
```

| Trigger | When release runs | Reason |
|---|---|---|
| 1. Successful materialization | Right after the `materializing → delivering` transaction **commits** (never inside it) | `materialized` |
| 2. Cancelled execution | Right after the cancellation transaction **commits**. Any materialization job still holding a lease finds `status = cancelled` at its next page lock and stops before reading the snapshot | `cancelled` |
| 3. Permanently failed execution | Right after the transition to `failed` **commits** (configuration failure at start, capture or resume) | `failed` |
| 4. Worker crash | **No release.** The execution is still `materializing` (not releasable); the snapshot stays; recovery resumes the **same** execution from `materialization_cursor`. If the crash happened between capture (S2) and recording (S3), recovery calls `capture` with the same `captureKey` and receives the **same** snapshot — a second snapshot cannot exist (`UNIQUE (workspace_id, capture_key)`) | — |
| 5. Recovery sweep | Periodically (every 15 min) and at process start, **per tenant** (see below) | `orphan_sweep` (or the matching reason if the execution state is known) |
| Paused during materialization | **No release** (not releasable): resume needs the snapshot | — |

**Recovery sweep (tenant-scoped).**

1. Discovery: `app.workspaces_with_snapshot_cleanup('campaign_execution', now() − 1 h)` returns
   `(org_id, workspace_id)` pairs only — workspaces with an unreleased snapshot older than 1 h **or** a released
   snapshot whose member purge is incomplete (Audience §9.6, decision J).
2. For each workspace, a job with the standard tenant envelope runs inside `withTenant` for that workspace and:
   - **Campaign side:** finds executions in this workspace that are `releasable` but have
     `snapshot_released_at IS NULL` and `started_at` set → runs the release procedure (covers a crash after a terminal
     transition but before release).
   - **Audience side:** `listUnreleased(scope, 'campaign_execution', now() − 1 h)` → for each, looks up the owning
     execution by `ownerId`: if it is releasable → release procedure; if it does not exist in this workspace →
     `releaseByKey(…, 'orphan_sweep')`, repeated in new transactions while `membersRemaining` (an orphan: e.g. a
     capture whose execution transaction never committed); otherwise (still materializing/paused) → **leave it**.
   - **Purge recovery (Audience-only, decision A):** `listReleasedUnpurged(scope, 'campaign_execution', limit)` → for
     each, `releaseByKey(…)` in new transactions until `membersRemaining` is false. Needs no execution state: a
     released snapshot is never read again.
3. Only snapshots whose owning execution is terminal, materialized or absent are cleaned; a snapshot of a live
   execution is never touched. The sweep never reads across tenants and never deletes recipients, executions or
   anything outside the snapshot tables.

**Concurrency.** The execution row lock and its state are the authoritative guard:

- A materialization page locks the execution row and requires `status = materializing`; release locks the same row
  and requires `releasable`. The two conditions are mutually exclusive, and `releasable` is permanent (no transition
  leads from `delivering` or a terminal state back to `materializing`), so a release can never interleave with a
  page that will read the snapshot.
- A worker whose lease expired and that resumes late re-checks status under the lock before every page; it stops if
  the execution is no longer `materializing`. As a second line of defence, `page()` on a released snapshot returns
  `AUDIENCE_SNAPSHOT_NOT_FOUND`, which the job treats as "stop" (never as a reason to capture again: an execution
  with a recorded `audience_snapshot_id` never re-captures).
- Release and sweep are idempotent; running them twice, concurrently or after a crash is harmless. The procedure never
  skips because `snapshot_released_at` is already set: a capture (S2) still running when a cancellation releases
  "by key" (a no-op at that moment) can commit afterwards; the next sweep finds that snapshot unreleased, sees its
  owner is releasable, and releases it.

**Observability.**

| Signal | Content (no personal data) |
|---|---|
| Execution columns | `audience_snapshot_id`, `captured_at`, `audience_size`, `snapshot_released_at` |
| Snapshot metadata (Audience) | `capture_key` (= execution id), `owner_kind`, `owner_id`, `captured_at`, `size`, `released_at`, `release_reason`, definition of selector **ids** only |
| Metrics | unreleased snapshots by age bucket; releases by reason; sweep runs, orphans found, orphans released; members held |
| Alerts | an unreleased snapshot older than 24 h whose execution is releasable (release failing); a released snapshot still unpurged after 1 h (purge failing); any unpurged snapshot older than 7 days |
| Logs | correlation id, execution id, snapshot id, reason — never contact ids in bulk, never names or addresses |

## 7. CampaignRecipient

### 7.1 State machine

```text
(materialization) ──eligible──▶ pending ──claim──▶ queued ──hand-off──▶ sending ──provider ok──▶ sent
        │                         │                  │                    │
        └──ineligible──▶ skipped  │cancel            │re-check fails      ├──retryable error──▶ queued (attempts+1)
                                  ▼                  ▼                    ├──permanent error──▶ failed
                              cancelled        skipped_at_send            └──outcome unknown──▶ unknown
```

| Status | Written by | Final? |
|---|---|---|
| `pending` | Phase 6 materialization | no |
| `skipped` (+ `reason_codes`) | Phase 6 materialization (Checkpoint A) | yes |
| `cancelled` | Phase 6 cancel | yes |
| `queued`, `sending` | Phase 8 delivery | no |
| `skipped_at_send` (+ `reason_codes`) | Phase 8 Checkpoint B | yes |
| `sent` | Phase 8 (and `NullDeliveryPort` in tests) | yes |
| `failed` (+ `failure_code`) | Phase 8 | yes |
| `unknown` | Phase 8 (provider outcome unknown, §10.3) | yes until reconciled |

A recipient that was `skipped` at materialization is **not** reconsidered during the same execution, even if it
becomes eligible later (the decision was recorded; re-sending requires a new campaign). A `pending` recipient that
becomes ineligible is caught at Checkpoint B.

### 7.2 Content

Ids, status, reason codes, attempt count, timestamps — **no** address, name or message content. Erasing a contact
leaves its recipient rows (ids only), consistent with the Phase 5 tombstone model.

## 8. Authorization

| Operation | Permission(s) | Built-in roles with it (from `system-roles.ts`) |
|---|---|---|
| list, view, counts, capabilities, versions, executions, pre-flight | `campaigns.read` | workspace admin, manager, editor, analyst, viewer |
| create, clone | `campaigns.create` | workspace admin, manager, editor |
| update draft, return to draft, restore version into draft | `campaigns.update` | workspace admin, manager, editor |
| delete, restore | `campaigns.delete` | workspace admin, manager, editor |
| schedule, send now, reschedule, unschedule, pause, resume, cancel | `campaigns.send` | workspace admin, manager |
| recipients list (shows contact display names) | `campaigns.read` + `contacts.read` | as above |
| audience selector of type `list` / `tag` in a draft | `campaigns.update` + `lists.read` / `tags.read` | as above |
| choose topic | `campaigns.update` + `topics.read` | as above |
| approval (reserved, §13) | `campaigns.approve` | workspace admin |

No new permissions are created: the existing catalogue already has `campaigns.read/create/update/delete/send/approve`.
Pause/resume/cancel share `campaigns.send` (whoever may start sending must be able to stop it). Permissions are
checked per request; a denial is `403` and audited (`access.denied`). A scheduled execution keeps running if its
initiator later loses access (authorized at commit; others with `campaigns.send` can cancel) — D-6.

## 9. Channels, content and capabilities

### 9.1 Layers (no layer may skip another)

| Layer | Responsibility | Location |
|---|---|---|
| Campaign orchestration | lifecycle, versions, executions, recipients | `apps/api/src/modules/campaigns` |
| `ChannelSpec` (strategy) | content schemas, content validation findings, address kind, enabled flag, capability declaration | `apps/api/src/modules/campaigns/domain/channels/` |
| Eligibility | may we message this contact | `@workeasy/audience-core` (D-7) |
| Rendering | content → `RenderedPayload` | Phase 7 |
| Scheduling | starting due executions; per-recipient timing | Phase 8 |
| Provider delivery | `ChannelAdapter.send` | `packages/channels` (exists) |
| Tracking | opens/clicks | Phase 9 |

The campaign aggregate never contains provider logic and never branches on channel except through
`channelSpecs.get(channel)`.

### 9.2 Channels in Phase 6

| Channel | `ChannelSpec` | Enabled | Create campaign |
|---|---|---|---|
| `email` | yes (`email.content.v1`) | yes | allowed |
| `sms` | declared, `enabled: false` | no | `422 CHANNEL_NOT_AVAILABLE` |
| `whatsapp` | declared, `enabled: false` | no | `422 CHANNEL_NOT_AVAILABLE` |

### 9.3 Delivery capability (server-enforced)

| `CAMPAIGN_DELIVERY_MODE` | Allowed when | Behaviour |
|---|---|---|
| `disabled` (**default**) | always | `schedule`, `send_now`, `reschedule`, `resume` → `422 DELIVERY_NOT_AVAILABLE`; readiness/pre-flight report the `DELIVERY_NOT_AVAILABLE` error; drafts, pre-flight, clone, delete work |
| `test` | **only when `NODE_ENV=test`**; config validation refuses it otherwise (boot fails) | Commands allowed; executions run; `NullDeliveryPort` marks `pending` recipients `sent` without I/O |
| `live` | Phase 8 only (the value is rejected by config validation until Gate 4) | Real delivery |

`NullDeliveryPort` throws in its constructor unless `NODE_ENV === 'test'`, is only wired when the mode is `test`, and
a dependency rule forbids importing it from anywhere except the campaigns module factory and tests. A unit test
asserts production configuration cannot enable it. `GET …/campaigns/capabilities` reports the mode so the UI can
explain it — enforcement never depends on the UI.

## 10. Idempotency, concurrency and delivery guarantees

### 10.1 API level

| Operation | Mechanism |
|---|---|
| create, clone, schedule | `Idempotency-Key` (existing claim-first service, scope includes workspace and campaign) |
| update, reschedule, unschedule, cancel, restore version | `expectedVersion` (campaign row version) → stale `409 version_conflict` |
| pause, resume, cancel, unschedule, return_to_draft, delete, restore | Target state already reached → `200` no-op |

### 10.2 Execution and recipient level

| Hazard | Guard |
|---|---|
| Duplicate execution from concurrent schedule/send-now | Campaign row lock + state check + `UNIQUE (version_id) WHERE run_kind = 'one_time'` + one-active-execution partial unique |
| Two starters / redelivered start job | Conditional `UPDATE … WHERE status = 'pending'` |
| Duplicate recipients (retry, redelivery, crash) | `UNIQUE (execution_id, contact_id)` + `ON CONFLICT DO NOTHING` + checkpoint under row lock |
| Commit failure after a page | Page re-runs; inserts are idempotent; cursor only advances with the commit |
| Pause/cancel during a page | Page re-checks status under the execution lock before writing |

### 10.3 Provider delivery (contract for Phase 8)

| Rule | Detail |
|---|---|
| Idempotency key | `recipient.id` (stable, unique), passed as `SendContext.idempotencyKey` (field exists in `packages/channels`) |
| Claim | `pending|queued → sending` with `FOR UPDATE SKIP LOCKED`, lease 5 min, attempt counter |
| Outcome write | Conditional on `status = 'sending'` and the same lease owner |
| Retryable provider error | back to `queued` with backoff; max 5 attempts; then `failed` |
| Unknown outcome (timeout after the request left, crash or commit failure after the provider accepted) | If the adapter declares `idempotentSend` (additive `ChannelCapabilities` field, Phase 8): retry with the same key — provider dedupes. Otherwise: mark `unknown`, **do not resend automatically**, reconcile from provider callbacks/status APIs |
| Guarantee | **At-least-once with provider-side deduplication** where supported; **at-most-once with possible "unknown" outcomes** otherwise. Exactly-once external delivery is **not** promised. The uncertainty window is between the provider call and the commit of its outcome. |

## 11. Error and failure taxonomy

| Class | Examples | Pre-flight | Blocks schedule | Fails execution | Retry | Pauses | Recipient only | Operator |
|---|---|---|---|---|---|---|---|---|
| **Validation** (request) | bad JSON, unknown field | — | 400 | — | — | — | — | — |
| **Configuration** | no topic, no audience, subject missing, source deleted before capture, audience too large, topic archived, channel disabled, delivery disabled, (P8) sender unverified | error findings | yes (`422 PREFLIGHT_FAILED`) | yes, at start, at capture or at resume (`failed`, `failure_class = configuration`, `failure_code`) — never because of list/tag changes after capture | no | no | — | fix + return to draft |
| **Infrastructure** | DB outage, worker crash, queue outage, transaction timeout, host pause | — | no | **never by itself** | page ×3, job ×5 with backoff | no (execution `health = retrying → stalled`) | — | stalled > 15 min alerts; recovery resumes from checkpoint |
| **Recipient** | ineligible (any eligibility code), (P8) invalid address, provider rejection, bounce | counted in estimate | no | no | per §10.3 | no | yes (`skipped`, `skipped_at_send`, `failed`, `unknown`) | — |
| **Conflict** | stale version, invalid transition | — | 409 | — | client reloads | — | — | — |
| **Authorization** | missing permission, foreign workspace | — | 403 / 404 | — | — | — | — | audited |

`system`-initiated pause (bounce/complaint thresholds) is a Phase 9 feature (`paused_by_system`, not a Phase 6 state).
Dead-letter handling is part of the Phase 8 queue (BullMQ); in Phase 6 the in-process dispatcher's equivalent is the
`stalled` health flag plus the recovery sweep.

**Observability** (Phase 6): structured logs with correlation id per command/page; metrics — materialization pages/s,
recipients/s, page latency p95, stalled executions, retries by error class.

## 12. Database

All four tables: `org_id` + `workspace_id`, composite tenant FKs, **forced RLS** with the standard workspace policy
(USING + WITH CHECK), UUIDv7 ids, column-level UPDATE grants for `workeasy_app`, created by migrations (Part A
generated, Part B security), covered by `security-invariants.test.ts`. No unscoped access: every query runs in
`inTenant` / `withTenant`. Workers use `workeasy_app`, never the owner role.

### 12.1 `campaigns`

| Item | Definition |
|---|---|
| PK / unique | `id`; `UNIQUE (org_id, workspace_id, id)` |
| Columns | `name` (1–200), `description` (≤ 1000), `channel` (CHECK `email|sms|whatsapp`, **no UPDATE grant**), `purpose` (CHECK `marketing`), `topic_id` (nullable, composite FK → `topics`), `audience` JSONB, `sender` JSONB, `messages` JSONB, `schedule` JSONB (all CHECK `jsonb_typeof = 'object'`/`'array'`), `status` (CHECK, 7 values), `current_version_id`, `current_execution_id`, `cloned_from_id`, `created_by_user_id`, `created_at`, `updated_at`, `deleted_at`, `version` |
| Indexes | `(workspace_id, status, updated_at DESC, id DESC)`; `(workspace_id, created_at DESC, id DESC)`; GIN trigram on `name` used only through a workspace-bound definer search function (as contacts) |
| Mutable | draft columns, `status`, pointers, `deleted_at`, `updated_at`, `version` |
| Soft delete | `deleted_at`; restorable; no purge in Phase 6 (§14.2) |

### 12.2 `campaign_versions` (insert-only)

| Item | Definition |
|---|---|
| PK / FK | `id`; `(org_id, workspace_id, campaign_id) → campaigns` |
| Unique | `(campaign_id, number)` |
| Columns | `number`, `schema` (CHECK `'campaign.version.v1'` — extended per new schema), `snapshot` JSONB, `content_hash`, `reason` (CHECK `scheduled|sent_now`), `created_by_user_id`, `created_at` |
| Grants | `SELECT, INSERT` only; `BEFORE UPDATE` trigger `app.reject_update()` |

### 12.3 `campaign_executions`

| Item | Definition |
|---|---|
| PK / FK | `id`; `→ campaigns`, `→ campaign_versions` (composite) |
| Unique | `(campaign_id, run_number)`; partial `(version_id) WHERE run_kind = 'one_time'`; partial `(campaign_id) WHERE status IN ('pending','materializing','delivering','paused')` |
| Columns | `run_number`, `run_kind` (CHECK `one_time`), `status` (CHECK 7 values), `paused_phase`, `send_at`, `started_at`, `audience_snapshot_id` (opaque reference to the Audience snapshot; no FK across contexts), `captured_at`, `audience_size`, `materialization_cursor` (text, opaque), `snapshot_released_at`, `materialized_at`, `completed_at`, `cancelled_at`, counts (`planned`, `skipped`, `sent`, `failed`, `cancelled`, `unknown`), `skipped_by_reason` JSONB, `failure_class`, `failure_code`, `health` (CHECK `ok|retrying|stalled`), `last_progress_at`, `lease_owner`, `lease_until`, `initiated_by_user_id`, `paused_by_user_id`, `cancelled_by_user_id`, `version` |
| Indexes | `(workspace_id, status, send_at)`; partial `(send_at) WHERE status = 'pending'` (for the Phase 8 due-discovery definer function only) |
| Mutable | system columns via column grants; no user-facing update path |

### 12.4 `campaign_recipients`

| Item | Definition |
|---|---|
| PK / FK | `id`; `→ campaign_executions` (composite); `(org_id, workspace_id, contact_id) → contacts` (contacts are never hard-deleted) |
| Unique | **`(execution_id, contact_id)`** |
| Columns | `address_identity_id` (nullable), `status` (CHECK the 9 values of §7.1; corrected 2026-10-07 from "10", a miscount), `reason_codes text[]`, `failure_code`, `attempts`, `lease_owner`, `lease_until`, `created_at`, `updated_at`, `final_at` |
| Indexes | `(execution_id, status, id)` (claims, counts); `(workspace_id, contact_id, created_at DESC)` (contact history, Phase 8) |
| Volume | High (1 row per contact per execution). **No partitioning in Phase 6.** Partitioning by `HASH (execution_id)` later is compatible with the unique key; partitioning by time would not be. |
| Retention | Kept while the campaign exists; main future purge target, by execution (§14.3) |

### 12.5 Transaction boundaries

| Unit of work | Transaction |
|---|---|
| Any user command | one transaction: campaign row (+ version + execution) + events + audit |
| Start | one short transaction (S1) |
| Audience capture | its own transaction (S2), no campaign locks held; then one short transaction (S3) recording the snapshot |
| Snapshot release | one short transaction (R1) under the execution lock, then member deletion in chunks (§6.4) |
| Materialization page | one transaction per page |
| Cancel of a running execution | status change in one transaction; recipient `pending → cancelled` in follow-up chunks of 1,000; snapshot released |
| Delivery (Phase 8) | claim batch / outcome per recipient |

## 13. Approval (deferred; integration point fixed now)

Not built in Phase 6. When enabled per workspace: `submit_for_approval` will create the version (new `reason`
`submitted_for_approval`) and set `pending_approval`; a separate insert-only table
`campaign_version_approvals (version_id, decision approved|rejected, decided_by_user_id, reason, decided_at)` records
decisions; `schedule` will then require an approved **version id**; any draft edit after submission requires a new
submission (the approval belongs to the immutable version, so it cannot drift). Decisions needed now and already
reflected: approvals attach to versions (immutable), `reason` is an extensible CHECK, `campaigns.approve` exists.

## 14. Deletion, and the retention policy boundary

### 14.1 Deletion (Phase 6 behaviour)

| Item | Rule |
|---|---|
| Delete | Soft (`deleted_at`) from `draft`, `completed`, `cancelled`, `failed`. `scheduled`/`sending`/`paused` → `422 CAMPAIGN_ACTIVE` (unschedule or cancel first) |
| Restore | Any time in Phase 6 |
| Versions, executions, recipients | Retained while the campaign row exists, deleted or not; never cascaded by a user action |
| Audit and domain events | Unaffected by campaign deletion (append-only) |

### 14.2 Retention policy vs Phase 6 implementation

| | **Retention policy** (boundary defined now) | **Phase 6 implementation** |
|---|---|---|
| What it is | A future, configurable rule set deciding how long each class of campaign data is kept and when it may be purged | **No automatic purge, no DELETE job, no retention table.** All campaign data is kept |
| Values (periods) | Decided by legal/product — **not** by this architecture. The foundation audit's 13 months for delivery data is a proposal `[OURS]`, not a decision | none |
| Where configuration will live | `campaign_retention_policies` — one row per workspace (organization defaults with workspace overrides when tenancy settings arrive), same shape and NULL-means-keep convention as `consent_retention_policies` | not created |
| Who enforces it | The **Campaigns context** (data owner) through one `SECURITY DEFINER` purge function per data class, bound to the caller's current workspace (same pattern as `app.purge_consent_evidence`), invoked per tenant by a worker job | not built |
| Who sets values | Workspace admins, within limits set by the organization/legal policy | — |

### 14.3 Data classes

| Data class | Mutable? | Contains personal data? | May eventually be purged? | Purge unit | Affected by contact erasure? |
|---|---|---|---|---|---|
| `campaigns` (config, draft) | draft yes | no (business content) | yes — soft-deleted campaigns after a period | campaign (with everything below) | no |
| `campaign_versions` | **immutable** | no | only together with their campaign (never individually — an execution must always resolve its version) | campaign | no |
| `campaign_executions` (counts, timings, outcome) | system-updated until terminal, then frozen | no | with the campaign; counts are the long-lived **report record** and outlive recipient purges | campaign | no |
| `campaign_recipients` | system-updated until final | **pseudonymous** (contact id + reason codes; no address, name or content) | **yes — the main retention target** (high volume) | execution (all rows of one execution, after `completed_at`/`cancelled_at` + period) | no change needed: erasure leaves the contact tombstone; recipient rows hold ids only. Policy option `onContactErasure: 'keep_pseudonymous' \| 'delete_recipient_rows'` reserved for legal choice |
| Audience snapshots (Audience-owned) | immutable | pseudonymous (ids) | **not retention**: released when materialization commits or the execution ends, plus the recovery sweep (§6.4) | snapshot | no |
| Campaign domain events | **immutable** (append-only) | no (ids, counts) | under the platform event-retention policy (Phase 11), not campaign retention | partition/time | no |
| Audit records | **immutable** | actor snapshot (staff) | under the organization audit-retention policy (Phase 17/19) | time | no |
| Delivery attempts (Phase 8) | per attempt | provider message id | with their recipient rows (same purge unit) | execution | as recipients |
| Engagement events (Phase 9) | append-only | ids, IP/user agent possibly | under analytics retention (Phase 9) | partition/time | defined in Phase 9 |

### 14.4 Invariants Phase 6 adopts so a later policy needs no redesign

1. Every row carries `org_id`, `workspace_id` and a terminal timestamp (`completed_at`, `cancelled_at`, `final_at`,
   `deleted_at`) that a policy can measure from — always **server time**, never client-supplied.
2. The purge unit for high-volume data is the **execution**: recipients (and Phase 8 delivery attempts) are keyed by
   `execution_id`, and the planned partitioning (`HASH (execution_id)`) keeps purge-by-execution cheap.
3. Reports never depend on recipient rows: execution counts and `skipped_by_reason` are maintained on the execution
   and survive a recipient purge.
4. `workeasy_app` has **no DELETE grant** on campaign tables except the transient audience snapshot (Audience-owned,
   released through its own contract). Future purges run only through definer functions, so ordinary code cannot
   delete history.
5. Nothing references `campaign_recipients` from outside its execution, so purging an execution's recipients never
   breaks another aggregate.

Changing a retention period later is a configuration change; adding the purge is new code behind these invariants —
neither requires redesigning the Campaign Engine.

## 15. API (v1)

Base: `/v1/workspaces/{workspaceId}`. All responses use the standard error shape. `CampaignView` is returned by every
command.

```ts
interface CampaignView {
  id: string; name: string; description: string; channel: Channel; purpose: 'marketing';
  status: CampaignStatus; version: number; deletedAt: string | null;
  draft: { topicId: string | null; audience: AudienceDefinitionDraft; sender: SenderDraft; messages: MessageDraft[]; schedule: ScheduleDraft };
  currentVersion: { id: string; number: number; createdAt: string } | null;
  currentExecution: ExecutionSummary | null;
  allowedActions: CampaignAction[]; blockedActions: { action: CampaignAction; reason: string }[];
  readiness: 'ready' | 'not_ready'; readinessFindings: ReadinessFinding[];
  createdAt: string; updatedAt: string; createdBy: { id: string; displayName: string } | null;
}
interface ExecutionSummary {
  id: string; runNumber: number; status: ExecutionStatus; health: 'ok' | 'retrying' | 'stalled';
  sendAt: string; startedAt: string | null; materializedAt: string | null; completedAt: string | null;
  counts: { planned: number; skipped: number; sent: number; failed: number; cancelled: number; unknown: number };
  skippedByReason: Record<string, number>; failure: { class: 'configuration'; code: string } | null;
}
```

| # | Operation | Request | Response | Permission | Idempotency / concurrency | Errors | Audit |
|---|---|---|---|---|---|---|---|
| 1 | `GET /campaigns/capabilities` | — | `{ deliveryMode, channels: [{ channel, enabled, sendingAvailable }] }` | `campaigns.read` | — | — | — |
| 2 | `GET /campaigns` | `status[]`, `channel`, `topicId`, `q` (≥ 2 chars), `limit ≤ 100`, `cursor`, `deleted=exclude|only` | `{ data: CampaignListItem[], nextCursor }` | read | — | 400 | — |
| 3 | `GET /campaigns/counts` | — | `Record<CampaignStatus, number>` | read | — | — | — |
| 4 | `POST /campaigns` | `{ name, channel, description?, topicId? }` | 201 `CampaignView` | create (+ `topics.read` if topicId) | Idempotency-Key | 400, 403, 422 `CHANNEL_NOT_AVAILABLE` | `campaign.created` |
| 5 | `GET /campaigns/{id}` | — | `CampaignView` | read | — | 404 | — |
| 6 | `PATCH /campaigns/{id}` | partial draft fields + `expectedVersion` | `CampaignView` | update (+ composite) | `expectedVersion` | 400, 403, 409 `version_conflict`, 422 `CAMPAIGN_NOT_EDITABLE` | events only |
| 7 | `DELETE /campaigns/{id}` | `{ expectedVersion }` | 200 `CampaignView` | delete | no-op if deleted | 409, 422 `CAMPAIGN_ACTIVE` | `campaign.deleted` |
| 8 | `POST /campaigns/{id}/restore` | — | `CampaignView` | delete | no-op | 404 | `campaign.restored` |
| 9 | `POST /campaigns/{id}/clone` | `{ versionId?, name? }` | 201 `CampaignView` | create | Idempotency-Key | 404 | `campaign.created` with `clonedFrom` (corrected 2026-10-07; earlier text said `campaign.cloned`, which never existed in the event contract) |
| 10 | `POST /campaigns/{id}/preflight` | — | `PreflightResult` | read | read-only; rate-limited 60/h/user | 404 | — |
| 11 | `POST /campaigns/{id}/schedule` | `{ mode: 'now' \| 'at', sendAt?, timezone?, expectedVersion }` | `CampaignView` | send | Idempotency-Key + `expectedVersion` | 409, 422 `PREFLIGHT_FAILED` (findings), 422 `DELIVERY_NOT_AVAILABLE` | `campaign.scheduled` |
| 12 | `POST /campaigns/{id}/reschedule` | `{ sendAt, timezone?, expectedVersion }` | `CampaignView` | send | Idempotency-Key (optional) + `expectedVersion` | 409, 422 | `campaign.rescheduled` |
| 13 | `POST /campaigns/{id}/unschedule` | `{ expectedVersion }` | `CampaignView` | send | Idempotency-Key (optional) + `expectedVersion`; no-op if draft | 409 | `campaign.unscheduled` |
| 14 | `POST /campaigns/{id}/pause` | — | `CampaignView` | send | Idempotency-Key (optional); no-op if paused | 409 | `campaign.paused` |
| 15 | `POST /campaigns/{id}/resume` | — | `CampaignView` | send | Idempotency-Key (optional); no-op if sending | 409, 422 `DELIVERY_NOT_AVAILABLE` | `campaign.resumed` |
| 16 | `POST /campaigns/{id}/cancel` | `{ expectedVersion }` | `CampaignView` | send | Idempotency-Key (optional) + `expectedVersion`; no-op if cancelled | 409 | `campaign.cancelled` |
| 17 | `POST /campaigns/{id}/return-to-draft` | — | `CampaignView` | update | no-op if draft | 409 | — (event only) |
| 18 | `GET /campaigns/{id}/versions` | `limit`, `cursor` | `{ data: VersionSummary[], nextCursor }` | read | — | 404 | — |
| 19 | `GET /campaigns/{id}/versions/{versionId}` | — | `{ id, number, reason, contentHash, createdAt, createdBy, snapshot }` | read | — | 404 | — |
| 20 | `POST /campaigns/{id}/versions/{versionId}/restore` | `{ expectedVersion }` | `CampaignView` | update | `expectedVersion` | 409, 422 `CAMPAIGN_NOT_EDITABLE` | — (event `campaign.updated`) |
| 21 | `GET /campaigns/{id}/executions` | `limit`, `cursor` | `{ data: ExecutionSummary[], nextCursor }` | read | — | 404 | — |
| 22 | `GET /campaigns/{id}/executions/{executionId}` | — | `ExecutionSummary` | read | — | 404 | — |
| 23 | `GET /campaigns/{id}/executions/{executionId}/recipients` | `status`, `reason`, `limit ≤ 100`, `cursor` | `{ data: { id, contact: { id, displayName }, status, reasonCodes, updatedAt }[], nextCursor }` | read + `contacts.read` | — | 403, 404 | — |

**Wire contracts (milestone 6.4, implemented):** every request and view above is a strict Zod schema in `packages/shared/src/api/campaigns.ts`; values, findings, `PreflightResult`, `campaign.version.v1`, `email.content.v1` and event payloads in `packages/shared/src/campaigns.ts`. Shapes the table leaves open (`CampaignListItem`, draft request bounds, PATCH replace semantics) are recorded in `docs/audit/phase-6.4-shared-contracts.md` §3; the `campaign.cloned` / `campaign.created` naming difference of row 9 is noted there (§4).

**Implementation status (2026-10-07):** rows 1–9 and 18–19 implemented in 6.6; rows 10 (pre-flight, 6.7) and 11–17, 20 (lifecycle, 6.8) implemented — `apps/api/src/modules/campaigns/application/preflight.service.ts`, `lifecycle.service.ts`. Rows 21–23 (execution reads) are deferred to 6.9 with the runner that produces their data. Additive refinements made while implementing, all backward compatible: (a) rows 12–16 accept an optional `Idempotency-Key` (database-backed, per user, claim-first, 24 h replay; the key's scope binds workspace, campaign and command, so a key reused for another command or body is `422 idempotency_conflict`); (b) `INVALID_TRANSITION` is a 409 (a state conflict, like `version_conflict`); (c) bodies of rows 10, 14, 15, 17 are the strict empty object (unknown fields, e.g. `workspaceId`, are 400). Evidence: `docs/audit/phase-6.7-6.8-preflight-lifecycle.md`.

Error codes (stable): `validation_failed`, `version_conflict`, `INVALID_TRANSITION`, `CAMPAIGN_NOT_EDITABLE`,
`CAMPAIGN_ACTIVE`, `CHANNEL_NOT_AVAILABLE`, `DELIVERY_NOT_AVAILABLE`, `PREFLIGHT_FAILED`, `PREFLIGHT_UNAVAILABLE` (409,
retryable, §3.3; added 2026-10-07), `forbidden`, `not_found`, `idempotency_conflict`.

**Audit actions (6.10, 2026-10-08):** `campaign.created` (create; clone with `clonedFrom`), `campaign.deleted`,
`campaign.restored`, `campaign.scheduled`, `campaign.rescheduled`, `campaign.unscheduled`, `campaign.paused`,
`campaign.resumed`, `campaign.cancelled` (contract), plus, additively in 6.10: `campaign.returned_to_draft`,
`campaign.version_restored` (`{ versionId, number, changes }`) and the runner's `campaign.execution_started`,
`campaign.execution_completed` (`counts`), `campaign.execution_failed` (`outcome = failure`, failure class/code) with
`actor_type = system`. Draft edits remain events-only (routine). Every row: org, workspace, actor (user id; e-mail /
name snapshot of the STAFF actor per the Phase 4 design), target campaign, correlation id; metadata = ids, codes and
counts only. `audit_logs` is organization-scoped (Phase 4 RLS); reading it needs `audit.read` (org-level).

**Implementation status (6.9, 2026-10-07):** rows 21–22 (execution list/detail) implemented — Campaign-owned data
only. ~~Row 23 (recipient list) deferred~~ → **Row 23 implemented (2026-10-08)** through the additive Audience Profiles v1
port (Audience contract §9.11): display names only, never an address; needs `contacts.read`; query `status`, `reason`,
`limit ≤ 100`, `cursor` (`recipientListQuery`). Evidence: `apps/api/test/campaigns-recipients.test.ts`. Executions: send-now starts immediately after commit; an execution scheduled for a
later time stays `pending` until the Phase 8 scheduler (due discovery is deferred, §9.1). OpenAPI documents every route with request **and response** schemas, errors, permission and
idempotency headers.

## 16. Events

See `docs/events.md` §"Campaign event contract v1". Campaign domain events are written in the command's transaction
to `domain_events`, aggregate `campaign`, ids/states/counts only. Per-recipient facts are recipient rows (Phase 6)
and delivery/engagement records (Phases 8–9), never domain events.


> **Amended 2026-10-08:** content, versions v2, preview, templates — see `docs/contracts/phase-6-content-amendment.md`. New versions are
> `campaign.version.v2`; stored v1 versions are never rewritten and are returned as stored.
