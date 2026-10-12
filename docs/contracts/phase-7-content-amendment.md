# Phase 7 content amendment — templates, dynamic content, personalization

**Status:** ACTIVE (sections are added as their milestones pass) · **Base:** `phase-6-content-amendment.md` (frozen;
decisions C1–C10 stay in force) · **Rule:** every change is additive and versioned; nothing stored earlier changes
meaning.

## §C `email.content.v3` — dynamic content, personalization v2, HTML block (milestone 7.2)

v1 and v2 stay valid and are read as stored. v3 is a new schema id, accepted wherever content is written (drafts,
templates, versions) and rendered by the same pure renderer.

| # | Decision |
|---|---|
| C11 | **v3 = the v2 block set + two block types.** `html` (sanitized HTML, below) and `conditional` (`when`, `then`, `else`). A conditional holds leaf blocks only (no nesting); at most 20 blocks per branch; at most 100 blocks in the whole body, counting branches. |
| C12 | **Conditions are data, not code.** `when = { match: all \| any, rules: 1–5 }`; a rule = `{ field, op, value? }` with `op` ∈ `is_set`, `is_not_set`, `equals`, `not_equals`, `contains`, `not_contains`. `value` is required (1–100 characters) exactly for the four comparison ops. Evaluation is deterministic and pure: values are the recipient's personalization values (no database access from content); comparisons are trimmed and case-insensitive; a missing value is "not set" and equals nothing. |
| C13 | **`merge_tags_v2`.** The names are `contact.first_name`, `contact.last_name`, `contact.company`, `contact.email`, `contact.custom.<key>` (`<key>` in the Audience custom-field key format), `workspace.name` and `organization.name`. The syntax and fallback rules of v1 are unchanged, and merge fields are still never allowed in URLs or attributes (C5). Content validation checks the syntax only. Whether `<key>` exists in the workspace is a readiness check through an Audience port: an unknown key is an error, an archived one a warning. |
| C14 | **Custom-field values** come from Audience through an additive `AudienceProfiles` method (`mergeDataV2`), formatted as text by Audience: booleans `Yes`/`No`; dates ISO `YYYY-MM-DD`; multi-select labels joined with `, `; at most 1,000 characters. Campaigns never read Audience tables. |
| C15 | **HTML block.** Up to 50,000 characters, parsed with a standards-compliant HTML parser (parse5) and rebuilt from an allowlist. Elements: text formatting, links, lists, headings h1–h4, tables, images, `div`/`span`, `blockquote`, `hr`, `pre`/`code`. Scripting, embedding, forms, SVG/MathML, `style`/`link`/`meta` and comments are removed with their content. Attributes are per-element allowlists: `href` must pass the link allowlist, `src` the https image allowlist; numeric sizes are bounded; `style` keeps only allowlisted properties with plain values (no `url(`, `expression(`, escapes or comments). Merge fields are interpreted only in text nodes. |
| C16 | **Nothing is removed silently.** Content whose HTML the sanitizer would remove anything from (an element, attribute, style property or comment) has the blocking issue `HTML_UNSUPPORTED`, listing what. The builder offers "Clean HTML", which applies the same pure function. Content without that issue is stored in the sanitizer's normalized serialization (lower-case tags, quoted attributes, escaped text). That form is a fixed point (sanitizing it again changes nothing, which is tested), and the renderer sanitizes again as defence in depth. |
| C17 | **Versions.** `campaign.version.v3` = v2 fields with personalization `merge_tags_v2` iff the content is v3. The v1/v2 snapshot readers are unchanged. The database CHECKs on versions and templates are widened by a new migration. |

**Evidence for §C (MEASURED):**
- `packages/content`: 120 tests. They include a 40-vector XSS corpus: every output is free of executable vectors, and each one is checked to be a fixed point (re-sanitizing changes nothing and removes nothing). They also cover merge_tags_v2, conditions, v3 rendering in every escaping context, re-sanitizing at render time, and validation/canonical form. The v2 tests are unchanged.
- API `campaigns-content-v3.test.ts`, 9 tests: findings with pointers; shape refusals (400); preview with a contact (formatted custom fields, branch per contact, escaped tenant names); the example profile; tenancy; an unknown field blocks schedule and an archived one is a warning; `campaign.version.v3` plus the event; v2 still versioned as v2; templates with v3 content.
- The existing API suites still pass with these changes (276 tests: content v2, templates, lifecycle, preflight, domain, routes).
- Web `message-editor-v3.test.tsx`, 9 tests: the lossless upgrade; HTML report plus Clean HTML; conditional rules and branches (no nesting); custom-field insertion; the permission-gated field list; the live preview branch; nested readiness pointers; saved blocks.

## §S Reusable saved blocks (milestone 7.2)

| # | Decision |
|---|---|
| S1 | A saved block ("snippet") is a workspace-owned, named list of 1–20 `email.content.v3` blocks (conditional sections included), stored as `{ schema: "email.snippet.v1", blocks }`. It is validated with the v3 content rules on write (422, one field error per problem, keyed `blocks/…`) and on read, and stored canonical. |
| S2 | **Copy semantics, as for templates.** Inserting copies the blocks with fresh ids unique in the target message. The message keeps no link, and later changes to the saved block never reach it. The insert is an ordinary draft change (all draft rules, readiness and permissions apply). A v2 message is upgraded to v3 when the inserted blocks need it. |
| S3 | Same tenancy and lifecycle as templates: forced RLS on org and workspace, soft delete only (no DELETE grant), live names unique case-insensitively, optimistic `expectedVersion`, signed keyset cursors scoped to the search. Reading needs `templates.read`; changing needs `templates.manage` (template write limit). Audit: `snippet.created` / `snippet.updated` / `snippet.deleted`. |

**Evidence (MEASURED):** API `snippets.test.ts`, 4 tests: CRUD and audit; v3 validation (unsafe HTML and bad links are 422 with pointers; shapes are 400); uniqueness, search and scoped cursors; permissions, cross-organization 404, RLS hiding and refusals. Web: insert with fresh ids plus the v3 upgrade; save-as with the permission gate.

## §B Builder: test send (milestone 7.3)

| # | Decision |
|---|---|
| B1 | `POST /campaigns/{id}/test-send { contactId? }` renders the CURRENT draft like the preview (the example profile, or one contact with `contacts.read`) and sends it with the subject prefixed `[Test]`. |
| B2 | **The only recipient is the requesting user's own verified address**, read from the identity record. The body is strict, so no address can be supplied and the endpoint is not a relay. The platform refuses unverified users before campaign code runs, and the service re-checks. |
| B3 | It goes through the delivery port's `sendTest` (a separate method, because a test send carries rendered content and is not a recipient delivery). There is no recipient row, execution, consent or suppression semantics. It is refused with `DELIVERY_NOT_AVAILABLE` while delivery is disabled, with 422 and per-pointer fields while the message has content errors, and with 503 `TEST_SEND_FAILED` plus `Retry-After` when the provider refuses. |
| B4 | It needs `campaigns.update` and is limited to 20 per user per hour. It is audited as `campaign.test_sent` with `{ sample }` (and a failure `code`); the metadata holds no address and no content. The campaign is unchanged (no version bump, no event). |

Mobile and desktop preview widths, template selection and the HTML mode (§C) complete the builder. Sender identities
are milestone 7.8 (deliverability).

**Evidence (MEASURED):** API `campaigns-test-send.test.ts`, 6 tests: own address only; a strict body refuses `to`; personalization by contact; content errors with pointers; foreign contact 404; viewer 403; other organization 404; unverified 403; provider failure 503 with Retry-After and the campaign unchanged; rate limit 429; disabled delivery 422. Web: the send dialog shows the destination, success and refusal messages; the permission gate.

## §T Template history, restore and categories (milestone 7.1)

| # | Decision |
|---|---|
| T8 | **History is immutable and complete from 7.1 on.** Every create, update and restore inserts one `email_template_versions` row holding the template's state *after* the change (name, description, category, content), keyed by the template's optimistic-lock `version`, in the same transaction as the change. The runtime role has SELECT and INSERT only; an UPDATE by anyone is rejected by trigger. |
| T9 | **Templates that existed before 7.1** get one `imported` row with their state at migration time (backfill in the migration; verified on a throwaway database). |
| T10 | **Restore never rewrites history.** `POST /templates/{id}/restore { version, expectedVersion }` copies that version's description, category and content into a NEW version (`change = restored`, `restoredFromVersion`). The name is kept, because names are unique among live templates and an old name could collide. Restoring a state equal to the current one changes nothing (no version, no row, no audit). Stale `expectedVersion` → `409 version_conflict`. |
| T11 | **Deleted templates.** A deleted template's history and restore answer 404, like the template itself. Its history rows are kept (no DELETE grant). Deletion bumps the optimistic-lock version without a history row, because a deleted template is not reachable. |
| T12 | **Clone independence.** A clone (`fromTemplateId`) is a new template whose history starts at version 1 (`created`). The category is not copied. Later edits of either template never reach the other. |
| T13 | **Categories.** Optional free text, 1–60 characters after trimming; `null` clears it. List filter `?category=` is a case-insensitive exact match, and the filter is part of the signed cursor's scope. `GET /template-categories` returns the distinct categories of live templates (case-insensitively distinct, most recent spelling, sorted). |
| T14 | **Permissions and audit.** History and categories need `templates.read`; restore needs `templates.manage` (and is rate-limited with the other template writes). Audit: `template.restored` with `{ fromVersion, version }`; `template.updated` now also records the new `version`. |

**API (additive):** `GET /templates/{id}/versions` (keyset, newest first; signed cursor scoped to the template),
`GET /templates/{id}/versions/{version}` (a malformed or unknown version is a 404), `POST /templates/{id}/restore`,
`GET /template-categories`; `category` on create/update/list/view.

**Evidence (MEASURED):**
- API `templates-history.test.ts`, 9 tests: history ordering and actors; restore semantics and no-op; optimistic lock; malformed versions; a concurrent restore and update (exactly one wins, no duplicate version); signed scoped cursor; deleted-template protection; clone independence; categories; permissions; HTTP 404 across organizations; RLS hiding and refusing cross-tenant inserts; no UPDATE/DELETE grants; the insert-only trigger.
- Existing `templates.test.ts` still passes, with the additive `category` field.
- Web `templates.test.tsx` 12/12: history, confirmed restore, the conflict message, reader view, category save and filter.
