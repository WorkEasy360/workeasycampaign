/**
 * Catalog-level invariants. These fail when a future migration adds a table without RLS, grants a runtime role
 * too much, or weakens a definer function — before any feature test would notice.
 */
import { describe, expect, it } from 'vitest';
import { withOwnerConnection } from '../src/testing.js';

const APPEND_ONLY = ['audit_logs', 'domain_events', 'security_events', 'consent_events'];
const RUNTIME_ROLES = ['workeasy_app', 'workeasy_identity', 'workeasy_reporting'];

describe('database security invariants', () => {
  it('every public table has row-level security enabled and forced', async () => {
    const rows = await withOwnerConnection(async (c) =>
      (
        await c.query<{ relname: string }>(`
          SELECT relname FROM pg_class
          WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p')
            AND relname <> '_prisma_migrations' AND NOT (relrowsecurity AND relforcerowsecurity)`)
      ).rows,
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it('no application function is executable by PUBLIC (each grant is explicit, per role)', async () => {
    const rows = await withOwnerConnection(async (c) =>
      (
        await c.query<{ fn: string }>(`
          SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS fn
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname IN ('app', 'public', 'identity')
             AND has_function_privilege('public', p.oid, 'EXECUTE')
             AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`)
      ).rows,
    );
    expect(rows.map((r) => r.fn)).toEqual([]);
  });

  it('runtime roles are not superusers, cannot bypass RLS and cannot create roles or databases', async () => {
    const rows = await withOwnerConnection(async (c) =>
      (
        await c.query(`SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles
                       WHERE rolname = ANY($1)`, [RUNTIME_ROLES])
      ).rows,
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) expect([r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb]).toEqual([false, false, false, false]);
  });

  it('the schema owner is not a superuser', async () => {
    const r = await withOwnerConnection(async (c) => (await c.query(`SELECT rolsuper FROM pg_roles WHERE rolname = 'workeasy_owner'`)).rows[0]);
    expect(r.rolsuper).toBe(false);
  });

  it('append-only tables cannot be updated, deleted or truncated by any runtime role', async () => {
    const rows = await withOwnerConnection(async (c) =>
      (
        await c.query(`
          SELECT r.role, t.tbl, p.priv FROM unnest($1::text[]) r(role), unnest($2::text[]) t(tbl),
               unnest(ARRAY['UPDATE', 'DELETE', 'TRUNCATE']) p(priv)
          WHERE has_table_privilege(r.role, format('public.%I', t.tbl)::regclass, p.priv)`, [RUNTIME_ROLES, APPEND_ONLY])
      ).rows,
    );
    expect(rows).toEqual([]);
  });

  it('no runtime role can update an id or tenant-key column', async () => {
    const rows = await withOwnerConnection(async (c) =>
      (
        await c.query(`
          SELECT r.role, a.attrelid::regclass::text AS tbl, a.attname FROM pg_attribute a
          JOIN pg_class cl ON cl.oid = a.attrelid AND cl.relkind = 'r'
          JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname IN ('public', 'identity')
          CROSS JOIN unnest($1::text[]) r(role)
          WHERE a.attname IN ('id', 'org_id', 'workspace_id', 'user_id') AND a.attnum > 0 AND NOT a.attisdropped
            AND cl.relname <> '_prisma_migrations'
            AND has_column_privilege(r.role, a.attrelid, a.attname, 'UPDATE')`, [RUNTIME_ROLES])
      ).rows,
    );
    expect(rows).toEqual([]);
  });

  it('the app role has no access to the identity schema and the identity role none to public tables', async () => {
    const r = await withOwnerConnection(async (c) => (await c.query(`
      SELECT has_schema_privilege('workeasy_app', 'identity', 'USAGE') AS app_identity,
             has_schema_privilege('workeasy_reporting', 'identity', 'USAGE') AS rep_identity,
             (SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
                AND (has_table_privilege('workeasy_identity', c.oid, 'SELECT')
                  OR has_table_privilege('workeasy_identity', c.oid, 'INSERT'))) AS identity_public,
             has_table_privilege('workeasy_app', 'public._prisma_migrations', 'SELECT') AS app_migrations`)).rows[0]);
    expect(r).toEqual({ app_identity: false, rep_identity: false, identity_public: 0, app_migrations: false });
  });

  it('SECURITY DEFINER functions pin search_path and are not executable by PUBLIC', async () => {
    const rows = await withOwnerConnection(async (c) =>
      (
        await c.query(`
          SELECT p.proname, p.proconfig, has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
          FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace AND p.prosecdef`)
      ).rows,
    );
    expect(rows.length).toBeGreaterThanOrEqual(6);
    for (const r of rows) {
      expect(r.proconfig?.some((s: string) => s.startsWith('search_path='))).toBe(true);
      expect(r.public_exec).toBe(false);
    }
  });
});
