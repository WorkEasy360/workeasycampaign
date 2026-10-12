#!/usr/bin/env node
// Backup → restore drill (Gate G; docs/operations/backup-restore.md).
// Dumps a SOURCE database (custom format), restores it into a scratch database, and proves the restore is complete and
// still secure: same tables with the same row counts, RLS enabled+forced on the same tables, the same policies, the
// same function privileges, and the same applied migrations. The scratch database is always dropped afterwards.
// Never touches the source except to read it. Refuses a source that is not a *_test database unless --allow-source.
//
//   node --env-file=.env scripts/backup-restore-drill.mjs [--source workeasy_test] [--pg-bin <dir>] [--allow-source]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const SOURCE = opt('source', 'workeasy_test');
const SCRATCH = `${SOURCE}_restore_check`;
const PG_BIN = opt('pg-bin', process.env.PG_BIN ?? '');
const bin = (name) => (PG_BIN ? join(PG_BIN, process.platform === 'win32' ? `${name}.exe` : name) : name);
if (!SOURCE.endsWith('_test') && !args.includes('--allow-source')) throw new Error(`refusing source ${SOURCE}: pass --allow-source for a non-test database`);
if (!/^[a-z_][a-z0-9_]*$/.test(SOURCE)) throw new Error('bad database name');
const admin = process.env.DATABASE_ADMIN_URL;
if (!admin) throw new Error('DATABASE_ADMIN_URL is required (a role that can read every table and create databases)');
const urlFor = (db) => {
  const u = new URL(admin);
  u.pathname = `/${db}`;
  return u.toString();
};

async function query(db, sql) {
  const c = new pg.Client({ connectionString: urlFor(db) });
  await c.connect();
  try {
    return (await c.query(sql)).rows;
  } finally {
    await c.end();
  }
}

async function fingerprint(db) {
  const tables = await query(db, `SELECT n.nspname || '.' || c.relname AS t, c.relrowsecurity AND c.relforcerowsecurity AS rls
                                     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                                    WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('public', 'identity') ORDER BY 1`);
  const counts = {};
  for (const { t } of tables) {
    const [schema, name] = t.split('.');
    counts[t] = Number((await query(db, `SELECT count(*)::bigint AS n FROM "${schema}"."${name}"`))[0].n);
  }
  const policies = (await query(db, `SELECT schemaname || '.' || tablename || ':' || policyname AS p FROM pg_policies ORDER BY 1`)).map((r) => r.p);
  const fnPrivs = (await query(db, `SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')=' || coalesce(array_to_string(p.proacl, ','), 'default') AS f
                                      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('app', 'public', 'identity') ORDER BY 1`)).map((r) => r.f);
  const migrations = (await query(db, `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY 1`)).map((r) => r.migration_name);
  return { tables: tables.map((r) => `${r.t}:${r.rls ? 'rls' : 'NO-RLS'}`), counts, policies, fnPrivs, migrations };
}

const dir = mkdtempSync(join(tmpdir(), 'workeasy-drill-'));
const dump = join(dir, `${SOURCE}.dump`);
const report = { source: SOURCE, startedAt: new Date().toISOString() };
try {
  const t0 = Date.now();
  execFileSync(bin('pg_dump'), ['--format=custom', '--no-password', `--file=${dump}`, urlFor(SOURCE)], { stdio: 'pipe' });
  report.dumpMs = Date.now() - t0;
  report.dumpBytes = statSync(dump).size;
  await query('postgres', `DROP DATABASE IF EXISTS "${SCRATCH}" WITH (FORCE)`);
  await query('postgres', `CREATE DATABASE "${SCRATCH}" OWNER workeasy_owner TEMPLATE template0 ENCODING 'UTF8'`);
  const t1 = Date.now();
  // --exit-on-error: a partial restore must fail the drill, never pass silently.
  execFileSync(bin('pg_restore'), ['--exit-on-error', '--no-password', `--dbname=${urlFor(SCRATCH)}`, dump], { stdio: 'pipe' });
  report.restoreMs = Date.now() - t1;
  const [a, b] = [await fingerprint(SOURCE), await fingerprint(SCRATCH)];
  const diffs = [];
  for (const k of ['tables', 'policies', 'fnPrivs', 'migrations']) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) diffs.push(k);
  for (const t of Object.keys(a.counts)) if (a.counts[t] !== b.counts[t]) diffs.push(`rows:${t}`);
  report.tables = a.tables.length;
  report.rows = Object.values(a.counts).reduce((x, y) => x + y, 0);
  report.policies = a.policies.length;
  report.migrations = a.migrations.length;
  // Tenant data lives in public and must have RLS forced. The identity schema is isolated by schema privileges instead
  // (the runtime app role has no access to it; security-invariants.test.ts), so it is not counted here.
  report.unprotectedTables = a.tables.filter((t) => t.startsWith('public.') && t.endsWith('NO-RLS') && !t.includes('_prisma_migrations')).length;
  report.differences = diffs;
  report.result = diffs.length === 0 ? 'PASS' : 'FAIL';
} finally {
  await query('postgres', `DROP DATABASE IF EXISTS "${SCRATCH}" WITH (FORCE)`).catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 1));
if (report.result !== 'PASS') process.exit(1);
