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


---

## 9. v1.1 additive extensions

**Status: proposed by the Phase 6 architecture review (`docs/architecture/phase-6-campaign-engine.md`, revision 2).
Requires approval at Gate 1 (code) and Gate 2 (the two new Audience-owned tables) before anything is built.**
Everything in §1–§8 above stays exactly as frozen; every item below is additive — existing callers, tests and stored
data behave identically.

**Implementation status (milestone 6.2, Gate G1):** E-3 is implemented for the existing read side — the packages,
ports and boundary rules of §9.8, with the eligibility rules, effective consent and fingerprint moved unchanged and
the eligibility facts adapter in `@workeasy/audience-infra`. The Resolution and Address Lookup **ports** and the pure
definition/paging rules exist in `@workeasy/audience-core`; their adapters do not (E-1 snapshot adapter → 6.3 after
Gate 2; E-4 adapter → Phase 8). E-1, E-2 and E-4 behaviour is not implemented. Record:
`docs/architecture/phase-6-campaign-engine.md` §14.

**Decision freeze (milestone 6.3.0, 2026-10-05):** E-1 (Audience Resolution v1 with snapshots) and E-2 (Eligibility
v1.1) are **approved and frozen for implementation**, including **Gate G2** for the two snapshot tables, with
decisions A–O recorded in `docs/architecture/phase-6-campaign-engine.md` §15. They are **not implemented yet**. E-4
stays proposed (Phase 8). The normative text is this section (§9.3–9.6), `docs/contracts/phase-6-campaign.md` §6.4
and `docs/eligibility.md` §"v1.1"; §15 records why.

**Implementation status (milestone 6.3, 2026-10-05):** E-1 and E-2 are **implemented** as frozen — migration
`20261011000000_audience_snapshots`, `PrismaAudienceResolution` and the cleanup helpers in `@workeasy/audience-infra`,
the v1.1 rule in `@workeasy/audience-core`. Implementation record, test evidence and benchmark:
`docs/architecture/phase-6-campaign-engine.md` §16.

**Audience Resolution v1.1 (E-5, approved 2026-10-07, implemented 2026-10-07):** additive `sample` and `topicStatus`
(§9.9). Approved by the product owner as "Option 1" when milestone 6.7 was blocked (record:
`docs/architecture/phase-6-campaign-engine.md` §21; evidence: `docs/audit/phase-6.7-6.8-preflight-lifecycle.md`).

| Ext | What | Why | Behaviour change for existing callers |
|---|---|---|---|
| E-1 | **Audience Resolution v1** with **Audience Snapshots** (§9.1–9.7): an Audience-owned, point-in-time capture of an audience definition, then paging over it | Campaigns must turn list/tag selections into contacts deterministically without reading Audience tables (P5-1) | none (new service, two new Audience-owned tables) |
| E-2 | **Eligibility v1.1**: optional `topicPolicy`, new code `TOPIC_UNSUBSCRIBED`, in-process batches ≤ 1,000 **only if the benchmark gate passes** (decision D; otherwise the largest batch size that passes, with sub-batching) | Topic semantics for campaigns (P5-2); throughput (P5-4) — `docs/eligibility.md` §"Proposed v1.1" | none (defaults preserve v1 exactly; HTTP limit stays 100) |
| E-3 | **Audience read packages**: `@workeasy/audience-core` (pure rules, contracts, ports) and `@workeasy/audience-infra` (the Audience context's database adapters for those ports) (§9.8) | The worker must evaluate eligibility at send time without importing the API, and without gaining open database access (P5-5) | none (code move; API services delegate; all Phase 5 tests unchanged) |
| E-4 | **Address Lookup v1** (`identityIds → { identityId, kind, value }`) | Delivery must send to `addressIdentityId` (P5-6) | none (new; Phase 8) |
| E-6 | **Audience Resolution v1.2** (§9.10): bounded `sampleWithin` + deduplicated `requestRecovery` | Interactive pre-flight must answer within a budget when the count bitmap is not valid, and ask the Audience context to restore fast resolution | none (additive; v1/v1.1 unchanged) |
| E-5 | **Audience Resolution v1.1** (§9.9): `sample` (uniform live sample ≤ 2,000 ids + exact size) and `topicStatus` | Campaign pre-flight needs an eligibility estimate on a uniform sample and the topic's status without a snapshot and without reading Audience tables (contract phase-6-campaign §3.1) | none (two new port methods, two new functions; v1 unchanged) |

### 9.1 Consistency model: capture once, page over the capture

An audience is resolved in **two steps**:

1. **Capture** — one SQL statement evaluates the whole definition and writes the resulting contact ids into an
   Audience-owned snapshot. PostgreSQL gives a single statement one consistent view of the database, so the snapshot
   is **exactly the audience at one instant, `capturedAt`**: every include source, every exclude source and every
   contact's live/deleted state are read at that same instant.
2. **Page** — callers then read the snapshot in ascending contact-id pages. The snapshot never changes, so pages are
   deterministic, restartable and identical for any number of readers or retries.

**What is snapshotted:** membership of the include sources, membership of the exclude sources, and whether each
contact was live (not deleted/erased) — all at `capturedAt`.

**What stays live (deliberately):** everything that decides whether a message *may* be sent — consent, subscription
type, topic preference, suppression, addresses, contact deletion after capture. That is Eligibility's job and is
evaluated later, twice (at materialization and immediately before delivery — `docs/contracts/phase-6-campaign.md` §6.3).

**Why this model.** It is the only one of the options considered that is deterministic regardless of how fast pages
are processed:

| Model considered | Deterministic? | Why rejected / chosen |
|---|---|---|
| Live paging (membership read when each page is processed) | No — the outcome for a contact depends on when its page runs | Rejected |
| High-water mark on `added_at`/`tagged_at` + live removals (revision 1) | No — removals and exclusions still depend on processing time | Rejected |
| One long `REPEATABLE READ` transaction / exported snapshot for the whole materialization | Yes | Rejected: holds a transaction open for minutes (idle-in-transaction timeout, bloat, blocks vacuum) |
| Membership history tables (reconstruct "as of T") | Yes | Rejected: Phase 5 keeps no membership history; adding it is a much larger change |
| **Single-statement capture into an Audience-owned snapshot, then paging** | **Yes** | **Chosen**: one bounded write, no long transaction, restartable, explainable |

**How it reads to a user:** *"A campaign is sent to everyone who was in the selected lists or tags **at the moment it
started**, minus everyone who was in the excluded lists or tags **at that same moment**. Changes to lists and tags
after that moment do not change the audience. To stop a message reaching someone after the campaign has started,
unsubscribe or suppress them — that is checked again just before each message is sent."*

Exclusion lists are a **targeting** tool, not a compliance tool. Compliance blocks (unsubscribe, consent withdrawal,
suppression) are always evaluated live.

### 9.2 Behaviour, case by case (T0 = `capturedAt`)

| # | Event | Effect on the audience | Can the contact still receive the message? |
|---|---|---|---|
| 1 | Contact **added to an include** list after T0 | Not in the audience | No (not a recipient) |
| 2 | Contact **removed from an include** list after T0 | Still in the audience (was a member at T0) | Yes, if still eligible at both eligibility checks |
| 3 | Contact **added to an exclude** list after T0 | Still in the audience (was not excluded at T0) | Yes, if still eligible — use unsubscribe/suppression to stop it |
| 4 | Contact **removed from an exclude** list after T0 | Still excluded (was excluded at T0) | No |
| 5 | Contact added to an include list **and removed again** after T0, before "its page" | Not in the audience (not a member at T0); there is no "its page" over live data any more | No |
| 5b | Contact added before T0 and removed after T0 | In the audience | Yes, if eligible |
| 6 | **Tag added** after T0 | Not in the audience | No |
| 7 | **Tag removed** after T0 | Still in the audience | Yes, if eligible |
| 8a | Source list/tag **deleted before T0** (after scheduling) | Capture fails: `AUDIENCE_SOURCE_NOT_FOUND` | Execution fails as a configuration error; nothing sent |
| 8b | Source list/tag **deleted after T0** | No effect: the snapshot already holds the members | Yes, if eligible |
| 8c | Source list **archived** (any time) | Archived lists keep their members and stay resolvable | Unchanged |
| 9a | Contact **deleted/erased before T0** | Not in the audience | No |
| 9b | Contact **deleted/erased after T0** | In the snapshot; Eligibility reports `CONTACT_DELETED` at materialization (`skipped`) or at delivery (`skipped_at_send`) | No |
| 10 | Contact becomes **ineligible** after capture (unsubscribe, consent withdrawn, suppression, address change) | In the snapshot | No — caught at materialization or at the fresh check before delivery |
| 11 | Contact becomes **eligible** after being skipped at materialization | Recorded as `skipped` | No in this execution (decision recorded; a new campaign is needed) |
| 12 | **Concurrent** list changes *during* the capture statement | The statement sees one snapshot; a change commits either before (visible) or after (invisible) | Deterministic |

### 9.3 Types

```ts
type AudienceSelector =            // ids are UUIDs; any other string is AUDIENCE_DEFINITION_INVALID
  | { type: 'list'; listId: string }
  | { type: 'tag'; tagId: string };
  // reserved, additive later: { type: 'segment'; segmentId: string } — a segment's criteria are evaluated inside the same capture statement

interface AudienceDefinitionV1 {
  include: AudienceSelector[];   // 1–25, no duplicates
  exclude: AudienceSelector[];   // 0–25, no duplicates, no selector also in include
}

type AudienceSourceStatus = 'ok' | 'archived' | 'not_found';
interface AudienceValidation {
  valid: boolean;
  sources: { role: 'include' | 'exclude'; selector: AudienceSelector; status: AudienceSourceStatus }[];
  errors: AudienceResolutionError[];
}

interface AudienceCount { count: number; capped: boolean; countedAt: string }   // live estimate for editing

interface AudienceSnapshotRef {
  snapshotId: string;
  captureKey: string;            // caller's idempotency key (Campaigns: the execution id)
  capturedAt: string;            // T0
  size: number;                  // members captured
  definitionHash: string;        // sha-256 of the canonical definition
}

interface AudienceSnapshotPage {
  contactIds: string[];          // ascending, unique, length ≤ limit
  cursor: string | null;         // null ⇔ no more members
}

type AudienceResolutionErrorCode =
  | 'AUDIENCE_DEFINITION_INVALID'      // shape, limits, duplicates, include/exclude conflict
  | 'AUDIENCE_SOURCE_NOT_FOUND'        // deleted, never existed, or another workspace's id (indistinguishable by design)
  | 'AUDIENCE_SNAPSHOT_NOT_FOUND'      // released (also: capture on a released key — decision C), or another workspace's snapshot
  | 'AUDIENCE_SNAPSHOT_KEY_CONFLICT'   // captureKey reused with a different definition or a different owner (decision B)
  | 'AUDIENCE_TOO_LARGE'               // above the capture limit (§9.6)
  | 'AUDIENCE_CURSOR_INVALID'
  | 'AUDIENCE_LIMIT_INVALID';          // page size outside 1–1,000
interface AudienceResolutionError { code: AudienceResolutionErrorCode; selector?: AudienceSelector; message: string }

interface AudienceReleaseResult {
  released: boolean;             // a snapshot with this key exists in this workspace and is released (by this call or earlier)
  membersRemaining: boolean;     // true ⇔ member purge incomplete (purged_at IS NULL): call again in a NEW transaction
}
```

### 9.4 Service (port defined in `@workeasy/audience-core`, implemented in `@workeasy/audience-infra`)

```ts
interface AudienceResolution {
  /** Do all sources exist (and are they usable) in this workspace? Read-only. */
  validate(scope: TenantScope, def: AudienceDefinitionV1): Promise<AudienceValidation>;
  /** Live, exact member count up to `cap` (default and maximum 5,000,000, the capture limit) — for editing and pre-flight only. */
  count(scope: TenantScope, def: AudienceDefinitionV1, opts?: { cap?: number }): Promise<AudienceCount>;
  /** Single-statement capture. Idempotent per captureKey: a repeat returns the existing snapshot. */
  capture(scope: TenantScope, def: AudienceDefinitionV1, captureKey: string,
          owner: { kind: 'campaign_execution'; id: string }): Promise<AudienceSnapshotRef>;
  /** Ascending pages over a snapshot; deterministic; ≤ 1,000 per page (default 1,000). */
  page(scope: TenantScope, snapshotId: string, opts: { cursor: string | null; limit?: number }): Promise<AudienceSnapshotPage>;
  /**
   * Releases the snapshot with this key and purges its members, at most 10,000 per call (decision A). By key so an
   * owner can release a snapshot whose id it never recorded (crash between capture and recording). After release,
   * page() → AUDIENCE_SNAPSHOT_NOT_FOUND and capture(key) → AUDIENCE_SNAPSHOT_NOT_FOUND. Repeat in new transactions
   * while `membersRemaining`. No snapshot for the key → { released: false, membersRemaining: false }, nothing written.
   */
  releaseByKey(scope: TenantScope, captureKey: string, reason: SnapshotReleaseReason): Promise<AudienceReleaseResult>;
  /** Unreleased snapshots of an owner kind captured before `olderThan` — for the owner's recovery sweep. Ids only. */
  listUnreleased(scope: TenantScope, ownerKind: 'campaign_execution', olderThan: Date, limit: number):
    Promise<{ snapshotId: string; captureKey: string; ownerId: string; capturedAt: string; size: number }[]>;
  /** Released snapshots whose member purge is incomplete, oldest release first — for purge recovery. Ids only; no age threshold. */
  listReleasedUnpurged(scope: TenantScope, ownerKind: 'campaign_execution', limit: number):
    Promise<{ snapshotId: string; captureKey: string; ownerId: string; releasedAt: string }[]>;
}
/** A transaction already scoped (RLS) to one org + workspace; adapters assert workspaceId matches the context. */
interface TenantScope { tx: unknown; orgId: string; workspaceId: string }
type SnapshotReleaseReason = 'materialized' | 'cancelled' | 'failed' | 'orphan_sweep';
```

- `capture` runs in a **dedicated transaction** that holds no locks of the caller's own rows (Campaigns does not hold
  campaign/execution locks while capturing, so cancel and pause are never blocked behind a large capture). It is
  **idempotent per `captureKey`**: if the transaction committed but the caller crashed before recording the result,
  calling `capture` again with the same key returns the existing snapshot; if it rolled back, a retry captures anew.
  It raises `statement_timeout` for that one statement only (`SET LOCAL`, capped at 5 minutes). Exact procedure
  (decisions B, C, K, L, M):
  1. **Caller:** a fresh `withTenant` transaction with `TxOptions.timeout = 330_000` ms containing only this call; it
     commits right after, and paging always happens in later, separate transactions. The adapter refuses (programming
     error) a transaction that already holds a transaction id (`pg_current_xact_id_if_assigned() IS NOT NULL`), i.e.
     one that has written or row-locked anything.
  2. **Key lookup** (runtime role's default timeout): if a snapshot with this key exists in the workspace —
     released → `AUDIENCE_SNAPSHOT_NOT_FOUND` whatever the definition or owner (decision C: a key identifies one
     capture lifecycle and is never reused); unreleased with the same `definition_hash` **and** the same owner
     (kind, id) → the existing `AudienceSnapshotRef`; otherwise → `AUDIENCE_SNAPSHOT_KEY_CONFLICT` (decision B;
     ownership is never transferred).
  3. **Capture:** `SET LOCAL statement_timeout = '300s'`; **one statement** that checks every source's existence,
     reads include and exclude membership and contact liveness, and inserts the snapshot row and its members;
     `SET LOCAL statement_timeout TO DEFAULT`. T0 = `captured_at` = `statement_timestamp()` of that statement, and
     everything it reads comes from that statement's single MVCC snapshot. A missing source →
     `AUDIENCE_SOURCE_NOT_FOUND` naming the selector; more than 5,000,000 members → `AUDIENCE_TOO_LARGE`; in both cases
     the statement inserts nothing. A concurrent capture with the same key makes the statement's
     `ON CONFLICT (workspace_id, capture_key) DO NOTHING` wait for it; the adapter then re-reads the key and applies
     step 2.
  4. Any error rolls back the whole transaction: a partial snapshot cannot exist.
- `count` evaluates the same membership expression live, with the runtime role's default statement timeout (no
  elevation), `cap` 1–5,000,000. It is answered by the verified count bitmap when that workspace's bitmap is VALID,
  otherwise by the exact query (§9.6, "Count bitmap"); both are exact. Decision M applies to it as to capture: a missing source is
  `AUDIENCE_SOURCE_NOT_FOUND`, never counted as empty.
- `page` is a read of an immutable snapshot by primary key; repeating it with the same cursor returns the same ids.
  The snapshot's status and its members are read **in one statement** (one MVCC snapshot), so a missing or released
  snapshot is `AUDIENCE_SNAPSHOT_NOT_FOUND` and a release committing concurrently can never yield a partial page. The
  cursor is opaque, bound to its snapshot and carries the last contact id (a UUID); anything else is
  `AUDIENCE_CURSOR_INVALID`.
- Plan robustness (implementation, no semantic effect): count and capture run with nested-loop joins disabled for
  that one statement (restored afterwards, like the timeout), so their cost stays linear even when table statistics
  lag behind a large import; members are stored as ascending `contact_id` chunks of 1,000 (§9.6).
- `releaseByKey`, per call and in the caller's transaction (decision A): (1) locate the snapshot by key under the
  tenant scope and lock its row (`SELECT … FOR UPDATE`) **before** changing anything, which serializes concurrent
  releases of the same snapshot; (2) if unreleased, set `released_at = now()` and `release_reason` — the first reason
  is kept, never overwritten; (3) if `purged_at` is set → `{ released: true, membersRemaining: false }`; (4) delete up
  to 10,000 members in ascending `contact_id` order — the lowest-numbered member chunks (10 chunks of 1,000 ids,
  §9.6; deleted by primary-key range, no join); (5) if no member remains, set `purged_at = now()` **in the
  same transaction**. Members cannot be added to a released snapshot (capture
  never writes to an existing key), so "no member remains" is stable once observed under the row lock. Crash at any
  point leaves either an unreleased snapshot (owner's lifecycle applies) or `released_at` set with `purged_at` NULL,
  which `listReleasedUnpurged` and the discovery function (§9.6) find; the next call resumes, and a call that deletes
  nothing because the previous transaction already deleted the last chunk sets `purged_at`. No permanent orphan state.
- `listReleasedUnpurged` lets any tenant-scoped job finish purges without knowing the owner's state (a released
  snapshot is never read again).
- `releaseByKey` is lifecycle clean-up of a transient working set, not retention (§9.6, and Campaign retention in
  `docs/contracts/phase-6-campaign.md` §14).
- Errors are thrown as `AudienceResolutionError`; Campaigns maps capture-time `AUDIENCE_SOURCE_NOT_FOUND` /
  `AUDIENCE_TOO_LARGE` to a configuration failure of the execution.

### 9.5 Semantics

| Concern | Rule |
|---|---|
| Members | union of include sources **minus** union of exclude sources, at T0 |
| Contacts | only contacts live at T0; consent, subscription, suppression and topics are **not** applied (Eligibility's job — no rule duplicated) |
| Duplicates | a contact in several sources is captured once (`PRIMARY KEY (snapshot_id, contact_id)`) |
| Ordering | ascending `contact_id` |
| Completion | `cursor === null` |
| Page size | default 1,000; 1–1,000 enforced |
| `count` vs snapshot size | `count` is a live estimate while editing; the snapshot `size` is the authoritative audience of a run |
| Archived / deleted sources | archived (lists only — tags have no archive state): captured normally; deleted (before capture): `AUDIENCE_SOURCE_NOT_FOUND` |
| Source existence (decision M) | a list or tag exists ⇔ its row is visible in the workspace **and** `deleted_at IS NULL`, checked inside the capture statement. Deleting a list/tag also deletes its memberships, so an existing source with zero members is an **empty source**, never a missing one, and a missing source is never treated as empty |
| Selector ids | UUIDs only, validated before any SQL (`AUDIENCE_DEFINITION_INVALID`); bound as array parameters, never interpolated |
| Live at T0 | `contacts.deleted_at IS NULL AND contacts.erased_at IS NULL` |

### 9.6 Storage, limits and lifecycle (Audience-owned; Gate 2 — approved 6.3.0)

**`audience_snapshots`** — metadata only, **no personal data** (decision H)

| Column | Type | Rule |
|---|---|---|
| `id` | `uuid` | primary key, `gen_random_uuid()` in the capture statement |
| `org_id`, `workspace_id` | `uuid NOT NULL` | from `app.current_org_id()` / `app.current_workspace_id()`; FK `(org_id, workspace_id)` → `workspaces(org_id, id)` `ON DELETE RESTRICT` |
| `capture_key` | `text NOT NULL` | `CHECK (char_length(capture_key) BETWEEN 1 AND 200)`; `UNIQUE (workspace_id, capture_key)` |
| `owner_kind` | `text NOT NULL` | `CHECK (owner_kind = 'campaign_execution')` |
| `owner_id` | `uuid NOT NULL` | the owning execution's id — an application-level reference, **no FK** to Campaign tables (decision G) |
| `definition` | `jsonb NOT NULL` | canonical definition: selector ids only, sorted (`CHECK (jsonb_typeof(definition) = 'object')`) |
| `definition_hash` | `text NOT NULL` | sha-256 hex of the canonical definition, `CHECK (definition_hash ~ '^[0-9a-f]{64}$')` |
| `captured_at` | `timestamptz(3) NOT NULL` | T0 = `statement_timestamp()` of the capture statement |
| `size` | `integer NOT NULL` | `CHECK (size BETWEEN 0 AND 5000000)` |
| `released_at` | `timestamptz(3) NULL` | server time; set once |
| `release_reason` | `text NULL` | `CHECK (release_reason IN ('materialized','cancelled','failed','orphan_sweep'))`, `CHECK ((released_at IS NULL) = (release_reason IS NULL))` |
| `purged_at` | `timestamptz(3) NULL` | server time, set in the transaction that observes no remaining member; `CHECK (purged_at IS NULL OR released_at IS NOT NULL)` (decision A) |

Keys and indexes: `PRIMARY KEY (id)`; `UNIQUE (workspace_id, capture_key)`; `UNIQUE (org_id, workspace_id, id)` (target of
the members' composite FK, repository pattern); partial index `(workspace_id, owner_kind, captured_at) WHERE purged_at
IS NULL` — every unreleased and every released-but-unpurged snapshot, i.e. only live working sets, so sweeps and
discovery never scan history.

States: `released_at IS NULL` → unreleased (live); `released_at IS NOT NULL AND purged_at IS NULL` → released, member
purge incomplete; both set → released and purged. Rows are never deleted (ids only; retention of this metadata is out
of scope for Phase 6, which purges nothing).

**`audience_snapshot_chunks`** — the captured members, ids only (decision D2, Phase 6.3 G2; migration
`20261012000000_audience_snapshot_chunks`)

| Column | Type | Rule |
|---|---|---|
| `org_id`, `workspace_id` | `uuid NOT NULL` | from the tenant context functions |
| `snapshot_id` | `uuid NOT NULL` | FK `(org_id, workspace_id, snapshot_id)` → `audience_snapshots(org_id, workspace_id, id)` `ON DELETE RESTRICT` |
| `chunk_no` | `int NOT NULL` | `CHECK (chunk_no BETWEEN 0 AND 4999)`; chunk k holds positions k·1,000 … k·1,000 + 999 of the snapshot's ascending `contact_id` order (5,000 chunks = the 5,000,000 limit) |
| `contact_ids` | `uuid[] NOT NULL` | ascending, distinct, `CHECK (cardinality BETWEEN 1 AND 1000)`; every chunk but the last holds exactly 1,000 ids. No FK to `contacts` (the capture statement only selects existing contacts; contacts are never hard-deleted) |
| `first_contact`, `last_contact` | `uuid NOT NULL` | `CHECK (first_contact = contact_ids[1] AND last_contact = contact_ids[cardinality] AND first_contact <= last_contact)` — a page finds its first chunk by `last_contact` |

Keys: `PRIMARY KEY (snapshot_id, chunk_no)` — paging and purge by primary-key range. No other index. One row (one FK
check, one RLS check, one index entry) per 1,000 members instead of per member: the 5M capture gate depends on it.

**`audience_snapshot_members`** — the previous one-row-per-member table. Kept by the D2 migration (which moved any
existing rows into chunks) and **no longer written or read**; same FK, RLS, grants and update trigger as before. A
later migration may drop it.

**Row-level security** (decision I) — all three tables: `ENABLE` and `FORCE ROW LEVEL SECURITY`; policy
`<table>_workspace FOR ALL USING (org_id = (SELECT app.current_org_id()) AND workspace_id = (SELECT
app.current_workspace_id())) WITH CHECK (same)`. Another workspace's snapshot, key or member is indistinguishable from
an absent one. The sub-select ("InitPlan") form is the **identical predicate**, evaluated once per statement instead of
once per row; D2 applies it to `contacts`, `list_memberships`, `contact_tags`, `lists`, `tags` and the three snapshot
tables (`packages/db/test/audience-snapshots.test.ts` asserts exactly this set).

**Grants** (decision I) — nothing else for any runtime role:

```sql
GRANT SELECT, INSERT ON audience_snapshots TO workeasy_app;
GRANT UPDATE (released_at, release_reason, purged_at) ON audience_snapshots TO workeasy_app;
GRANT SELECT, INSERT, DELETE ON audience_snapshot_chunks TO workeasy_app;
GRANT SELECT, INSERT, DELETE ON audience_snapshot_members TO workeasy_app;   -- unchanged, no longer used
-- no DELETE or TRUNCATE on audience_snapshots; no UPDATE on either member table;
-- workeasy_reporting and workeasy_identity: no privileges on any of the three tables.
```

**Triggers (defence in depth, also against the owner role):** `audience_snapshot_chunks` and
`audience_snapshot_members` `BEFORE UPDATE` → `app.reject_update()`; `audience_snapshots` `BEFORE UPDATE` → rejects
any change other than `released_at`, `release_reason` and `purged_at` going from NULL to a value (never back, never
overwritten).

**Index for the resolution** (D2): `contacts_non_live_idx ON contacts (workspace_id, id) INCLUDE (org_id) WHERE
deleted_at IS NOT NULL OR erased_at IS NOT NULL`. Count and capture compute (∪ includes) − (∪ excludes) − (non-live
contacts of the workspace) with `work_mem` 64 MB for that one statement; equivalent to joining to live contacts
because every membership references a contact of the same workspace.

**Discovery for sweeps** (decision J): `app.workspaces_with_snapshot_cleanup(p_owner_kind text, p_unreleased_before
timestamptz) RETURNS TABLE (org_id uuid, workspace_id uuid)` — distinct pairs having a snapshot of that owner kind with
`purged_at IS NULL AND (released_at IS NOT NULL OR captured_at < p_unreleased_before)`. `SECURITY DEFINER`,
`SET search_path = pg_catalog, public`, `REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE … TO workeasy_app` only. Returns
workspace identifiers only — never snapshot ids, keys, owners or contact ids. This replaces the earlier proposed name
`workspaces_with_unreleased_snapshots`: the function now also finds released-but-unpurged snapshots (decision A).
Each workspace is then processed inside `withTenant` for that workspace only, through `listUnreleased` /
`listReleasedUnpurged`.

**Count bitmap** (Phase 6.3 G2; migration `20261013000000_audience_count_bitmap`; evidence
`docs/audit/phase-6.3-g2-closure.md`). A **derived, exact** index that answers `count` only. It does not change the
`AudienceResolution` API, any request or response, capture, page, T0 or Eligibility. It holds **membership and
liveness only** (the same facts as the exact query); consent, subscription, suppression, topics and addresses stay
live in Eligibility.

| Table | Content |
|---|---|
| `audience_count_state` | one row per workspace: `state` ∈ `valid` / `invalid` / `rebuilding`, `generation` (bumped by every invalidation and rebuild start), `reason`, rebuild lease (`rebuild_token`, `rebuild_lease_until`), `last_reconciled_at`, `last_reconcile_result` |
| `audience_count_contact_seq` | one position per contact (global sequence `app.audience_count_seq_gen`; never reused); chunk = position / 4,096, bit = position mod 4,096 |
| `audience_count_source_chunks` | per (list or tag, chunk): a 4,096-bit `varbit` of member positions |
| `audience_count_dead_chunks` | per chunk: positions of deleted or erased contacts |

- **Count:** `Σ bit_count(OR(include chunks) & ~OR(exclude chunks) & ~dead)`, read **in one statement together with
  the state and the source-existence check**, after definition validation. Only `state = 'valid'` in that statement
  answers; otherwise (invalid, rebuilding, no state row) the exact set-algebra query answers. Never an approximation;
  the cap and errors are identical on both paths.
- **Maintenance:** triggers in the writer's transaction: statement level on `list_memberships` / `contact_tags`
  INSERT and DELETE and on `contacts` INSERT; row level on `contacts` liveness changes. Shared advisory lock per
  (source, chunk) or dead chunk, taken in ascending order; commutative `|` / `& ~` updates. Deadlock, serialization
  failure and lock timeout are re-raised (the caller's existing retry applies); any other maintenance failure marks
  the workspace INVALID instead of failing the write. Writes outside the matching tenant context (owner sessions),
  membership UPDATE, contact hard DELETE and TRUNCATE invalidate the affected workspaces. All triggers are
  `ENABLE ALWAYS`; a superuser-installed DDL event trigger invalidates every workspace on DDL that touches them.
- **Rebuild (online):** one rebuilder per workspace (lease); begin = new generation + REBUILDING; positions filled in
  batches; then each chunk is repaired in its **own short transaction** under an exclusive chunk lock taken with
  try-lock / bounded wait (busy chunks are skipped and retried; writers are never queued behind the rebuild); finish =
  whole-bitmap verification and compare-and-set on generation and lease token. Any invalidation or takeover meanwhile
  prevents VALID.
- **Reconciliation:** VALID bitmaps only, whole-bitmap verification in one statement, at least every 24 h (worker
  maintenance job). A difference marks the workspace INVALID, records the result and time, and is alerted
  (`alert: audience_count_reconcile_mismatch`, ids only); the same run rebuilds it.
- **Garbage collection:** all-zero chunks are deleted under their chunk lock (try-lock), after re-checking they are
  still zero; never changes a count.
- **Security:** forced RLS with the InitPlan workspace predicate on all four tables. `workeasy_app`: SELECT on state,
  source and dead chunks only; EXECUTE on the maintenance entry points (`begin_rebuild`, `renew_lease`,
  `positions_missing`, `fill_positions`, `repair_list`, `repair_source_chunk`, `repair_dead_chunk`, `finish_rebuild`, `reconcile`, `gc`,
  `workspaces_due`), each confined by RLS to the session's workspace. Maintenance functions are SECURITY DEFINER owned
  by `workeasy_audience_count` (NOLOGIN, NOBYPASSRLS; SELECT on `contacts`, `list_memberships`, `contact_tags` and
  writes on the bitmap tables only). Only invalidation across workspaces, the TRUNCATE and new-workspace triggers, and
  discovery (ids and state only) are owned by the schema owner. Nothing for reporting or identity; nothing PUBLIC.

- **Capture limit:** 5,000,000 members per snapshot in v1 (`AUDIENCE_TOO_LARGE` above). Targets (benchmark gates,
  not facts — decision N): 1 M captured in ≤ 10 s, 5 M in ≤ 60 s.
- **Lifecycle:** the **owner decides** when a snapshot is no longer needed and calls `releaseByKey`; the Audience
  context never releases a snapshot on its own (it cannot see the owner's state without crossing context
  boundaries). Finishing the purge of an already released snapshot needs no owner state. For Campaigns, the rules
  are in `docs/contracts/phase-6-campaign.md` §6.4.
- **Uniqueness:** `UNIQUE (workspace_id, capture_key)` — there is never a second snapshot per key; repeat-capture rules
  in §9.4 (decisions B and C). Keys are namespaced per workspace: workspace B may use the same key independently.
- **Observability (Audience side):** metrics — unreleased snapshots by owner kind and age bucket, released-but-unpurged
  snapshots, members held, releases by reason; a warning when an unreleased snapshot is older than 7 days or a purge
  is incomplete after 1 hour. Logs carry snapshot id, capture key and owner id only.
- **Personal data:** ids only (decision H) — no email, phone, name, company, custom fields, consent, topic or
  suppression details.

### 9.7 Interaction with Eligibility

Resolution answers **who is in the audience (at T0)**; Eligibility answers **who may be messaged now**. Campaigns call
`page()` then `Eligibility.evaluate(page.contactIds, …)`. Resolution never applies consent, subscription,
suppression or topic rules; Eligibility never reads list or tag membership.

### 9.8 Package boundaries (E-3)

`@workeasy/audience-core` must not become a database-access package. The read side of the Audience context is split
into **pure core** and **infrastructure adapters**, following the ports-and-adapters shape the API modules already
use (`domain` pure, `application` orchestrates, `infrastructure` does I/O):

| Package | Contains | May depend on | Must not depend on |
|---|---|---|---|
| `@workeasy/shared` (exists) | Wire contracts: types, Zod schemas, reason codes | — | anything internal |
| `@workeasy/audience-core` (new) | **Pure**: eligibility rules (`evaluateEligibility`), effective consent state, consent fingerprint (HMAC, `node:crypto`), audience-definition rules (limits, duplicates, conflicts, canonical hash); **ports**: `EligibilityFactsReader`, `AudienceResolution`, `AddressLookup`; **services** that combine pure rules with ports (`EligibilityEvaluator`) | `@workeasy/shared`, Node built-ins | `@workeasy/db`, Prisma, `pg`, NestJS, `@workeasy/channels`, `apps/*` |
| `@workeasy/audience-infra` (new, owned by the Audience context) | The **only** implementations of those ports: SQL/Prisma readers for eligibility facts and address lookup; snapshot capture/page/release over the two Audience-owned snapshot tables | `@workeasy/audience-core`, `@workeasy/db`, `@workeasy/shared` | `apps/*`, NestJS, `@workeasy/channels` |

Where code may use them:

| Consumer | `audience-core` | `audience-infra` |
|---|---|---|
| `apps/api` Audience module | ✓ | ✓ (its own context) |
| `apps/api` Campaigns module (`domain`, `application`) | ✓ ports and types only | **✗** — implementations are injected by the composition root |
| `apps/api` composition root (`app.module.ts`, module providers) | ✓ | ✓ (wiring only) |
| `apps/worker` jobs | ✓ ports and types only | ✗ |
| `apps/worker` composition root (`worker.module.ts`) | ✓ | ✓ (wiring only) |
| `apps/web`, `packages/shared`, `packages/channels` | ✗ | ✗ |

Why the worker's database access stays controlled: the worker already depends on `@workeasy/db` and runs every job
in `withTenant` as `workeasy_app` (existing `tenant-job.ts`), so no new privilege appears. Job code receives only
Audience **ports** (read eligibility facts, read addresses, page a snapshot) — it cannot reach Audience tables except
through the Audience context's own adapters, and RLS confines those to the job's tenant. Writes to Audience data stay
in `apps/api` (consent recording, suppression, imports); the only Audience write the adapters perform is the
Audience-owned snapshot.

Enforcement (added in milestone 6.2): dependency-cruiser rules for every row of the two tables above, the manifest
check for `apps/web` / `packages/shared`, `domain-is-pure`-style rule for `audience-core`, `no-circular`, and an
architecture test that fails if `apps/api/src/modules/campaigns/**` references Prisma delegates of Audience tables
(`tx.contact`, `tx.contactIdentity`, `tx.listMembership`, `tx.contactTag`, `tx.consentState`, `tx.suppression`,
`tx.topic`, `tx.contactTopicPreference`, `tx.audienceSnapshot…`).

The fingerprint moves with an identical algorithm (HMAC-SHA256 over `consent-subject␀channel␀value`, base64url, same
`DATA_FINGERPRINT_SECRET`), proven by a regression test against stored `subject_fingerprint` values; the worker then
needs `DATA_FINGERPRINT_SECRET`.

### 9.9 Audience Resolution v1.1 — uniform sample and topic status (E-5)

**Status: APPROVED 2026-10-07 ("Option 1", product owner) and IMPLEMENTED 2026-10-07.** Additive: Audience
Resolution v1 (§9.4 — `validate`, `count`, `capture`, `page`, `release`) is unchanged in signature, semantics,
errors and storage; every v1 consumer and test behaves identically.

**Why it was needed.** Campaign pre-flight (contract phase-6-campaign §3.1) must report the exact live audience size,
an eligibility estimate *on a uniform sample of ≤ 2,000 members*, and `TOPIC_UNAVAILABLE` for a deleted, archived or
category topic. v1 offered only `count` (no members) and `capture` (a durable snapshot of up to 5,000,000 members with
retention and cleanup). Campaigns may not read `topics`, `contacts`, memberships, consents or suppressions (§9.8), so
milestone 6.7 had no compliant way to obtain either fact.

**Why not a snapshot.** A capture is a durable, audited, retained write sized to the whole audience (up to 5M members
in chunks, cleanup jobs, owner bookkeeping); pre-flight is a frequent read-only check (rate-limited 60/h/user) that
needs ≤ 2,000 ids. Capturing to sample would turn every pre-flight into a large write, leave snapshots to purge, and
blur the rule that a snapshot exists only for an execution. v1.1 reads the *live* audience and writes nothing.

#### Port (`@workeasy/audience-core`, `ports.ts`)

```ts
export const AUDIENCE_SAMPLE_LIMIT = 2_000;
export interface AudienceSampleOptions { size: number /* integer 0–2,000 */; seed?: number /* −1…1, tests only */ }
export interface AudienceSample {
  contactIds: string[];   // min(size, N) distinct members of the live audience, ascending — ids only, no PII
  audienceSize: number;   // exact N, capped at 5,000,000 like count()
  capped: boolean;        // N > 5,000,000
  sampledAt: string;      // statement time of the read (size and sample come from ONE statement)
}
export type AudienceTopicStatus =
  | { available: true }
  | { available: false; reason: 'not_found' | 'archived' | 'category' };
export interface AudienceResolutionV1_1<TTx = unknown> extends AudienceResolution<TTx> {
  sample(scope: TenantScope<TTx>, def: AudienceDefinitionV1, opts: AudienceSampleOptions): Promise<AudienceSample>;
  topicStatus(scope: TenantScope<TTx>, topicId: string): Promise<AudienceTopicStatus>;
}
```

Implemented by `PrismaAudienceResolution` (`@workeasy/audience-infra`); `createAudienceReadSide().resolution` is typed
`AudienceResolutionV1_1`. The API's Audience composition root binds it to the `AUDIENCE_RESOLUTION` token, which
`CampaignsModule.forRoot(AudienceModule)` receives — Campaign code imports neither the Audience module nor the adapter.

#### Sampling semantics

- **Population**: exactly the members `count()` counts — union of included lists/tags, minus excluded, minus deleted
  and erased contacts (§9.5). Same validation and the same errors as `count` (`AudienceResolutionError`: invalid
  definition, `AUDIENCE_SOURCE_NOT_FOUND` for a missing, deleted or foreign list or tag).
- **Uniform**: every k-subset of the N members is equally likely, k = min(size, N). Not `ORDER BY id LIMIT k`, not
  "first chunks", not biased by list order, overlap or position.
  - *Bitmap path* (workspace bitmap VALID, §6.3 G2): per chunk, audience bits = OR(include) & ~OR(exclude) & ~dead;
    ranks drawn uniformly without replacement from [0, N) (N ≤ 2k: a random permutation of all ranks; otherwise iid
    draws, DISTINCT, then a random k of them — uniform among k-subsets); rank → chunk by `width_bucket` over the
    per-chunk prefix sums; rank → bit by binary search over prefix popcounts; bit → contact by its position. One
    statement (one MVCC snapshot), bounded by k and the number of chunks — never by the workspace size (migration
    `20261015000001`, see Performance).
  - *Exact path* (bitmap not valid, rebuilding or absent, or positions inconsistent): the count query's set
    expression ordered by `uuid_hash_extended(contact_id, seed)` (a 64-bit hash of the id's bytes) with a fresh
    64-bit random seed, `LIMIT k` — a uniformly random order, so the first k are a uniform k-subset; count and sample
    in one statement. Cost ≈ the exact count + 10 % (MEASURED; an md5-of-text order cost ≈ 2× the count).
- **Live, not frozen**: two calls may differ as the audience changes. No snapshot, no row written, no lock taken.
- **Seed** (−1…1) makes a draw repeatable; for tests only — production callers omit it.
- **Consistency guard**: if a VALID bitmap names a position with no contact, the function answers like a non-valid
  bitmap and the exact path serves the request — a sample is never silently short.
- MEASURED uniformity (60 members spread over ≥ 3 chunks; 2,000 draws bitmap, 600 exact): χ² for 59 degrees of
  freedom (mean 59, sd ≈ 10.9; test bound 120) — run 1: 50.1 bitmap / 65.4 exact (md5 order); run 2: 81.3 bitmap /
  73.0 exact (`uuid_hash_extended` order) — consistent with uniform.

#### Topic status semantics

`topicStatus(scope, topicId)` reads one row of the current workspace's topics under RLS: `{ available: true }` for an
active topic of kind `topic`; `archived` (status not active); `category` (kind `category` — not sendable);
`not_found` for a missing id, a malformed id (validated before any SQL), or a topic of another workspace or
organization (RLS makes it invisible — existence in another tenant is never revealed). Topics have no hard delete in
Phase 5; a deleted topic is `not_found`.

#### Security

- Tenant scope asserted (`assertTenantScope`) on every call; all SQL runs as `workeasy_app` inside the caller's
  tenant transaction, RLS-confined.
- `app.audience_sample_ids` / `app.audience_sample_nth_bit`: SECURITY DEFINER (`ids`), owned by the NOLOGIN,
  **NOBYPASSRLS** `workeasy_audience_count` role (RLS still applies to the owner), `search_path` pinned; refuses to run
  without a workspace context (42501); size bounded 0–2,000 (22023). EXECUTE revoked from PUBLIC; granted to
  `workeasy_app` for `audience_sample_ids` only. No grant on any table changes.
- Named outside the `audience_count_` prefix on purpose: the 6.3 DDL guard invalidates every bitmap on DDL touching
  that prefix; installing or replacing a reader must not. MEASURED: applying both migrations invalidated no bitmap.
- Returns contact **ids only** — no names, addresses, phones or attributes. Campaign pre-flight passes them straight
  to Eligibility and returns counts and shares only (contract phase-6-campaign §3.1). Regression tests assert that no
  id, email or phone appears in the response, findings, audit rows, domain events or logs.

#### Performance (MEASURED; full tables in the audit)

End-to-end pre-flight through HTTP (sample + Eligibility on 2,000 + topic + validation), target p95 < 2 s: met on
the bitmap path (VALID) at 100k / 500k / 1M (p95 282 / 376 / 1,456 ms); not met on the exact fallback from 500k
(its floor is the v1 exact count) — `docs/audit/phase-6.7-6.8-preflight-lifecycle.md` §4.5 and §10. The sampling statement alone, bitmap path: p95 ≈ 19 ms at
100,000 contacts, ≈ 44 ms at 500,000, ≈ 260 ms at 1,000,000.

#### Compatibility

`AudienceResolutionV1_1` extends `AudienceResolution`: anything typed against v1 accepts a v1.1 implementation
unchanged. No v1 method, error code, table, index or grant changed; the two migrations add functions only.

#### Campaign consumption

Only `PreflightService` (pre-flight, and the identical check inside `schedule` / send-now) calls `sample`;
`PreflightService` and `LifecycleService.resume` call `topicStatus`. Execution (6.9) will use v1 `capture` / `page`
for the actual recipients — a sample never becomes a recipient list.

### 9.10 Audience Resolution v1.2 — bounded sample and resolution recovery (E-6)

**Status: APPROVED 2026-10-07 (product owner: "additive degraded-mode design … combined with proactive bitmap
recovery") and IMPLEMENTED 2026-10-07.** Additive over v1.1 (§9.9); v1 and v1.1 are unchanged.

**Why.** Measured in 6.7 (`docs/audit/phase-6.7-6.8-preflight-lifecycle.md` §4.5): when a workspace's count bitmap is
not valid, the v1.1 `sample` falls back to the exact query, whose cost grows with the audience (p95 5.9 s at 500k,
10.6 s at 1M, 2/28 requests failing on the 15 s statement timeout). An interactive caller needs a bounded answer, and
the Audience context needs to be asked to restore fast resolution.

**Port (`@workeasy/audience-core`).**

```ts
interface AudienceSampleWithinOptions extends AudienceSampleOptions { exactBudgetMs: number /* 100–10,000 */ }
type AudienceSampleOutcome =
  | { available: true; sample: AudienceSample }
  | { available: false; reason: 'exact_budget_exceeded' };      // bitmap not valid AND exact did not fit the budget
interface AudienceResolutionV1_2<TTx> extends AudienceResolutionV1_1<TTx> {
  sampleWithin(scope, def, opts: AudienceSampleWithinOptions): Promise<AudienceSampleOutcome>;
}
type AudienceRecoveryStatus = 'ready' | 'rebuilding' | 'requested';
interface AudienceResolutionRecovery {
  requestRecovery(workspace: { orgId; workspaceId }): Promise<{ status: AudienceRecoveryStatus }>;
}
```

**Semantics.**
- `sampleWithin`: VALID bitmap → exactly `sample` (bitmap path). Otherwise the exact query runs inside a SAVEPOINT
  with `statement_timeout = exactBudgetMs`; if the budget cancels it (SQLSTATE 57014) the savepoint — settings
  included — is rolled back, the caller's transaction stays usable, and the answer is `available: false`. Nothing is
  read partially; no estimate is invented. Other errors propagate unchanged. Same validation/errors as `sample`.
- `requestRecovery`: `ready` if the bitmap is VALID; `rebuilding` if a rebuild is already in flight (this process) or
  holds a live rebuild lease (any process); otherwise starts the Phase 6.3 online rebuild in the background and
  answers `requested`. Never waits for the rebuild. Deduplicated per workspace: in-process single flight + the 6.3
  rebuild lease across processes (a second process's rebuild ends immediately as `busy`). Workspace-scoped (RLS);
  logs ids and outcomes only.
- Implementation: `PrismaAudienceResolution.sampleWithin`, `PrismaAudienceResolutionRecovery` (`@workeasy/audience-infra`),
  bound by the Audience module to `AUDIENCE_RESOLUTION` / `AUDIENCE_RECOVERY`. Campaigns never learn that a bitmap
  exists; the 6.3 G2 design (bitmap, rebuild, CAS, maintenance) is reused unchanged — not reopened.

**Tests (MEASURED):** `audience-resolution-v1-1.test.ts` §v1.2 — bitmap / exact / budget-exceeded paths, caller
transaction usable and `statement_timeout` restored after a budget cancel, bounded latency under a held table lock;
20 concurrent recovery requests → 1 `requested` + 19 `rebuilding`, exactly one rebuild generation, then `ready`;
two processes racing → exactly one `published`, other workspaces untouched.

**Campaign consumption:** pre-flight and schedule/send-now (contract phase-6-campaign §3.3). Execution keeps using
v1 `capture` / `page` (exact by construction).

### 9.11 Audience Profiles v1 — merge data and display names (E-7, 2026-10-08)

**Why:** Campaigns needs two contact facts it may not read from Audience tables (§9.8, RULE 2): merge-tag values for
email rendering and preview (`docs/contracts/phase-6-content-amendment.md` §3, §5), and a human display name for the
execution recipient list (campaign contract row 23, previously deferred for want of this port). Additive; no existing
port changes.

```ts
// @workeasy/audience-core — implemented by PrismaAudienceProfiles in @workeasy/audience-infra
interface AudienceProfiles<TTx> {
  mergeData(scope: TenantScope<TTx>, contactIds: string[]): Promise<Map<string, MergeData>>;
  displayNames(scope: TenantScope<TTx>, contactIds: string[]): Promise<Map<string, string>>;
}
const AUDIENCE_PROFILES_BATCH_LIMIT = 1_000;
```

| Rule | Behaviour |
|---|---|
| Tenancy | The caller's RLS-scoped transaction; `assertTenantScope` first. Another workspace's contact is ABSENT (never an error, never a leak) |
| `mergeData` fields | The `merge_tags_v1` allowlist only: first name, last name, company, primary email (primary identity first, else the oldest email identity). Blank → `null` |
| `mergeData` exclusions | Deleted or erased contacts are absent (nothing is rendered for them) |
| `displayNames` | "First Last", else company, else "Unnamed contact"; erased → "Erased contact"; deleted → "Deleted contact". **Never an address or identity value** |
| Bounds | ≤ 1,000 unique ids per call (`RangeError` above); non-uuid ids ignored; two queries at most per call |
| Use | Values are used immediately (render, response) and never stored by the caller; never logged |

Evidence: `apps/api/test/campaigns-content.test.ts` (preview: tenancy, erasure, escaping, permissions),
`apps/api/test/campaigns-recipients.test.ts` (row 23: names only, no addresses, erasure, permissions, tenancy).
