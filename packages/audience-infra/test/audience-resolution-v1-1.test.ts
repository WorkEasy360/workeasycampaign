/**
 * Audience Resolution v1.1 (approved 2026-10-07; docs/contracts/phase-5-audience.md §9.9): uniform live sample and topic
 * status. Oracle: the audience computed independently by the owner (EXISTS / NOT EXISTS over contacts), never the
 * bitmap. Both paths: the verified bitmap (VALID) and the exact query (bitmap not valid).
 */
import { randomUUID } from 'node:crypto';
import { AudienceResolutionError } from '@workeasy/audience-core';
import { createDatabase, type Database, type TenantContext } from '@workeasy/db';
import { resetTestDatabase, testDatabaseUrls, withAppConnection, withOwnerConnection } from '@workeasy/db/testing';
import type { AudienceDefinitionV1 } from '@workeasy/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaAudienceResolution, PrismaAudienceResolutionRecovery, rebuildCountBitmap } from '../src/index.js';

let db: Database;
const user = randomUUID();
const orgA = randomUUID();
const orgB = randomUUID();
const resolution = new PrismaAudienceResolution();
const exactOnly = new PrismaAudienceResolution({ bitmapCount: false });
type Ws = { w: TenantContext & { workspaceId: string }; list: string; exclusion: string; tag: string };

const inWs = <T>(w: Ws['w'], fn: (s: { tx: never; orgId: string; workspaceId: string }) => Promise<T>) =>
  db.withTenant(w, (tx) => fn({ tx: tx as never, orgId: w.orgId, workspaceId: w.workspaceId }), { timeout: 60_000 });
const code = (e: unknown) => (e instanceof AudienceResolutionError ? e.code : String((e as { code?: string })?.code ?? (e as Error)?.message ?? e));

/** Workspace with `members` live members in `list` (spread over `spread` contacts), plus deleted and excluded contacts that must never be sampled. */
async function workspace(org: string, members: number, opts: { spread?: number; dead?: number; excluded?: number } = {}): Promise<Ws> {
  const w = { orgId: org, workspaceId: randomUUID(), userId: null };
  const [list, exclusion, tag] = [randomUUID(), randomUUID(), randomUUID()];
  const spread = Math.max(opts.spread ?? members, members);
  await withOwnerConnection(async (c) => {
    await c.query(`SET statement_timeout = 0`);
    await c.query(`INSERT INTO workspaces (id, org_id, name, slug) VALUES ($1, $2, $3, $3)`, [w.workspaceId, org, `s-${w.workspaceId.slice(0, 8)}`]);
    await c.query(`INSERT INTO lists (id, org_id, workspace_id, name, name_key) VALUES ($1, $2, $3, 'l', 'l'), ($4, $2, $3, 'x', 'x')`, [list, org, w.workspaceId, exclusion]);
    await c.query(`INSERT INTO tags (id, org_id, workspace_id, name, name_key) VALUES ($1, $2, $3, 't', 't')`, [tag, org, w.workspaceId]);
    const total = spread + (opts.dead ?? 0) + (opts.excluded ?? 0);
    if (total) {
      await c.query(`CREATE TEMP TABLE IF NOT EXISTS s_c (g int, id uuid) ON COMMIT DELETE ROWS`);
      await c.query('BEGIN');
      await c.query(`INSERT INTO s_c SELECT g, gen_random_uuid() FROM generate_series(1, $1::int) g`, [total]);
      await c.query(`INSERT INTO contacts (id, org_id, workspace_id, deleted_at) SELECT id, $1, $2, CASE WHEN g > $3::int AND g <= $3::int + $4::int THEN now() END FROM s_c`, [org, w.workspaceId, spread, opts.dead ?? 0]);
      // members: every (spread/members)-th of the first `spread` contacts → spread across chunks; dead + excluded are in the list too
      const step = members ? spread / members : 1;
      await c.query(
        `INSERT INTO list_memberships (org_id, workspace_id, list_id, contact_id)
         SELECT $1, $2, $3, id FROM s_c WHERE (g <= $5 AND $6 > 0 AND (g - 1) % greatest(1, floor($4::float8)::int) = 0 AND (g - 1) / greatest(1, floor($4::float8)::int) < $6) OR g > $5`,
        [org, w.workspaceId, list, step, spread, members],
      );
      await c.query(`INSERT INTO list_memberships (org_id, workspace_id, list_id, contact_id) SELECT $1, $2, $3, id FROM s_c WHERE g > $4::int + $5::int`, [org, w.workspaceId, exclusion, spread, opts.dead ?? 0]);
      await c.query('COMMIT');
      await c.query(`ANALYZE contacts`);
    }
  });
  return { w, list, exclusion, tag };
}

const defOf = (ws: Ws): AudienceDefinitionV1 => ({ include: [{ type: 'list', listId: ws.list }], exclude: [{ type: 'list', listId: ws.exclusion }] });
/** Independent oracle: live members of the list not in the exclusion list. */
const reference = (ws: Ws) =>
  withOwnerConnection(async (c) =>
    new Set<string>(
      (
        await c.query(
          `SELECT m.contact_id::text AS id FROM list_memberships m JOIN contacts c ON c.id = m.contact_id
           WHERE m.list_id = $1 AND c.deleted_at IS NULL AND c.erased_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM list_memberships e WHERE e.list_id = $2 AND e.contact_id = m.contact_id)`,
          [ws.list, ws.exclusion],
        )
      ).rows.map((r) => r.id as string),
    ),
  );
const valid = async (ws: Ws) => expect((await rebuildCountBitmap(db, { orgId: ws.w.orgId, workspaceId: ws.w.workspaceId })).outcome).toBe('published');

beforeAll(async () => {
  await resetTestDatabase();
  await withOwnerConnection(async (c) => {
    await c.query(`INSERT INTO users (id, email, email_normalized, display_name) VALUES ($1, 's@x.test', 's@x.test', 'S')`, [user]);
    for (const [o, slug] of [[orgA, 'sa'], [orgB, 'sb']]) await c.query(`INSERT INTO organizations (id, name, slug, created_by_user_id) VALUES ($1, $2, $2, $3)`, [o, slug, user]);
  });
  db = createDatabase({ url: testDatabaseUrls().app, maxConnections: 4 });
});
afterAll(async () => {
  await db?.disconnect();
  await resetTestDatabase();
});

describe('sample: size, membership, both paths', () => {
  for (const members of [0, 1, 1_999, 2_000, 2_001]) {
    it(`${members} members → min(2,000, ${members}), all members of the live audience, no duplicates, exact size`, async () => {
      const ws = await workspace(orgA, members, { dead: 3, excluded: 4 });
      const ref = await reference(ws);
      expect(ref.size).toBe(members);
      await valid(ws);
      for (const [path, r] of [['bitmap', resolution], ['exact', exactOnly]] as const) {
        const got = await inWs(ws.w, (s) => r.sampleWithPath(s, defOf(ws), { size: 2_000 }));
        expect(got.path, path).toBe(path);
        expect(got.sample.audienceSize, path).toBe(members);
        expect(got.sample.capped).toBe(false);
        expect(got.sample.contactIds, path).toHaveLength(Math.min(2_000, members));
        expect(new Set(got.sample.contactIds).size).toBe(got.sample.contactIds.length);
        for (const id of got.sample.contactIds) expect(ref.has(id), `${path}: ${id} not in the audience`).toBe(true);
        expect([...got.sample.contactIds]).toEqual([...got.sample.contactIds].sort());
      }
    }, 120_000);
  }

  it('a large audience (12,000 members over 3 chunks): exactly 2,000, members only; size from the same read', async () => {
    const ws = await workspace(orgA, 12_000, { dead: 50, excluded: 50 });
    await valid(ws);
    const ref = await reference(ws);
    const got = await inWs(ws.w, (s) => resolution.sampleWithPath(s, defOf(ws), { size: 2_000 }));
    expect([got.path, got.sample.audienceSize, got.sample.contactIds.length]).toEqual(['bitmap', 12_000, 2_000]);
    expect(got.sample.contactIds.every((id) => ref.has(id))).toBe(true);
    const smaller = await inWs(ws.w, (s) => resolution.sample(s, defOf(ws), { size: 10 }));
    expect(smaller.contactIds).toHaveLength(10);
    expect((await inWs(ws.w, (s) => resolution.sample(s, defOf(ws), { size: 0 }))).contactIds).toEqual([]);
  }, 180_000);

  it('uniform: over many draws every member is chosen about equally often (bitmap and exact paths; members spread across chunks)', async () => {
    const ws = await workspace(orgA, 60, { spread: 9_000 }); // 60 members scattered over ≥ 3 chunks
    await valid(ws);
    for (const [path, r, draws] of [['bitmap', resolution, 2_000], ['exact', exactOnly, 600]] as const) {
      const hits = new Map<string, number>();
      for (let i = 0; i < draws; i++) {
        const s = await inWs(ws.w, (sc) => r.sample(sc, defOf(ws), { size: 6 }));
        expect(s.contactIds).toHaveLength(6);
        for (const id of s.contactIds) hits.set(id, (hits.get(id) ?? 0) + 1);
      }
      const expected = (draws * 6) / 60;
      expect(hits.size, path).toBe(60);
      // chi-square over 60 cells (59 df): mean 59, sd ≈ 10.9; 120 is > 5 sd above the mean
      const chi2 = [...hits.values()].reduce((a, x) => a + (x - expected) ** 2 / expected, 0);
      console.log(`uniformity ${path}: draws=${draws} expected=${expected} min=${Math.min(...hits.values())} max=${Math.max(...hits.values())} chi2=${chi2.toFixed(1)}`);
      expect(chi2, path).toBeLessThan(120);
    }
  }, 600_000);

  it('seeded samples are repeatable; unseeded ones vary; no write happens', async () => {
    const ws = await workspace(orgA, 500, { spread: 5_000 });
    await valid(ws);
    const before = await withOwnerConnection(async (c) => (await c.query(`SELECT (SELECT count(*) FROM audience_snapshots)::int s, (SELECT count(*) FROM audience_snapshot_chunks)::int c`)).rows[0]);
    for (const r of [resolution, exactOnly]) {
      const a = await inWs(ws.w, (s) => r.sample(s, defOf(ws), { size: 20, seed: 0.42 }));
      const b = await inWs(ws.w, (s) => r.sample(s, defOf(ws), { size: 20, seed: 0.42 }));
      const c = await inWs(ws.w, (s) => r.sample(s, defOf(ws), { size: 20 }));
      expect(b.contactIds).toEqual(a.contactIds);
      expect(c.contactIds).not.toEqual(a.contactIds);
    }
    const after = await withOwnerConnection(async (c) => (await c.query(`SELECT (SELECT count(*) FROM audience_snapshots)::int s, (SELECT count(*) FROM audience_snapshot_chunks)::int c`)).rows[0]);
    expect(after).toEqual(before);
  }, 120_000);

  it('errors are those of count: invalid definition, missing source, size bounds', async () => {
    const ws = await workspace(orgA, 5);
    await valid(ws);
    const missing: AudienceDefinitionV1 = { include: [{ type: 'list', listId: randomUUID() }], exclude: [] };
    expect(await inWs(ws.w, (s) => resolution.sample(s, missing, { size: 5 })).catch(code)).toBe('AUDIENCE_SOURCE_NOT_FOUND');
    expect(await inWs(ws.w, (s) => resolution.sample(s, { include: [], exclude: [] }, { size: 5 })).catch(code)).toBe('AUDIENCE_DEFINITION_INVALID');
    expect(await inWs(ws.w, (s) => resolution.sample(s, defOf(ws), { size: 2_001 })).catch(code)).toMatch(/size must be/);
    expect(await inWs(ws.w, (s) => resolution.sample(s, defOf(ws), { size: 1.5 })).catch(code)).toMatch(/size must be/);
  });
});

describe('tenant isolation and privileges', () => {
  it('another workspace (same org or another org): its sources are not found and its members never sampled', async () => {
    const a = await workspace(orgA, 50);
    const sameOrg = await workspace(orgA, 50);
    const otherOrg = await workspace(orgB, 50);
    await valid(a);
    for (const foreign of [sameOrg, otherOrg]) {
      expect(await inWs(a.w, (s) => resolution.sample(s, defOf(foreign), { size: 10 })).catch(code)).toBe('AUDIENCE_SOURCE_NOT_FOUND');
      // the SQL function itself, called directly with foreign source ids, sees nothing of them
      const direct = await withAppConnection(a.w, async (c) => (await c.query(`SELECT app.audience_sample_ids($1::uuid[], '{}', 50, NULL) AS r`, [[foreign.list]])).rows[0].r);
      expect(direct).toMatchObject({ state: 'valid', total: 0, contactIds: [] });
    }
  });

  it('the sampling function: app may execute, reporting/identity/PUBLIC may not; SECURITY DEFINER with pinned search_path; needs a workspace context', async () => {
    const r = await withOwnerConnection(async (c) => (await c.query(`
      SELECT p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig,
             has_function_privilege('workeasy_app', p.oid, 'EXECUTE') AS app, has_function_privilege('workeasy_reporting', p.oid, 'EXECUTE') AS rep,
             has_function_privilege('workeasy_identity', p.oid, 'EXECUTE') AS idn, has_function_privilege('public', p.oid, 'EXECUTE') AS pub
      FROM pg_proc p WHERE p.oid = 'app.audience_sample_ids(uuid[], uuid[], int, double precision)'::regprocedure`)).rows[0]);
    expect(r).toMatchObject({ prosecdef: true, owner: 'workeasy_audience_count', app: true, rep: false, idn: false, pub: false });
    expect(r.proconfig.some((x: string) => x.startsWith('search_path=pg_catalog'))).toBe(true);
    const nth = await withOwnerConnection(async (c) => (await c.query(`SELECT has_function_privilege('workeasy_app', 'app.audience_sample_nth_bit(bit varying, int)', 'EXECUTE') AS app`)).rows[0].app);
    expect(nth).toBe(false);
    await expect(withAppConnection({ orgId: orgA, workspaceId: null }, (c) => c.query(`SELECT app.audience_sample_ids('{}', '{}', 5, NULL)`))).rejects.toMatchObject({ code: '42501' });
    const ws = await workspace(orgA, 1);
    await valid(ws);
    await expect(withAppConnection(ws.w, (c) => c.query(`SELECT app.audience_sample_ids('{}', '{}', 2001, NULL)`))).rejects.toMatchObject({ code: '22023' });
  });
});

describe('topicStatus', () => {
  it('distinguishes available, archived, category and not found (missing, malformed, another workspace, another org)', async () => {
    const a = await workspace(orgA, 0);
    const sameOrg = await workspace(orgA, 0);
    const otherOrg = await workspace(orgB, 0);
    const ids = { active: randomUUID(), archived: randomUUID(), category: randomUUID(), sameOrg: randomUUID(), otherOrg: randomUUID() };
    await withOwnerConnection(async (c) => {
      await c.query(`INSERT INTO topics (id, org_id, workspace_id, key, name) VALUES ($1, $2, $3, 'ta', 'A')`, [ids.active, orgA, a.w.workspaceId]);
      await c.query(`INSERT INTO topics (id, org_id, workspace_id, key, name, status) VALUES ($1, $2, $3, 'tb', 'B', 'archived')`, [ids.archived, orgA, a.w.workspaceId]);
      await c.query(`INSERT INTO topics (id, org_id, workspace_id, key, name, kind) VALUES ($1, $2, $3, 'tc', 'C', 'category')`, [ids.category, orgA, a.w.workspaceId]);
      await c.query(`INSERT INTO topics (id, org_id, workspace_id, key, name) VALUES ($1, $2, $3, 'td', 'D')`, [ids.sameOrg, orgA, sameOrg.w.workspaceId]);
      await c.query(`INSERT INTO topics (id, org_id, workspace_id, key, name) VALUES ($1, $2, $3, 'te', 'E')`, [ids.otherOrg, orgB, otherOrg.w.workspaceId]);
    });
    const status = (id: string) => inWs(a.w, (s) => resolution.topicStatus(s, id));
    expect(await status(ids.active)).toEqual({ available: true });
    expect(await status(ids.archived)).toEqual({ available: false, reason: 'archived' });
    expect(await status(ids.category)).toEqual({ available: false, reason: 'category' });
    expect(await status(ids.sameOrg)).toEqual({ available: false, reason: 'not_found' });
    expect(await status(ids.otherOrg)).toEqual({ available: false, reason: 'not_found' });
    expect(await status(randomUUID())).toEqual({ available: false, reason: 'not_found' });
    expect(await status("x' OR 1=1 --")).toEqual({ available: false, reason: 'not_found' });
  });
});

describe('sample: plan independence and consistency (migration 20261015000001)', () => {
  it('bounded under any join strategy: forced nested loops and a 3 s statement timeout still answer from the bitmap', async () => {
    // The first version mapped ranks to members through a join whose condition contained the bit-search function; a
    // nested-loop plan evaluated it per (rank × position) and hit the statement timeout (MEASURED via the API at 100k).
    const ws = await workspace(orgA, 20_000, { dead: 10, excluded: 10 });
    await valid(ws);
    const ref = await reference(ws);
    for (const settings of [`SET LOCAL enable_hashjoin = off; SET LOCAL enable_mergejoin = off`, `SET LOCAL enable_nestloop = off`, `SET LOCAL plan_cache_mode = force_generic_plan`]) {
      for (let i = 0; i < 7; i++) {
        const got = await inWs(ws.w, async (s) => {
          for (const stmt of [...settings.split(';'), ` SET LOCAL statement_timeout = '3s'`]) await (s.tx as unknown as { $executeRawUnsafe(q: string): Promise<number> }).$executeRawUnsafe(stmt.trim());
          return resolution.sampleWithPath(s, defOf(ws), { size: 2_000 });
        });
        expect([got.path, got.sample.audienceSize, got.sample.contactIds.length], settings).toEqual(['bitmap', 20_000, 2_000]);
        expect(got.sample.contactIds.every((id) => ref.has(id))).toBe(true);
      }
    }
  }, 180_000);

  it('positions inconsistent with a VALID bitmap: never a short sample — the exact path answers', async () => {
    const ws = await workspace(orgA, 50);
    await valid(ws);
    await withOwnerConnection((c) =>
      c.query(`DELETE FROM audience_count_contact_seq WHERE contact_id = (SELECT contact_id FROM list_memberships WHERE list_id = $1 LIMIT 1)`, [ws.list]),
    );
    const got = await inWs(ws.w, (s) => resolution.sampleWithPath(s, defOf(ws), { size: 2_000 }));
    expect(got.path).toBe('exact');
    expect(got.sample.contactIds).toHaveLength(50);
    expect(got.sample.audienceSize).toBe(50);
  }, 60_000);
});

// ─── Audience Resolution v1.2: bounded sample + recovery (degraded mode, approved 2026-10-07; §9.10) ─────────────

const stateOf = (ws: Ws) =>
  withOwnerConnection(async (c) => (await c.query(`SELECT state, generation::int AS generation FROM audience_count_state WHERE workspace_id = $1`, [ws.w.workspaceId])).rows[0] as { state: string; generation: number });
const invalidate = (ws: Ws) => withOwnerConnection((c) => c.query(`UPDATE audience_count_state SET state = 'invalid', reason = 'test' WHERE workspace_id = $1`, [ws.w.workspaceId]));
/** Holds an ACCESS EXCLUSIVE lock on list_memberships (the exact query's input) until `release()` — "exact is too slow". */
async function blockExact(): Promise<{ release: () => Promise<void> }> {
  let unlock!: () => void;
  let locked!: () => void;
  const held = new Promise<void>((r) => (locked = r));
  const done = withOwnerConnection(async (c) => {
    await c.query('BEGIN');
    await c.query('LOCK TABLE list_memberships IN ACCESS EXCLUSIVE MODE');
    locked();
    await new Promise<void>((r) => (unlock = r));
    await c.query('ROLLBACK');
  });
  await held;
  return { release: async () => { unlock(); await done; } };
}

describe('v1.2 sampleWithin: bounded exact path', () => {
  it('VALID bitmap → bitmap answer; not valid + time → exact answer; not valid + budget exceeded → unavailable, caller transaction intact', async () => {
    const ws = await workspace(orgA, 3_000, { dead: 5, excluded: 5 });
    await valid(ws);
    const opts = { size: 2_000, exactBudgetMs: 1_000 };
    const a = await inWs(ws.w, (s) => resolution.sampleWithinWithPath(s, defOf(ws), opts));
    expect([a.path, a.outcome.available && a.outcome.sample.audienceSize]).toEqual(['bitmap', 3_000]);
    await invalidate(ws);
    const b = await inWs(ws.w, (s) => resolution.sampleWithinWithPath(s, defOf(ws), opts));
    expect([b.path, b.outcome.available && b.outcome.sample.contactIds.length]).toEqual(['exact', 2_000]);

    const lock = await blockExact();
    try {
      const t0 = performance.now();
      const c = await inWs(ws.w, async (s) => {
        const r = await resolution.sampleWithinWithPath(s, defOf(ws), { size: 2_000, exactBudgetMs: 300 });
        // the caller's transaction is still usable and the statement timeout was restored
        const [after] = await (s.tx as unknown as { $queryRawUnsafe<T>(q: string): Promise<T> }).$queryRawUnsafe<{ t: string }[]>(`SELECT current_setting('statement_timeout') AS t`);
        return { r, timeout: after!.t };
      });
      const ms = performance.now() - t0;
      expect(c.r.outcome).toEqual({ available: false, reason: 'exact_budget_exceeded' });
      expect(c.r.path).toBe('unavailable');
      expect(c.timeout).not.toBe('300ms');
      expect(ms).toBeLessThan(3_000); // bounded: budget + overhead, not the lock duration
    } finally {
      await lock.release();
    }
  }, 120_000);

  it('validation and errors are those of sample; budget bounds enforced', async () => {
    const ws = await workspace(orgA, 10);
    await expect(inWs(ws.w, (s) => resolution.sampleWithin(s, { include: [{ type: 'list', listId: randomUUID() }], exclude: [] }, { size: 10, exactBudgetMs: 500 }))).rejects.toMatchObject({ code: 'AUDIENCE_SOURCE_NOT_FOUND' });
    await expect(inWs(ws.w, (s) => resolution.sampleWithin(s, defOf(ws), { size: 10, exactBudgetMs: 50 }))).rejects.toThrow(/exactBudgetMs/);
    await expect(inWs(ws.w, (s) => resolution.sampleWithin(s, defOf(ws), { size: 10, exactBudgetMs: 60_000 }))).rejects.toThrow(/exactBudgetMs/);
  });
});

describe('v1.2 requestRecovery: deduplicated, workspace-scoped, non-blocking', () => {
  const logs = () => {
    const lines: { msg: string; data: Record<string, unknown> }[] = [];
    return { lines, log: { info: (msg: string, data: Record<string, unknown>) => lines.push({ msg, data }), error: (msg: string, data: Record<string, unknown>) => lines.push({ msg, data }) } };
  };

  it('valid → ready; invalid → one rebuild for 20 concurrent requests (others "rebuilding"), then ready', async () => {
    const ws = await workspace(orgA, 2_000);
    await valid(ws);
    const l = logs();
    const recovery = new PrismaAudienceResolutionRecovery(db, l.log);
    expect(await recovery.requestRecovery(ws.w)).toEqual({ status: 'ready' });
    await invalidate(ws);
    const g0 = (await stateOf(ws)).generation;
    const t0 = performance.now();
    const answers = await Promise.all(Array.from({ length: 20 }, () => recovery.requestRecovery(ws.w)));
    expect(performance.now() - t0).toBeLessThan(5_000); // never waits for the rebuild
    expect(answers.filter((a) => a.status === 'requested')).toHaveLength(1);
    expect(answers.filter((a) => a.status === 'rebuilding')).toHaveLength(19);
    expect(recovery.running).toBe(1);
    await recovery.idle();
    expect(l.lines.filter((x) => x.msg.includes('finished')).map((x) => x.data.outcome)).toEqual(['published']);
    expect(await stateOf(ws)).toMatchObject({ state: 'valid' });
    expect((await stateOf(ws)).generation - g0).toBe(1); // exactly one rebuild generation
    expect(await recovery.requestRecovery(ws.w)).toEqual({ status: 'ready' });
    expect(JSON.stringify(l.lines)).not.toMatch(/@|contact/i); // ids only
  }, 120_000);

  it('across processes: two instances racing → at most one rebuild does work (6.3 lease), bitmap valid, other workspaces untouched', async () => {
    const ws = await workspace(orgA, 2_000);
    const other = await workspace(orgB, 50);
    await valid(other);
    const otherBefore = await stateOf(other);
    await invalidate(ws);
    const db2 = createDatabase({ url: testDatabaseUrls().app, maxConnections: 2 });
    try {
      const [l1, l2] = [logs(), logs()];
      const r1 = new PrismaAudienceResolutionRecovery(db, l1.log);
      const r2 = new PrismaAudienceResolutionRecovery(db2, l2.log);
      await Promise.all([r1.requestRecovery(ws.w), r2.requestRecovery(ws.w)]);
      await Promise.all([r1.idle(), r2.idle()]);
      const outcomes = [...l1.lines, ...l2.lines].filter((x) => x.msg.includes('finished')).map((x) => x.data.outcome);
      expect(outcomes.filter((o) => o === 'published')).toHaveLength(1);
      expect(outcomes.every((o) => o === 'published' || o === 'busy')).toBe(true);
      expect((await stateOf(ws)).state).toBe('valid');
      expect(await stateOf(other)).toEqual(otherBefore);
    } finally {
      await db2.disconnect();
    }
  }, 120_000);
});
