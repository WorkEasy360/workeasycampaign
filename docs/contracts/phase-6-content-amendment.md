# Campaign content amendment — `email.content.v2`, merge tags, rendering, templates, preview

**Status:** IMPLEMENTED (2026-10-08; evidence §8) · **Amends:**
`docs/contracts/phase-6-campaign.md` §4.1 (snapshot), §9.1 (rendering layer). It pulls the *rendering* part of Phase 7 and
the *template* part of Phase 8 forward. Delivery stays TEST MODE ONLY. Nothing is sent to a real provider.

Compatibility follows §4.1 exactly:
- stored snapshots are never rewritten;
- every shape change gets a new schema id;
- old ids stay readable forever through upcasters;
- `email.content.v1` and `campaign.version.v1` are unchanged.

---

## 1. Decisions

| # | Decision | Why |
|---|---|---|
| C1 | **Structured content only. No raw-HTML input anywhere.** HTML is produced only by the renderer, from typed blocks, with every text escaped | Sanitizing arbitrary HTML is the largest source of email XSS and rendering bugs. Generating HTML from data removes that class of problem instead of filtering it |
| C2 | New `email.content.v2` (blocks). v1 (plain text) stays valid for drafts and versions | Contract §4.1: no optional additions within v1 |
| C3 | New `campaign.version.v2`. Same shape as v1 except `messages[].content` is `EmailContentV1 \| EmailContentV2` and `personalization.mode` is `'none' \| 'merge_tags_v1'`. Mode is derived: `merge_tags_v1` exactly when the content is v2 | One mode per content version; no ambiguity in how text is interpreted |
| C4 | New versions are written as `campaign.version.v2`. Stored v1 versions are returned **as stored** (the wire view is a union) and upcast only inside the domain | Existing API responses for existing versions do not change |
| C5 | Merge tags `{{ contact.first_name }}` and `{{ contact.first_name \| "there" }}`, from a closed allowlist, in text positions only (subject, preheader, text runs, button labels). **Never inside URLs** | URL personalization enables open-redirect and injection. Closed allowlist means no data leaks through template access |
| C6 | Rendering is a **pure, browser-safe package** `@workeasy/content`: no I/O, no Node APIs. The web preview and the API use the same function | A single source of truth for what recipients get; the preview cannot drift from the send |
| C7 | The compliance footer (unsubscribe link and reason for receiving) is always appended by the renderer and cannot be removed by content | `compliance.unsubscribeLink: 'required'` is enforced by construction |
| C8 | Templates are workspace-owned rows (`email_templates`, forced RLS) holding `email.content.v2`, validated on write and read, optimistic-locked by `version`. Applying a template copies its content into the draft; the campaign keeps no live link | A later template edit never changes a scheduled or sent campaign (versions are immutable anyway) |
| C9 | Preview with a real contact goes through a new **Audience port** (`AudienceProfiles.mergeData`), never through contact tables directly (RULE 2) | Audience owns contact data and erasure semantics |

## 2. `email.content.v2`

```ts
interface EmailContentV2 {
  schema: 'email.content.v2';
  subject: string;        // 1–200 chars, merge tags allowed
  preheader: string;      // 0–200 chars, merge tags allowed
  body: { format: 'blocks'; blocks: Block[] };   // 1–100 blocks
}
type Run = { text: string; bold?: true; italic?: true; href?: Url };   // 1–2,000 chars per run
type Block =
  | { id: Id; type: 'heading';   level: 1 | 2 | 3; runs: Run[] }                    // 1–50 runs
  | { id: Id; type: 'paragraph'; runs: Run[]; align?: 'left' | 'center' }          // 1–200 runs
  | { id: Id; type: 'button';    label: string; href: Url; align?: 'left' | 'center' }   // label 1–80
  | { id: Id; type: 'image';     src: HttpsUrl; alt: string; width?: number; href?: Url } // alt 1–250; width 16–600
  | { id: Id; type: 'divider' }
  | { id: Id; type: 'spacer';    height: 8 | 16 | 24 | 32 | 48 | 64 };
type Id = string;          // /^[a-z0-9]{1,16}$/, unique within the message (editor keys, finding pointers)
type Url = string;         // ≤ 2,000 chars; https:, http: or mailto:; no whitespace or control characters
type HttpsUrl = string;    // ≤ 2,000 chars; https: only (mixed content and tracking pixels over http are refused)
```

**Total text** across subject, preheader, runs and labels: at most 100,000 characters (the same bound as v1's body).

**Schema vs readiness:**
- The **schema** enforces shape and bounds. Strict objects: unknown keys are rejected.
- **Readiness** (`ChannelSpec.validateContent`) reports user-fixable problems as findings with JSON pointers:
  - `SUBJECT_MISSING`;
  - `BODY_MISSING` (no block with visible text and no button);
  - `MERGE_TAG_INVALID` (unknown name, or malformed `{{`);
  - `LINK_INVALID`;
  - `IMAGE_ALT_MISSING`.

  Each finding points at e.g. `/messages/0/content/body/blocks/3/runs/0/text`.

## 3. Merge tags (`merge_tags_v1`)

**Grammar:**
- `{{` ws* NAME ws* ( `|` ws* `"` FALLBACK `"` ws* )? `}}`
- NAME is one of the allowlist below.
- FALLBACK is ≤ 100 characters, contains no `"` and no `}`.
- Any other use of `{{` is `MERGE_TAG_INVALID`; there is no escape syntax in v1.

| Name | Source (Audience port) |
|---|---|
| `contact.first_name` | contact first name |
| `contact.last_name` | contact last name |
| `contact.company` | company |
| `contact.email` | primary email identity |

**Rendering a tag:** use the value if non-empty, else the fallback, else the empty string. Values are inserted as text, so the HTML output escapes them. They are never interpreted as markup or as further tags (single pass).

## 4. Rendering (`@workeasy/content`)

```ts
renderEmail(content: EmailContentV1 | EmailContentV2, data: MergeData, ctx: { unsubscribeUrl: string; reason: string })
  → { subject: string; preheader: string; html: string; text: string; usedTags: MergeTagName[] }
```

- **HTML:** a fixed, table-based, inline-styled 600 px layout. It contains no `<script>`, `<style>` with user input, event-handler attributes or `<form>`.
  - Every text node is escaped (`& < > " '`).
  - Every attribute value is escaped, and every URL is re-validated against the allowlist at render time; an invalid URL is dropped and its text kept (defence in depth behind the schema).
- **Text:** the plain-text alternative. Links become `label (url)`.
- **v1 content** renders as escaped paragraphs split on blank lines, with no tag interpretation (`personalization.mode = 'none'`).
- **Footer:** C7. In preview, the unsubscribe URL is a placeholder (`#unsubscribe-preview`). Real links are Phase 8 (delivery).

## 5. Preview

`POST /v1/workspaces/{ws}/campaigns/{id}/preview` with body `{ contactId?: uuid }`, permission `campaigns.read`. It returns:

```ts
{ subject, preheader, html, text, sample: 'example' | 'contact', missingTags: MergeTagName[] }
```

- Without `contactId`, a fixed example profile is used ("Alex Example", "Example Co", `alex@example.com`).
- With `contactId`, the API calls `AudienceProfiles.mergeData(scope, contactId)`:
  - it is RLS-scoped to the workspace;
  - it returns `null` for a missing, deleted or erased contact → `404 contact_not_found`;
  - only allowlisted fields are returned.
- `missingTags` lists the tags the contact has no value for, so the user sees where a fallback applies.
- The draft is rendered as it is now, readiness errors included; preview never requires a ready draft.
- No contact data is logged, audited, or written into events.
- The web app renders the HTML in a sandboxed `<iframe sandbox srcdoc>` (no scripts, no same-origin).

## 6. Templates

**Table `email_templates`** (new migration; RLS forced; workspace-scoped like `lists`):

| Column | Type / rule |
|---|---|
| `id` | uuid v7 |
| `org_id`, `workspace_id` | FK to the workspace; RLS scope |
| `name` | 1–120 chars; unique among live templates of the workspace (case-insensitive) |
| `description` | 0–500 chars |
| `content` | JSONB holding `email.content.v2`; validated on write and read |
| `version` | int, starts at 1, +1 per update (optimistic locking) |
| `created_by_user_id`, `created_at`, `updated_at`, `deleted_at` | soft delete |

**API** (`templates.read` / `templates.manage`). JSON is strict; errors follow the existing envelope.

| Row | Route | Notes |
|---|---|---|
| T1 | `GET /templates?q&limit&cursor` | keyset by (updated_at desc, id); no content in the list |
| T2 | `POST /templates` `{ name, description?, content }` | 201; `409 name_taken` |
| T3 | `GET /templates/{id}` | with content |
| T4 | `PATCH /templates/{id}` `{ expectedVersion, name?, description?, content? }` | `409 version_conflict` |
| T5 | `DELETE /templates/{id}` | soft delete; 204 |
| T6 | `POST /campaigns/{id}/apply-template` `{ templateId, expectedVersion }` | draft only (`422 CAMPAIGN_NOT_EDITABLE` otherwise — the same answer as any draft edit); needs `campaigns.update` **and** `templates.read`; replaces `messages[0].content` with the template's content; the change set is recorded like a PATCH |
| T7 | `POST /templates` with `{ fromCampaignId }` in place of `content` | "Save as template" from a v2 draft (`422` when the draft is v1) |

**Audit:** `template.created`, `template.updated`, `template.deleted`. **Events:** none in this amendment (no consumer exists; recorded as a gap).

## 7. Out of scope (recorded gaps)

- HTML import or paste-as-HTML.
- Custom-field merge tags.
- Conditional blocks.
- Image upload (assets, Phase 8; images are referenced by https URL).
- Template folders and sharing.
- Brand kit.
- Dark-mode variants.
- Per-provider rendering quirks testing (Litmus-style).
- Link tracking (Phase 9; rendering exposes no tracking hooks).

## 8. Implementation and evidence (2026-10-08)

| Part | Where | Tests (MEASURED, 2026-10-08) |
|---|---|---|
| Schemas: `email.content.v2` (complete + draft levels), `campaign.version.v2`, merge-tag allowlist, readiness codes (+4, additive) | `packages/shared/src/content.ts`, `campaigns.ts`, `api/templates.ts` | `content.test.ts` 22/22 |
| Renderer, merge-tag parser, content issues, canonical form, editor inline markup | `packages/content` (new; pure, browser-safe; dependency rules `content-is-pure`, `content-no-builtins`) | 49/49, incl. an XSS set; **mutation check:** with escaping disabled, 10 tests fail |
| Versions: v2 written, v1 read as stored (wire) and upcast (domain); hash unchanged for stored v1 | `apps/api/.../domain/version.ts`; migration `20261017000000_campaign_version_v2` (CHECK widened) | domain 161/161; API `campaigns-content.test.ts` 19/19 |
| Preview (§5) through Audience Profiles v1 (Audience contract §9.11) | `preview.service.ts`; `POST …/preview` | API 19/19 (above) |
| Templates (§6) | migration `20261018000000_email_templates` (forced RLS, no DELETE grant); `templates.service.ts`, `templates.controller.ts` | API `templates.test.ts` 14/14 (CRUD, strictness, 422 field errors, RLS at the DB, apply/save-as) |
| Row 23 (recipient list) — enabled by the same port | `recipients.service.ts`; `GET …/executions/{id}/recipients` | API `campaigns-recipients.test.ts` 4/4 |
| Web: block editor, live sandboxed preview, templates screens, template/preview actions, recipients card | `apps/web/src/components/campaigns/message-editor.tsx`, `content-actions.tsx`, `recipients-card.tsx`, `app/(app)/templates/**` | web 78/78 |
| End to end + accessibility | `apps/e2e/tests/phase6-content.spec.ts` | 7/7; axe on the editor, preview, templates list/editor, preview-as-contact, finished run; **plus an axe scan of the rendered email HTML itself** |

**UI default (decision C10, 2026-10-08):** in the web app, a campaign that has no message yet starts as a designed email (v2). Plain-text (v1) messages stay fully supported, both in the editor and on the API: the server stores whichever schema the client sends. A plain-text message can be switched to a designed one; that switch is one way.

**Corrections made while implementing** (the design text above is updated where it was wrong):
- T6 on a non-draft is `422 CAMPAIGN_NOT_EDITABLE`, the same answer as any draft edit, not 409.
- Template content is accepted at the draft level. A structural violation is a 400; incomplete or unsafe values are a `422` with one field error per problem, keyed `content/<pointer>`.
- Italic in the editor markup is `__…__`, never `*`. The round-trip test showed that adjacent `**`/`*` spans are ambiguous.

**Defects found and fixed along the way:**
- A latent 500 on forged pagination cursors in every keyset list (`test/pagination-cursor.test.ts`).
- The field-insert select's accessible name absorbed its option texts.
- The recipients list stayed empty after a run finished, because the query key did not follow execution progress (regression test with a mutation check).

### 8.1 Security review and full regression (2026-10-08)

**Read-only security and privacy review of all new code.** No critical or high finding. One medium finding and four lows, all fixed with tests:

| Finding | Fix | Evidence |
|---|---|---|
| **M1** An unspaced merge field inside a URL (`https://x.com/?e={{contact.email}}`) was accepted. The WHATWG parser allows raw braces, which broke C5 | URLs with raw `{` or `}` are invalid (RFC 3986 requires `%7B`/`%7D`); readiness says "Links cannot contain merge fields" | 3 new URL cases failed before the fix and pass after; plus a content-issue test |
| L1 A lone `from` widened the analytics period beyond 366 days | The span is checked after defaults | `campaigns-analytics.test.ts` |
| L2 `sum()::int` could overflow into a 500 | Sums are bigint, converted with `Number()` | review |
| L3 `width` and heading level reached the markup without coercion if the schema was bypassed | Coerced in the renderer (defence in depth) | hostile-input renderer test |
| L4 The apply-template audit was written in a separate transaction, and also on a no-op | Written in the same unit of work, and only on a real change | `templates.test.ts` (second identical apply: no new version, one audit row) |
| L5 Template id unencoded in a client path | `encodeURIComponent` | review |

**Full regression r3 (MEASURED, quiet host, keep-awake):**

| Step | Result |
|---|---|
| Boundaries | 359 modules, 0 violations |
| Typecheck | pass |
| Build | pass |
| Packages | all pass |
| Web | 79/79 |
| API | 532 passed, 7 opt-in benches skipped |
| Worker | 9/9 |
| E2E, two consecutive full runs | **53/53** (2.3 min), then **53/53** (2.7 min) |

Runs r1 and r2 are void, for these reasons:
- r1: one shared test expected the old count of 24 readiness codes, and one Phase 6 E2E step still used the old plain-text editor.
- r2: one web test timed out under CPU contention that I caused by running other tests in parallel. With the machine quiet the heaviest test takes 1.4 s against a 5 s limit, and the web suite then passed 3 times in a row. r2's E2E runs also had two locators that matched more than one element; the fix was to give titled cards accessible names.
