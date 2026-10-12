# Backup, restore and disaster recovery — Workeasy Campaigns (Gate G)

**Status:**
- The restore procedure is TESTED locally by a drill (§4).
- Managed backups, point-in-time recovery and cross-region copies are a production-platform setting: NOT TESTED here.

## 1. What must be backed up

| Data | Where | Backup |
|---|---|---|
| Everything durable: tenants, contacts, consent history, campaigns, versions, executions, recipients, job queue, schedules, engagement, usage ledger, audit and security logs | PostgreSQL 16 (`workeasy`) | **required**: continuous WAL archiving + daily base backup (point-in-time recovery) |
| In-progress CSV imports | `FILE_STORE_DIR` | optional. Files are deleted when an import ends; a lost file only fails that import, which the user re-uploads |
| Rate-limit counters | Redis | none: short-lived windows, rebuilt by traffic |
| Secrets | secrets manager | per the platform. Losing `UNSUBSCRIBE_SECRET` breaks links in delivered emails; keep it and its previous values |

**Targets** (proposed; confirm with the business):
- RPO ≤ 5 minutes (WAL archiving);
- RTO ≤ 1 hour for a full restore;
- backups kept 30 days.

## 2. Backup

- **Managed PostgreSQL:** enable automated backups with point-in-time recovery and a retention of at least 30 days.
- **Self-managed PostgreSQL:** run `pg_basebackup` daily with `archive_mode=on`, `archive_command` shipping WAL to object storage, and encryption at rest.
- **Before each release:** take an on-demand snapshot (docs/operations/deployment.md §4).
- **Logical dumps** (`pg_dump --format=custom`) suit copies, investigation and the drill. They do not replace PITR.

## 3. Restore

1. Stop writers: scale the campaign workers and the API to zero (readiness drops; the web shows errors).
2. Restore into a NEW database or instance (PITR to just before the incident, or the latest backup). Never restore over the damaged one: keep it for investigation.
3. Run `pnpm db:bootstrap`, which re-asserts role attributes and privileges, then `pnpm db:migrate`: a no-op when the backup is current, otherwise it applies newer migrations.
4. Verify (the same checks as the drill):
   - row counts of key tables;
   - RLS enabled and forced on every table;
   - policies present;
   - no function executable by PUBLIC (`packages/db/test/security-invariants.test.ts` encodes these).
5. Point `DATABASE_URL` / `IDENTITY_DATABASE_URL` at the restored database and start the API and campaign workers.
6. Campaign work resumes from PostgreSQL by itself:
   - due schedules are picked up by the next scheduler tick;
   - interrupted runs are resumed by the recovery sweep from their checkpoints;
   - expired job leases are re-claimed.

   Recipients handed to the provider after the restore point are a known exposure. Their provider routes are lost, and a resumed run may send to them again. To avoid that, restore to a point after the last send, or cancel the affected runs.

## 4. Drill (MEASURED)

`node --env-file=.env scripts/backup-restore-drill.mjs --pg-bin <postgres bin>`. The script:
1. dumps a `*_test` database (custom format);
2. restores it into a scratch database with `--exit-on-error`;
3. compares the two: tables and their RLS state, row counts of every table, policies, function privileges and applied migrations;
4. always drops the scratch database.

Results: §4.1.

## 5. Incident response (summary)

1. **Detect:** an alert (docs/runbooks/campaigns.md §6) or a report.
2. **Contain:**
   - pause sending campaigns (API or UI); runs pause gracefully and resume later;
   - for a suspected credential leak, rotate the secret.
     - `SESSION_SECRET` signs everyone out.
     - Rotate `UNSUBSCRIBE_SECRET` by moving the old value to `UNSUBSCRIBE_SECRETS_PREVIOUS`.
     - Rotate the provider and webhook keys at the provider, then in configuration.
3. **Investigate:**
   - the audit log (`/v1/organizations/{id}/audit-logs`);
   - the security events;
   - access logs by `requestId`.

   None of these contain message content or addresses.
4. **Recover:** §3, or roll the code back (docs/operations/deployment.md §3). Migrations are additive, so older code runs on the newer schema.
5. **Review:** write a post-incident note, then add an alert or test for the gap.
