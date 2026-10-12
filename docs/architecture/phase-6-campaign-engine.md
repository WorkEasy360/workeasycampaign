# Phase 6 — Campaign Engine: final architecture review

**Status: APPROVED_WITH_CONDITIONS (architecture review, revision 2) — awaiting human approval. Nothing is implemented.**

Revision 2 corrects four points of revision 1: a deterministic audience snapshot model (ADR D-3), tighter package
boundaries (ADR D-7), an explicit topic-gate hierarchy (ADR D-2) and a retention policy boundary (ADR D-13).
This document records the decisions (ADRs), the issue register, the dependency graph, targets, tests, the plan and its
approval gates. Normative detail lives in the contracts, and this document does not repeat it:

| Contract | File | Status |
|---|---|---|
| Campaign contract v1 (lifecycle, readiness, version schema, executions, recipients, DB, API, authorization, idempotency, errors) | `docs/contracts/phase-6-campaign.md` | frozen for implementation, pending approval |
| Audience v1.1 proposed additive extensions (Audience Resolution v1 with snapshots, package boundaries, address lookup) | `docs/contracts/phase-5-audience.md` §9 | proposed, Gate 1 |
| Eligibility v1.1 proposed (topic policy, truth table, batch size) | `docs/eligibility.md` §"Proposed v1.1" | proposed, Gate 1 |
| Campaign event contract v1 | `docs/events.md` §"Campaign event contract v1" | frozen for implementation, pending approval |

Provenance tags: `[VERIFIED]` = Zoho behaviour recorded as `[ZOHO_PARITY]` in `docs/spec.md` (from earlier research;
not re-verified in this review); `[OURS]` = our original design; `[INFERENCE]` = reasoned, unverified;
`[DEFERRED]` = designed for, built later.

---

## 1. Summary

The Campaign Engine is four persistent entities — **Campaign** (editable draft + lifecycle), **CampaignVersion**
(immutable snapshot), **CampaignExecution** (one run of one version), **CampaignRecipient** (one contact per
execution) — built on three Audience contracts (Audience Resolution v1, Eligibility v1.1, Address Lookup v1) that
are defined as pure rules and ports in `@workeasy/audience-core` and implemented by the Audience context's adapters in
`@workeasy/audience-infra`, so both the API and the future delivery worker can use them without the worker importing
the API or gaining open database access. Seven lifecycle
states; readiness is computed, not a state. At execution start the audience is **captured once** (one statement, one
instant T0) into an Audience-owned snapshot; recipients are then materialized from that snapshot in checkpointed pages;
eligibility is checked at materialization (Checkpoint A) and, from Phase 8, again immediately before provider hand-off
(Checkpoint B). Production scheduling and sending stay **disabled server-side** until Phase 8; tests use a
test-only delivery stand-in that cannot be enabled in production.

Phase 5 needs **additive extensions only** (no behavioural change for existing callers). Two previously blocking issues
are resolved by decisions D-2 and D-3 below, subject to approval at Gate 1.

## 2. Architecture decision records

Each ADR: context → decision → consequences. "Deviation" notes where this review changed the earlier proposal or
the instruction it was given.

### ADR D-1 — Lifecycle: 7 states; readiness separate; scaffold replaced

- **Context.** The foundation scaffold (`apps/api/src/modules/campaigns/domain/campaign-state.ts`, its test, and
  `packages/shared/src/campaigns.ts` `CAMPAIGN_STATUSES`) defines 13 statuses, three of which (`configured`,
  `content_ready`, `validated`) track form completion, plus `pending_approval`, `awaiting_winner`,
  `paused_by_system` whose behaviour does not exist. Verified: no code other than the scaffold's own test imports it.
- **Decision.** Lifecycle `draft, scheduled, sending, paused, completed, cancelled, failed`
  (contract §2). Readiness = computed findings (§3). Execution and recipient states are separate machines (§5, §7).
  `failed` is kept: it is genuinely needed for configuration failures detected at start/resume or mid-materialization
  (e.g. a deleted exclusion list) and is the only state that is neither editable nor terminal.
- **Reconciliation of the scaffold:** `draft` kept; `configured`/`content_ready`/`validated` → readiness findings;
  `scheduled` kept; `queued` → execution `pending`/`materializing`; `sending`, `paused`, `completed` kept;
  `stopped` → `cancelled`; `pending_approval`, `awaiting_winner`, `paused_by_system` → removed now, re-added
  additively with their behaviour (D-12, Phase 9, A/B). Milestone 6.1 replaces the three files; the scaffold is
  **not** deleted during this review.
- **Consequences.** Server-side `allowedActions`/`blockedActions`; the UI never computes transitions. Spec M10's
  reference to the 13-state machine is marked superseded.

### ADR D-2 — Topic semantics: `block_unsubscribed` for campaigns (additive)

- **Context.** Eligibility v1 reports `TOPIC_NOT_SUBSCRIBED` for an unset preference; Phase 5 never auto-subscribes;
  the spec requires a topic to send. A fully consented new import would reach nobody.
- **Decision.** Eligibility v1.1 adds an optional `topicPolicy`. Campaigns always use `block_unsubscribed`: explicit
  unsubscribe blocks (`TOPIC_UNSUBSCRIBED`), explicit subscription satisfies the topic check, **unset passes the topic
  check only** — channel consent and every other check still apply, and unset is never treated as consent. Default
  stays `require_subscription` → v1 callers unchanged. Gate hierarchy and truth table (21 rows) in `docs/eligibility.md`.
- **Deviation / provenance.** This deviates from the opt-in topic rule that Phase 5 code labels `[ZOHO_PARITY]`; it is
  our product decision `[OURS]`, justified by our stricter channel-consent requirement and the absence of
  auto-subscription. **Requires human approval** (product).
- **Hierarchy (revision 2).** Eligibility is an AND of gates (contact exists → administrative status → address →
  suppression → **channel consent** → topic). Only channel consent establishes permission to send marketing; the topic
  gate can only block. `UNSET` is **not** evidence of consent. Labelled **OUR PRODUCT DECISION**.
- **Consequences.** Additive code change in Audience (Gate 1); no data migration.

### ADR D-3 — Audience Resolution v1: capture once, then page (additive) — revised

- **Decision.** At execution start the Audience context **captures** the audience definition in **one SQL statement**
  into an Audience-owned snapshot (`audience_snapshots`, members in `audience_snapshot_chunks` since D2); the execution then reads the
  snapshot in ascending contact-id pages. One statement sees one consistent database state, so the audience is
  *exactly* the members of the include sources minus the members of the exclude sources, for contacts live at that
  instant (T0 = `capturedAt`). Contract: `docs/contracts/phase-5-audience.md` §9.1–9.7.
- **What is snapshotted:** include membership, exclude membership, contact liveness — all at T0.
  **What stays live:** consent, subscription, topic preference, suppression, addresses, deletion after T0 — applied by
  Eligibility at Checkpoint A (materialization) and Checkpoint B (before delivery).
- **Why.** Revision 1's high-water mark + live removals made a contact's outcome depend on *when its page ran*. The
  capture model is deterministic, explainable ("everyone in the lists at the moment it started, minus everyone in the
  excluded lists at that moment"), restartable (capture idempotent per `captureKey`; pages read an immutable set),
  safe under concurrent workers, and bounded (one set-based statement; target 1 M in ≤ 10 s; limit 5 M in v1).
  Rejected alternatives and the full case table (12 cases) are in the contract.
- **Consequences.** Two Audience-owned tables (Gate 2). Exclusion lists are a targeting tool; after T0, only
  unsubscribe, consent withdrawal and suppression stop a message (checked live). A source deleted after T0 no longer
  fails a running execution.

### ADR D-4 — Immutable CampaignVersion, typed schema, `run_kind` uniqueness

- **Decision.** Snapshot schema `campaign.version.v1` (contract §4.1): channel, purpose, topic + policy, audience,
  sender (`senderIdentityId` null in Phase 6, `fromName`, `replyTo`), `messages[]` with variant keys, tracking
  (literal off), compliance requirements, personalization mode `none`, schedule, `abTest: null`. Created only by
  `schedule`/send-now; immutable by grant + trigger + repository; versioned schemas with upcasters, never rewritten.
- **Deviation.** The earlier strict 1:1 version↔execution is replaced by `UNIQUE (version_id) WHERE run_kind =
  'one_time'` plus one-active-execution-per-campaign. Same guarantee for one-time campaigns, but recurring campaigns
  (many executions of one version) remain possible later. A/B variants live inside one execution, so they need no
  extra executions.

### ADR D-5 — Execution-time recipient materialization

- **Decision.** Started = commit of `pending → materializing` (S1). Audience fixed = commit of the capture (S2, its own
  transaction, no campaign locks held — cancel/pause are never blocked behind it). Materialization complete = commit of
  `materializing → delivering` after the last snapshot page. One transaction per page of ≤ 1,000; cursor + counts
  committed with the page; unique `(execution_id, contact_id)`; row lock + lease. Snapshot lifecycle (contract §6.4):
  released only when the execution is `releasable` (materialization committed, or terminal) — after successful
  materialization, after a committed cancellation, after a committed failure; kept across worker crashes (recovery
  resumes the same execution; capture is idempotent per execution id, so no second snapshot); a tenant-scoped recovery
  sweep releases snapshots of terminal, materialized or missing executions only; the execution row lock and state are
  the single guard against racing a resumed job.
  Contract §6.0–6.2.

### ADR D-6 — Two-stage eligibility

- **Decision.** The single pipeline definition (contract §6.0) is used by every document:
  **Audience Resolution (capture) → Eligibility Checkpoint A → CampaignRecipient → fresh Eligibility Checkpoint B →
  Provider delivery**. Checkpoint A is Phase 6; Checkpoint B and delivery are Phase 8 (contract fixed now, §6.3,
  §10.3). Phase 6 does **not** claim a send-time check: in `test` mode the `NullDeliveryPort` sends nothing and
  performs no Checkpoint B. Behaviour for every change between A and B (consent withdrawal, topic unsubscribe, global
  unsubscribe, suppression, address change, deletion, merge, newly eligible, eligibility outage → fail closed):
  contract §6.3.

### ADR D-7 — Audience read side: pure core + context-owned adapters (revised)

- **Decision.** Two server-only packages, following the ports-and-adapters layering the API already uses:
  - `@workeasy/audience-core` — **pure**: eligibility rules, effective consent state, fingerprint, audience-definition
    rules, contracts/types, **ports** (`EligibilityFactsReader`, `AudienceResolution`, `AddressLookup`) and the
    `EligibilityEvaluator` service that combines rules with a facts port. Depends only on `@workeasy/shared`. **No
    database access.**
  - `@workeasy/audience-infra` — owned by the Audience context: the only implementations of those ports (SQL/Prisma
    readers; snapshot capture/page/release). Depends on audience-core, `@workeasy/db`, shared.
- **Who may use what:** Campaigns code and worker job code depend on audience-core **ports only**; implementations are
  injected by the API and worker **composition roots**, the only places allowed to import audience-infra. Writes to
  Audience data stay in `apps/api`. Contract and enforcement: `docs/contracts/phase-5-audience.md` §9.8; diagram §4.
- **Why not one package with readers inside:** it would make "import the package" equal "query Audience tables",
  breaking `domain-is-pure` and inviting cross-module table access. With the split, the worker gains no new privilege
  (it already runs `withTenant` as `workeasy_app`) and can reach Audience data only through Audience's own adapters.
- **Smallest safe migration.** (1) create audience-core with copies of the pure code and port interfaces; (2) create
  audience-infra with the existing fact-loading queries behind the ports; (3) make the API Audience services delegate;
  (4) delete the moved originals. Every step keeps all Phase 5 tests green; fingerprint byte-equality against stored
  values. Gate 1.

### ADR D-8 — Idempotency and concurrency

API: Idempotency-Key on create/clone/schedule; `expectedVersion` on edits and lifecycle commands; idempotent no-ops
for target-state commands. Execution: row locks (campaign → execution → recipients), conditional transitions,
partial unique indexes, leases. Recipient: unique per execution. Delivery (Phase 8): recipient id as provider
idempotency key; unknown outcomes are not resent without provider-side idempotency. **No exactly-once external
delivery is promised.** Contract §10.

### ADR D-9 — Failure taxonomy

Configuration (blocks schedule, fails execution, operator fixes), infrastructure (retried page ×3 and job ×5 with
backoff, then `health = stalled` + alert; never fails the campaign by itself), recipient (only that recipient).
Contract §11.

### ADR D-10 — No production delivery before Phase 8

`CAMPAIGN_DELIVERY_MODE`: `disabled` (default) · `test` (config refuses unless `NODE_ENV=test`) · `live` (rejected
until Gate 4). Enforced in commands (`422 DELIVERY_NOT_AVAILABLE`) and in readiness/pre-flight; the UI explains via
`GET …/campaigns/capabilities`. `NullDeliveryPort` refuses construction outside tests and is import-restricted.
Contract §9.3.

### ADR D-11 — Channels and content boundaries

Orchestration / `ChannelSpec` (content schemas and validation) / eligibility / rendering (Phase 7) / scheduling
(Phase 8) / `ChannelAdapter` (exists in `packages/channels`) / tracking (Phase 9) are separate layers. Email only;
SMS and WhatsApp declared disabled (`422 CHANNEL_NOT_AVAILABLE`). Phase 6 renders nothing (plain text stored
verbatim) — no template-injection surface. Contract §9.

### ADR D-12 — Approval deferred

No approval states in Phase 6. Integration point fixed: approvals attach to immutable versions in a future
insert-only table; `schedule` will then require an approved version id; editing requires resubmission. Contract §13.

### ADR D-13 — Deletion, and retention as a policy boundary (revised)

- **Phase 6 implementation:** soft delete from `draft`/`completed`/`cancelled`/`failed`; restore any time; **no
  automatic purge, no DELETE job, no retention table**; all campaign data kept.
- **Retention policy (boundary defined now, values not decided):** a future `campaign_retention_policies` (per
  workspace, NULL = keep, same convention as consent retention), enforced by the Campaigns context through
  workspace-bound definer purge functions run by per-tenant worker jobs. Periods are a **legal/product decision**;
  the foundation's "13 months" is only a proposal.
- **Data classes** (contract §14.3): immutable (versions, events, audit), purgeable later (recipients by execution —
  the main target; soft-deleted campaigns as a whole), not retention at all (audience snapshots — lifecycle clean-up),
  governed elsewhere (domain events, audit, engagement). Contact erasure needs no campaign rewrite (recipients are
  pseudonymous ids); an `onContactErasure` option is reserved for legal choice.
- **Invariants adopted now** (contract §14.4) so a later policy is configuration plus a purge function, not a
  redesign: server-time terminal timestamps, execution as purge unit, reports independent of recipient rows, no
  DELETE grant on campaign tables for the runtime role, no inbound references into recipients.

### ADR D-14 — Events

Campaign domain events (aggregate `campaign`, outbox, ids/counts only) vs recipient state (rows) vs engagement events
(Phase 9). `docs/events.md` §Campaign event contract v1.

### ADR D-15 — Database

Four tables, standard workspace RLS (forced), composite tenant FKs, column grants, insert-only versions, partial
uniques, no partitioning in Phase 6 (recipients later by `HASH (execution_id)`, compatible with the unique key).
Contract §12.

### ADR D-16 — API

23 operations (the earlier 21 plus `GET …/capabilities` and `GET …/executions/{id}`), every command returning
`CampaignView` with `allowedActions`, `blockedActions`, `readiness`, `readinessFindings`. Contract §15.

### ADR D-17 — Frontend contract (§6 below)

### ADR D-18 — Performance targets and benchmark (§7 below)

## 3. Issue register

### 3.1 Phase 5 contract issues

| ID | Severity | Current behaviour (verified) | Required decision | Proposed resolution | Affected contracts | Affected modules | Phase | Regression tests | Blocking |
|---|---|---|---|---|---|---|---|---|---|
| P5-1 | High | `AudienceModule` exports only `EligibilityService`; no union/exclusion resolution exists | Approve Audience Resolution v1 with snapshots | E-1, ADR D-3 | Audience v1.1 | audience-core (port), audience-infra (adapter), 2 Audience-owned tables | 6.3 | every Audience §9.2 case, capture idempotency, determinism, RLS; all Phase 5 suites unchanged | **Yes → resolved by D-3, pending Gates G1 + G2** |
| P5-2 | High (product) | `TOPIC_NOT_SUBSCRIBED` when preference unset | Approve topic policy | E-2, ADR D-2 | Eligibility v1.1 | audience domain + service, shared | 6.3 | 21-row truth table × 2 policies; v1 default unchanged | **Yes → resolved by D-2, pending human approval** |
| P5-3 | Low | Eligibility takes one `topicId`; spec M7 wants several | Single topic in Phase 6? | Yes; multi-topic rule fixed now for v1.2 | Eligibility v1.2 (later) | — | later | — | No |
| P5-4 | Medium (perf) | ≤ 100 ids per evaluate call | Raise in-process limit? | ≤ 1,000 for in-process callers after benchmark (p95 < 250 ms); HTTP stays 100 | Eligibility v1.1 | audience service | 6.3 / 6.13 | batch-size equivalence test (1,000 = 10 × 100) | No |
| P5-5 | High (Phase 8) | Eligibility only in `apps/api`; worker may not import the API | Split the read side into core (pure + ports) and infra (adapters) | E-3, ADR D-7 | Audience v1.1 (packaging) | api audience, audience-core, audience-infra, worker composition root | 6.2 | full Phase 5 regression + fingerprint byte-equality; boundary lint | No for Phase 6 itself; required before Phase 8 → scheduled in 6.2 |
| P5-6 | Medium (Phase 8) | No `addressIdentityId → address` contract | Approve Address Lookup v1 | E-4 | Audience v1.1 | audience-core port, audience-infra adapter | 8 | RLS + no cross-workspace lookup | No |
| P5-7 | Low | Import job envelope `actor {userId,email,displayName}`, workspace non-null ≠ worker envelope `actor {type,id}` (doc claims equal) | Standardize | Campaign jobs use the worker envelope; imports adapt when moved; correct `docs/imports.md` at 6.2 | jobs | api common/jobs, imports | 6.2 (doc) / 8 | — | No |
| P5-8 | Low | Lists/tags deletable while referenced by a scheduled campaign | Block deletion? | Not in Phase 6: pre-flight reports it as an error; a source deleted **before** capture fails the execution (`AUDIENCE_SOURCE_NOT_FOUND`); deleted **after** capture has no effect (snapshot); reference guard later | — | — | later | E2E: delete a list of a scheduled campaign → start fails (test mode) | No |
| P5-9 | Info | Eligibility has no "as of T" | — | Correct as is (eligibility must be current) | — | — | — | — | No |

### 3.2 Discovery open questions

| # | Question | Resolution |
|---|---|---|
| Q1 | Topic semantics | D-2 (approval) |
| Q2 | Topic mandatory? | Yes for every campaign; draft pre-filled with the workspace default topic (`TOPIC_MISSING` otherwise) |
| Q3 | Production without delivery | D-10: disabled server-side |
| Q4 | Approval now? | D-12: deferred |
| Q5 | Materialize at or before `send_at`? | At `send_at`; "prepare ahead" is a Phase 8 optimization |
| Q6 | Max audience sources | 25 include + 25 exclude `[OURS]` (spec proposal; verified Zoho limit is 10). A constant; changing it is not a contract break if lowered only for new drafts |
| Q7 | Block deletion of referenced lists? | P5-8: no, handled at start |
| Q8 | Unique campaign names? | No |
| Q9 | Contact page "campaigns received"? | Phase 8 (from recipients/delivery) |

### 3.3 Earlier decisions D-1…D-8 (discovery) → this review

D-1 → ADR D-1. D-2 → ADR D-2. D-3 → ADR D-3/D-7 and E-1…E-4. D-4 → ADR D-10. D-5 → ADR D-7 (in 6.2). D-6 → contract
§8 (scheduled executions keep running if the initiator loses access; others can cancel). D-7 → P5-3. D-8 → this
document set.

### 3.4 Discrepancies (documentation vs implementation) carried forward

| ID | Discrepancy | Action |
|---|---|---|
| X-1 | Spec M10 references the 13-state scaffold | Marked superseded in `docs/spec.md` (this review) |
| X-2 | `docs/imports.md` job-envelope claim | Fix in 6.2 (P5-7) |
| X-3 | Phase 5 contract implied more exported services than exist | Resolved by E-1…E-4 |
| X-4 | Spec M7 multi-topic vs Eligibility v1 | P5-3 |
| X-5 | Foundation audit's set-based `INSERT … SELECT` into deliveries | Superseded by paged resolution through contracts |

## 4. Dependency graph (revised)

```text
                                   ┌──────────────────────────┐
                                   │  @workeasy/shared        │  contracts only, browser-safe
                                   └──────────────────────────┘
                                     ▲     ▲      ▲      ▲   ▲
                 ┌───────────────────┘     │      │      │   └──────────────── apps/web
                 │                         │      │      │
   ┌──────────────────────────┐   ┌────────────────┐   ┌──────────────────────┐
   │ @workeasy/audience-core  │   │ @workeasy/db   │   │ @workeasy/channels   │
   │ pure rules + ports       │   │ Tx, withTenant │   │ ChannelAdapter       │
   └──────────────────────────┘   └────────────────┘   └──────────────────────┘
          ▲            ▲                 ▲    ▲                ▲        ▲
          │            │                 │    │                │        │
          │   ┌──────────────────────────┐    │                │        │
          │   │ @workeasy/audience-infra │────┘ (→ db, core, shared)    │
          │   │ Audience-owned adapters  │                     │        │
          │   └──────────────────────────┘                     │        │
          │      ▲ (composition roots only)  ▲                 │        │
   ┌──────┴──────┴──────────────────────┐  ┌─┴─────────────────┴────────┴─┐
   │ apps/api                           │  │ apps/worker                   │
   │  ├ Audience module (writes, HTTP)  │  │  ├ jobs → audience-core ports │
   │  ├ Campaigns module → core ports   │  │  └ composition root → infra   │
   │  └ composition root → infra        │  └───────────────────────────────┘
   └────────────────────────────────────┘        (api ✗ worker, worker ✗ api)
```

Edges point from dependent to dependency.

| Package / module | Depends on | Must not depend on |
|---|---|---|
| `@workeasy/shared` | — | everything internal |
| `@workeasy/db` | shared | apps, audience-*, channels |
| `@workeasy/channels` | shared | db, audience-*, apps |
| `@workeasy/audience-core` | shared (+ Node built-ins) | **db, Prisma, pg**, NestJS, channels, apps |
| `@workeasy/audience-infra` | audience-core, db, shared | apps, NestJS, channels |
| `apps/api` Campaigns module | audience-core (ports, types), db (its own tables via `inTenant`), shared, channels (types) | audience-infra, Audience module internals, Prisma delegates of Audience tables |
| `apps/api` Audience module | audience-core, audience-infra, db, shared | Campaigns module |
| `apps/api` / `apps/worker` composition roots | audience-infra (wiring) | each other |
| `apps/worker` jobs | audience-core ports, db (`withTenant`), channels, shared | apps/api, audience-infra |
| `apps/web` | shared | every server package |

**Verified properties (by construction; enforced in 6.2):**

| Property | Why it holds |
|---|---|
| No circular dependencies | Packages form a strict layering: shared → {db, channels, audience-core} → audience-infra → {api, worker}; inside the API, Campaigns → Audience ports, never the reverse (events flow out through the outbox) |
| No browser dependency | `apps/web` and `packages/shared` may not declare or import any server package (manifest check + dependency-cruiser) |
| No unauthorized database access | audience-core has no DB dependency; audience-infra is the Audience context's own adapter; job and Campaigns code receive ports, not the client; every query runs in `withTenant`/`inTenant` as `workeasy_app` under RLS |
| No API-private service in the worker | existing `api-and-worker-are-separate` rule; the worker uses packages only |
| No cross-module direct table access | Campaigns may touch only Campaigns tables; an architecture test fails on Prisma delegates of Audience tables in `modules/campaigns/**`; the snapshot tables are reached only through `AudienceResolution` |

Rules to add in 6.2: dependency-cruiser rules for every "must not" cell above, `domain-is-pure`-style rule for
audience-core, manifest-check entries for `apps/web`/`packages/shared`, the Audience-table architecture test, and
`NullDeliveryPort` importable only by the campaigns module factory and tests.

## 5. Static validation performed in this review (no runtime claims)

| Check | Result | Basis |
|---|---|---|
| Referenced modules/files exist | ✓ `campaign-state.ts` + test, `shared/campaigns.ts`, `AudienceModule` exports, `EligibilityService.evaluate(tx, workspaceId, req)`, `common/jobs.ts`, `common/idempotency.ts`, `tenant-tx.ts` (`source` option), `domain_events` envelope, `packages/channels` `ChannelAdapter`/`ChannelRegistry`/`SendContext.idempotencyKey`, `workspaces.timezone`, membership `added_at`/`tagged_at`, permission catalogue `campaigns.*`, `reports.read` | repository inspection |
| No package cycles | ✓ | §4 |
| Worker tenant isolation | ✓ jobs carry the server-built envelope; adapters run in `withTenant` as `workeasy_app` and assert the workspace; job code holds ports, not the database client; only the Phase 8 due-discovery definer function reads across tenants, returning ids | `apps/worker/src/jobs/tenant-job.ts` + design |
| Audience determinism | ✓ single-statement capture; immutable snapshot; pages by primary key; capture idempotent per key | Audience §9.1–9.6 |
| Snapshot cleanup cannot race materialization | ✓ `releasable` and `status = materializing` are mutually exclusive under the same row lock, and `releasable` is permanent | contract §6.4 |
| Pipeline described identically everywhere | ✓ contract §6.0 is the single definition; ADR D-6, Audience §9.7, events and frontend copy refer to it | §13 |
| Versions cannot be silently modified | ✓ grants + trigger + repository + content hash test | contract §4.2 |
| Retries cannot duplicate recipients | ✓ snapshot primary key + unique `(execution_id, contact_id)` + checkpoint under lock | contract §6, §10 |
| Production cannot invoke fake delivery | ✓ config refuses `test` outside `NODE_ENV=test`; constructor guard; import rule; unit test planned | contract §9.3 |
| Late unsubscribe blocks delivery | ✓ by contract at Checkpoint B (Phase 8); an unsubscribe before a contact's page is already caught at Checkpoint A | contract §6.3 |
| Phase 5 guarantees intact | ✓ only additive extensions; defaults preserve v1; full Phase 5 regression required at Gate 1 | §3.1 |
| API and frontend share lifecycle rules | ✓ one pure transition function produces `allowedActions`; UI renders them | contract §2.5 |
| Every milestone has acceptance criteria | ✓ | §9 |

None of the above has been executed; it is design verification only.

## 6. Frontend contract (D-17)

| Surface | Contract |
|---|---|
| Navigation | "Campaigns" replaces the "Soon" placeholder |
| Capability banner | From `GET …/campaigns/capabilities`: while `deliveryMode = disabled`, every campaign screen shows "Sending is not available yet — you can prepare and review campaigns"; schedule/send controls appear **disabled with that reason** (from `blockedActions`), never hidden as if they worked |
| List | Tabs from `GET …/campaigns/counts`: All · Drafts · Scheduled · Sending (incl. paused) · Sent; cancelled/failed via the All filter. Columns: name, channel, status badge (server value), topic, audience summary, send time (viewer TZ, campaign TZ on hover), updated. Keyset "Load more". Empty state with "New campaign" (if `campaigns.create`) |
| Create | Dialog: name + channel (SMS/WhatsApp shown disabled "not available yet"); creates the draft; Idempotency-Key per attempt |
| Draft page | Sections freely navigable: Details (name, description, topic — default topic preselected) · Audience (include/exclude lists and tags; live size and eligible estimate from pre-flight; help text: "The audience is fixed when the campaign starts; unsubscribes and suppressions are always respected") · Sender (from name, reply-to; "verified sender identities arrive with delivery" notice; `SENDER_NOT_CONFIGURED` warning) · Message (subject, preheader, plain-text body; character counters) · Schedule (now / at date-time + timezone, workspace default) |
| Readiness rail | `readinessFindings` grouped by section with pass/warning/error; each finding links to its field; "Run full check" calls pre-flight (estimates); refreshed after saves |
| Saving | Explicit save with `expectedVersion`; on `409 version_conflict` show "Changed by someone else — reload" without discarding local edits |
| Schedule dialog | Shows estimate, send time in campaign and viewer time zones, "content will be locked"; submit disabled unless `schedule`/`send_now` is in `allowedActions` |
| Campaign page (non-draft) | Status header; actions strictly from `allowedActions`; execution progress (planned, skipped by reason, sent, failed, cancelled, unknown) polled every 5 s while `sending`; health `stalled` explained; History (versions with number, reason, author, time; restore into draft when allowed); Recipients tab (needs `contacts.read`) with status/reason filters |
| States | Loading skeletons; empty states; error states with request id; permission-denied states; deleted campaigns read-only with Restore |
| Accessibility | WCAG 2.1 A/AA (axe in E2E), keyboard-complete, labelled controls, live region for progress, focus management in dialogs — same standard as Phase 5 |
| Authority | The UI never computes lifecycle, permissions, readiness or delivery capability; it renders server fields |

## 7. Performance targets and benchmark (D-18)

All values are **targets**, not measurements. The Phase 5 import benchmark (90–210 rows/s, writes-heavy) is **not**
evidence for these numbers; materialization does far less work per contact (no contact writes).

| Metric | Target |
|---|---|
| Draft API (`GET`/`PATCH` campaign) | p95 < 150 ms |
| Campaign list | p95 < 200 ms for 10k campaigns in a workspace |
| Readiness (in `CampaignView`) | adds < 20 ms |
| Audience count (exact) | p95 < 1 s for 1 M members across 5 sources; exact up to the 5 M capture limit |
| Pre-flight with estimate (sample 2,000) | p95 < 2 s on a 1 M audience |
| Audience capture (single statement) | 1 M members in ≤ 10 s; 5 M (v1 limit) in ≤ 60 s |
| Snapshot page (1,000 ids, by primary key) | p95 < 50 ms |
| Eligibility call (1,000 ids, in-process) | p95 < 250 ms (gate for P5-4) |
| Materialization throughput | ≥ 2,000 recipients/s per execution (1 M in ≤ 10 min) |
| Page transaction duration | p95 < 1 s; never > 10 s (DB statement timeout 15 s) |
| Worker/API memory during materialization | < 100 MB above baseline, independent of audience size |
| DB load | ≤ 1 materialization job per workspace; ≤ 4 concurrent per instance |
| Progress updates | committed per page (≈ every 0.5–1 s); UI polls every 5 s |
| Queue depth (Phase 8) | bounded by per-provider rate limits; not a Phase 6 target |
| Recovery | a killed process resumes from the last committed page within 1 job retry; ≤ 1 page of rework |

**Benchmark required before freeze (6.13):** opt-in `CAMPAIGN_SCALE=1` test like the Phase 5 import scale test —
seed 1,000,000 contacts with channel consent across 5 lists (with 20 % overlap) and 1 exclusion list; measure count,
pre-flight, capture time, full materialization (throughput, page p95, RSS), crash-and-resume (kill mid-run, verify exact counts and
no duplicates), pause/resume/cancel mid-run; run with the system kept awake for the process only; publish numbers in
the Phase 6 hardening audit. The Phase 6 freeze is blocked if any target is missed without an approved waiver.

## 8. Test strategy

| Level | Scope | Must prove |
|---|---|---|
| Domain unit | transition function (every cell of contract §2.3), `allowedActions`/`blockedActions`, readiness rules (every code), version schema + upcaster harness, content hash canonicalization, execution and recipient machines, `ChannelSpec` registry, delivery-mode guard | Exhaustive; no I/O |
| Audience contract (6.2/6.3) | package extraction regression; boundary rules; Resolution — every case of Audience §9.2 (include/exclude added/removed after T0, add+remove after T0, tags, deleted/archived sources before/after T0, deleted contacts before/after T0), union, exclusion, dedupe, capture idempotency per key and key conflict, concurrent capture with list writes (one statement, deterministic), page determinism on repeat, size limit, release, RLS; Eligibility v1.1 gate hierarchy and truth table × 2 policies; default equals v1 | Phase 5 suites unchanged + new |
| Database | RLS on 4 tables; composite FKs; version insert-only (UPDATE/DELETE as `workeasy_app` → 42501; trigger blocks owner UPDATE); unique constraints (version number, one-time execution per version, one active execution, recipient per execution); security invariants extended | Catalogue audit like Phase 5 |
| API | permission matrix (viewer, editor, manager, analyst, custom role) per operation; composite permissions for audience/topic; validation; `expectedVersion` conflicts; Idempotency-Key replays and concurrent duplicates; no-op semantics; tenant sweep across all 23 operations; `DELIVERY_NOT_AVAILABLE` in disabled mode; OpenAPI with response schemas | 403/404/409/422 exactly as contracted |
| Execution | start races; crash between capture and recording (same snapshot returned); snapshot release on materialized/cancelled/failed; no release while materializing or paused; recovery sweep (terminal → released, live → untouched, orphan → released, other workspace → invisible); late worker after cancel stops; double release idempotent; page retry; crash/resume (no duplicates, exact counts); pause/resume/cancel at page boundaries and during capture; source deleted after T0 → run continues; source deleted before T0 → `failed`; Checkpoint A reasons recorded; `NullDeliveryPort` completion; events emitted exactly once | Deterministic with fake clock |
| Events/privacy | catalogue validation; payload PII scan (as Phase 5) | Zero matches |
| Frontend | components: list, tabs, create, sections, readiness rail, schedule dialog, progress, permission-aware actions, capability banner, conflict handling | No client-side lifecycle logic |
| E2E (twice, consecutive) | create draft; edit; select audience; validate (errors → pass); schedule (v1); unschedule → edit → schedule (v2); reschedule; pause; resume; cancel; complete (test mode); delete list of a scheduled campaign → failed; cross-workspace denial; viewer denial; production-mode run shows disabled scheduling; axe on all campaign screens | Two green runs |
| Scale (opt-in) | §7 benchmark | Targets met or waived |

## 9. Implementation plan and approval gates

Gates: **G0** approve this review (decisions in "Human approval required"). **G1** before changing frozen Phase 5
code (6.2, 6.3). **G2** before applying the campaign migration (6.5). **G3** before enabling execution — in `test`
mode only (6.9). **G4** before production delivery — Phase 8, not Phase 6.

| # | Milestone | Scope | Files / modules | Consumes → produces | DB | Unit | Integration | E2E | Security / tenancy checks | Done when | Rollback |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 6.0 | Approval | Decisions listed under "Human approval required" | docs | — | — | — | — | — | — | G0 signed | — |
| 6.1 | Campaign domain (pure) | transition function, actions, readiness engine + codes, version schema types/upcaster harness, execution/recipient machines, `ChannelSpec` (email; sms/whatsapp disabled), delivery-mode guard; **replace the 13-state scaffold** | `apps/api/src/modules/campaigns/domain/**`, `packages/shared/src/campaigns.ts` | — → domain API | none | exhaustive | — | — | delivery guard unit test | every matrix cell tested; scaffold replaced; lint/typecheck green | revert commit |
| 6.2 | **G1** Read packages | create `@workeasy/audience-core` (pure rules, ports) and `@workeasy/audience-infra` (adapters); API Audience services delegate; boundary rules + architecture test; fix `imports.md` envelope note | `packages/audience-core/**`, `packages/audience-infra/**`, `apps/api/src/modules/audience/**`, `.dependency-cruiser.cjs`, `scripts/check-package-boundaries.mjs` | Phase 5 code → same behaviour from a package | none | moved tests | fingerprint byte-equality vs stored rows | Phase 5 E2E ×2 | boundary lint | all Phase 5 suites + E2E ×2 unchanged and green | revert package commit (API code restored) |
| 6.3 | **G1 + G2** Audience v1.1 extensions | Audience Resolution v1 with snapshots (two Audience-owned tables, RLS, grants); Eligibility v1.1 (`topicPolicy`, `TOPIC_UNSUBSCRIBED`, in-process batch limit set by benchmark — decision D); OpenAPI for the optional HTTP field. Decisions A–O and sub-steps 6.3.0–6.3.11: §15 | audience-core, audience-infra, shared, audience HTTP schema, `packages/db/prisma/**` (new migration) | → Resolution v1, Eligibility v1.1 | **migration (snapshot tables)** | gate hierarchy, truth table, definition rules | every Audience §9.2 case over a real DB incl. RLS, capture benchmark | Phase 5 E2E ×2 | cross-workspace sources → `not_found` | v1 default output unchanged; new tests green | feature is additive; revert commit |
| 6.4 | Shared contracts | Zod schemas (requests, snapshot v1, email content v1, findings), view types, statuses, events catalogue types | `packages/shared/src/campaigns*.ts` | domain → wire contracts | none | schema tests | — | — | — | types match contract doc | revert |
| 6.5 | **G2** Database | 4 tables, grants, triggers, CHECKs, partial uniques, RLS, indexes, definer name search; security invariants | `packages/db/prisma/**` (new migration only) | → schema | **migration** | — | DB tests (RLS, immutability, uniques) | — | catalogue audit (policies, grants) | DB suite green; dev DB rebuilt | new migration only; roll forward with a corrective migration (applied migrations immutable) |
| 6.6 | API: drafts | capabilities, list, counts, create, get, patch, delete/restore, clone, versions read | `apps/api/src/modules/campaigns/{application,http}`, OpenAPI | Resolution.validate, `ChannelSpec` → API | — | service units | API tests (authz matrix, isolation sweep, idempotency, conflicts) | — | composite permissions, IDOR sweep | contract §15 rows 1–9, 18–19 | revert routes |
| 6.7 | Pre-flight + estimates | readiness in views; `POST preflight` with count + sampled eligibility | campaigns application | Resolution.count, Eligibility v1.1 → `PreflightResult` | — | rule tests | 100k-contact estimate test | — | findings contain no PII | p95 < 2 s on 100k (dev) | revert |
| 6.8 | Lifecycle commands | schedule/send-now (version + execution), reschedule, unschedule, pause, resume, cancel, return-to-draft, restore version; delivery-mode enforcement | campaigns application/http | → executions `pending` | — | — | concurrency tests (parallel schedules/edits), no-ops, `DELIVERY_NOT_AVAILABLE` | — | `campaigns.send` only | no duplicate versions/executions under concurrency | revert; disabled mode keeps production inert |
| 6.9 | **G3** Execution | `startExecution`, capture via `AudienceResolution.capture`, materialization job (worker envelope) via `JobDispatcher`, checkpoints, retries, leases, health/stalled, recovery sweep, snapshot release, `NullDeliveryPort` (test mode), completion | campaigns application/jobs | Resolution.capture/page/release + Eligibility (Checkpoint A) → recipients | — | — | crash/resume, races, capture idempotency, sources deleted before/after T0, exact counts | — | job tenant envelope, RLS per page | exactly-once recipients; resumable | `test` mode only; production unaffected |
| 6.10 | Events + audit | catalogue entries, audit actions, PII scan | events catalogue, audit actions | → event contract v1 | — | catalogue tests | privacy scan | — | no PII | zero PII matches | revert |
| 6.11 | Frontend | §6 | `apps/web/src/app/(app)/campaigns/**`, nav | API → UI | — | component tests | — | — | permission-aware, no client policy | component tests + axe pass | revert UI |
| 6.12 | E2E | §8 flows + axe, twice | `apps/e2e/tests/phase6*.spec.ts` | — | — | — | — | ×2 | cross-workspace + viewer denial | two consecutive green runs | — |
| 6.13 | Benchmark, hardening, freeze | §7 benchmark; hardening audit like Phase 5; freeze contracts | docs/audit, contracts | — | — | — | scale test | full ×2 | full audit | `READY_FOR_PHASE_7` (or not) | — |

## 10. Deferred features (explicit)

Approval workflow · A/B testing (`abTest`, variants) · multi-topic campaigns (v1.2) · segments as audience selectors ·
"all contacts" audiences · recurring campaigns (`run_kind = 'recurring'`) · recipient-local time, optimal time,
batch windows, throttling, quiet hours · the scheduler (due-execution discovery) · real delivery, renderers, merge
tags, HTML/templates/builder (Phase 7–8) · tracking (opens/clicks) · system auto-pause on bounce/complaint
thresholds · Address Lookup implementation (Phase 8) · reference guards on list/tag deletion · campaign purge, the
`campaign_retention_policies` table and retention periods (policy boundary defined in contract §14; values are a
legal decision) · reports and analytics · version diff view · SMS and WhatsApp channels.

## 11. Remaining risks

| Risk | Mitigation |
|---|---|
| D-2 is a product/compliance choice that deviates from the opt-in rule recorded as Zoho parity | Explicit approval; channel consent still mandatory; truth-table tests; policy is per request, so it can be changed per campaign type later |
| Package extraction touches frozen Phase 5 code | Behaviour-preserving move in small steps; full Phase 5 regression + E2E ×2 at Gate 1; fingerprint byte-equality |
| Throughput targets unmeasured | Benchmark blocks the freeze; batch size and page size are tunable without contract changes (≤ limits) |
| Snapshot semantics surprise users ("I added contacts after it started", "I added them to the exclusion list") | One-sentence explanation in UI copy and the contract; compliance blocks (unsubscribe, suppression, consent) are always live |
| Very large audiences (> 5 M) | v1 capture limit with an explicit error; limit revisited with the benchmark |
| Delivery stays disabled for a whole phase | Capability banner; disabled controls with reasons; nothing looks scheduled that cannot send |
| In-process job dispatcher until the worker takes over | Same pattern as imports; recovery sweep; moving to the worker changes only the dispatcher (P5-5 resolved in 6.2) |
| Retention period undecided | Policy boundary and invariants defined (contract §14); no purge built; values await a legal decision without blocking Phase 6 |

## 12. Final architecture acceptance criteria

The architecture is accepted for implementation when the human approves the decisions listed below. Phase 6 is
**complete** only when: every contract table/state/code is implemented as written or the contract is amended through
review; all suites (DB, API, web, worker, shared), boundary lint, typecheck and build pass; E2E passes twice
consecutively including axe; the benchmark meets §7 or has approved waivers; a hardening audit finds no open Critical
or High issue; production configuration provably cannot schedule, send or construct `NullDeliveryPort`.

## 13. Revision 2 consistency review

Checked across this document, `docs/contracts/phase-6-campaign.md`, `docs/contracts/phase-5-audience.md` §9,
`docs/eligibility.md` §"Proposed v1.1" and `docs/events.md` §"Campaign event contract v1".

| Topic | Single source | Consistent? |
|---|---|---|
| Pipeline Resolution → A → Recipient → B → Provider | campaign contract §6.0 | ✓ ADR D-5/D-6, Audience §9.1/§9.7, eligibility doc, events table of non-domain facts, frontend copy all match |
| Audience consistency (capture at T0) | Audience §9.1–9.2 | ✓ revision-1 high-water-mark text removed everywhere; execution columns now `audience_snapshot_id`, `captured_at`, `audience_size`, `materialization_cursor` |
| Source deleted during a run | Audience §9.2 (8a/8b), contract §6.2 | ✓ fails only if deleted before T0; failure taxonomy and resume rules updated |
| Lifecycle ↔ execution ↔ recipient states | contract §2, §5, §7 | ✓ |
| Readiness ↔ start checks | contract §3.2 | ✓ `AUDIENCE_SOURCE_NOT_FOUND` and `AUDIENCE_TOO_LARGE` are capture-time start checks |
| Topic semantics | eligibility doc gate hierarchy | ✓ ADR D-2, contract §6.3 (Checkpoint A/B use `block_unsubscribed`) |
| Idempotency | contract §10 | ✓ capture idempotent per `captureKey` added |
| Snapshot lifecycle | contract §6.4, Audience §9.6 | ✓ release triggers, crash recovery, sweep, concurrency guard and metadata consistent in both contracts, the retention table (§14.3) and execution columns |
| Pause/resume/cancel | contract §2.2, §6.2 | ✓ pause/cancel never wait for a capture (no campaign locks during capture) |
| Production delivery restrictions | contract §9.3 | ✓ `test` mode never performs Checkpoint B; stated in §6.0 |
| Events | events doc | ✓ `campaign.started` payload uses `executionId` only (no `asOf`); capture time is on the execution |
| RLS / authorization | contract §8, §12; Audience §9.6 | ✓ snapshot tables workspace-scoped; Campaigns reaches them only via the port |
| Retention | contract §14 | ✓ ADR D-13; deferred list; risks |
| Worker | §4, ADR D-7 | ✓ ports only; adapters wired in the composition root |

## Human approval required

1. **D-2** topic policy `block_unsubscribed` for campaigns, with the gate hierarchy — OUR PRODUCT DECISION that deviates from the opt-in rule recorded as Zoho parity.
2. **D-3 / E-1** Audience Resolution v1 with single-statement snapshots, including the two new Audience-owned tables (additive Phase 5 extension; Gates G1 + G2).
3. **E-2** Eligibility v1.1 (optional `topicPolicy`, new code `TOPIC_UNSUBSCRIBED`, in-process batch ≤ 1,000 after benchmark).
4. **D-7 / E-3** the `audience-core` / `audience-infra` split and the behaviour-preserving move of frozen Audience read code (Gate G1).
5. **D-1** replacement of the 13-state foundation scaffold (milestone 6.1).
6. **D-10** production delivery disabled throughout Phase 6.
7. Gates G1 (6.2–6.3), G2 (6.3 snapshot tables, 6.5 campaign tables), G3 (6.9) as defined in §9.

Not requiring approval now: the retention **periods** — the boundary is defined and Phase 6 purges nothing; values will
be set by a separate legal/product decision before any purge is built.

## 14. Phase 6.2 Boundary Implementation

Milestone 6.2 (Gate G1) implements ADR D-7 / Audience E-3 for the read side that exists today. No behaviour changed;
no migration, no Campaign persistence, no worker job, no delivery.

**New packages**

| Package | Contents | Depends on |
|---|---|---|
| `@workeasy/audience-core` | `evaluateEligibility` + `ADDRESS_KIND_FOR_CHANNEL` (moved unchanged), `effectiveChannelState` + `DEFAULT_PENDING_EXPIRY_DAYS` (moved), `consentFingerprint` (same algorithm), `EligibilityEvaluator` (fact assembly moved from `EligibilityService.evaluate`), ports `EligibilityFactsReader`, `AudienceResolution`, `AddressLookup`, `TenantScope`; Resolution v1 pure rules (definition validation, canonical `definitionHash`, page limit, snapshot-bound opaque cursor, reference `captureMembers` / `pageMembers`) | `@workeasy/shared`, `node:crypto` |
| `@workeasy/audience-infra` | `PrismaEligibilityFactsReader` (the Phase 5 queries, moved), `assertTenantScope` / `tenantScopeFor`, `createAudienceReadSide` | audience-core, `@workeasy/db`, shared |

**Dependency graph (as built, verified by dependency-cruiser):** shared → {db, channels, audience-core} →
audience-infra → {api Audience module, worker composition root}. Campaigns → audience-core only (nothing imports it
yet). `apps/web` → shared only.

**Migrated consumers**

| Consumer | Before | After |
|---|---|---|
| `EligibilityService.evaluate` / HTTP `eligibility/check` | queries + rules in the API | delegates to the injected `EligibilityEvaluator` port (`ELIGIBILITY_EVALUATOR`, bound in `AudienceModule`); same signature, same 400 `validation_failed` for an unknown topic |
| `effectiveConsent` (consent.service) | API helper | removed — moved into `EligibilityEvaluator` + adapter |
| `fingerprint()` (consent writes) | `hmac(secret, 'consent-subject', …)` | delegates to `consentFingerprint` (byte-identical) |
| contact detail (`contacts.service`) | API domain imports | imports `effectiveChannelState`, `ADDRESS_KIND_FOR_CHANNEL` from audience-core |
| `domain/eligibility.ts`, read-state part of `domain/consent.ts` | API domain | deleted / moved; write-side consent state machines stay in the API |
| worker | no Audience access | `apps/worker/src/audience-read-side.ts` composition root (not registered until a job needs it — Phase 8 — so worker boot does not yet require `DATA_FINGERPRINT_SECRET`) |

**Enforcement added:** dependency-cruiser rules `audience-core-is-pure`, `audience-core-no-io-builtins`,
`audience-infra-boundaries`, `audience-packages-no-undeclared-or-unresolvable`, `lower-packages-not-audience`,
`audience-infra-only-in-composition-roots`, `campaigns-no-audience-internals`, `audience-not-campaigns`, and web/shared
extended to the new packages (each rule proven to fire with temporary probe files); manifest check entries for both
packages, `packages/db` and `packages/channels`; architecture test `apps/api/test/audience-boundary.test.ts` (no
Audience Prisma delegates, Audience SQL, audience-infra or Audience-module imports in `modules/campaigns/**`).

**Tenant isolation:** every adapter call asserts that the scope's org and workspace equal the transaction's tenant
settings (`app.org_id`, `app.workspace_id`) before reading — a mislabelled, empty or org-only scope fails with
`TenantScopeMismatchError` — and every query then runs under forced RLS as `workeasy_app`.

**Performance:** the adapter issues the same seven delegate queries as Phase 5 for any batch size (asserted for 1 and
251 contacts), plus one tenant-settings check per transaction. No caching added.

**Deferred:** Audience Resolution adapter and snapshot tables (6.3, Gate G2), Eligibility v1.1 `topicPolicy` /
`TOPIC_UNSUBSCRIBED` (6.3), Address Lookup adapter (Phase 8), registering the worker provider (Phase 8). Campaign
`draft.ts` keeps its own copy of the audience limits (25/25) frozen in 6.1; unifying them with
`AUDIENCE_DEFINITION_LIMITS` belongs to the 6.4 shared contracts.

## 15. Phase 6.3 Decision Freeze (milestone 6.3.0, 2026-10-05)

Approval of the Phase 6.3 discovery with fifteen decisions. Gate **G2** (the two Audience-owned snapshot tables) is
approved with the exact schema, RLS and grants in `docs/contracts/phase-5-audience.md` §9.6. Nothing is implemented
by this freeze. Normative text: Audience contract §9.3–9.6, Campaign contract §6.1 and §6.4, `docs/eligibility.md`
§"v1.1". This section records the decisions and why.

| # | Decision | Where it is normative |
|---|---|---|
| A | **Purge completion.** New column `audience_snapshots.purged_at` (server time, `CHECK (purged_at IS NULL OR released_at IS NOT NULL)`). States: unreleased / released + purge incomplete / released + purged. `releaseByKey` keeps its parameters and returns `{ released, membersRemaining }`; each call marks released (first reason kept), locks the snapshot row, deletes ≤ 10,000 members and sets `purged_at` in the same transaction that observes none remaining. Every crash point resumes; no permanent orphan state. New port method `listReleasedUnpurged`. The meaning of `released_at` is unchanged. | Audience §9.3, §9.4, §9.6; Campaign §6.4 |
| B | **Key reuse.** `UNIQUE (workspace_id, capture_key)`. Same definition (canonical hash) **and** same owner → existing snapshot; different definition or different owner → `AUDIENCE_SNAPSHOT_KEY_CONFLICT`; ownership never transfers; keys are namespaced per workspace and invisible across workspaces (RLS). | Audience §9.3, §9.4 step 2, §9.6 |
| C | **Released keys.** A key identifies one capture lifecycle: capture on a released key → `AUDIENCE_SNAPSHOT_NOT_FOUND` regardless of definition or owner; never recreated. | Audience §9.4 step 2 |
| D | **Eligibility batch size.** Benchmark 100 / 500 / 1,000 ids (p50/p95/p99); adopt 1,000 only if p95 < 250 ms, else the largest passing size with internal sub-batching (identical results). HTTP stays ≤ 100. Until the benchmark runs, the in-process limit is the documented v1 limit of 100. | `eligibility.md` v1.1; Campaign §6.1 |
| E | **`topicPolicy?: 'require_subscription' \| 'block_unsubscribed'`.** Omitted ⇒ byte-for-byte v1; `require_subscription` is v1's explicit name; `block_unsubscribed` is the Campaigns policy. | `eligibility.md` v1.1 |
| F | **Topic semantics.** `require_subscription`: UNSET → `TOPIC_NOT_SUBSCRIBED`, SUBSCRIBED passes, UNSUBSCRIBED → `TOPIC_NOT_SUBSCRIBED`. `block_unsubscribed`: UNSET passes the topic gate, SUBSCRIBED passes, UNSUBSCRIBED → `TOPIC_UNSUBSCRIBED`. UNSET ≠ consent; channel consent stays an independent mandatory gate. | `eligibility.md` v1.1 (tables, hierarchy, truth table) |
| G | **Ownership.** Audience owns both snapshot tables and their adapter; Campaigns owns executions; `owner_id` is an application-level reference with **no FK** in either direction; Campaigns never query Audience tables (enforced by the 6.2 rules and architecture test). | Audience §9.6; §4 |
| H | **No personal data** in snapshots: ids, hashes, counts, timestamps, reasons only. | Audience §9.6 |
| I | **RLS and grants** exactly as Audience §9.6: forced RLS with the workspace policy on both tables; members `SELECT, INSERT, DELETE`, no UPDATE; snapshots `SELECT, INSERT` + `UPDATE (released_at, release_reason, purged_at)` only; no snapshot DELETE for any runtime role. | Audience §9.6 |
| J | **Cleanup discovery.** `app.workspaces_with_snapshot_cleanup(owner_kind, unreleased_before)` (renamed from the proposed `workspaces_with_unreleased_snapshots`, because it now also finds released-but-unpurged snapshots): SECURITY DEFINER, pinned `search_path`, no PUBLIC execute, `workeasy_app` only, returns `(org_id, workspace_id)` only. | Audience §9.6; Campaign §6.4 |
| K | **Capture timeout.** Caller transaction `TxOptions.timeout = 330 s` containing only the capture; `SET LOCAL statement_timeout = '300s'` for the one capture statement, reset immediately after; the runtime role default (15 s) is never changed; paging always in separate later transactions. The adapter refuses a transaction that already holds a transaction id. | Audience §9.4 |
| L | **T0.** One statement, one MVCC snapshot, `captured_at = statement_timestamp()`; membership changes after T0 are ignored; consent, suppression, topic, address and deletion stay live (Eligibility). | Audience §9.1–9.2, §9.4 |
| M | **Source deletion.** Existence = visible row with `deleted_at IS NULL`, checked inside the capture statement; deletion before T0 → `AUDIENCE_SOURCE_NOT_FOUND`; zero memberships ≠ missing source (the repository deletes memberships with the list/tag). | Audience §9.5 |
| N | **Performance claims.** 1 M capture ≤ 10 s, 5 M ≤ 60 s, page p95 < 50 ms, count p95 < 1 s at 1 M, eligibility p95 < 250 ms at 1,000 ids are benchmark gates (6.3.10), not facts. | §7; Audience §9.6 |
| O | **Sequence** below; no Campaign persistence, execution, delivery, scheduler or UI in 6.3. | this section |

**Implementation sequence (6.3):**

| Step | Content |
|---|---|
| 6.3.0 | This contract/decision freeze |
| 6.3.1 | Eligibility v1.1: shared field + code (+ the "422" comment fix), core rule, evaluator/service pass-through, HTTP/OpenAPI optional field, in-process limit 100 until the benchmark (decision D); truth table × both policies + omitted; compatibility; batch tests |
| 6.3.2 | Pure Audience Resolution refinements in core: UUID selector ids and cursor, capture-identity rules (B, C), `AudienceReleaseResult`, `listReleasedUnpurged` on the port |
| 6.3.3 | Prisma models + additive migration: both tables, keys, FKs, partial index, RLS, grants, triggers, discovery function; permission/invariant tests as the real roles |
| 6.3.4 | `validate` + `count` |
| 6.3.5 | Deterministic capture (single statement, dedicated-transaction assertion, timeout, idempotency, conflicts) |
| 6.3.6 | Deterministic `page` |
| 6.3.7 | `releaseByKey` with resumable purge |
| 6.3.8 | `listUnreleased`, `listReleasedUnpurged`, `SystemQueries.workspacesWithSnapshotCleanup`, Audience-side purge recovery |
| 6.3.9 | Tenant-isolation and security tests (every Audience §9.2 case over a real database) |
| 6.3.10 | Benchmark: capture/count/page/cleanup at 100 k / 500 k / 1 M (+ 5 M limit), concurrent captures, eligibility 100 / 500 / 1,000 — results in the Phase 6 hardening audit |
| 6.3.11 | Documentation + freeze |

**Repository facts these decisions rely on (verified):** list/tag deletion is a soft delete that removes memberships in
the same transaction; only lists have an archive state; runtime roles have `statement_timeout = 15s` and
`idle_in_transaction_session_timeout = 30s` (bootstrap); `withTenant` uses a Prisma interactive transaction with a 10 s
default timeout; `security-invariants.test.ts` enforces forced RLS on every public table, no UPDATE of id/tenant
columns and pinned definer functions; PostgreSQL 16 (no native `uuidv7()`).

**Contradiction check:** none between the Audience contract, the Campaign contract, `eligibility.md`, this document
and repository behaviour after this freeze. One code comment (`packages/shared/src/eligibility.ts`, "422") disagrees
with the frozen and implemented `400 validation_failed`; recorded in `eligibility.md` and corrected in 6.3.1.

## 16. Phase 6.3 Implementation record (Audience Resolution v1 + Eligibility v1.1)

Implemented as frozen by §15 (decisions A–O). No Campaign persistence, API, execution, scheduler, delivery or UI.

**Code**

| Area | Where |
|---|---|
| Eligibility v1.1 | `packages/shared/src/eligibility.ts` (`TOPIC_POLICIES`, `TopicPolicy`, `TOPIC_UNSUBSCRIBED`, 422→400 comment fix), `packages/shared/src/api/audience.ts` (optional `topicPolicy` on the HTTP body), `@workeasy/audience-core` `eligibility.ts` (topic gate per policy), `evaluator.ts` (pass-through, `ELIGIBILITY_BATCH_LIMIT`, `evaluateInBatches`), `EligibilityService` pass-through, `docs/api/openapi.json` regenerated (+ enum, + code) |
| Resolution rules | `@workeasy/audience-core` `audience-definition.ts`: UUID-only selector ids and cursor positions, `captureKeyOutcome` / `captureKeyError` (B, C), `assertCaptureRequest`; `ports.ts`: `AudienceReleaseResult`, `releaseByKey → AudienceReleaseResult`, `listReleasedUnpurged` |
| Schema (Gate G2) | migration `20261011000000_audience_snapshots` (Part A generated by `prisma migrate diff`; Part B: CHECKs, partial cleanup index, immutability triggers, grants, RLS, `app.workspaces_with_snapshot_cleanup`); Prisma models `AudienceSnapshot`, `AudienceSnapshotMember`; `prisma migrate diff` against the migrated database reports no drift |
| Adapter | `@workeasy/audience-infra` `audience-resolution.ts` (`PrismaAudienceResolution`: validate, count, capture, page, releaseByKey, listUnreleased, listReleasedUnpurged), `snapshot-cleanup.ts` (`discoverSnapshotCleanup`, `purgeUntilDone`, `resumeSnapshotPurges`), `SystemQueries.workspacesWithSnapshotCleanup` in `@workeasy/db`; `createAudienceReadSide` now also returns `resolution` |

**Implementation choices within the frozen contract** (no semantic change; recorded in Audience contract §9.4):

1. `releaseByKey` locks the snapshot row (`SELECT … FOR UPDATE`) before any lifecycle change, then marks released, then purges one chunk; `purged_at` is written in the transaction that observes no remaining member.
2. The purge chunk is found with one primary-key range read (`OFFSET 9,999 LIMIT 1`) and deleted by primary-key range — no join.
3. `page` reads the snapshot status and the members in one statement, so a concurrent release can never yield a partial page.
4. `count` and `capture` run with `enable_nestloop = off` for that one statement (restored afterwards, like the capture timeout). Found by the benchmark: without table statistics (fresh import, new workspace) the planner chose nested loops with an inner scan per outer row — a 20,000-member capture ran past 300 s and a release chunk past 15 s. With the setting both are linear; regression test `packages/audience-infra/test/audience-plans.test.ts` runs on never-analyzed tables.
5. Members are inserted in `contact_id` order (since D2: as ascending chunks of 1,000 ids in `audience_snapshot_chunks`).
6. Decision M is applied to `count` as to capture: a missing source is `AUDIENCE_SOURCE_NOT_FOUND`, never an empty count.
7. Test seams that can only lower limits: `PrismaAudienceResolution({ captureLimit, purgeChunk, chunkSize })` (clamped to 5,000,000 / 10,000 / 1,000) and `EligibilityEvaluator(…, { batchLimit })` (clamped to 1–1,000) — production uses the defaults.

**Tests added**

| Suite | Tests | Covers |
|---|---|---|
| `packages/audience-core` | 86 (from 47) | v1.1 truth table rows 1–16 + 14a–14e under both policies and omitted; the six policy × state combinations; UNSET never bypasses gates 1–5; reason placement; batching 1/100/101/500/501/1,000 identical; limits; UUID selectors and cursors; capture-key rules; reference capture/paging |
| `packages/db/test/audience-snapshots.test.ts` | 31 | every CHECK; uniqueness per workspace; no FK to Campaign tables; immutability trigger (captured columns, NULL→value once, never back); members never updated; exact grants for every role and column; RLS enabled+forced with identical USING/WITH CHECK; raw-SQL cross-workspace read/update/delete/lock/insert refused; org-only context sees nothing; discovery function security attributes and semantics |
| `packages/audience-infra/test/audience-resolution.test.ts` | 29 | validate statuses; count semantics and cap; capture union/exclusion/liveness/dedupe; empty source ≠ missing source; deleted source → NOT_FOUND with nothing written; over-limit → TOO_LARGE with nothing committed; dedicated-transaction refusal; timeout restored; key reuse/conflict/released/per-workspace; concurrent captures; every Audience §9.2 case incl. an uncommitted concurrent writer during the statement; paging first/middle/final/empty/deterministic/limits/tampered and foreign cursors/foreign, unknown and non-UUID snapshot ids; release/purge with first reason kept; unknown and foreign keys; concurrent releases; all four crash points; discovery + per-workspace recovery without crossing tenants; listUnreleased scope and threshold |
| `packages/audience-infra/test/audience-plans.test.ts` | 1 | linear plans without statistics (see choice 4) |
| `apps/api/test/eligibility-v1-1.test.ts` | 5 | HTTP: UNSET/UNSUBSCRIBED under each policy; UNSET is not consent; omitted = v1 response; unknown policy 400; HTTP 100 accepted, 101 → 400 |
| `packages/audience-infra/test/audience-scale.test.ts` | opt-in | the benchmark below |

**Benchmark (6.3.10, decision N)** — `AUDIENCE_SCALE=1 pnpm --filter @workeasy/audience-infra exec vitest run test/audience-scale.test.ts --silent=false`
(sizes via `AUDIENCE_SCALE_SIZES`; the 5M limit test via `AUDIENCE_SCALE_LIMIT=1`). Environment: development laptop
(Windows 11, local PostgreSQL 16 with default settings — `work_mem` 4 MB), system kept awake for each run, tables
analyzed after seeding. Dataset per size: 5 include lists (20 % overlap), 1 tag, 1 exclusion list (5 %), 1 % deleted
contacts, a noise workspace in another organization. Measured through the adapter as `workeasy_app`. Two complete
runs on the final code paths for capture/count/release (run 2 also on the final single-statement `page`); the machine
showed large run-to-run variance, so both are reported.

| Metric | 100k (run 1 / run 2) | 500k | 1M | Gate | Result |
|---|---|---|---|---|---|
| Capture, 3 runs | 2.0–6.7 s / 3.0–3.8 s | 33.9–35.1 s / 13.7–14.9 s | 64.8–70.2 s / 34.7–48.1 s | 1M ≤ 10 s | **FAIL** |
| Count p95, 10 runs | 0.78 s / 1.42 s | 3.96 s / 5.02 s | 8.49 s / 7.44 s | < 1 s at 1M | **FAIL** |
| Page p95, 300 random cursors × 1,000 ids | 25.9 / 16.2 ms | 24.5 / 12.7 ms | 23.1 / 12.0 ms | < 50 ms | **PASS** |
| Full page walk | 2.0 / 1.0 s | 10.1 / 3.7 s | 19.9 / 20.8 s (RSS +7–22 MB) | — | — |
| Release, first call (R1) | 0.32–0.42 s | 0.77–1.80 s | 1.72–2.48 s (run 1) | — | — |
| Purge to completion | 9 calls, 1.7–2.5 s | 49 calls, 24.5–36.6 s | 99 calls, 108–117 s (run 1) | — | — |
| Temp spill / WAL per capture | 10–13 MB / 21–26 MB | 104–112 MB / 108–127 MB | 216–219 MB / 215–252 MB | — | — |
| 4 concurrent 500k captures (run 1) | — | 33.6 s wall, each 32–34 s | — | — | no contention penalty |
| 5M limit (count, capture, atomic over-limit) | — | — | — | 5M ≤ 60 s | **NOT MEASURED** (see below) |

| Eligibility, realistic facts, 27 measured calls | Run 1 p50 / p95 / p99 | Run 2 p50 / p95 / p99 | Gate p95 < 250 ms |
|---|---|---|---|
| 100 ids | 100 / 114 / 168 ms | 11.5 / 16.7 / 17.1 ms | pass / pass |
| 500 ids | 156 / 191 / 199 ms | 35.4 / 45.8 / 50.9 ms | pass / pass → **adopted in-process limit 500** |
| 1,000 ids | 245 / 316 / 357 ms | 70.6 / 89.9 / 91.0 ms | **fail** / pass — not stable, not adopted |

Decision D outcome: 500 is the largest batch size that passed in both runs; the in-process limit is 500, a 1,000-id
Campaign page is evaluated as two sub-batches (identical results, tested), HTTP stays 100.

**5M limit:** not measured. The limit run was aborted after 37 minutes still seeding 5.3M contacts (IO-bound index
maintenance on this disk; identities and memberships still to come). Atomicity of the over-limit path is proven
against the real database with a lowered limit (`capture.test` "above the capture limit"), not at 5M. The 5M figures
below are **extrapolations, not measurements**.

**Cost analysis of the capture miss** (controlled experiments on the 1M dataset, rolled back): sequential scan of all
memberships 0.4 s; 1M-uuid insert into a temp table 1.4 s + index build 0.4 s (machine baseline); membership
resolution alone 3.3 s as the owner, 5.1 s as `workeasy_app` (RLS ≈ +55 %); the full capture shape 28.8 s in
isolation (69 s inside the benchmark run with concurrent checkpoints/autovacuum). Raising `work_mem` to 256 MB
changed nothing material. **The time is dominated by writing one row per member** (≈ 24 µs per row: logged composite
B-tree insert, per-row FK check, per-row RLS WITH CHECK) — a property of the frozen one-row-per-member storage, not of
a setting. Consequences on this hardware (extrapolated, not measured): count of an audience of roughly 2M or more would exceed
the 15 s runtime statement timeout, and a capture of roughly 4–8M members would reach the 300 s capture timeout. The gates are therefore **not met**; per
§7 the Phase 6 freeze is blocked without an approved waiver or design change (Gate G2 decision below).

**Remaining-work options for the decision (not implemented):** (a) re-run the benchmark on production-like hardware
before deciding; (b) waiver with revised targets/limits for v1 (e.g. a lower capture limit); (c) design change to the
member storage (e.g. chunked rows of sorted contact ids, or dropping the per-row composite FK — decision F), which
changes the frozen §9.6 schema and needs approval.

## 17. Phase 6.3 Gate G2 resolution (2026-10-07)

**G2: PASS — CLOSED. Phase 6.3: COMPLETE. Official progress: 35 %. Phase 6.4: NOT STARTED.**

The capture and count misses recorded in §16 were resolved by design changes approved during Phase 6.3 (the
"Remaining-work options" above, option (c) and the derived count):

| Gate | Resolution | Migration |
|---|---|---|
| Capture (1M ≤ 10 s, 5M ≤ 60 s) | **D2**: members stored as sorted 1,000-id chunks, set-algebra resolution, InitPlan RLS predicate. 1M 2.47–4.77 s; 5M 14.9 / 15.4 / 30.3 s quiet-state (one 62.5 s sample under concurrent checkpoint/autovacuum retained and classified as environmental contention) | `20261012000000_audience_snapshot_chunks` |
| Count (1M p95 < 1 s, 5M completes) | **Derived exact bitmap** (VALID → bitmap, otherwise the exact query; never approximate), online rebuild with generation/lease compare-and-set, reconciliation, GC. 1M p95 8.0–18.7 ms, 5M p95 9.6–19.5 ms | `20261013000000_audience_count_bitmap` |
| Membership write concurrency | **C1**: ascending-id membership writes, bounded conflict retry | none (application code) |

The `AudienceResolution` port and every request/response schema are unchanged; the Audience contract
(`docs/contracts/phase-5-audience.md` §9.4/§9.6) describes the chunked storage and the count bitmap. The `5M limit:
not measured` note in §16 is superseded: the over-limit path was measured at full scale (5,016,144 members →
`AUDIENCE_TOO_LARGE`, nothing committed). Evidence, every measurement (including outliers) and the scorecard:
`docs/audit/phase-6.3-g2-closure.md`.

## 18. Phase 6.4 Shared contracts — implementation record (2026-10-07)

**6.4: COMPLETE. 6.5 (campaign tables): BLOCKED — awaiting the human approval this plan requires (§9, item 7 of
"Human approval required"). 6.6–6.8 depend on 6.5. Phase 6.9: NOT STARTED. Official progress: 35 %.**

Zod schemas and inferred types for every campaign wire contract — statuses, findings, `PreflightResult`,
`campaign.version.v1`, `email.content.v1`, the 16 campaign event payloads, the requests and views of contract §15 —
in `packages/shared/src/campaigns.ts` and `packages/shared/src/api/campaigns.ts`; additive campaign error codes and
the `PREFLIGHT_FAILED` findings slot in the standard error contract. The 6.1 domain now validates snapshots with the
shared schema and takes its event payload types from it (behaviour unchanged). Decisions where the contract is silent,
two findings in existing documents/code, and the approval blocker: `docs/audit/phase-6.4-shared-contracts.md`.

## 19. Phase 6.5 campaign tables — APPROVED (2026-10-07)

**Gate (§9 "G2 before applying the campaign migration (6.5)"; "Human approval required" item 7): APPROVED by explicit
human instruction on 2026-10-07**, for the four Campaign-owned tables of `docs/contracts/phase-6-campaign.md` §12 —
`campaigns`, `campaign_versions`, `campaign_executions`, `campaign_recipients` — with their schema, constraints, indexes,
forced RLS, grants, immutability triggers and optimistic-concurrency support. Implementation through milestone 6.8 is
authorized; **6.9 (execution, Gate G3) is NOT authorized.** No other table is approved. This gate is distinct from the
Phase 6.3 G2 (Audience snapshot tables), which is closed and not reopened.

The same instruction resolved two findings of the 6.4 audit (`docs/audit/phase-6.4-shared-contracts.md` §4): clone
emits `campaign.created` with `clonedFrom` (no `campaign.cloned`); readiness and version creation use one canonical
email body representation.

## 20. Phase 6.5–6.6 implementation record; 6.7 blocked (2026-10-07)

**6.5 (campaign database): COMPLETE. 6.6 (draft API): COMPLETE. 6.7 (pre-flight): BLOCKED — no approved Audience port
provides the eligibility sample or the topic status that contract §3.1 requires. 6.8: NOT STARTED (its schedule
command runs the same pre-flight). 6.9: NOT STARTED. Official progress: 35 %.** Evidence, decisions and options:
docs/audit/phase-6.5-6.8-campaign-management.md.

## 21. 6.7 blocker resolved — Audience Resolution v1.1; 6.7 and 6.8 implementation record (2026-10-07)

**Decision (product owner, 2026-10-07): "Option 1" of §20 — an additive Audience Resolution v1.1 with `sample`
(uniform, live, ≤ 2,000 contact ids, exact size, no snapshot, no write, no PII) and `topicStatus` (available, or
unavailable: not found / archived / category).** Constraints recorded with the approval: v1 is not rewritten and no
consumer breaks; Campaigns consume Audience only through ports and never query topics, contacts, memberships,
consents or suppressions; no Campaign foreign key to new Audience tables and no Campaign import in Audience; no
snapshot merely for pre-flight; not `ORDER BY id LIMIT 2000`; pre-flight p95 < 2 s without weakening the target or
raising timeouts; the closed 6.3 G2 decision is not reopened.

Normative text: `docs/contracts/phase-5-audience.md` §9.9 (port, semantics, security, compatibility) and
`docs/contracts/phase-6-campaign.md` §3.1 "Fact sources" and §15 "Implementation status". Evidence:
`docs/audit/phase-6.7-6.8-preflight-lifecycle.md`.

Shape of the solution:

| Concern | Where | Notes |
|---|---|---|
| Port | `@workeasy/audience-core` `AudienceResolutionV1_1 extends AudienceResolution` | additive; v1 consumers unchanged |
| Adapter | `@workeasy/audience-infra` `PrismaAudienceResolution` (`sample`, `sampleWithPath`, `topicStatus`) | bitmap path via `app.audience_sample_ids`; exact path = count's set expression, random-salted hash order |
| Database | migrations `20261015000000_audience_resolution_sample` (functions), `20261015000001_audience_sample_fixed_plan` (plan-independent replacement) | functions only, owned by NOBYPASSRLS `workeasy_audience_count`, EXECUTE to `workeasy_app` only; outside the DDL-guard prefix — no bitmap invalidated |
| Wiring | `AudienceModule` provides/exports `AUDIENCE_RESOLUTION`; `CampaignsModule.forRoot(AudienceModule)` | Campaign code imports neither Audience code nor `audience-infra` (dependency-cruiser) |
| Pre-flight (6.7) | `PreflightService` | read-only, rate-limited 60/h/user, counts and shares only |
| Lifecycle (6.8) | `LifecycleService` | schedule/send-now, reschedule, unschedule, pause, resume, cancel, return-to-draft, restore-version; executions persisted `pending`, never processed |

Lifecycle command pipeline (contract §2.2), unchanged state machine (`decideCommand`, `nextExecutionState`): route
authorization → (schedule only: version/state/delivery decided without a lock, then pre-flight in its own read
transaction so no row lock is held during Audience reads) → `SELECT … FOR UPDATE` on the campaign → domain decision
with `expectedVersion` checked before any outcome (a stale no-op is `version_conflict`) → writes (version
`campaign.version.v1` validated on write; execution `pending`; campaign status/pointers/version) + domain events +
audit in ONE transaction. Execution status changes are conditional updates (`status IN expected AND version = read`)
through the execution state machine; lock order campaign → execution.

Not built (6.9 / Gate G3): runner, queue, scheduler, materialization, recipient creation, Checkpoint A/B, delivery,
provider calls, retries, leases, snapshot release, `NullDeliveryPort`, execution read routes (rows 21–23).
Production delivery stays `disabled`; tests that schedule use `CAMPAIGN_DELIVERY_MODE=test` (accepted only with
`NODE_ENV=test`).

Defect found and fixed during 6.7 (MEASURED): the first sampling function's rank→member mapping let the planner put
the bit-search function in a join condition over all contact positions; through the API at 100,000 contacts it hit the
15 s statement timeout. Replaced additively (migration `20261015000001`) by a join-free, plan-independent form;
regression test forces nested-loop / no-nested-loop / generic plans under a 3 s timeout and was shown to fail on the
old function. Details in the audit, §4.

Performance work during 6.7 (MEASURED; audit §4.3–4.5): eligibility of a uniform sample is random-IO bound (no
prefetch on this host), so `PreflightService` evaluates the sample in slices of 500 in separate short read
transactions, at most 4 at once per API process (no transaction held while waiting — concurrent pre-flights queue
and cannot starve the pool); the exact-path sample orders by a seeded 64-bit uuid hash instead of md5 of text. No
Audience table, index, Eligibility rule or 6.3 count behaviour changed.

## 22. Gate G3 — Phase 6.9 execution APPROVED (test mode only) and implementation record (2026-10-07)

**Authorization (product owner, 2026-10-07), conditional on the pre-G3 items passing:**

```text
Phase 6.9 execution:  APPROVED
Mode:                 test only
Production delivery:  NOT APPROVED
Real providers:       NOT APPROVED
```

**Pre-G3 conditions — met before execution code was written (MEASURED, docs/audit/phase-6.7-6.8-preflight-lifecycle.md
§12):** degraded pre-flight (Audience Resolution v1.2, contract §3.3) implemented and tested; performance gate
(normal p95 119 / 253 / 524 ms, degraded p95 207 / 785 / 1,265 ms at 100k / 500k / 1M, 0 failures, no 500); the
6.3 generation-CAS test repaired (100/100); 6.7 and 6.8 closed.

**What 6.9 implements (frozen design: ADR D-5, D-6; contract §5–§7, §10–§11), unchanged except for one amendment:**

| Concern | Implementation |
|---|---|
| Jobs | `JobDispatcher` port (in-process `InlineJobDispatcher` today; the worker later changes only the dispatcher — §11 risk table). Job names `campaign.execution.{start,run,finalize,release}`; envelope = worker tenant envelope `{ tenant: {orgId, workspaceId}, actor, correlationId, payload: {executionId, attempt} }`, built server-side, validated (zod) before the handler; handlers re-resolve the execution inside `withTenant` (RLS) — a forged or foreign id is "not found" |
| Start (S1) | lock campaign → execution; `pending` and due (send-now: right after the command commits; later send times wait for the Phase 8 scheduler); start checks (channel, topic via Audience `topicStatus`, delivery capability) → `materializing` or configuration failure |
| Capture (S2/S3) | Audience Resolution `capture(def from the IMMUTABLE version, captureKey = execution id, owner = {campaign_execution, execution id})` in its own dedicated transaction; recorded under the execution lock only if still materializing under our lease |
| Materialization | one transaction per page of 1,000: lock, `page`, Checkpoint A (`evaluateInBatches`, frozen version parameters), `INSERT … ON CONFLICT (execution_id, contact_id) DO NOTHING RETURNING`, cursor + counts; last page → `delivering` + `campaign.audience_materialized`; snapshot release after that commit |
| Checkpoint B (amendment) | contract §6.0 amendment: claim `pending→queued` (index-ordered, `FOR UPDATE SKIP LOCKED`), fresh Eligibility, `skipped_at_send` or `sending`, hand-off outside any transaction to `CampaignDeliveryPort` (key = recipient id), outcomes conditional on the claim |
| Delivery | `NullDeliveryPort` only (no I/O; deterministic, deduplicated acknowledgement per key); wired only when `CAMPAIGN_DELIVERY_MODE=test`, which config accepts only with `NODE_ENV=test`; constructor refuses other environments; dependency rule restricts imports |
| Leases | execution lease (`lease_owner`, `lease_until`): conditional acquire, renewed every page/batch, given back at the end; an expired lease is taken over by the sweep; recipient claims 5 min |
| Retries | page ×3 (0.5/1/2 s); job ×5 (1/2/4/8/16 min) with `health = retrying`, then `stalled` (never `failed`); configuration errors never retried; recipient transient failures → `queued`, `failed` after 5 attempts |
| Completion | derived from recipient rows (no pending/queued/sending; counts recomputed and stored) |
| Terminal follow-up | cancelled/failed: `pending`/`queued` → `cancelled` in chunks of 1,000; interrupted hand-offs → `unknown`; then release |
| Snapshot release | contract §6.4 procedure (R1 under the execution lock, purge continuation), triggers materialized / cancelled / failed |
| Recovery sweep | `app.workspaces_with_campaign_recovery` (definer, workspace pairs only; migration `20261016000000`) + per-workspace RLS queries: expired leases → run, lost send-now start → start, cancelled/failed with non-final recipients → finalize, releasable unreleased → release; Audience side: orphans and incomplete purges via the Audience port. At process start + every 15 min (off under NODE_ENV=test) |
| Reads | contract §15 rows 21–22; row 23 deferred (needs an Audience display-name port) |

Evidence: `docs/audit/phase-6.9-execution.md`.

**Status (2026-10-08): Phase 6.9 COMPLETE — test mode only; production delivery DISABLED; real providers not wired.
6.10 NOT STARTED. Official progress 45 %** (accounting: docs/audit/phase-6.9-execution.md §12).
