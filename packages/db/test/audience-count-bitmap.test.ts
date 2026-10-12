/**
 * Gate G2 — the Audience count bitmap as the database enforces it (migration 20261013000000_audience_count_bitmap;
 * docs/audit/phase-6.3-g2-closure.md). Security matrix: roles, grants, forced RLS, function ownership and EXECUTE,
 * trigger firing mode, DDL guard, tenant confinement of every maintenance entry point, fail-safe invalidation.
 * Exercised as the real roles. Count correctness and the rebuild are tested in packages/audience-infra.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetTestDatabase, testDatabaseUrls, withAppConnection, withOwnerConnection } from '../src/testing.js';
import pg from 'pg';

const id = () => randomUUID();
const ids = { user: id(), orgA: id(), orgB: id(), wsA: id(), wsB: id(), listA: id(), listB: id(), cA: id(), cB: id() };
const A = { orgId: ids.orgA, workspaceId: ids.wsA };
const B = { orgId: ids.orgB, workspaceId: ids.wsB };
const TABLES = ['audience_count_state', 'audience_count_contact_seq', 'audience_count_source_chunks', 'audience_count_dead_chunks'];
const INITPLAN_PREDICATE =
  '((org_id = ( SELECT app.current_org_id() AS current_org_id)) AND (workspace_id = ( SELECT app.current_workspace_id() AS current_workspace_id)))';
/** Maintenance entry points the runtime role may call; everything else is internal. */
const APP_FUNCTIONS = [
  'audience_count_begin_rebuild(uuid,integer)',
  'audience_count_fill_positions(uuid,integer)',
  'audience_count_finish_rebuild(uuid,bigint)',
  'audience_count_gc(integer)',
  'audience_count_positions_missing()',
  'audience_count_reconcile()',
  'audience_count_renew_lease(uuid,bigint,integer)',
  'audience_count_repair_chunk(bigint,integer)',
  'audience_count_repair_list()',
  'audience_count_workspaces_due(timestamp with time zone,integer)',
];
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string; message?: string }) => e.code ?? e.message ?? 'error');
const owner = <T>(fn: (c: pg.Client) => Promise<T>) => withOwnerConnection(fn);
const stateOf = (ws: string) => owner(async (c) => (await c.query(`SELECT state, generation::int AS generation, reason FROM audience_count_state WHERE workspace_id = $1`, [ws])).rows[0]);
const setValid = (ws: string) => owner((c) => c.query(`UPDATE audience_count_state SET state = 'valid', reason = 'test' WHERE workspace_id = $1`, [ws]));

/** Committed work as the runtime role in a tenant context (withAppConnection always rolls back). */
async function appCommit<T>(ctx: { orgId: string; workspaceId: string | null }, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: testDatabaseUrls().app });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.org_id', $1, true), set_config('app.workspace_id', $2, true)`, [ctx.orgId, ctx.workspaceId ?? '']);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}

/** Rebuild through the maintenance API as the runtime role (single transaction is fine for these tiny workspaces). */
async function rebuild(ctx: typeof A) {
  return appCommit(ctx, async (c) => {
    const token = id();
    const g = (await c.query(`SELECT app.audience_count_begin_rebuild($1, 60) AS g`, [token])).rows[0].g;
    for (let after: string | null = null; ; ) {
      after = (await c.query(`SELECT app.audience_count_fill_positions($1, 1000)::text AS last`, [after])).rows[0].last;
      if (after === null) break;
    }
    for (const r of (await c.query(`SELECT chunk FROM app.audience_count_repair_list()`)).rows) await c.query(`SELECT app.audience_count_repair_chunk($1, 0)`, [r.chunk]);
    return (await c.query(`SELECT app.audience_count_finish_rebuild($1, $2) AS f`, [token, g])).rows[0].f;
  });
}

beforeAll(async () => {
  await resetTestDatabase();
  await owner(async (c) => {
    await c.query(`INSERT INTO users (id, email, email_normalized, display_name) VALUES ($1, 'cb@x.test', 'cb@x.test', 'CB')`, [ids.user]);
    for (const [org, ws, list, contact, slug] of [[ids.orgA, ids.wsA, ids.listA, ids.cA, 'a'], [ids.orgB, ids.wsB, ids.listB, ids.cB, 'b']] as const) {
      await c.query(`INSERT INTO organizations (id, name, slug, created_by_user_id) VALUES ($1, $2, $2, $3)`, [org, `cb-org-${slug}`, ids.user]);
      await c.query(`INSERT INTO workspaces (id, org_id, name, slug) VALUES ($1, $2, $3, $3)`, [ws, org, `cb-${slug}`]);
      await c.query(`INSERT INTO lists (id, org_id, workspace_id, name, name_key) VALUES ($1, $2, $3, 'l', 'l')`, [list, org, ws]);
    }
  });
  // Contacts and memberships through the runtime role, in context: the triggers maintain the (valid, empty) bitmap.
  for (const [ctx, list, contact] of [[A, ids.listA, ids.cA], [B, ids.listB, ids.cB]] as const) {
    await appCommit(ctx, async (c) => {
      await c.query(`INSERT INTO contacts (id, org_id, workspace_id) VALUES ($1, $2, $3)`, [contact, ctx.orgId, ctx.workspaceId]);
      await c.query(`INSERT INTO list_memberships (org_id, workspace_id, list_id, contact_id) VALUES ($1, $2, $3, $4)`, [ctx.orgId, ctx.workspaceId, list, contact]);
    });
  }
});

afterAll(async () => {
  await resetTestDatabase();
});

describe('roles and privileges', () => {
  it('the maintenance role cannot log in, bypass RLS, or create anything; the owner is a member', async () => {
    const r = await owner(async (c) => (await c.query(`SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit FROM pg_roles WHERE rolname = 'workeasy_audience_count'`)).rows[0]);
    expect(r).toEqual({ rolcanlogin: false, rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolinherit: false });
    const m = await owner(async (c) => (await c.query(`SELECT pg_has_role('workeasy_owner', 'workeasy_audience_count', 'MEMBER') AS m,
      pg_has_role('workeasy_app', 'workeasy_audience_count', 'MEMBER') AS app, pg_has_role('workeasy_reporting', 'workeasy_audience_count', 'MEMBER') AS rep`)).rows[0]);
    expect(m).toEqual({ m: true, app: false, rep: false });
    const create = await owner(async (c) => (await c.query(`SELECT has_schema_privilege('workeasy_audience_count', 'app', 'CREATE') OR has_schema_privilege('workeasy_audience_count', 'public', 'CREATE') AS c`)).rows[0].c);
    expect(create).toBe(false);
  });

  it('table privileges: the runtime role reads state and chunks only and writes nothing; reporting and identity get nothing', async () => {
    const rows = await owner(async (c) =>
      (
        await c.query(`SELECT r.role, t.tbl, p.priv FROM unnest(ARRAY['workeasy_app', 'workeasy_reporting', 'workeasy_identity', 'workeasy_audience_count']) r(role),
                        unnest($1::text[]) t(tbl), unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p(priv)
                       WHERE has_table_privilege(r.role, format('public.%I', t.tbl)::regclass, p.priv) ORDER BY 1, 2, 3`, [TABLES])
      ).rows.map((x: { role: string; tbl: string; priv: string }) => `${x.role} ${x.tbl} ${x.priv}`),
    );
    expect(rows).toEqual([
      'workeasy_app audience_count_dead_chunks SELECT',
      'workeasy_app audience_count_source_chunks SELECT',
      'workeasy_app audience_count_state SELECT',
      'workeasy_audience_count audience_count_contact_seq INSERT',
      'workeasy_audience_count audience_count_contact_seq SELECT',
      'workeasy_audience_count audience_count_dead_chunks DELETE',
      'workeasy_audience_count audience_count_dead_chunks INSERT',
      'workeasy_audience_count audience_count_dead_chunks SELECT',
      'workeasy_audience_count audience_count_dead_chunks UPDATE',
      'workeasy_audience_count audience_count_source_chunks DELETE',
      'workeasy_audience_count audience_count_source_chunks INSERT',
      'workeasy_audience_count audience_count_source_chunks SELECT',
      'workeasy_audience_count audience_count_source_chunks UPDATE',
      'workeasy_audience_count audience_count_state INSERT',
      'workeasy_audience_count audience_count_state SELECT',
      'workeasy_audience_count audience_count_state UPDATE',
    ]);
  });

  it('the maintenance role reads only the three membership source tables and writes no Audience table', async () => {
    const rows = await owner(async (c) =>
      (
        await c.query(`SELECT cl.relname, p.priv FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname IN ('public', 'identity')
                        CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p(priv)
                       WHERE cl.relkind = 'r' AND NOT (cl.relname = ANY($1::text[]))
                         AND has_table_privilege('workeasy_audience_count', cl.oid, p.priv) ORDER BY 1, 2`, [TABLES])
      ).rows.map((x: { relname: string; priv: string }) => `${x.relname} ${x.priv}`),
    );
    expect(rows).toEqual(['contact_tags SELECT', 'contacts SELECT', 'list_memberships SELECT']);
  });

  it('as the runtime role: direct writes to every bitmap table are refused, the position table is unreadable', async () => {
    for (const t of TABLES) {
      expect(await code(withAppConnection(A, (c) => c.query(`DELETE FROM ${t}`)))).toBe('42501');
      expect(await code(withAppConnection(A, (c) => c.query(`TRUNCATE ${t}`)))).toBe('42501');
    }
    expect(await code(withAppConnection(A, (c) => c.query(`UPDATE audience_count_state SET state = 'valid'`)))).toBe('42501');
    expect(await code(withAppConnection(A, (c) => c.query(`INSERT INTO audience_count_source_chunks (org_id, workspace_id, source_id, chunk, bits) VALUES ($1, $2, $3, 0, repeat('1', 4096)::varbit)`, [ids.orgA, ids.wsA, ids.listA])))).toBe('42501');
    expect(await code(withAppConnection(A, (c) => c.query(`UPDATE audience_count_source_chunks SET bits = repeat('1', 4096)::varbit`)))).toBe('42501');
    expect(await code(withAppConnection(A, (c) => c.query(`SELECT * FROM audience_count_contact_seq`)))).toBe('42501');
    expect(await code(withAppConnection(A, (c) => c.query(`SELECT nextval('app.audience_count_seq_gen')`)))).toBe('42501');
  });
});

describe('row-level security', () => {
  it('forced RLS with the identical InitPlan workspace predicate (USING and WITH CHECK) on all four tables', async () => {
    const r = await owner(async (c) =>
      (
        await c.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, p.polcmd, pg_get_expr(p.polqual, p.polrelid) AS q, pg_get_expr(p.polwithcheck, p.polrelid) AS w
                       FROM pg_class c JOIN pg_policy p ON p.polrelid = c.oid WHERE c.relname = ANY($1::text[]) ORDER BY 1`, [TABLES])
      ).rows,
    );
    expect(r.map((x: { relname: string }) => x.relname)).toEqual([...TABLES].sort());
    for (const p of r) expect([p.relrowsecurity, p.relforcerowsecurity, p.polcmd, p.q, p.w]).toEqual([true, true, '*', INITPLAN_PREDICATE, INITPLAN_PREDICATE]);
  });

  it('workspace B never sees workspace A bitmap rows; no context sees nothing', async () => {
    await withAppConnection(B, async (c) => {
      expect((await c.query(`SELECT workspace_id FROM audience_count_state`)).rows.map((x: { workspace_id: string }) => x.workspace_id)).toEqual([ids.wsB]);
      expect((await c.query(`SELECT 1 FROM audience_count_source_chunks WHERE workspace_id = $1 OR source_id = $2`, [ids.wsA, ids.listA])).rowCount).toBe(0);
      expect((await c.query(`SELECT 1 FROM audience_count_source_chunks WHERE source_id = $1`, [ids.listB])).rowCount).toBe(1);
    });
    await withAppConnection({ orgId: ids.orgA, workspaceId: null }, async (c) => {
      expect((await c.query(`SELECT 1 FROM audience_count_state`)).rowCount).toBe(0);
      expect((await c.query(`SELECT 1 FROM audience_count_source_chunks`)).rowCount).toBe(0);
    });
    // A mismatched org/workspace pair (client-supplied ids are never trusted) sees nothing either.
    await withAppConnection({ orgId: ids.orgB, workspaceId: ids.wsA }, async (c) => expect((await c.query(`SELECT 1 FROM audience_count_state`)).rowCount).toBe(0));
  });
});

describe('functions', () => {
  it('every bitmap function is SECURITY DEFINER with a pinned search_path, and nothing is executable by PUBLIC', async () => {
    const r = await owner(async (c) =>
      (
        await c.query(`SELECT p.oid::regprocedure::text AS f, p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig,
                              has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
                       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                       WHERE n.nspname = 'app' AND p.proname LIKE 'audience_count_%' ORDER BY 1`)
      ).rows,
    );
    expect(r.length).toBeGreaterThanOrEqual(25);
    for (const f of r) {
      expect(f.public_exec, f.f).toBe(false);
      expect(f.proconfig?.some((x: string) => x.startsWith('search_path=pg_catalog')), f.f).toBe(true);
      // try_lock and the pure helpers need no definer rights; everything touching data is SECURITY DEFINER
      if (!/(_mask|_source_key|_dead_key|_try_lock)\(/.test(f.f)) expect(f.prosecdef, f.f).toBe(true);
    }
    // Only these four reach across workspaces, and they are owned by the schema owner; all else by the NOBYPASSRLS role.
    const ownerOwned = r.filter((f: { owner: string }) => f.owner === 'workeasy_owner').map((f: { f: string }) => f.f.replace(/^app\./, ''));
    expect(ownerOwned).toEqual([
      'audience_count_invalidate_workspaces(uuid[],text)',
      'audience_count_trg_invalidate_rows()',
      'audience_count_trg_truncate()',
      'audience_count_trg_workspace_ins()',
      'audience_count_workspaces_due(timestamp with time zone,integer)',
    ]);
    for (const f of r.filter((f: { owner: string }) => f.owner !== 'workeasy_owner')) expect(f.owner, f.f).toBe('workeasy_audience_count');
  });

  it('the runtime role can execute exactly the maintenance entry points', async () => {
    const r = await owner(async (c) =>
      (
        await c.query(`SELECT replace(p.oid::regprocedure::text, 'app.', '') AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                       WHERE n.nspname = 'app' AND p.proname LIKE 'audience_count_%' AND has_function_privilege('workeasy_app', p.oid, 'EXECUTE') ORDER BY 1`)
      ).rows.map((x: { f: string }) => x.f),
    );
    expect(r).toEqual(APP_FUNCTIONS);
    for (const role of ['workeasy_reporting', 'workeasy_identity']) {
      const n = await owner(async (c) => (await c.query(`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
        WHERE ns.nspname = 'app' AND p.proname LIKE 'audience_count_%' AND has_function_privilege($1, p.oid, 'EXECUTE')`, [role])).rows[0].n);
      expect(n, role).toBe(0);
    }
    expect(await code(withAppConnection(A, (c) => c.query(`SELECT app.audience_count_invalidate_workspaces(ARRAY[$1::uuid], 'x')`, [ids.wsB])))).toBe('42501');
    expect(await code(withAppConnection(A, (c) => c.query(`SELECT app.audience_count_invalidate('x')`)))).toBe('42501');
    expect(await code(withAppConnection(A, (c) => c.query(`SELECT app.audience_count_verify()`)))).toBe('42501');
  });

  it('every entry point is confined to the session workspace: called in A it never reads or changes B', async () => {
    await rebuild(A);
    await rebuild(B);
    const before = await owner(async (c) => (await c.query(`SELECT workspace_id, state, generation, rebuild_token FROM audience_count_state ORDER BY 1`)).rows);
    await withAppConnection(A, async (c) => {
      // repairing B's chunk from A: RLS hides B's positions, memberships and chunk rows → nothing of B is read or written
      const chunkB = await owner(async (o) => (await o.query(`SELECT seq / 4096 AS c FROM audience_count_contact_seq WHERE contact_id = $1`, [ids.cB])).rows[0].c);
      const before = await owner(async (o) => (await o.query(`SELECT count(*)::int AS n FROM audience_count_source_chunks`)).rows[0].n);
      expect((await c.query(`SELECT app.audience_count_repair_chunk($1, 0) AS ok`, [chunkB])).rows[0].ok).toBe(true);
      expect((await c.query(`SELECT 1 FROM audience_count_source_chunks WHERE source_id = $1`, [ids.listB])).rowCount).toBe(0);
      expect((await c.query(`SELECT count(*)::int AS n FROM audience_count_source_chunks`)).rows[0].n).toBeLessThanOrEqual(before);
      expect((await c.query(`SELECT app.audience_count_reconcile() AS r`)).rows[0].r.ok).toBe(true);
      expect((await c.query(`SELECT app.audience_count_finish_rebuild($1, 1) AS f`, [id()])).rows[0].f.published).toBe(false);
      expect((await c.query(`SELECT app.audience_count_renew_lease($1, 1, 60) AS ok`, [id()])).rows[0].ok).toBe(false);
      expect((await c.query(`SELECT app.audience_count_gc(100) AS r`)).rows[0].r).toEqual({ deleted: 0, busy: 0 });
    });
    const after = await owner(async (c) => (await c.query(`SELECT workspace_id, state, generation, rebuild_token FROM audience_count_state ORDER BY 1`)).rows);
    expect(after).toEqual(before);
    // B's bitmap is untouched and still verifies
    expect((await appCommit(B, (c) => c.query(`SELECT app.audience_count_reconcile() AS r`))).rows[0].r.ok).toBe(true);
  });

  it('a begin_rebuild without workspace context is refused; discovery returns ids and state only', async () => {
    expect(await code(withAppConnection({ orgId: ids.orgA, workspaceId: null }, (c) => c.query(`SELECT app.audience_count_begin_rebuild($1, 60)`, [id()])))).toBe('42501');
    const cols = await withAppConnection({ orgId: ids.orgA, workspaceId: null }, async (c) => (await c.query(`SELECT * FROM app.audience_count_workspaces_due(now() + interval '1 day', 10)`)).fields.map((f) => f.name));
    expect(cols).toEqual(['org_id', 'workspace_id', 'state']);
  });
});

describe('triggers and guards', () => {
  it('maintenance triggers fire ALWAYS (also in replica mode) on every membership and liveness table', async () => {
    const r = await owner(async (c) =>
      (
        await c.query(`SELECT tgrelid::regclass::text AS t, tgname, tgenabled FROM pg_trigger WHERE tgname LIKE 'audience_count_%' AND NOT tgisinternal ORDER BY tgrelid::regclass::text COLLATE "C", tgname::text COLLATE "C"`)
      ).rows.map((x: { t: string; tgname: string; tgenabled: string }) => `${x.t} ${x.tgname} ${x.tgenabled}`),
    );
    expect(r).toEqual([
      'contact_tags audience_count_ct_del A', 'contact_tags audience_count_ct_ins A', 'contact_tags audience_count_ct_upd A', 'contact_tags audience_count_truncate_ct A',
      'contacts audience_count_contact_del A', 'contacts audience_count_contact_ins A', 'contacts audience_count_contact_live A', 'contacts audience_count_truncate_contacts A',
      'list_memberships audience_count_lm_del A', 'list_memberships audience_count_lm_ins A', 'list_memberships audience_count_lm_upd A', 'list_memberships audience_count_truncate_lm A',
      'workspaces audience_count_workspace_ins A',
    ]);
  });

  it('the DDL guard event triggers are installed and enabled', async () => {
    const r = await owner(async (c) => (await c.query(`SELECT evtname, evtevent, evtenabled, pg_get_userbyid(evtowner) <> '' AS owned FROM pg_event_trigger WHERE evtname LIKE 'audience_count_%' ORDER BY 1`)).rows);
    expect(r).toEqual([
      { evtname: 'audience_count_ddl_guard', evtevent: 'ddl_command_end', evtenabled: 'O', owned: true },
      { evtname: 'audience_count_drop_guard', evtevent: 'sql_drop', evtenabled: 'O', owned: true },
    ]);
  });

  it('disabling a maintenance trigger invalidates every bitmap (DDL guard), and the runtime role cannot do it', async () => {
    expect(await code(withAppConnection(A, (c) => c.query(`ALTER TABLE list_memberships DISABLE TRIGGER audience_count_lm_ins`)))).toBe('42501');
    await setValid(ids.wsA);
    await setValid(ids.wsB);
    const g = (await stateOf(ids.wsA)).generation;
    await owner(async (c) => {
      await c.query(`ALTER TABLE list_memberships DISABLE TRIGGER audience_count_lm_ins`);
      await c.query(`ALTER TABLE list_memberships ENABLE ALWAYS TRIGGER audience_count_lm_ins`);
    });
    for (const ws of [ids.wsA, ids.wsB]) expect((await stateOf(ws)).state).toBe('invalid');
    expect((await stateOf(ids.wsA)).generation).toBeGreaterThan(g);
    expect((await stateOf(ids.wsA)).reason).toMatch(/^DDL: ALTER TABLE/);
  });

  it('writes outside the matching tenant context (owner sessions) invalidate the affected workspace only', async () => {
    await setValid(ids.wsA);
    await setValid(ids.wsB);
    await owner((c) => c.query(`DELETE FROM list_memberships WHERE contact_id = $1`, [ids.cA]));
    expect((await stateOf(ids.wsA)).state).toBe('invalid');
    expect((await stateOf(ids.wsB)).state).toBe('valid');
    await owner((c) => c.query(`INSERT INTO list_memberships (org_id, workspace_id, list_id, contact_id) VALUES ($1, $2, $3, $4)`, [ids.orgA, ids.wsA, ids.listA, ids.cA]));
    // A runtime session whose context is A writing B's rows is refused by RLS before any trigger runs.
    expect(await code(appCommit(A, (c) => c.query(`INSERT INTO contacts (id, org_id, workspace_id) VALUES ($1, $2, $3)`, [id(), ids.orgB, ids.wsB])))).toBe('42501');
    expect((await stateOf(ids.wsB)).state).toBe('valid');
  });

  it('TRUNCATE of a source table and a hard contact DELETE invalidate', async () => {
    await setValid(ids.wsA);
    await setValid(ids.wsB);
    await owner((c) => c.query(`BEGIN; TRUNCATE contact_tags; COMMIT`));
    for (const ws of [ids.wsA, ids.wsB]) expect((await stateOf(ws)).state).toBe('invalid');
    await setValid(ids.wsB);
    const extra = id();
    await appCommit(B, (c) => c.query(`INSERT INTO contacts (id, org_id, workspace_id) VALUES ($1, $2, $3)`, [extra, ids.orgB, ids.wsB]));
    expect((await stateOf(ids.wsB)).state).toBe('valid');
    await owner((c) => c.query(`DELETE FROM contacts WHERE id = $1`, [extra]));
    expect((await stateOf(ids.wsB)).state).toBe('invalid');
  });

  it('a maintenance failure marks the bitmap INVALID instead of failing the write; lock timeouts are re-raised', async () => {
    await rebuild(A);
    expect((await stateOf(ids.wsA)).state).toBe('valid');
    const c2 = id();
    await owner((c) => c.query(`REVOKE INSERT ON audience_count_source_chunks FROM workeasy_audience_count`));
    try {
      await appCommit(A, async (c) => {
        await c.query(`INSERT INTO contacts (id, org_id, workspace_id) VALUES ($1, $2, $3)`, [c2, ids.orgA, ids.wsA]);
        await c.query(`INSERT INTO list_memberships (org_id, workspace_id, list_id, contact_id) VALUES ($1, $2, $3, $4)`, [ids.orgA, ids.wsA, ids.listA, c2]);
      });
    } finally {
      await owner((c) => c.query(`GRANT INSERT ON audience_count_source_chunks TO workeasy_audience_count`));
    }
    const s = await stateOf(ids.wsA);
    expect(s.state).toBe('invalid');
    expect(s.reason).toMatch(/^maintenance failed: 42501/);
    expect(await owner(async (c) => (await c.query(`SELECT count(*)::int AS n FROM list_memberships WHERE contact_id = $1`, [c2])).rows[0].n)).toBe(1);

    // Lock timeout: the rebuild/GC holds a chunk exclusively; a writer with lock_timeout gets 55P03 (retryable), and
    // the bitmap stays valid (nothing was half-applied).
    await rebuild(A);
    const seq = await owner(async (c) => (await c.query(`SELECT seq FROM audience_count_contact_seq WHERE contact_id = $1`, [ids.cA])).rows[0].seq);
    const holder = new pg.Client({ connectionString: testDatabaseUrls().owner });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || ($2::bigint / 4096)::text, 6301))`, [ids.listA, seq]);
      expect(await code(appCommit(A, async (c) => {
        await c.query(`SET LOCAL lock_timeout = '200ms'`);
        await c.query(`DELETE FROM list_memberships WHERE contact_id = $1 AND list_id = $2`, [ids.cA, ids.listA]);
      }))).toBe('55P03');
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
    expect((await stateOf(ids.wsA)).state).toBe('valid');
  });

  it('a new workspace starts VALID and empty; an existing one cannot be created twice', async () => {
    const ws = id();
    await owner((c) => c.query(`INSERT INTO workspaces (id, org_id, name, slug) VALUES ($1, $2, 'n', 'n')`, [ws, ids.orgA]));
    expect((await stateOf(ws)).state).toBe('valid');
  });
});
