/**
 * Gate G2 — the Audience snapshot tables as the database enforces them (docs/contracts/phase-5-audience.md §9.6;
 * decisions A, G, H, I, J). Exercised as the real roles: the schema owner for setup, workeasy_app (RLS, grants) for
 * everything the runtime can do. Behaviour of the adapter is tested in packages/audience-infra.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetTestDatabase, withAppConnection, withOwnerConnection } from '../src/testing.js';

const id = () => randomUUID();
const ids = { user: id(), orgA: id(), orgB: id(), wsA: id(), wsB: id(), snapA: id(), snapB: id(), contactA: id(), contactB: id() };
const HASH = 'a'.repeat(64);
const A = { orgId: ids.orgA, workspaceId: ids.wsA };
const B = { orgId: ids.orgB, workspaceId: ids.wsB };
/** The workspace predicate as uncorrelated sub-selects (InitPlan: evaluated once per statement; the same rows). */
const INITPLAN_PREDICATE =
  '((org_id = ( SELECT app.current_org_id() AS current_org_id)) AND (workspace_id = ( SELECT app.current_workspace_id() AS current_workspace_id)))';
const SNAPSHOT_TABLES = `ARRAY['audience_snapshots', 'audience_snapshot_members', 'audience_snapshot_chunks']`;
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string; message?: string }) => e.code ?? e.message ?? 'error');

async function insertSnapshot(c: { query: (q: string, v?: unknown[]) => Promise<unknown> }, over: Record<string, unknown> = {}) {
  const row = { id: id(), org_id: ids.orgA, workspace_id: ids.wsA, capture_key: id(), owner_kind: 'campaign_execution', owner_id: id(), definition: '{"include":[],"exclude":[]}', definition_hash: HASH, size: 0, released_at: null, release_reason: null, purged_at: null, ...over };
  await c.query(
    `INSERT INTO audience_snapshots (id, org_id, workspace_id, capture_key, owner_kind, owner_id, definition, definition_hash, captured_at, size, released_at, release_reason, purged_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, now(), $9, $10, $11, $12)`,
    [row.id, row.org_id, row.workspace_id, row.capture_key, row.owner_kind, row.owner_id, row.definition, row.definition_hash, row.size, row.released_at, row.release_reason, row.purged_at],
  );
  return row.id as string;
}

beforeAll(async () => {
  await resetTestDatabase();
  await withOwnerConnection(async (c) => {
    await c.query(`INSERT INTO users (id, email, email_normalized, display_name) VALUES ($1, 's@x.test', 's@x.test', 'S')`, [ids.user]);
    for (const [org, ws, snap, contact, slug] of [[ids.orgA, ids.wsA, ids.snapA, ids.contactA, 'a'], [ids.orgB, ids.wsB, ids.snapB, ids.contactB, 'b']] as const) {
      await c.query(`INSERT INTO organizations (id, name, slug, created_by_user_id) VALUES ($1, $2, $2, $3)`, [org, `snap-org-${slug}`, ids.user]);
      await c.query(`INSERT INTO workspaces (id, org_id, name, slug) VALUES ($1, $2, $3, $3)`, [ws, org, `ws-${slug}`]);
      await c.query(`INSERT INTO contacts (id, org_id, workspace_id) VALUES ($1, $2, $3)`, [contact, org, ws]);
      await insertSnapshot(c, { id: snap, org_id: org, workspace_id: ws, capture_key: `key-${slug}`, size: 1 });
      await c.query(`INSERT INTO audience_snapshot_members (org_id, workspace_id, snapshot_id, contact_id) VALUES ($1, $2, $3, $4)`, [org, ws, snap, contact]);
      await c.query(
        `INSERT INTO audience_snapshot_chunks (org_id, workspace_id, snapshot_id, chunk_no, first_contact, last_contact, contact_ids) VALUES ($1, $2, $3, 0, $4, $4, ARRAY[$4]::uuid[])`,
        [org, ws, snap, contact],
      );
    }
  });
});
afterAll(async () => undefined);

describe('audience_snapshots constraints', () => {
  it.each([
    ['owner kind other than campaign_execution', { owner_kind: 'journey' }],
    ['size above 5,000,000', { size: 5_000_001 }],
    ['negative size', { size: -1 }],
    ['empty capture key', { capture_key: '' }],
    ['capture key over 200 characters', { capture_key: 'k'.repeat(201) }],
    ['definition hash that is not sha-256 hex', { definition_hash: 'xyz' }],
    ['definition that is not an object', { definition: '[]' }],
    ['unknown release reason', { released_at: new Date(), release_reason: 'expired' }],
    ['released without a reason', { released_at: new Date() }],
    ['a reason without release', { release_reason: 'cancelled' }],
    ['purged but not released', { purged_at: new Date() }],
  ])('rejects %s', async (_label, over) => {
    expect(await code(withOwnerConnection((c) => insertSnapshot(c, over)))).toBe('23514');
  });

  it('accepts the boundary values', async () => {
    expect(await code(withOwnerConnection((c) => insertSnapshot(c, { size: 5_000_000, capture_key: 'k'.repeat(200) })))).toBe('ok');
  });

  it('one snapshot per (workspace, capture key); the same key in another workspace is independent', async () => {
    expect(await code(withOwnerConnection((c) => insertSnapshot(c, { capture_key: 'key-a' })))).toBe('23505');
    expect(await code(withOwnerConnection((c) => insertSnapshot(c, { capture_key: 'key-a', org_id: ids.orgB, workspace_id: ids.wsB })))).toBe('ok');
  });

  it('no foreign key to Campaign tables: owner_id is an application-level reference', async () => {
    const fks = await withOwnerConnection(async (c) =>
      (await c.query(`SELECT conname, confrelid::regclass::text AS target FROM pg_constraint WHERE contype = 'f' AND conrelid = ANY(${SNAPSHOT_TABLES}::regclass[]) ORDER BY conname`)).rows,
    );
    expect(fks.map((f: { target: string }) => f.target).sort()).toEqual(['audience_snapshots', 'audience_snapshots', 'workspaces']);
  });
});

describe('immutability (trigger; binds even the schema owner)', () => {
  it.each([['capture_key', `'changed'`], ['owner_id', `gen_random_uuid()`], ['definition_hash', `'${'b'.repeat(64)}'`], ['size', '2'], ['captured_at', `now() - interval '1 day'`], ['workspace_id', `'${ids.wsB}'::uuid`]])(
    'captured column %s cannot change',
    async (col, value) => {
      const result = await code(withOwnerConnection((c) => c.query(`UPDATE audience_snapshots SET ${col} = ${value} WHERE id = $1`, [ids.snapA])));
      expect(result).toBe('42501');
    },
  );

  it('lifecycle columns go from NULL to a value once, never back, never overwritten', async () => {
    const snap = await withOwnerConnection((c) => insertSnapshot(c));
    const set = (sql: string) => code(withOwnerConnection((c) => c.query(`UPDATE audience_snapshots SET ${sql} WHERE id = $1`, [snap])));
    expect(await set(`released_at = now(), release_reason = 'cancelled'`)).toBe('ok');
    expect(await set(`release_reason = 'failed'`)).toBe('42501');
    expect(await set(`released_at = now() + interval '1 second'`)).toBe('42501');
    expect(await set(`released_at = NULL, release_reason = NULL`)).toBe('42501');
    expect(await set(`purged_at = now()`)).toBe('ok');
    expect(await set(`purged_at = NULL`)).toBe('42501');
    expect(await set(`purged_at = now() + interval '1 second'`)).toBe('42501');
  });

  it('members and member chunks are never updated', async () => {
    expect(await code(withOwnerConnection((c) => c.query(`UPDATE audience_snapshot_members SET contact_id = contact_id WHERE snapshot_id = $1`, [ids.snapA])))).toBe('42501');
    expect(await code(withOwnerConnection((c) => c.query(`UPDATE audience_snapshot_chunks SET contact_ids = contact_ids WHERE snapshot_id = $1`, [ids.snapA])))).toBe('42501');
  });
});

describe('grants (decision I)', () => {
  it('workeasy_app: snapshots SELECT/INSERT + UPDATE of the three lifecycle columns only; members SELECT/INSERT/DELETE', async () => {
    const r = await withOwnerConnection(async (c) =>
      (
        await c.query(`
          SELECT t.tbl, p.priv, has_table_privilege('workeasy_app', t.tbl, p.priv) AS granted
          FROM unnest(${SNAPSHOT_TABLES}) t(tbl),
               unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p(priv)
          ORDER BY 1, 2`)
      ).rows,
    );
    const granted = r.filter((x: { granted: boolean }) => x.granted).map((x: { tbl: string; priv: string }) => `${x.tbl}:${x.priv}`);
    expect(granted.sort()).toEqual(['audience_snapshot_chunks:DELETE', 'audience_snapshot_chunks:INSERT', 'audience_snapshot_chunks:SELECT', 'audience_snapshot_members:DELETE', 'audience_snapshot_members:INSERT', 'audience_snapshot_members:SELECT', 'audience_snapshots:INSERT', 'audience_snapshots:SELECT']);
    const updatable = await withOwnerConnection(async (c) =>
      (
        await c.query(`
          SELECT a.attrelid::regclass::text AS tbl, a.attname FROM pg_attribute a
          WHERE a.attrelid = ANY(${SNAPSHOT_TABLES}::regclass[]) AND a.attnum > 0 AND NOT a.attisdropped
            AND has_column_privilege('workeasy_app', a.attrelid, a.attname, 'UPDATE') ORDER BY 1, 2`)
      ).rows,
    );
    expect(updatable.map((x: { tbl: string; attname: string }) => `${x.tbl}.${x.attname}`)).toEqual([
      'audience_snapshots.purged_at',
      'audience_snapshots.release_reason',
      'audience_snapshots.released_at',
    ]);
  });

  it('reporting and identity roles have no access at all', async () => {
    const r = await withOwnerConnection(async (c) =>
      (
        await c.query(`
          SELECT count(*)::int AS n FROM unnest(ARRAY['workeasy_reporting', 'workeasy_identity']) r(role),
            unnest(${SNAPSHOT_TABLES}) t(tbl),
            unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p(priv)
          WHERE has_table_privilege(r.role, t.tbl, p.priv)`)
      ).rows[0],
    );
    expect(r.n).toBe(0);
  });

  it('as workeasy_app: updating a member, a captured column or deleting a snapshot is refused', async () => {
    expect(await code(withAppConnection(A, (c) => c.query(`UPDATE audience_snapshot_members SET contact_id = contact_id`)))).toBe('42501');
    expect(await code(withAppConnection(A, (c) => c.query(`UPDATE audience_snapshots SET size = 3`)))).toBe('42501');
    expect(await code(withAppConnection(A, (c) => c.query(`UPDATE audience_snapshots SET workspace_id = workspace_id`)))).toBe('42501');
    expect(await code(withAppConnection(A, (c) => c.query(`DELETE FROM audience_snapshots`)))).toBe('42501');
    expect(await code(withAppConnection(A, (c) => c.query(`TRUNCATE audience_snapshot_members`)))).toBe('42501');
    expect(await code(withAppConnection(A, (c) => c.query(`UPDATE audience_snapshot_chunks SET contact_ids = contact_ids`)))).toBe('42501');
    expect(await code(withAppConnection(A, (c) => c.query(`TRUNCATE audience_snapshot_chunks`)))).toBe('42501');
  });
});

describe('row-level security (even when application checks are bypassed)', () => {
  it('the snapshot tables have RLS enabled and forced, with the workspace policy (InitPlan form) for USING and WITH CHECK', async () => {
    const r = await withOwnerConnection(async (c) =>
      (
        await c.query(`
          SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, p.polname, p.polcmd,
                 pg_get_expr(p.polqual, p.polrelid) AS using_expr, pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr
          FROM pg_class c JOIN pg_policy p ON p.polrelid = c.oid
          WHERE c.oid = ANY(${SNAPSHOT_TABLES}::regclass[]) ORDER BY c.relname`)
      ).rows,
    );
    expect(r).toHaveLength(3);
    for (const p of r) {
      expect([p.relrowsecurity, p.relforcerowsecurity, p.polcmd]).toEqual([true, true, '*']);
      for (const e of [p.using_expr, p.check_expr]) expect(e).toBe(INITPLAN_PREDICATE);
    }
  });

  it("raw SQL from workspace B never sees, pages, releases or deletes workspace A's snapshot", async () => {
    await withAppConnection(B, async (c) => {
      expect((await c.query(`SELECT id FROM audience_snapshots WHERE id = $1 OR capture_key = 'key-a'`, [ids.snapA])).rows.map((x: { id: string }) => x.id)).toEqual(
        (await c.query(`SELECT id FROM audience_snapshots WHERE capture_key = 'key-a'`)).rows.map((x: { id: string }) => x.id),
      );
      expect((await c.query(`SELECT 1 FROM audience_snapshots WHERE id = $1`, [ids.snapA])).rowCount).toBe(0);
      expect((await c.query(`SELECT 1 FROM audience_snapshot_members WHERE snapshot_id = $1`, [ids.snapA])).rowCount).toBe(0);
      expect((await c.query(`UPDATE audience_snapshots SET released_at = now(), release_reason = 'cancelled' WHERE id = $1`, [ids.snapA])).rowCount).toBe(0);
      expect((await c.query(`DELETE FROM audience_snapshot_members WHERE snapshot_id = $1`, [ids.snapA])).rowCount).toBe(0);
      expect((await c.query(`SELECT 1 FROM audience_snapshot_chunks WHERE snapshot_id = $1`, [ids.snapA])).rowCount).toBe(0);
      expect((await c.query(`DELETE FROM audience_snapshot_chunks WHERE snapshot_id = $1`, [ids.snapA])).rowCount).toBe(0);
      expect((await c.query(`SELECT 1 FROM audience_snapshots WHERE id = $1 FOR UPDATE`, [ids.snapA])).rowCount).toBe(0);
    });
    // A's rows are intact.
    await withAppConnection(A, async (c) => {
      expect((await c.query(`SELECT released_at FROM audience_snapshots WHERE id = $1`, [ids.snapA])).rows).toEqual([{ released_at: null }]);
      expect((await c.query(`SELECT count(*)::int AS n FROM audience_snapshot_members WHERE snapshot_id = $1`, [ids.snapA])).rows[0].n).toBe(1);
      expect((await c.query(`SELECT count(*)::int AS n FROM audience_snapshot_chunks WHERE snapshot_id = $1`, [ids.snapA])).rows[0].n).toBe(1);
    });
  });

  it("workspace B cannot write rows labelled with workspace A's tenant", async () => {
    expect(
      await code(withAppConnection(B, (c) => c.query(`INSERT INTO audience_snapshot_members (org_id, workspace_id, snapshot_id, contact_id) VALUES ($1, $2, $3, $4)`, [ids.orgA, ids.wsA, ids.snapA, ids.contactA]))),
    ).toBe('42501');
    expect(await code(withAppConnection(B, (c) => insertSnapshot(c)))).toBe('42501');
    const insertChunk = `INSERT INTO audience_snapshot_chunks (org_id, workspace_id, snapshot_id, chunk_no, first_contact, last_contact, contact_ids) VALUES ($1, $2, $3, 1, $4, $4, ARRAY[$4]::uuid[])`;
    expect(await code(withAppConnection(B, (c) => c.query(insertChunk, [ids.orgA, ids.wsA, ids.snapA, ids.contactA])))).toBe('42501');
    // B's own labels but A's snapshot: the composite FK refuses it
    expect(await code(withAppConnection(B, (c) => c.query(insertChunk, [ids.orgB, ids.wsB, ids.snapA, ids.contactB])))).toBe('23503');
  });

  it('an org-only context (no workspace) sees no snapshot rows', async () => {
    await withAppConnection({ orgId: ids.orgA, workspaceId: null }, async (c) => {
      expect((await c.query(`SELECT 1 FROM audience_snapshots`)).rowCount).toBe(0);
    });
  });
});

describe('cleanup discovery function (decision J)', () => {
  it('is SECURITY DEFINER with a pinned search_path, executable by workeasy_app only', async () => {
    const r = await withOwnerConnection(async (c) =>
      (
        await c.query(`
          SELECT p.prosecdef, p.proconfig,
                 has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
                 has_function_privilege('workeasy_app', p.oid, 'EXECUTE') AS app,
                 has_function_privilege('workeasy_reporting', p.oid, 'EXECUTE') AS rep,
                 has_function_privilege('workeasy_identity', p.oid, 'EXECUTE') AS idn,
                 pg_get_function_result(p.oid) AS result
          FROM pg_proc p WHERE p.proname = 'workspaces_with_snapshot_cleanup'`)
      ).rows,
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ prosecdef: true, pub: false, app: true, rep: false, idn: false, result: 'TABLE(org_id uuid, workspace_id uuid)' });
    expect(r[0].proconfig).toEqual(['search_path=pg_catalog, public']);
  });

  it('finds unreleased snapshots older than the threshold and released-but-unpurged ones; never purged ones', async () => {
    const orgC = id();
    const wsC = id();
    const wsD = id();
    await withOwnerConnection(async (c) => {
      await c.query(`INSERT INTO organizations (id, name, slug, created_by_user_id) VALUES ($1, 'snap-org-c', 'snap-org-c', $2)`, [orgC, ids.user]);
      for (const [ws, slug] of [[wsC, 'c'], [wsD, 'd']] as const) await c.query(`INSERT INTO workspaces (id, org_id, name, slug) VALUES ($1, $2, $3, $3)`, [ws, orgC, `ws-${slug}`]);
      await insertSnapshot(c, { org_id: orgC, workspace_id: wsC, released_at: new Date(), release_reason: 'cancelled' }); // released, unpurged
      await insertSnapshot(c, { org_id: orgC, workspace_id: wsD, released_at: new Date(), release_reason: 'failed', purged_at: new Date() }); // done
    });
    const call = (before: string) =>
      withAppConnection({ orgId: ids.orgB, workspaceId: ids.wsB }, async (c) =>
        (await c.query(`SELECT org_id, workspace_id FROM app.workspaces_with_snapshot_cleanup('campaign_execution', ${before}) ORDER BY 1, 2`)).rows,
      );
    const future = await call(`now() + interval '1 hour'`);
    expect(future).toEqual(expect.arrayContaining([{ org_id: ids.orgA, workspace_id: ids.wsA }, { org_id: ids.orgB, workspace_id: ids.wsB }, { org_id: orgC, workspace_id: wsC }]));
    expect(future).not.toContainEqual({ org_id: orgC, workspace_id: wsD });
    // threshold in the past: fresh unreleased snapshots are not candidates yet, released-but-unpurged always are
    const past = await call(`now() - interval '1 hour'`);
    expect(past).toContainEqual({ org_id: orgC, workspace_id: wsC });
    expect(past).not.toContainEqual({ org_id: ids.orgA, workspace_id: ids.wsA });
    // workspace pairs only
    for (const row of future) expect(Object.keys(row).sort()).toEqual(['org_id', 'workspace_id']);
    expect(await code(withAppConnection(A, (c) => c.query(`SELECT * FROM app.workspaces_with_snapshot_cleanup('journey', now())`)))).toBe('ok');
  });
});

describe('audience_snapshot_chunks constraints (D2)', () => {
  const sorted = (n: number) => Array.from({ length: n }, () => id()).sort();
  const chunk = (no: number, contactIds: string[] | null, first?: string, last?: string) =>
    code(
      withOwnerConnection((c) =>
        c.query(
          `INSERT INTO audience_snapshot_chunks (org_id, workspace_id, snapshot_id, chunk_no, first_contact, last_contact, contact_ids) VALUES ($1, $2, $3, $4, $5, $6, $7::uuid[])`,
          [ids.orgA, ids.wsA, ids.snapA, no, first ?? contactIds?.[0] ?? id(), last ?? contactIds?.at(-1) ?? id(), contactIds],
        ),
      ),
    );

  it('rejects an empty chunk, more than 1,000 ids, a chunk number outside 0–4,999 and bounds that disagree with the ids', async () => {
    expect(await chunk(10, [])).toBe('23514');
    expect(await chunk(11, sorted(1001))).toBe('23514');
    expect(await chunk(-1, sorted(3))).toBe('23514');
    expect(await chunk(5000, sorted(3))).toBe('23514');
    const s3 = sorted(3);
    expect(await chunk(12, s3, s3[1], s3[2])).toBe('23514');
    expect(await chunk(13, s3, s3[0], s3[1])).toBe('23514');
  });

  it('accepts 1,000 ids and the last chunk number; chunk numbers are unique per snapshot; ids cannot be NULL', async () => {
    expect(await chunk(4999, sorted(1000))).toBe('ok');
    expect(await chunk(4999, sorted(2))).toBe('23505');
    expect(await chunk(20, null)).toBe('23502');
  });
});

describe('InitPlan form of the Audience policies (D2)', () => {
  it('exactly the Audience tables use the identical workspace predicate in InitPlan form, for USING and WITH CHECK', async () => {
    const r = await withOwnerConnection(async (c) =>
      (
        await c.query(`SELECT c.relname, pg_get_expr(p.polqual, p.polrelid) AS q, pg_get_expr(p.polwithcheck, p.polrelid) AS w
                       FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
                       WHERE pg_get_expr(p.polqual, p.polrelid) LIKE '%SELECT app.current_org_id()%' ORDER BY 1`)
      ).rows,
    );
    expect(r.map((x: { relname: string }) => x.relname)).toEqual([
      'audience_count_contact_seq', 'audience_count_dead_chunks', 'audience_count_source_chunks', 'audience_count_state', // G2 count bitmap
      'audience_snapshot_chunks', 'audience_snapshot_members', 'audience_snapshots', 'contact_tags', 'contacts', 'list_memberships', 'lists', 'tags',
    ]);
    for (const p of r) expect([p.q, p.w]).toEqual([INITPLAN_PREDICATE, INITPLAN_PREDICATE]);
  });
});
