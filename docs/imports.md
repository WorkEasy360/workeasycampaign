# Contact imports (Phase 5)

CSV import that never loads a whole file into memory, shows exactly what will happen before anything changes,
and can resume after a failure.

| Part | Location |
|---|---|
| HTTP | `ImportsController` (`apps/api/src/modules/audience/http/audience.controllers.ts`), permission `contacts.import` |
| Lifecycle | `application/imports.service.ts` |
| Processing (dry run and run) | `application/import-processor.ts` |
| Row decision (pure) | `domain/import-decision.ts` |
| CSV parsing | `infrastructure/csv.ts` (csv-parse 6, streaming) |
| File storage | `apps/api/src/infrastructure/files/file-store.ts` (`LocalFileStore`; S3/MinIO later behind the same interface) |
| UI | `/imports` (upload, history), `/imports/{id}` (mapping, options, check, progress, problems) |

## 1. Lifecycle

```
upload ─▶ uploaded ──(mapping + dry run)──▶ validated ──start──▶ processing ──▶ completed
              ▲              │                    │                   │
              └── mapping changed (dry run discarded)                 ├──▶ failed ──retry──▶ processing
                                                                      └── stalled > 5 min ──retry──▶ processing
uploaded | validated | processing | failed ──cancel──▶ cancelled
```

- **Abandoned and stale imports expire.** An import still `uploaded`/`validated` 24 h after its last change, or `failed` for 7 days, is cancelled and its file deleted. This runs (scoped to the workspace) whenever imports are listed or a file is uploaded, so no scheduler is needed; each expiry is audited as `import.cancelled` with reason `abandoned` / `failed_expired`.
- **At most 10 unfinished imports per workspace** (`uploaded`, `validated`, `processing`, `failed`). The 11th upload is refused with `409 TOO_MANY_OPEN_IMPORTS` before any byte is stored. Together with the 20 MB file limit this bounds disk use to 200 MB per workspace.
- **One import runs at a time per workspace.** `start` and `retry` take a transaction-scoped advisory lock and refuse with `409 IMPORT_IN_PROGRESS` while another import is processing (works across API instances).
- **Start requires a dry run.** `start` refuses anything that is not `validated`, so nobody imports a file blind. Changing the mapping or options returns the import to `uploaded` and discards the dry-run result and issues.
- `start` accepts an `Idempotency-Key`; a replayed request returns the first response and does not start twice.
- The file is deleted when the import completes or is cancelled.

## 2. Upload and file safety

| Check | Behaviour |
|---|---|
| Content type | Body must be `text/csv` (raw stream, not multipart); anything else is 400. |
| Web proxy | The Next.js server buffers proxied bodies and truncates them at `experimental.proxyClientMaxBodySize` (set to 32 MB in `apps/web/next.config.ts`). **Invariant: keep it above `IMPORT_MAX_BYTES`**, so a truncated body is still over the API limit and is rejected (413), never imported partially (hardening H-3). |
| Size | Streamed to storage and counted; above `IMPORT_MAX_BYTES` (default 20 MB) the upload is aborted with 413 and the partial file removed. The request body is drained, not destroyed, so the connection stays healthy. |
| Rows | Counted while inspecting the stored file; above `IMPORT_MAX_ROWS` (default 100,000) the upload is refused with 413 `TOO_MANY_ROWS` and the file removed. |
| Encoding | Must be valid UTF-8 (a BOM is accepted and stripped); otherwise 400 `ENCODING_INVALID`. The UI asks for a UTF-8 export. |
| Structure | Header row required; at most 100 columns, 2,000 characters per cell, 1 MB per record. Empty files (`EMPTY_FILE`) and header-only files (`NO_ROWS`) are refused. The delimiter (`,` `;` tab `\|`) is detected from the header line. |
| File name | Display only. It is sanitized (path segments, control characters and reserved characters removed). Storage keys are server-generated: `imports/{workspaceId}/{importId}.csv`, validated against a strict pattern and checked to stay inside the storage root, so a name like `../../etc/passwd` cannot escape. |
| Formulas | Cell text such as `=HYPERLINK(…)` is stored as plain text and never evaluated. The downloadable problems report neutralizes cells starting with `= + - @` (tab, CR) against spreadsheet formula injection. |
| Storage location | `FILE_STORE_DIR` (required in production). Tests use the OS temp directory, outside the synced repository. |

## 3. Mapping and options

`PUT /imports/{id}/mapping` with `{ mapping: { "<column index>": target }, options, version }`.

- **Targets:** `email`, `phone`, `whatsapp`, `first_name`, `last_name`, `company`, `timezone`, `locale`, `cf:<custom field key>`, or `ignore`. Each target at most once. At least one of email, phone or WhatsApp is required.
- **Suggestions** come from common header names and custom-field labels (`suggestMapping`).
- **Options:**
  - `mode`: `create_or_update` (default), `create_only`, `update_only`.
  - `defaultCountry`: for national-format phone numbers. Without it a number lacking `+code` is a row error; we never guess a country.
  - `blankClears`: empty cells clear values on update. By default they are ignored.
  - `subscriptionType` for **new** contacts. Existing contacts' subscription type is never changed by an import.
  - `listIds`, `tagIds`, `topicIds` (≤ 20 each) applied to every imported contact.
  - `consent`: `{ channel, lawfulBasis, evidenceNote }`. Records consent with the import id and row number as evidence. Optional, and only when the user confirms they can prove it.
- **Options need their own permissions** (hardening M-3): `listIds` needs `lists.manage`, `tagIds` needs `tags.manage`, `topicIds` and `consent` need `consent.manage`, on top of `contacts.import`. Checked when the mapping is saved and again at `start`/`retry` (the starter's permissions count, not the saver's). Violations are `403` with the offending option in `fields`.

## 4. Duplicates (deterministic, never merged)

Each row's identities are normalized (`docs/audience.md` §3) and looked up. Exactly one outcome follows, in this order:

| Situation | Outcome | Code |
|---|---|---|
| No valid email, phone or WhatsApp | error | `NO_IDENTITY` |
| An earlier row in the file used one of these addresses (after normalization, so `A@x.com` = `a@x.com`) | skip | `DUPLICATE_IN_FILE` |
| The addresses belong to **different** existing contacts | error, **not merged** | `IDENTITY_CONFLICT` |
| Matches a soft-deleted contact | error | `CONTACT_DELETED` |
| Matches one existing contact | update (or skip `EXISTS` in create-only) | |
| Matches nobody | create (or skip `NOT_FOUND` in update-only) | |

Per-field problems (invalid email or phone, invalid custom-field value, unknown select option) are reported per
cell. Invalid cells are not written. A row whose only identity is invalid becomes `NO_IDENTITY`.

## 5. Dry run = run

The dry run and the real run go through the **same** parse → validate → `decideRow` code. The dry run only counts
and records issues (phase `dry_run`); the run writes (phase `run`). The API test asserts the run's created / updated /
skipped / error counts equal the dry run's for the same file. A difference is possible only if someone else changes
contacts between the check and the start; the run's own counts are then authoritative.

## 6. Processing, progress and recovery

- Rows are read as a stream and applied in **chunks of 250**. Each chunk is one transaction holding the contact changes, list/tag/topic/consent changes, domain events, issues and the advanced `processed_rows` checkpoint. A chunk is all-or-nothing.
- **Progress** is `processed_rows / total_rows`; the UI polls every 1.5 s while processing.
- **Transient failures retry automatically** (hardening M-6): a chunk that fails because its transaction expired (e.g. the process or machine was paused), the connection dropped, or PostgreSQL reported a serialization failure or deadlock is retried up to 3 times with backoff before the import is marked `failed`. Safe because each attempt locks the import row and re-reads its status and checkpoint: a cancelled import stops, and a chunk already committed is skipped. Completion is conditional on `status = processing`, so `import.completed` is emitted exactly once even if two runners race after a "stalled" retry.
- **Retry** resumes after the last committed chunk (rows before the checkpoint are skipped), so nothing is imported twice. Allowed for `failed`, or `processing` with no progress for 5 minutes (a crashed process).
- **Issues** are capped at 5,000 per phase so a broken file cannot flood the database; counts stay exact. Problems are paged in the UI and downloadable as CSV.
- **Events and audit:** `import.started`, `import.completed` and `import.failed` domain events and audit records (with file name, row count and SHA-256). `import.cancelled` is audited. Per-contact `contact.created` / `contact.updated` events carry the import id, so each contact's timeline shows the import.

## 7. Jobs: inline today, BullMQ-ready

`start` and `retry` dispatch `contacts.import` through `JobDispatcher`. Phase 5 ships `InlineJobDispatcher`, which runs
the job in the API process after the response; shutdown waits for running jobs. The envelope, built server-side, is
`{ tenant: { orgId, workspaceId }, actor: { userId, email, displayName }, correlationId, payload: { importId } }`, and the
handler runs under RLS for that tenant. It has the same outer shape as the worker's tenant-job envelope
(`apps/worker/src/jobs/tenant-job.ts`) but is **not identical**: the worker envelope carries `actor: { type, id }` and allows a
null `workspaceId`, while imports need a non-null workspace and the acting user's email and name (for audit and
notifications). Moving imports to the BullMQ worker therefore needs an envelope adaptation (worker actor + the import
loading the user details it needs), not only a dispatcher swap (issue P5-7; corrected in milestone 6.2).

**Not yet tested:** Redis/BullMQ execution. Imports have only run in-process.

**Deployment constraint:** the upload, dry run and run read the file from `FILE_STORE_DIR` on the API instance's disk. With more than one API instance, `FILE_STORE_DIR` must be a shared volume until the object-store `FileStore` (S3/MinIO) arrives; a single instance needs nothing extra. Run imports are tied to the instance that started them: if it stops, the import shows as stalled after 5 minutes and can be retried from its checkpoint.

## 8. Tests

- Domain: duplicate decisions per mode, never-merge conflicts, header suggestions, formula neutralization (`audience-domain.test.ts`).
- API (`apps/api/test/audience.test.ts`): exact dry run = run, resume from a checkpoint after a simulated failure, cancel, never-merge conflicts, oversize (413), invalid UTF-8, malformed CSV, empty and header-only files, wrong content type, a `../../etc/passwd.csv` file name, formula text in cells and in the problems report, cross-workspace access, viewer and editor denied.
- Web: mapping → check → start flow, identity-column requirement, retry after failure (`apps/web/src/app/(app)/imports/[importId]/import-detail.test.tsx`).
- E2E: upload, auto-mapping, dry-run counts with an in-file duplicate (case-insensitive) and an invalid row, import, update of an existing contact (`apps/e2e/tests/phase5.spec.ts`).
