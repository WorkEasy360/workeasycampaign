/**
 * Phase 6.3 G2 — the derived exact-count bitmap (docs/audit/phase-6.3-g2-closure.md).
 *
 * Oracles (never the bitmap itself): the pure core reference (captureMembers over the workspace's rows, read as the
 * owner) and an independent SQL count (EXISTS / NOT EXISTS over contacts, no set algebra, no bitmap). Every count is
 * also checked against the exact production query (bitmapCount: false).
 *
 * Covers: randomized definitions × random mutations through the runtime role (every membership and liveness write
 * kind), state routing (only VALID serves), online rebuild (lease, one rebuilder, generation compare-and-set, takeover,
 * writers during rebuild), the six failure-injection stages, corruption detection by reconciliation (no false
 * invalidation), garbage collection.
 */
import { randomUUID } from 'node:crypto';
import { AudienceResolutionError, captureMembers } from '@workeasy/audience-core';
import { createDatabase, type Database, type TenantContext } from '@workeasy/db';
import { resetTestDatabase, testDatabaseUrls, withOwnerConnection } from '@workeasy/db/testing';
import type { AudienceDefinitionV1, AudienceSelector } from '@workeasy/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type CountRebuildStage,
  gcCountBitmap,
  PrismaAudienceResolution,
  rebuildCountBitmap,
  reconcileCountBitmap,
  runCountMaintenance,
} from '../src/index.js';

const CASES = Number(process.env.BITMAP_CASES ?? 24);
let db: Database;
const user = randomUUID();
const org = randomUUID();
let seed = 6_300_301;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
const sample = <T,>(xs: T[], k: number) => [...xs].sort(() => rnd() - 0.5).slice(0, k);
const bitmap = new PrismaAudienceResolution();
const exact = new PrismaAudienceResolution({ bitmapCount: false });
const code = (e: unknown) => (e instanceof AudienceResolutionError ? e.code : String((e as { code?: string })?.code ?? e));
const silent = { info: () => undefined, error: () => undefined };

interface Ws {
  w: TenantContext & { workspaceId: string };
  lists: string[];
  tags: string[];
  contacts: string[];
}

const scope = (w: Ws['w']) => (tx: unknown) => ({ tx: tx as never, orgId: w.orgId, workspaceId: w.workspaceId });
const stateOf = (ws: string) =>
  withOwnerConnection(async (c) => (await c.query(`SELECT state, generation::int AS generation, reason FROM audience_count_state WHERE workspace_id = $1`, [ws])).rows[0]);
const sql = (w: Ws['w'], q: string, params: unknown[] = []) => db.withTenant(w, (tx) => tx.$executeRawUnsafe(q, ...params));

/** Pure core reference over the workspace's rows. */
async function reference(w: Ws['w'], def: AudienceDefinitionV1): Promise<number | string> {
  const rows = await withOwnerConnection(async (c) => ({
    lists: (await c.query(`SELECT id::text FROM lists WHERE workspace_id = $1 AND deleted_at IS NULL`, [w.workspaceId])).rows.map((r) => r.id as string),
    tags: (await c.query(`SELECT id::text FROM tags WHERE workspace_id = $1 AND deleted_at IS NULL`, [w.workspaceId])).rows.map((r) => r.id as string),
    lm: (await c.query(`SELECT list_id::text AS s, contact_id::text AS c FROM list_memberships WHERE workspace_id = $1`, [w.workspaceId])).rows,
    ct: (await c.query(`SELECT tag_id::text AS s, contact_id::text AS c FROM contact_tags WHERE workspace_id = $1`, [w.workspaceId])).rows,
    live: (await c.query(`SELECT id::text FROM contacts WHERE workspace_id = $1 AND deleted_at IS NULL AND erased_at IS NULL`, [w.workspaceId])).rows.map((r) => r.id as string),
  }));
  const members = new Map<string, string[]>();
  for (const l of rows.lists) members.set(`list:${l}`, []);
  for (const t of rows.tags) members.set(`tag:${t}`, []);
  for (const r of rows.lm) members.get(`list:${r.s}`)?.push(r.c);
  for (const r of rows.ct) members.get(`tag:${r.s}`)?.push(r.c);
  try {
    return captureMembers(def, members, new Set(rows.live)).length;
  } catch (e) {
    return code(e);
  }
}

/** Independent SQL (owner; no set algebra, no bitmap). Only meaningful for a definition whose sources all exist. */
async function independent(w: Ws['w'], def: AudienceDefinitionV1): Promise<number> {
  const ids = (sel: AudienceSelector[], t: 'list' | 'tag') => sel.flatMap((s) => (s.type === 'list' && t === 'list' ? [s.listId] : s.type === 'tag' && t === 'tag' ? [s.tagId] : []));
  return withOwnerConnection(async (c) =>
    Number(
      (
        await c.query(
          `SELECT count(*) AS n FROM contacts c WHERE c.workspace_id = $1 AND c.deleted_at IS NULL AND c.erased_at IS NULL
             AND (EXISTS (SELECT 1 FROM list_memberships m WHERE m.contact_id = c.id AND m.list_id = ANY($2::uuid[]))
               OR EXISTS (SELECT 1 FROM contact_tags m WHERE m.contact_id = c.id AND m.tag_id = ANY($3::uuid[])))
             AND NOT EXISTS (SELECT 1 FROM list_memberships m WHERE m.contact_id = c.id AND m.list_id = ANY($4::uuid[]))
             AND NOT EXISTS (SELECT 1 FROM contact_tags m WHERE m.contact_id = c.id AND m.tag_id = ANY($5::uuid[]))`,
          [w.workspaceId, ids(def.include, 'list'), ids(def.include, 'tag'), ids(def.exclude, 'list'), ids(def.exclude, 'tag')],
        )
      ).rows[0].n,
    ),
  );
}

async function countBoth(w: Ws['w'], def: AudienceDefinitionV1) {
  const b = await db.withTenant(w, (tx) => bitmap.countWithPath(scope(w)(tx), def)).then((r) => ({ n: r.count as number | string, path: r.path }), (e) => ({ n: code(e), path: 'error' }));
  const e = await db.withTenant(w, (tx) => exact.countWithPath(scope(w)(tx), def)).then((r) => r.count as number | string, (err) => code(err));
  return { bitmap: b.n, path: b.path, exact: e };
}

/** Asserts bitmap = exact query = core reference (= independent SQL when valid), and that the bitmap path answered. */
async function assertCounts(ws: Ws, defs: AudienceDefinitionV1[], expectPath: 'bitmap' | 'exact' = 'bitmap') {
  for (const def of defs) {
    const ref = await reference(ws.w, def);
    const got = await countBoth(ws.w, def);
    expect(got.bitmap, JSON.stringify(def)).toBe(ref);
    expect(got.exact, JSON.stringify(def)).toBe(ref);
    if (typeof ref === 'number') {
      expect(got.path).toBe(expectPath);
      expect(await independent(ws.w, def)).toBe(ref);
    }
  }
}

async function newWorkspace(i: number, size: number, density = 0.4): Promise<Ws> {
  const w = { orgId: org, workspaceId: randomUUID(), userId: null };
  const contacts = Array.from({ length: size }, () => randomUUID());
  const lists = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => randomUUID());
  const tags = Array.from({ length: Math.floor(rnd() * 3) }, () => randomUUID());
  // Seeded as the owner (outside tenant context): the bitmap is then INVALID and must be rebuilt.
  await withOwnerConnection(async (c) => {
    await c.query(`INSERT INTO workspaces (id, org_id, name, slug) VALUES ($1, $2, $3, $3)`, [w.workspaceId, org, `cb-${i}-${w.workspaceId.slice(0, 6)}`]);
    await c.query(`INSERT INTO contacts (id, org_id, workspace_id, deleted_at, erased_at)
                   SELECT x, $2, $3, CASE WHEN random() < 0.1 THEN now() END, CASE WHEN random() < 0.03 THEN now() END FROM unnest($1::uuid[]) x`, [contacts, org, w.workspaceId]);
    for (const [j, l] of lists.entries()) {
      await c.query(`INSERT INTO lists (id, org_id, workspace_id, name, name_key) VALUES ($1, $2, $3, $4, $4)`, [l, org, w.workspaceId, `l${j}`]);
      await c.query(`INSERT INTO list_memberships (org_id, workspace_id, list_id, contact_id) SELECT $1, $2, $3, x FROM unnest($4::uuid[]) x WHERE random() < $5`, [org, w.workspaceId, l, contacts, density]);
    }
    for (const [j, t] of tags.entries()) {
      await c.query(`INSERT INTO tags (id, org_id, workspace_id, name, name_key) VALUES ($1, $2, $3, $4, $4)`, [t, org, w.workspaceId, `t${j}`]);
      await c.query(`INSERT INTO contact_tags (org_id, workspace_id, tag_id, contact_id) SELECT $1, $2, $3, x FROM unnest($4::uuid[]) x WHERE random() < $5`, [org, w.workspaceId, t, contacts, density]);
    }
  });
  return { w, lists, tags, contacts };
}

function randomDefinition(ws: Ws): AudienceDefinitionV1 {
  const pool: AudienceSelector[] = [...ws.lists.map((listId) => ({ type: 'list' as const, listId })), ...ws.tags.map((tagId) => ({ type: 'tag' as const, tagId }))];
  const chosen = sample(pool, Math.min(pool.length, 1 + Math.floor(rnd() * 4)));
  const nInc = Math.max(1, Math.ceil(chosen.length * rnd()));
  return { include: chosen.slice(0, nInc), exclude: chosen.slice(nInc) };
}

/** One random write through the runtime role, in context — the same statements the Audience services issue. */
async function randomMutation(ws: Ws): Promise<string> {
  const { w } = ws;
  const some = (k: number) => sample(ws.contacts, Math.max(1, Math.floor(rnd() * k))).sort();
  const src = rnd() < 0.6 || !ws.tags.length ? { t: 'list_memberships', col: 'list_id', id: pick(ws.lists) } : { t: 'contact_tags', col: 'tag_id', id: pick(ws.tags) };
  switch (pick(['add', 'add', 'remove', 'remove', 'create', 'delete', 'restore', 'erase', 'move'] as const)) {
    case 'add':
      await sql(w, `INSERT INTO ${src.t} (org_id, workspace_id, ${src.col}, contact_id) SELECT $1, $2, $3, x FROM unnest($4::uuid[]) x ON CONFLICT DO NOTHING`, [w.orgId, w.workspaceId, src.id, some(40)]);
      return 'add';
    case 'remove':
      await sql(w, `DELETE FROM ${src.t} WHERE ${src.col} = $1 AND contact_id = ANY($2::uuid[])`, [src.id, some(40)]);
      return 'remove';
    case 'create': {
      const ids = Array.from({ length: 1 + Math.floor(rnd() * 20) }, () => randomUUID());
      await db.withTenant(w, async (tx) => {
        await tx.$executeRawUnsafe(`INSERT INTO contacts (id, org_id, workspace_id) SELECT x, $2, $3 FROM unnest($1::uuid[]) x`, ids, w.orgId, w.workspaceId);
        await tx.$executeRawUnsafe(`INSERT INTO ${src.t} (org_id, workspace_id, ${src.col}, contact_id) SELECT $1, $2, $3, x FROM unnest($4::uuid[]) x`, w.orgId, w.workspaceId, src.id, ids);
      });
      ws.contacts.push(...ids);
      return 'create';
    }
    case 'delete':
      await sql(w, `UPDATE contacts SET deleted_at = now() WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`, [some(10)]);
      return 'delete';
    case 'restore':
      await sql(w, `UPDATE contacts SET deleted_at = NULL WHERE id = ANY($1::uuid[]) AND erased_at IS NULL`, [some(10)]);
      return 'restore';
    case 'erase':
      await sql(w, `UPDATE contacts SET erased_at = now(), deleted_at = coalesce(deleted_at, now()) WHERE id = $1 AND erased_at IS NULL`, [pick(ws.contacts)]);
      return 'erase';
    case 'move': {
      // remove + add in one transaction (list/tag replacement)
      const ids = some(20);
      await db.withTenant(w, async (tx) => {
        await tx.$executeRawUnsafe(`DELETE FROM list_memberships WHERE list_id = $1 AND contact_id = ANY($2::uuid[])`, ws.lists[0], ids);
        await tx.$executeRawUnsafe(`INSERT INTO list_memberships (org_id, workspace_id, list_id, contact_id) SELECT $1, $2, $3, x FROM unnest($4::uuid[]) x ON CONFLICT DO NOTHING`, w.orgId, w.workspaceId, pick(ws.lists), ids);
      });
      return 'move';
    }
  }
}

/** Background writer through the runtime role; stop() before any assertion (oracle and count must see the same data). */
function startWriter(ws: Ws, errors: string[]) {
  let stop = false;
  const done = (async () => {
    while (!stop) await randomMutation(ws).catch((e) => errors.push(code(e)));
  })();
  return { stop: async () => ((stop = true), await done) };
}

async function corruptAndReconcile(ws: Ws, sqlText: string) {
  await withOwnerConnection((c) => c.query(sqlText, [ws.w.workspaceId]));
  return reconcileCountBitmap(db, ws.w);
}

beforeAll(async () => {
  await resetTestDatabase();
  await withOwnerConnection(async (c) => {
    await c.query(`INSERT INTO users (id, email, email_normalized, display_name) VALUES ($1, 'cbm@x.test', 'cbm@x.test', 'CBM')`, [user]);
    await c.query(`INSERT INTO organizations (id, name, slug, created_by_user_id) VALUES ($1, 'cbm-org', 'cbm-org', $2)`, [org, user]);
  });
  db = createDatabase({ url: testDatabaseUrls().app, maxConnections: 8 });
});

afterAll(async () => {
  await db?.disconnect();
  await resetTestDatabase();
});

describe('state routing', () => {
  it('only a VALID bitmap answers; INVALID, REBUILDING and a missing state row use the exact query; both are exact', async () => {
    const ws = await newWorkspace(0, 300);
    const def: AudienceDefinitionV1 = { include: [{ type: 'list', listId: ws.lists[0]! }], exclude: [] };
    expect((await stateOf(ws.w.workspaceId)).state).toBe('invalid'); // seeded outside tenant context
    await assertCounts(ws, [def], 'exact');
    expect((await rebuildCountBitmap(db, ws.w)).outcome).toBe('published');
    await assertCounts(ws, [def], 'bitmap');
    await withOwnerConnection((c) => c.query(`UPDATE audience_count_state SET state = 'rebuilding', rebuild_token = gen_random_uuid(), rebuild_lease_until = now() + interval '1 minute' WHERE workspace_id = $1`, [ws.w.workspaceId]));
    await assertCounts(ws, [def], 'exact');
    await withOwnerConnection((c) => c.query(`DELETE FROM audience_count_state WHERE workspace_id = $1`, [ws.w.workspaceId]));
    await assertCounts(ws, [def], 'exact');
    expect((await rebuildCountBitmap(db, ws.w)).outcome).toBe('published'); // recreates the state row
    await assertCounts(ws, [def], 'bitmap');
  });

  it('validation errors and missing sources are reported identically on both paths (no count on bad input)', async () => {
    const ws = await newWorkspace(1, 50);
    await rebuildCountBitmap(db, ws.w);
    const missing: AudienceDefinitionV1 = { include: [{ type: 'list', listId: randomUUID() }], exclude: [] };
    const conflicting: AudienceDefinitionV1 = { include: [{ type: 'list', listId: ws.lists[0]! }], exclude: [{ type: 'list', listId: ws.lists[0]! }] };
    for (const def of [missing, conflicting, { include: [], exclude: [] }]) {
      const got = await countBoth(ws.w, def as AudienceDefinitionV1);
      expect(got.bitmap).toBe(got.exact);
      expect(typeof got.bitmap).toBe('string');
    }
    // a soft-deleted list is reported missing on the bitmap path too, although its chunks still exist
    await sql(ws.w, `UPDATE lists SET deleted_at = now(), name_key = NULL WHERE id = $1`, [ws.lists[0]]);
    expect((await countBoth(ws.w, { include: [{ type: 'list', listId: ws.lists[0]! }], exclude: [] })).bitmap).toBe('AUDIENCE_SOURCE_NOT_FOUND');
  });

  it('the cap applies identically: capped counts never exceed the cap', async () => {
    const ws = await newWorkspace(2, 400, 0.9);
    await rebuildCountBitmap(db, ws.w);
    const def: AudienceDefinitionV1 = { include: [{ type: 'list', listId: ws.lists[0]! }], exclude: [] };
    const b = await db.withTenant(ws.w, (tx) => bitmap.countWithPath(scope(ws.w)(tx), def, { cap: 10 }));
    const e = await db.withTenant(ws.w, (tx) => exact.countWithPath(scope(ws.w)(tx), def, { cap: 10 }));
    expect([b.path, b.count, b.capped]).toEqual(['bitmap', 10, true]);
    expect([e.path, e.count, e.capped]).toEqual(['exact', 10, true]);
  });
});

describe('randomized correctness under writes', () => {
  it(`${CASES} random workspaces × random writes of every kind: bitmap = core reference = independent SQL = exact query, bitmap stays VALID`, async () => {
    const kinds = new Map<string, number>();
    let checks = 0;
    for (let i = 0; i < CASES; i++) {
      const ws = await newWorkspace(100 + i, Math.floor(rnd() * 400) + (i % 4 === 0 ? 4_200 : 0)); // some span > 1 chunk
      expect((await rebuildCountBitmap(db, ws.w)).outcome).toBe('published');
      const defs = Array.from({ length: 4 }, () => randomDefinition(ws));
      await assertCounts(ws, defs);
      for (let round = 0; round < 6; round++) {
        for (let k = 0; k < 3; k++) {
          const kind = await randomMutation(ws);
          kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
        }
        expect((await stateOf(ws.w.workspaceId)).state).toBe('valid');
        await assertCounts(ws, defs);
        checks += defs.length;
      }
      // reconciliation of a correctly maintained bitmap: no difference, no invalidation (no false positive)
      const r = await reconcileCountBitmap(db, ws.w);
      expect(r).toMatchObject({ ok: true, sourceDiff: 0, deadDiff: 0, positionsMissing: 0 });
      expect((await stateOf(ws.w.workspaceId)).state).toBe('valid');
    }
    console.log('randomized', { workspaces: CASES, checks, kinds: Object.fromEntries(kinds) });
    for (const k of ['add', 'remove', 'create', 'delete', 'restore', 'erase', 'move']) expect(kinds.get(k) ?? 0, k).toBeGreaterThan(0);
  }, 600_000);

  it('list and tag deletion (memberships removed, source soft-deleted) keeps every other count exact; GC then removes the zero chunks', async () => {
    const ws = await newWorkspace(3, 4_500, 0.5);
    await rebuildCountBitmap(db, ws.w);
    const keep = randomDefinition(ws);
    const victim = ws.lists.at(-1)!;
    await db.withTenant(ws.w, async (tx) => {
      await tx.$executeRawUnsafe(`DELETE FROM list_memberships WHERE list_id = $1`, victim);
      await tx.$executeRawUnsafe(`UPDATE lists SET deleted_at = now(), name_key = NULL WHERE id = $1`, victim);
    });
    const zero = () => withOwnerConnection(async (c) => (await c.query(`SELECT count(*)::int AS n FROM audience_count_source_chunks WHERE workspace_id = $1 AND bit_count(bits) = 0`, [ws.w.workspaceId])).rows[0].n);
    expect(await zero()).toBeGreaterThan(0);
    ws.lists = ws.lists.filter((l) => l !== victim);
    if (ws.lists.length) await assertCounts(ws, [randomDefinition(ws)]);
    // GC in another workspace never touches this one (tenant scoped)
    const other = await newWorkspace(4, 10);
    expect((await gcCountBitmap(db, other.w)).deleted).toBe(0);
    expect(await zero()).toBeGreaterThan(0);
    const first = await gcCountBitmap(db, ws.w);
    expect(first.deleted).toBeGreaterThan(0);
    expect(await zero()).toBe(0);
    expect(await gcCountBitmap(db, ws.w)).toEqual({ deleted: 0, busy: 0 }); // repeatable
    expect((await reconcileCountBitmap(db, ws.w)).ok).toBe(true);
    if (keep.include.every((s) => s.type !== 'list' || s.listId !== victim) && keep.exclude.every((s) => s.type !== 'list' || s.listId !== victim)) await assertCounts(ws, [keep]);
  }, 120_000);

  it('GC skips a chunk a writer holds (never queues), and a later run deletes it', async () => {
    const ws = await newWorkspace(5, 100, 1);
    await rebuildCountBitmap(db, ws.w);
    await sql(ws.w, `DELETE FROM list_memberships WHERE list_id = $1`, [ws.lists[0]]);
    const seq = await withOwnerConnection(async (c) => (await c.query(`SELECT min(seq) AS s FROM audience_count_contact_seq WHERE workspace_id = $1`, [ws.w.workspaceId])).rows[0].s);
    // a writer's shared chunk lock, held in another session
    const busy = await withOwnerConnection(async (holder) => {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text || ':' || ($2::bigint / 4096)::text, 6301))`, [ws.lists[0], seq]);
      const t0 = Date.now();
      const r = await gcCountBitmap(db, ws.w);
      expect(Date.now() - t0).toBeLessThan(2_000);
      await holder.query('ROLLBACK');
      return r;
    });
    expect(busy.busy).toBeGreaterThan(0);
    expect((await gcCountBitmap(db, ws.w)).deleted).toBeGreaterThan(0);
  });
});

describe('online rebuild', () => {
  it('one rebuilder per workspace: a live lease makes a second rebuild return busy; an expired lease is taken over and the stale owner cannot publish', async () => {
    const ws = await newWorkspace(6, 200);
    const a = randomUUID();
    const gA = await db.withTenant(ws.w, async (tx) => (await tx.$queryRawUnsafe<{ g: bigint }[]>(`SELECT app.audience_count_begin_rebuild($1::uuid, 1) AS g`, a))[0]!.g);
    expect(gA).not.toBeNull();
    // concurrently started rebuilds while A's lease is live
    const [r1, r2] = await Promise.all([rebuildCountBitmap(db, ws.w), rebuildCountBitmap(db, ws.w)]);
    expect([r1.outcome, r2.outcome]).toEqual(['busy', 'busy']);
    await new Promise((r) => setTimeout(r, 1_200));
    const both = await Promise.all([rebuildCountBitmap(db, ws.w), rebuildCountBitmap(db, ws.w)]);
    expect(both.map((x) => x.outcome).sort()).toEqual(['busy', 'published']);
    // the expired owner's completion is refused by the generation/token compare-and-set
    const late = await db.withTenant(ws.w, async (tx) => (await tx.$queryRawUnsafe<{ f: { published: boolean; superseded: boolean } }[]>(`SELECT app.audience_count_finish_rebuild($1::uuid, $2::bigint) AS f`, a, gA))[0]!.f);
    expect(late).toMatchObject({ published: false, superseded: true });
    expect((await stateOf(ws.w.workspaceId)).state).toBe('valid');
  });

  it('rebuild from empty: a workspace without contacts publishes VALID; an existing empty source counts 0 on the bitmap', async () => {
    const ws = await newWorkspace(9, 0);
    const r = await rebuildCountBitmap(db, ws.w);
    expect(r).toMatchObject({ outcome: 'published', chunks: 0 });
    // an empty audience: an existing list with no member (never "missing")
    await assertCounts(ws, [{ include: [{ type: 'list', listId: ws.lists[0]! }], exclude: [] }]);
    expect((await countBoth(ws.w, { include: [{ type: 'list', listId: ws.lists[0]! }], exclude: [] })).bitmap).toBe(0);
  });

  it('writes at a chunk boundary during the rebuild (last position of one chunk, first of the next) are kept exactly', async () => {
    const ws = await newWorkspace(10, 4_600, 0.3);
    // positions are given in contact-id order by the first rebuild; find the two contacts on each side of a boundary
    expect((await rebuildCountBitmap(db, ws.w)).outcome).toBe('published');
    const edge = await withOwnerConnection(async (c) =>
      (
        await c.query(
          `SELECT contact_id::text AS id, seq FROM audience_count_contact_seq WHERE workspace_id = $1
             AND seq IN (SELECT (min(seq) / 4096 + 1) * 4096 - 1 FROM audience_count_contact_seq WHERE workspace_id = $1
                         UNION SELECT (min(seq) / 4096 + 1) * 4096 FROM audience_count_contact_seq WHERE workspace_id = $1) ORDER BY seq`,
          [ws.w.workspaceId],
        )
      ).rows.map((r) => r.id as string),
    );
    expect(edge).toHaveLength(2);
    const list = ws.lists[0]!;
    await withOwnerConnection((c) => c.query(`UPDATE audience_count_state SET state = 'invalid' WHERE workspace_id = $1`, [ws.w.workspaceId]));
    const r = await rebuildCountBitmap(db, ws.w, {
      onStage: async (s) => {
        if (s === 'first-chunk') {
          // between chunk repairs: toggle both boundary contacts' membership, delete one of them
          await sql(ws.w, `DELETE FROM list_memberships WHERE list_id = $1 AND contact_id = ANY($2::uuid[])`, [list, edge]);
          await sql(ws.w, `INSERT INTO list_memberships (org_id, workspace_id, list_id, contact_id) SELECT $1, $2, $3, x FROM unnest($4::uuid[]) x`, [ws.w.orgId, ws.w.workspaceId, list, edge]);
          await sql(ws.w, `UPDATE contacts SET deleted_at = now(), erased_at = NULL WHERE id = $1`, [edge[1]]);
        }
      },
    });
    expect(r.outcome).toBe('published');
    await assertCounts(ws, [{ include: [{ type: 'list', listId: list }], exclude: [] }, randomDefinition(ws)]);
    expect((await reconcileCountBitmap(db, ws.w)).ok).toBe(true);
  });

  it('generation compare-and-set: an invalidation committed during the rebuild prevents VALID even though verification passes', async () => {
    const ws = await newWorkspace(7, 300);
    // The seed marks ~10 % deleted and ~3 % erased at random; only a LIVE contact's deletion changes liveness (and so
    // must invalidate). Picking an already non-live contact made this test fail ~13 % of runs while the product was
    // right (docs/audit/phase-6.7-6.8-preflight-lifecycle.md §9).
    const live = await withOwnerConnection(async (c) =>
      (await c.query(`SELECT id FROM contacts WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL AND erased_at IS NULL LIMIT 1`, [ws.contacts])).rows[0].id as string,
    );
    const r = await rebuildCountBitmap(db, ws.w, {
      onStage: async (s) => {
        // an owner-session write (outside tenant context) invalidates mid-rebuild
        if (s === 'repaired') await withOwnerConnection((c) => c.query(`UPDATE contacts SET deleted_at = now() WHERE id = $1`, [live]));
      },
    });
    expect(r.outcome).toBe('superseded');
    expect((await stateOf(ws.w.workspaceId)).state).toBe('invalid');
    await assertCounts(ws, [randomDefinition(ws)], 'exact');
    expect((await rebuildCountBitmap(db, ws.w)).outcome).toBe('published');
    await assertCounts(ws, [randomDefinition(ws)], 'bitmap');
  });

  it('writers keep working during an online rebuild (no errors, no blocking), and the published bitmap is exact', async () => {
    const ws = await newWorkspace(8, 12_000, 0.3);
    let stop = false;
    const errors: string[] = [];
    let writes = 0;
    const lat: number[] = [];
    const writer = async () => {
      while (!stop) {
        const t0 = performance.now();
        try {
          await randomMutation(ws);
          writes++;
        } catch (e) {
          errors.push(code(e));
        }
        lat.push(performance.now() - t0);
      }
    };
    const writers = [writer(), writer(), writer()];
    const r = await rebuildCountBitmap(db, ws.w).finally(() => (stop = true));
    await Promise.all(writers);
    expect(r.outcome).toBe('published');
    expect(errors).toEqual([]);
    lat.sort((x, y) => x - y);
    console.log('online rebuild under writers', { ...r, writes, p50: lat[Math.floor(lat.length * 0.5)]?.toFixed(1), p99: lat[Math.floor(lat.length * 0.99)]?.toFixed(1), max: lat.at(-1)?.toFixed(1) });
    expect((await stateOf(ws.w.workspaceId)).state).toBe('valid');
    expect((await reconcileCountBitmap(db, ws.w)).ok).toBe(true);
    await assertCounts(ws, Array.from({ length: 4 }, () => randomDefinition(ws)));
  }, 300_000);

  it('a chunk that hits its statement timeout is retried, then reported incomplete — never an error; a later run publishes', async () => {
    const ws = await newWorkspace(30, 6_000, 0.4);
    // Every chunk repair times out (1 ms): before 2026-10-10 the first timeout aborted the rebuild with an error.
    const r = await rebuildCountBitmap(db, ws.w, { chunkTimeoutMs: 1, maxPasses: 2, lockWaitMs: 10, leaseSeconds: 1 });
    expect(r.outcome).toBe('incomplete');
    expect((await stateOf(ws.w.workspaceId)).state).not.toBe('valid'); // never served while incomplete
    // The incomplete run keeps its lease until it expires (by design: "a later run takes over").
    expect((await rebuildCountBitmap(db, ws.w)).outcome).toBe('busy');
    await new Promise((res) => setTimeout(res, 1_500));
    expect((await rebuildCountBitmap(db, ws.w)).outcome).toBe('published');
    expect((await stateOf(ws.w.workspaceId)).state).toBe('valid');
    await assertCounts(ws, Array.from({ length: 3 }, () => randomDefinition(ws)), 'bitmap');
  }, 300_000);

  describe('failure injection: the rebuild dies at each stage; never served while stale; deterministic recovery', () => {
    const stages: (CountRebuildStage | 'finish')[] = ['begun', 'first-chunk', 'halfway', 'repaired', 'finish', 'published'];
    for (const stage of stages) {
      it(`stage: ${stage}`, async () => {
        const ws = await newWorkspace(20 + stages.indexOf(stage), 9_000, 0.4);
        expect((await rebuildCountBitmap(db, ws.w)).outcome).toBe('published');
        const defs = Array.from({ length: 3 }, () => randomDefinition(ws));
        // guard-bypassing corruption (owner DML on the bitmap) → reconciliation detects it → INVALID
        const rec = await corruptAndReconcile(ws, `UPDATE audience_count_source_chunks SET bits = repeat('0', 4096)::varbit WHERE workspace_id = $1 AND chunk = (SELECT min(chunk) FROM audience_count_source_chunks WHERE workspace_id = $1 AND bit_count(bits) > 0)`);
        expect(rec.ok).toBe(false);
        expect((await stateOf(ws.w.workspaceId)).state).toBe('invalid');

        const errors: string[] = [];
        let writer = startWriter(ws, errors);
        const crash = new Error(`injected crash at ${stage}`);
        const outcome = await rebuildCountBitmap(db, ws.w, {
          leaseSeconds: 2,
          onStage: async (s) => {
            if (stage === 'finish' && s === 'repaired') {
              // the final verification starts, then its transaction dies before commit
              await db.withTenant(ws.w, async (tx) => {
                await tx.$queryRawUnsafe(`SELECT app.audience_count_finish_rebuild(rebuild_token, generation) FROM audience_count_state`);
                throw crash;
              }).catch(() => undefined);
              throw crash;
            }
            if (s === stage) throw crash;
          },
        })
          .catch((e) => (e === crash ? 'crashed' : Promise.reject(e)))
          .finally(() => writer.stop());
        expect(outcome).toBe('crashed');
        const after = await stateOf(ws.w.workspaceId);
        if (stage === 'published') {
          expect(after.state).toBe('valid'); // the crash came after a verified publish: the bitmap is correct
          await assertCounts(ws, defs, 'bitmap');
        } else {
          expect(after.state).not.toBe('valid');
          await assertCounts(ws, defs, 'exact'); // not served while stale
        }
        // recovery: the same procedure every time (after the dead rebuilder's lease expires)
        await new Promise((r) => setTimeout(r, 2_100));
        writer = startWriter(ws, errors);
        const rec2 = await rebuildCountBitmap(db, ws.w).finally(() => writer.stop());
        expect(rec2.outcome).toBe('published');
        expect(errors).toEqual([]);
        // the recovery published a NEW generation (never the failed rebuild's)
        const final = await stateOf(ws.w.workspaceId);
        expect(final.state).toBe('valid');
        expect(final.generation).toBeGreaterThan(after.generation);
        expect((await reconcileCountBitmap(db, ws.w)).ok).toBe(true);
        await assertCounts(ws, defs, 'bitmap');
      }, 180_000);
    }
  });
});

describe('reconciliation', () => {
  it('detects every corruption kind (→ INVALID), and the maintenance run rebuilds it to a verified VALID bitmap', async () => {
    const ws = await newWorkspace(40, 9_000, 0.4);
    await sql(ws.w, `UPDATE contacts SET deleted_at = now() WHERE id = ANY($1::uuid[])`, [ws.contacts.slice(0, 50)]);
    expect((await rebuildCountBitmap(db, ws.w)).outcome).toBe('published');
    const defs = Array.from({ length: 3 }, () => randomDefinition(ws));
    const kinds: [string, string, keyof Awaited<ReturnType<typeof reconcileCountBitmap>>][] = [
      ['flipped source bit', `UPDATE audience_count_source_chunks SET bits = set_bit(bits, 7, 1 - get_bit(bits, 7)) WHERE workspace_id = $1 AND chunk = (SELECT min(chunk) FROM audience_count_source_chunks WHERE workspace_id = $1 AND bit_count(bits) > 0)`, 'sourceDiff'],
      ['missing source chunk', `DELETE FROM audience_count_source_chunks WHERE ctid = (SELECT ctid FROM audience_count_source_chunks WHERE workspace_id = $1 AND bit_count(bits) > 0 LIMIT 1)`, 'sourceDiff'],
      ['extra source chunk', `INSERT INTO audience_count_source_chunks (org_id, workspace_id, source_id, chunk, bits) SELECT org_id, workspace_id, gen_random_uuid(), 0, set_bit(repeat('0', 4096)::varbit, 1, 1) FROM audience_count_state WHERE workspace_id = $1`, 'sourceDiff'],
      ['stale chunk (bits of another chunk)', `UPDATE audience_count_source_chunks s SET bits = repeat('1', 4096)::varbit WHERE workspace_id = $1 AND chunk = (SELECT max(chunk) FROM audience_count_source_chunks WHERE workspace_id = $1)`, 'sourceDiff'],
      ['dead bit cleared', `UPDATE audience_count_dead_chunks SET bits = repeat('0', 4096)::varbit WHERE workspace_id = $1`, 'deadDiff'],
      ['stale dead bit', `UPDATE audience_count_dead_chunks SET bits = repeat('1', 4096)::varbit WHERE workspace_id = $1`, 'deadDiff'],
      ['position lost', `DELETE FROM audience_count_contact_seq WHERE contact_id = (SELECT contact_id FROM audience_count_contact_seq WHERE workspace_id = $1 LIMIT 1)`, 'positionsMissing'],
    ];
    const detected: string[] = [];
    for (const [name, corruption, field] of kinds) {
      const r = await corruptAndReconcile(ws, corruption);
      expect(r.ok, name).toBe(false);
      expect(Number(r[field]), name).toBeGreaterThan(0);
      expect((await stateOf(ws.w.workspaceId)).state, name).toBe('invalid');
      await assertCounts(ws, defs, 'exact');
      const alerts: Record<string, unknown>[] = [];
      const report = await runCountMaintenance(db, { info: () => undefined, error: (o) => alerts.push(o) }, { limit: 1_000 });
      expect(report.errors, name).toBe(0);
      expect((await stateOf(ws.w.workspaceId)).state, name).toBe('valid');
      await assertCounts(ws, defs, 'bitmap');
      detected.push(name);
    }
    expect(detected).toHaveLength(kinds.length);
  }, 300_000);

  it('the maintenance run reconciles VALID bitmaps once per period, records the time, and alerts on a mismatch', async () => {
    const ws = await newWorkspace(41, 500);
    await rebuildCountBitmap(db, ws.w);
    const last = () => withOwnerConnection(async (c) => (await c.query(`SELECT last_reconciled_at, last_reconcile_result FROM audience_count_state WHERE workspace_id = $1`, [ws.w.workspaceId])).rows[0]);
    const t0 = (await last()).last_reconciled_at as Date;
    // not due within 24 h
    await runCountMaintenance(db, silent, { limit: 1_000 });
    expect((await last()).last_reconciled_at).toEqual(t0);
    // due 25 h later
    const later = new Date(Date.now() + 25 * 3_600_000);
    const report = await runCountMaintenance(db, silent, { now: later, limit: 1_000 });
    expect(report.reconciled).toBeGreaterThan(0);
    expect(report.reconcileFailures).toBe(0);
    const l = await last();
    expect((l.last_reconciled_at as Date).getTime()).toBeGreaterThan(t0.getTime());
    expect(l.last_reconcile_result).toMatchObject({ ok: true });
    // mismatch → alert at error level (ids only) → rebuilt
    await withOwnerConnection((c) => c.query(`UPDATE audience_count_source_chunks SET bits = set_bit(bits, 3, 1 - get_bit(bits, 3)) WHERE workspace_id = $1 AND chunk = (SELECT min(chunk) FROM audience_count_source_chunks WHERE workspace_id = $1 AND bit_count(bits) > 0)`, [ws.w.workspaceId]));
    const alerts: Record<string, unknown>[] = [];
    const r2 = await runCountMaintenance(db, { info: () => undefined, error: (o) => alerts.push(o) }, { now: new Date(Date.now() + 50 * 3_600_000), limit: 1_000 });
    expect(r2.reconcileFailures).toBe(1);
    expect(alerts.filter((a) => a.alert === 'audience_count_reconcile_mismatch')).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ orgId: org, workspaceId: ws.w.workspaceId });
    expect((await stateOf(ws.w.workspaceId)).state).toBe('valid');
  }, 120_000);
});
