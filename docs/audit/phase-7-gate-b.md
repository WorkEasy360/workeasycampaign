# Gate B — Phase 7 core product: audit record

**Result: PASS (2026-10-09)** · **Official progress:** 50 % → **65 %** (weight fixed in advance,
`progress-accounting.md`) · **Delivery:** test mode only; production delivery disabled.

## 1. Scope and evidence

| Milestone | What | Contract | Evidence (MEASURED) |
|---|---|---|---|
| 7.1 Templates | immutable version history, restore as a new version, categories (filter, distinct list), search and pagination, audit, deleted-template protection, clone independence | content amendment §T | API `templates-history` 9 + `templates` 21; web 12; backfill verified on a throwaway database |
| 7.2 Content v3 | dynamic content (IF/ELSE, bounded data conditions), `merge_tags_v2` (custom fields via the Audience port, workspace/organization names), sanitized HTML block (parse5 allowlist rebuild, nothing removed silently), saved reusable blocks | content amendment §C, §S | content 120 (40-vector XSS corpus with fixed-point checks); API `campaigns-content-v3` 9, `snippets` 4; web editor 9 |
| 7.3 Builder | test send to the requester's own verified address only; desktop/mobile preview; HTML mode; template selection | content amendment §B | API `campaigns-test-send` 6; web 2 |
| 7.4 Workflow + audience UX | steps driven by server readiness; exact vs estimate vs frozen audience, always labelled; sample recipients (names only, contacts.read) | campaign amendment §W | API `campaigns-audience-sample` 3; web 2 |
| 7.5 Scheduling | durable due discovery (definer function, partial index), guarded start, safe under several schedulers, catch-up after downtime, unschedule/reschedule/cancel races, workspace time-zone default | campaign amendment §D | API `campaigns-scheduler` 8, stable over 3 runs |

## 2. Regression r7 (MEASURED, 2026-10-08/09, display-awake runner, 0 standby events in every window)

| Step | Result |
|---|---|
| Boundaries | 394 modules, 1,851 dependencies, **0 violations** |
| Typecheck, build | PASS |
| E2E | **57/57** (2.3 min) and **57/57** (3.6 min), consecutive |
| Tests (rerun r7c, 00:07–00:27) | db 124 · shared 62 · audience-core 86 · content 120 · audience-infra 81 (7 opt-in skipped) · web 99 · **API 603** (9 opt-in skipped) · worker 9 — all passed |

The test step needed two reruns, both explained:
1. **r7.** `shared` pinned 28 readiness codes, but 7.2 added 6 codes (documented, additive). The test was updated to name each code, and since `pnpm -r` stops at the first failure, the rest did not run in that attempt.
2. **r7b.** `packages/db` `audience-queries` "search uses the trigram index" failed once (it passed in r7). **Root cause (MEASURED):** after a bulk insert the trigram GIN index's pending list (26 pages) tripled the index cost estimate (72 → 213), because `ANALYZE` does not flush it and autovacuum does at an unpredictable time. With more pending pages the planner preferred a sequential scan. The test seed now runs `VACUUM contacts` (the steady state the test intends), and it passed 3 out of 3 times, then in r7c.

Product code did not change after the E2E runs; only those two test files changed.

## 3. Limitations recorded at this gate

| Item | Classification | Owner / action |
|---|---|---|
| Contact search right after a large import may use a sequential scan until autovacuum flushes the GIN pending list (the finding above; Audience-owned) | ACCEPTABLE PRE-PRODUCTION | Audience: decide `fastupdate = off` or `gin_clean_pending_list` after imports; measure at Gate E |
| Segments (an Audience feature) | FUTURE PRODUCT FEATURE | Audience roadmap |
| Per-recipient time-zone sending | FUTURE PRODUCT FEATURE | — |
| Accessibility of the new builder controls (conditional sections, HTML block, steps): axe covers the campaign page, but the v3-only controls appear only after a user adds them | Covered at Gate F | Gate F: axe scenarios with v3 blocks plus the manual screen-reader pass |
| Sender identities (§6 lists them under the builder) | Gate C (7.8 deliverability) | 7.8 |
| Jobs still run in-process; the durable queue is next (owner decision 2026-10-09: PostgreSQL queue) | Gate C (7.6) | 7.6 |

## 4. Not claimed

Production readiness. Engagement analytics (Gate C producers). Real delivery (Gate C).
