# Phase 6.4 — Shared Campaign Contracts (implementation record) and the 6.5 approval gate

**Status:** 6.4 COMPLETE. **6.5–6.8 BLOCKED at the campaign-table approval gate** (§5). **Phase 6.9: NOT STARTED.**
**Date:** 2026-10-07. **Official progress:** 35 % (unchanged; §7).
**Scope source:** `docs/architecture/phase-6-campaign-engine.md` §9 row 6.4 — "Zod schemas (requests, snapshot v1,
email content v1, findings), view types, statuses, events catalogue types; `packages/shared/src/campaigns*.ts`;
domain → wire contracts; no database; schema tests; done when types match the contract doc".

## 1. Repository audit (before any change)

| Area | State found |
|---|---|
| Phase 6.1 domain | `apps/api/src/modules/campaigns/domain/` — pure lifecycle transition function, execution/recipient machines, readiness, version builder + canonical hash, channel specs, delivery-mode guard, event payload **types**; 149 tests. No persistence, no HTTP. |
| Shared campaign module | `packages/shared/src/campaigns.ts` — status/action/finding-code constants and TypeScript interfaces only. **No Zod schemas, no request or view contracts, no event schemas.** |
| Standard error contract | `packages/shared/src/api/common.ts` — closed `ApiErrorCode` list without the campaign codes of contract §15; no slot for the findings of `422 PREFLIGHT_FAILED`. |
| Campaign database | none (no model, no migration) |
| Jobs / worker | `InlineJobDispatcher` (imports use it); the worker registers no queue processor; Redis/BullMQ never exercised |
| Phase 6.3 | complete, G2 PASS — CLOSED; last full regression green on fresh databases |

## 2. What 6.4 added

| File | Content |
|---|---|
| `packages/shared/src/campaigns.ts` | Zod schemas and `z.infer` types for: campaign/execution/recipient statuses and actions; execution phases and health; version reasons; delivery modes (`disabled`, `test` — `live` is added additively at Gate 4); readiness finding (strict, scalar-only `details`), readiness, `PreflightResult`; audience selector/definition; `email.content.v1`; **`campaign.version.v1`** (exact shape, UUID ids, contract limits, UTC `sendAt` consistent with `mode`); campaign event payload schemas for all 16 types of `docs/events.md` (strict) + counts. Every previously exported name and shape is kept. |
| `packages/shared/src/api/campaigns.ts` (new) | Request schemas for contract §15 rows 1–23 (list query, create, update, versioned command, body-less command, clone, schedule/send-now, reschedule, history and recipients queries); draft value schemas (`AudienceDefinitionDraft`, `SenderDraft`, `MessageDraft`/`EmailContentDraft`, `ScheduleDraft`); view schemas (`CampaignView`, `CampaignListItem`, `ExecutionSummary`, counts by status, capabilities, `VersionSummary`, `VersionDetail`, `RecipientListItem`, `pageOf`). All strict. |
| `packages/shared/src/api/common.ts` | **Additive:** error codes `INVALID_TRANSITION`, `CAMPAIGN_NOT_EDITABLE`, `CAMPAIGN_ACTIVE`, `CHANNEL_NOT_AVAILABLE`, `DELIVERY_NOT_AVAILABLE`, `PREFLIGHT_FAILED` (contract §15); optional `findings` on the error body, only with `PREFLIGHT_FAILED` (contract §3.1/§15 row 11). No existing code or field changed. |
| `packages/shared/src/index.ts` | exports `api/campaigns` |
| `apps/api/.../domain/events.ts` | payload types now come from the shared schemas (one definition); domain helper and exports unchanged |
| `apps/api/.../domain/version.ts` | `assertSnapshotV1` delegates to the shared `campaign.version.v1` schema (contract §4.1: "validated by a Zod schema in `packages/shared` on write and read"); same `VersionError('SNAPSHOT_INVALID')` and message fragments |
| Tests | `packages/shared/src/campaigns.test.ts` (30); `apps/api/.../domain/campaign-contracts.test.ts` (4: domain output vs shared contracts) |

No database, Prisma, NestJS or API-infrastructure import was added to `packages/shared` (the boundary check enforces it).

## 3. Decisions taken where the contract is silent (6.4, recorded for review)

| # | Gap | Decision | Why |
|---|---|---|---|
| C-1 | `CampaignListItem` fields not listed in §15 | `CampaignView` minus `draft`, `readinessFindings`, `blockedActions`, `description`, `purpose`, `createdBy`, `currentVersion`; plus `topicId` | a list row shows status, schedule/progress and the actions it can offer; per-row findings would cost pre-flight-like work |
| C-2 | Draft request bounds | wider than the v1 limits where a readiness finding reports the overflow (sources 100/side vs 25; subject 1,000 vs 200; body 200,000 vs 100,000; any reply-to / time-zone string), equal to the v1 limit where no finding exists (preheader 200, fromName 100) | a ready draft must always build a valid snapshot; findings stay reachable; payloads stay bounded (1 MiB request limit) |
| C-3 | PATCH merge semantics | each present draft field replaces that field entirely | deterministic outcome independent of stored state |
| C-4 | `expectedVersion` | positive integer, same rule as existing `version` tokens | consistency with Phase 3–5 contracts |
| C-5 | Duplicate selectors | rejected within one side (400); include/exclude overlap accepted (it is the `AUDIENCE_SOURCE_CONFLICT` finding) | §3.2 |
| C-6 | `sendAt` on requests | ISO 8601 **with an explicit offset**; snapshots store the UTC instant | no client-local ambiguity; server-authoritative time |
| C-7 | Wire delivery modes | `disabled`, `test`; `live` added at Gate 4 | Phase 6 can never report `live` |

## 4. Findings in existing documents/code (reported, not changed)

1. **Contract §15 row 9 vs §2.2 / events.md:** row 9 names the audit/event of clone `campaign.cloned`; §2.2 and the
   event contract say clone emits `campaign.created` with `clonedFrom`. The shared event contract follows events.md
   (`campaign.created`). Needs a one-word contract correction when 6.6 is approved.
2. **Body length edge (6.1 domain):** readiness measures `BODY_TOO_LONG` on the trimmed text, while
   `buildVersionSnapshot` stores the untrimmed text. A body whose trimmed length is ≤ 100,000 but whose raw length
   exceeds it would pass readiness and then fail `campaign.version.v1` validation at schedule time
   (`SNAPSHOT_INVALID` — rejected, never stored invalid). Unreachable today (no schedule command exists). To resolve in
   6.8: measure the stored text, or store it trimmed. Not changed here (no silent fix of frozen domain behaviour).

## 5. BLOCKER — campaign-table approval gate (6.5)

**Evidence.**
- `docs/architecture/phase-6-campaign-engine.md` §9: "**G2** before applying the campaign migration (6.5)"; §"Human
  approval required" item 7: "Gates G1 (6.2–6.3), G2 (6.3 snapshot tables, **6.5 campaign tables**), G3 (6.9)".
- The architecture status line still reads "awaiting human approval"; `docs/contracts/phase-6-campaign.md` is
  "FROZEN FOR IMPLEMENTATION, **pending human approval**".
- The only recorded gate approval is §15 (Phase 6.3 discovery; the Audience snapshot tables). No record approves the
  four campaign tables of contract §12.

**Why it matters.** 6.5 creates four tenant tables with forced RLS, grants, immutability triggers and partial unique
indexes that every later milestone depends on; the architecture reserves that step for explicit human sign-off, and
the instruction for this task forbids treating the Phase 6.3 G2 closure as that approval. 6.6, 6.7 and 6.8 all read or
write those tables, so none of them can proceed without it.

**Recommended action.** Record the approval of contract §12 (tables `campaigns`, `campaign_versions`,
`campaign_executions`, `campaign_recipients`, their RLS, grants, triggers and indexes) — e.g. a dated "Phase 6.5
campaign tables: APPROVED" entry in the architecture document, as §15 did for 6.3 — and, at the same time, decide
finding §4.1. Then 6.5–6.8 proceed exactly as planned, stopping before 6.9.

## 6. Verification

| Check | Result |
|---|---|
| Shared contract tests | 34 passed (4 existing + 30 new) |
| Campaign domain + contract tests | 153 passed (149 existing unchanged + 4 new) |
| Full regression | see §6.1 |

### 6.1 Full regression (fresh databases)

Run 2026-10-07 13:11–13:24, in order, after drop + bootstrap + `migrate deploy` of the dev and test databases:

| Step | Result |
|---|---|
| Security suites (security-invariants, audience-count-bitmap, audience-snapshots) | 3 files, **58 passed** |
| `pnpm typecheck` | PASS |
| `pnpm lint:boundaries` | PASS (284 modules, 1,153 dependencies, 0 violations) |
| `pnpm test` | db **112** · shared **34** (+30) · web **40** · audience-core **86** · audience-infra **63 passed, 7 skipped** · API **378 passed, 1 skipped** (+4) · worker **9** |
| `pnpm build` | PASS |
| `pnpm test:e2e` | run 1 **24 passed**; run 2 **24 passed** |
| `git diff --check` (including new files) | clean |

Phase 6.3 suites (snapshot capture, chunk storage, bitmap count, exact count, cap, paging, eligibility, RLS,
generation safety, reconciliation, GC) are part of the db / audience-infra / API / worker counts above and are
unchanged and green. No Phase 6.3 file was modified by 6.4.

## 7. Progress

The repository defines no per-milestone weighting; the official percentage has been set explicitly at gate closures
(30 % → 35 % at the Phase 6.3 G2 closure). 6.4 is the smallest milestone of the 6.4–6.8 block (contracts only, no
database, no API). **Official progress stays 35 %** until the 6.5 gate is decided and the block is delivered; no
partial increment is claimed for 6.4 alone.
