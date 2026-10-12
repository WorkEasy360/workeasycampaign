/**
 * Opt-in benchmark for milestone 6.3.10 (decision N: targets are gates, never assumed). Not part of the default suite:
 *   AUDIENCE_SCALE=1 [AUDIENCE_SCALE_SIZES=100000,500000,1000000] pnpm --filter @workeasy/audience-infra exec vitest run test/audience-scale.test.ts
 * Prints one JSON line per measurement (prefix BENCH) for docs/audit. Seeds through the owner connection with
 * generate_series; measures through the real adapter as workeasy_app inside withTenant.
 *
 * Dataset per size N (≈ N captured members): 5 include lists (every contact in one, 20 % also in a second — overlap),
 * 1 include tag (10 %), 1 exclusion list (5 %), 1 % deleted contacts, an email identity per contact, and eligibility
 * facts (consent event + state, topic preference, 5 % suppressed) for a 5,000-contact sample. A noise workspace with
 * 500,000 contacts in another organization shares the tables.
 */
import { randomUUID } from 'node:crypto';
import { EligibilityEvaluator } from '@workeasy/audience-core';
import { createDatabase, type Database, type TenantContext, type Tx } from '@workeasy/db';
import { resetTestDatabase, testDatabaseUrls, withOwnerConnection } from '@workeasy/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CAPTURE_TRANSACTION_TIMEOUT_MS,
  PrismaAudienceResolution,
  PrismaEligibilityFactsReader,
  purgeUntilDone,
  rebuildCountBitmap,
  reconcileCountBitmap,
} from '../src/index.js';

/** AUDIENCE_SCALE_BITMAP_ONLY=1: per size, only seed + the count bitmap section (diagnosis runs). */
const BITMAP_ONLY = !!process.env.AUDIENCE_SCALE_BITMAP_ONLY;
const REUSE_5M = !!process.env.AUDIENCE_SCALE_REUSE_5M;
const SIZES = (process.env.AUDIENCE_SCALE_SIZES ?? '100000,500000,1000000').split(',').filter(Boolean).map(Number);
/** Members for the capture-limit test (AUDIENCE_SCALE_LIMIT=1): just above the frozen 5,000,000 limit. */
const LIMIT_MEMBERS = Number(process.env.AUDIENCE_SCALE_LIMIT_MEMBERS ?? 5_000_001);
const ELIGIBILITY_SAMPLE = 5_000;
const NOISE = Number(process.env.AUDIENCE_SCALE_NOISE ?? 500_000);
const CONCURRENT = Number(process.env.AUDIENCE_SCALE_CONCURRENT ?? 500_000);
const ms = (t0: bigint) => Number(process.hrtime.bigint() - t0) / 1e6;
const pct = (xs: number[], p: number) => Float64Array.from(xs).sort()[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)]!;
const stats = (xs: number[]) => ({ n: xs.length, p50: +pct(xs, 50).toFixed(1), p95: +pct(xs, 95).toFixed(1), p99: +pct(xs, 99).toFixed(1), max: +xs.reduce((m, x) => Math.max(m, x), -Infinity).toFixed(1) });
const report = (name: string, data: Record<string, unknown>) => console.log(`BENCH ${JSON.stringify({ name, ...data })}`);

let db: Database;
const resolution = new PrismaAudienceResolution();
const USER = randomUUID();

interface Seeded {
  ws: TenantContext;
  lists: string[];
  tag: string;
  exclusion: string;
  topic: string;
  sample: string[];
}

async function seedWorkspace(contacts: number, opts: { eligibility: boolean }): Promise<Seeded> {
  const org = randomUUID();
  const ws: TenantContext = { orgId: org, workspaceId: randomUUID(), userId: null };
  const lists = Array.from({ length: 5 }, () => randomUUID());
  const [tag, exclusion, topic] = [randomUUID(), randomUUID(), randomUUID()];
  let sample: string[] = [];
  await withOwnerConnection(async (c) => {
    const q = (sql: string, v: unknown[] = []) => c.query(sql, v);
    await q(`SET statement_timeout = 0`);
    await q(`INSERT INTO organizations (id, name, slug, created_by_user_id) VALUES ($1, $2, $2, $3)`, [org, `bench-${org.slice(0, 8)}`, USER]);
    await q(`INSERT INTO workspaces (id, org_id, name, slug) VALUES ($1, $2, 'bench', 'bench')`, [ws.workspaceId, org]);
    await q('BEGIN');
    await q(`CREATE TEMP TABLE tmp_c2 (g int, id uuid) ON COMMIT DROP`);
    await q(`INSERT INTO tmp_c2 SELECT g, gen_random_uuid() FROM generate_series(1, $1::int) g`, [contacts]);
    await q(`INSERT INTO contacts (id, org_id, workspace_id, deleted_at) SELECT id, $1::uuid, $2::uuid, CASE WHEN g % 100 = 0 THEN now() END FROM tmp_c2`, [org, ws.workspaceId]);
    // fresh statistics before the FK-checked inserts: with stale "0 rows" statistics the cached FK-check plan becomes a
    // sequential scan of contacts per row (quadratic seeding, MEASURED: 50k identities 57 s)
    await q(`ANALYZE contacts`);
    await q(
      `INSERT INTO contact_identities (id, org_id, workspace_id, contact_id, kind, value, value_normalized, is_primary)
       SELECT gen_random_uuid(), $1::uuid, $2::uuid, id, 'email', 'u' || g || '@bench.test', 'u' || g || '@bench.test', true FROM tmp_c2`,
      [org, ws.workspaceId],
    );
    for (const [i, l] of lists.entries()) await q(`INSERT INTO lists (id, org_id, workspace_id, name, name_key) VALUES ($1, $2, $3, $4, $4)`, [l, org, ws.workspaceId, `list-${i}`]);
    await q(`INSERT INTO lists (id, org_id, workspace_id, name, name_key) VALUES ($1, $2, $3, 'exclude', 'exclude')`, [exclusion, org, ws.workspaceId]);
    await q(`INSERT INTO tags (id, org_id, workspace_id, name, name_key) VALUES ($1, $2, $3, 'tag', 'tag')`, [tag, org, ws.workspaceId]);
    await q(
      `INSERT INTO list_memberships (org_id, workspace_id, list_id, contact_id)
       SELECT $1::uuid, $2::uuid, ($3::uuid[])[(g % 5) + 1], id FROM tmp_c2
       UNION ALL SELECT $1::uuid, $2::uuid, ($3::uuid[])[((g + 1) % 5) + 1], id FROM tmp_c2 WHERE g % 5 = 0
       UNION ALL SELECT $1::uuid, $2::uuid, $4::uuid, id FROM tmp_c2 WHERE g % 20 = 7`,
      [org, ws.workspaceId, lists, exclusion],
    );
    await q(`INSERT INTO contact_tags (org_id, workspace_id, tag_id, contact_id) SELECT $1::uuid, $2::uuid, $3::uuid, id FROM tmp_c2 WHERE g % 10 = 3`, [org, ws.workspaceId, tag]);
    if (opts.eligibility) {
      await q(`INSERT INTO topics (id, org_id, workspace_id, key, name, is_default) VALUES ($1, $2, $3, 'news', 'News', true)`, [topic, org, ws.workspaceId]);
      await q(`CREATE TEMP TABLE tmp_s ON COMMIT DROP AS SELECT g, id, gen_random_uuid() AS ev FROM tmp_c2 WHERE g % 100 <> 0 ORDER BY g LIMIT $1::int`, [ELIGIBILITY_SAMPLE]);
      await q(
        `INSERT INTO consent_events (id, org_id, workspace_id, contact_id, channel, action, previous_state, new_state, source, actor_type, correlation_id, occurred_at, subject_fingerprint)
         SELECT ev, $1::uuid, $2::uuid, id, 'email', 'subscribed', 'none', 'granted', 'admin', 'user', gen_random_uuid(), now(), md5(id::text) FROM tmp_s`,
        [org, ws.workspaceId],
      );
      await q(
        `INSERT INTO consent_states (org_id, workspace_id, contact_id, channel, state, changed_by, last_event_id, changed_at, subject_fingerprint)
         SELECT $1::uuid, $2::uuid, id, 'email', CASE WHEN g % 7 = 0 THEN 'withdrawn' ELSE 'granted' END, 'user', ev, now(), md5(id::text) FROM tmp_s`,
        [org, ws.workspaceId],
      );
      await q(
        `INSERT INTO contact_topic_preferences (org_id, workspace_id, contact_id, topic_id, status, changed_by, last_event_id, changed_at)
         SELECT $1::uuid, $2::uuid, id, $3::uuid, CASE WHEN g % 10 = 1 THEN 'unsubscribed' ELSE 'subscribed' END, 'user', ev, now() FROM tmp_s WHERE g % 2 = 0`,
        [org, ws.workspaceId, topic],
      );
      await q(
        `INSERT INTO suppressions (id, org_id, workspace_id, channel, contact_id, reason, source, active_key)
         SELECT gen_random_uuid(), $1::uuid, $2::uuid, 'all', id, 'manual', 'admin', 'contact:' || id || ':all' FROM tmp_s WHERE g % 20 = 0`,
        [org, ws.workspaceId],
      );
      sample = (await q(`SELECT id::text AS id FROM tmp_s`)).rows.map((r: { id: string }) => r.id);
    }
    await q('COMMIT');
  });
  return { ws, lists, tag, exclusion, topic, sample };
}

const inTenant = <T>(ws: TenantContext, fn: (s: { tx: Tx; orgId: string; workspaceId: string }) => Promise<T>) =>
  db.withTenant(ws, (tx) => fn({ tx, orgId: ws.orgId, workspaceId: ws.workspaceId! }), { timeout: CAPTURE_TRANSACTION_TIMEOUT_MS });
const defOf = (s: Seeded) => ({ include: [...s.lists.map((listId) => ({ type: 'list' as const, listId })), { type: 'tag' as const, tagId: s.tag }], exclude: [{ type: 'list' as const, listId: s.exclusion }] });
const dbStats = () =>
  withOwnerConnection(async (c) => (await c.query(`SELECT temp_bytes::bigint AS temp, pg_current_wal_lsn() AS lsn FROM pg_stat_database WHERE datname = current_database()`)).rows[0] as { temp: string; lsn: string });
const walBytes = (a: string, b: string) => withOwnerConnection(async (c) => Number((await c.query(`SELECT pg_wal_lsn_diff($2::pg_lsn, $1::pg_lsn)::bigint AS d`, [a, b])).rows[0].d));
const membersSize = () => withOwnerConnection(async (c) => Number((await c.query(`SELECT pg_total_relation_size('audience_snapshot_chunks')::bigint AS s`)).rows[0].s));

/**
 * Exact set comparison of a captured snapshot against an independent reference computed by the owner with the
 * row-by-row formulation (join to live contacts, NOT EXISTS exclusion) — no set algebra, no chunks. Exact: both
 * EXCEPT directions and duplicates must be 0.
 */
async function exactCompare(s: Seeded, snapshotId: string) {
  return withOwnerConnection(async (c) => {
    await c.query(`SET statement_timeout = 0`);
    await c.query(`SET work_mem = '256MB'`);
    const r = await c.query(
      `WITH ref AS (
         SELECT i.contact_id FROM (
           SELECT contact_id FROM list_memberships WHERE workspace_id = $1 AND list_id = ANY($2::uuid[])
           UNION SELECT contact_id FROM contact_tags WHERE workspace_id = $1 AND tag_id = $3) i
         JOIN contacts c ON c.id = i.contact_id
         WHERE c.workspace_id = $1 AND c.deleted_at IS NULL AND c.erased_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM list_memberships e WHERE e.list_id = $4 AND e.contact_id = i.contact_id)),
       snap AS (SELECT x AS contact_id FROM audience_snapshot_chunks, unnest(contact_ids) AS x WHERE snapshot_id = $5)
       SELECT (SELECT count(*) FROM ref)::int AS reference,
              (SELECT count(*) FROM snap)::int AS snapshot,
              (SELECT count(*) FROM (SELECT contact_id FROM ref EXCEPT SELECT contact_id FROM snap) a)::int AS missing,
              (SELECT count(*) FROM (SELECT contact_id FROM snap EXCEPT SELECT contact_id FROM ref) b)::int AS extra,
              (SELECT count(*) - count(DISTINCT contact_id) FROM snap)::int AS duplicates,
              (SELECT count(*) FROM (SELECT chunk_no, first_contact, lag(last_contact) OVER (ORDER BY chunk_no) AS prev,
                                            chunk_no - lag(chunk_no) OVER (ORDER BY chunk_no) AS step
                                     FROM audience_snapshot_chunks WHERE snapshot_id = $5) o
               WHERE o.prev IS NOT NULL AND (o.first_contact <= o.prev OR o.step <> 1))::int AS order_violations`,
      [s.ws.workspaceId, s.lists, s.tag, s.exclusion, snapshotId],
    );
    return r.rows[0] as { reference: number; snapshot: number; missing: number; extra: number; duplicates: number; order_violations: number };
  });
}

// ─── Count bitmap (Phase 6.3 G2) ────────────────────────────────────────────────────────────────────────────────
const exactOnly = new PrismaAudienceResolution({ bitmapCount: false });
const wsOf = (s: Seeded) => ({ orgId: s.ws.orgId, workspaceId: s.ws.workspaceId! });

/** Definitions checked at scale: the full audience, one list alone, the tag minus the exclusion list. */
const bitmapDefs = (s: Seeded) => [
  { name: 'full', def: defOf(s), incLists: s.lists, incTags: [s.tag], excLists: [s.exclusion] },
  { name: 'one-list', def: { include: [{ type: 'list' as const, listId: s.lists[0]! }], exclude: [] }, incLists: [s.lists[0]!], incTags: [] as string[], excLists: [] as string[] },
  {
    name: 'tag-minus-list',
    def: { include: [{ type: 'tag' as const, tagId: s.tag }], exclude: [{ type: 'list' as const, listId: s.exclusion }] },
    incLists: [] as string[],
    incTags: [s.tag],
    excLists: [s.exclusion],
  },
];

/** Independent exact count (owner; row-by-row EXISTS formulation over live contacts — no set algebra, no bitmap). */
async function independentCount(s: Seeded, d: { incLists: string[]; incTags: string[]; excLists: string[] }) {
  return withOwnerConnection(async (c) => {
    await c.query(`SET statement_timeout = 0`);
    await c.query(`SET work_mem = '256MB'`);
    const r = await c.query(
      `SELECT count(*) AS n FROM contacts c WHERE c.workspace_id = $1 AND c.deleted_at IS NULL AND c.erased_at IS NULL
         AND (EXISTS (SELECT 1 FROM list_memberships m WHERE m.contact_id = c.id AND m.list_id = ANY($2::uuid[]))
           OR EXISTS (SELECT 1 FROM contact_tags m WHERE m.contact_id = c.id AND m.tag_id = ANY($3::uuid[])))
         AND NOT EXISTS (SELECT 1 FROM list_memberships m WHERE m.contact_id = c.id AND m.list_id = ANY($4::uuid[]))`,
      [s.ws.workspaceId, d.incLists, d.incTags, d.excLists],
    );
    return Number(r.rows[0].n);
  });
}

/**
 * Light concurrent writers through the runtime role (the trigger-maintained path): membership add/remove of 50
 * contacts, contact create with a membership, soft delete / restore. Latency per unit of work; errors by SQLSTATE.
 */
function startWriters(s: Seeded, ids: string[], n: number) {
  let stop = false;
  const lat: number[] = [];
  const errors: Record<string, number> = {};
  let k = 0;
  const one = async (w: number) => {
    while (!stop) {
      const i = k++;
      const batch = Array.from({ length: 50 }, (_, j) => ids[(i * 997 + j * 131 + w) % ids.length]!).sort();
      const list = s.lists[i % 5]!;
      const t = process.hrtime.bigint();
      try {
        await db.withTenant(s.ws, async (tx) => {
          const op = i % 5;
          if (op === 0)
            await tx.$executeRawUnsafe(
              `INSERT INTO list_memberships (org_id, workspace_id, list_id, contact_id) SELECT $1, $2, $3, x FROM unnest($4::uuid[]) x ON CONFLICT DO NOTHING`,
              s.ws.orgId, s.ws.workspaceId, list, batch,
            );
          else if (op === 1) await tx.$executeRawUnsafe(`DELETE FROM list_memberships WHERE list_id = $1 AND contact_id = ANY($2::uuid[])`, list, batch);
          else if (op === 2) {
            const id = randomUUID();
            await tx.$executeRawUnsafe(`INSERT INTO contacts (id, org_id, workspace_id) VALUES ($1, $2, $3)`, id, s.ws.orgId, s.ws.workspaceId);
            await tx.$executeRawUnsafe(`INSERT INTO list_memberships (org_id, workspace_id, list_id, contact_id) VALUES ($1, $2, $3, $4)`, s.ws.orgId, s.ws.workspaceId, list, id);
          } else if (op === 3) await tx.$executeRawUnsafe(`UPDATE contacts SET deleted_at = now() WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`, batch.slice(0, 5));
          else await tx.$executeRawUnsafe(`UPDATE contacts SET deleted_at = NULL WHERE id = ANY($1::uuid[]) AND erased_at IS NULL`, batch.slice(0, 5));
        });
      } catch (e) {
        const err = e as { code?: string; meta?: { code?: string }; message?: string };
        const code = err.meta?.code ?? (/\b(40P01|40001|55P03|57014)\b/.exec(err.message ?? '')?.[1] ?? err.code ?? 'other');
        errors[code] = (errors[code] ?? 0) + 1;
      }
      lat.push(ms(t));
    }
  };
  const all = Array.from({ length: n }, (_, w) => one(w));
  return {
    stop: async () => {
      stop = true;
      await Promise.all(all);
      return { writes: lat.length, ...(lat.length ? stats(lat) : {}), errors };
    },
  };
}

/** The earlier BLOCKING rebuild, for comparison only: every chunk repaired in ONE transaction (locks held to commit). */
async function blockingRebuild(s: Seeded) {
  return db.withTenant(
    s.ws,
    async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('statement_timeout', '0', true)`);
      const token = randomUUID();
      const [b] = await tx.$queryRawUnsafe<{ g: bigint }[]>(`SELECT app.audience_count_begin_rebuild($1::uuid, 3600) AS g`, token);
      for (let after: string | null = null; ; ) {
        const [f]: { last: string | null }[] = await tx.$queryRawUnsafe<{ last: string | null }[]>(`SELECT app.audience_count_fill_positions($1::uuid, 20000)::text AS last`, after);
        if (f!.last === null) break;
        after = f!.last;
      }
      const items = await tx.$queryRawUnsafe<{ chunk: bigint }[]>(`SELECT chunk FROM app.audience_count_repair_list()`);
      // every chunk waits for its locks and KEEPS them to commit (the blocking behaviour being compared)
      for (const it of items) await tx.$queryRawUnsafe(`SELECT app.audience_count_repair_chunk($1::bigint, 600000)`, it.chunk);
      const [fin] = await tx.$queryRawUnsafe<{ f: { published: boolean } }[]>(`SELECT app.audience_count_finish_rebuild($1::uuid, $2::bigint) AS f`, token, b!.g);
      return { chunks: items.length, published: fin!.f.published };
    },
    { timeout: 7_200_000 },
  );
}

const invalidate = (s: Seeded) =>
  withOwnerConnection((c) =>
    c.query(`UPDATE audience_count_state SET state = 'invalid', generation = generation + 1, rebuild_token = NULL, rebuild_lease_until = NULL WHERE workspace_id = $1`, [s.ws.workspaceId]),
  );
const countState = (s: Seeded) =>
  withOwnerConnection(async (c) => (await c.query(`SELECT state, generation::text AS g FROM audience_count_state WHERE workspace_id = $1`, [s.ws.workspaceId])).rows[0] as { state: string; g: string });
const sampleIds = (s: Seeded, n: number) =>
  withOwnerConnection(async (c) =>
    (await c.query(`SELECT id::text AS id FROM contacts WHERE workspace_id = $1 AND deleted_at IS NULL ORDER BY md5(id::text) LIMIT $2`, [s.ws.workspaceId, n])).rows.map((r: { id: string }) => r.id),
  );

/**
 * Bitmap at one size: online rebuild under 4 writers (+ blocking comparison), writer baseline, count latency, exact
 * equality against the independent count (0 mismatches), reconciliation time, storage.
 */
async function bitmapAtScale(label: string, s: Seeded, opts: { blocking: boolean }) {
  const ids = await sampleIds(s, 20_000);
  if (process.env.AUDIENCE_SCALE_IDLE_REBUILD) {
    // the same online rebuild with no concurrent writers (separates rebuild cost from contention)
    await invalidate(s);
    const t = process.hrtime.bigint();
    const idle = await rebuildCountBitmap(db, wsOf(s));
    report('bitmap-rebuild-online-idle', { label, ms: Math.round(ms(t)), ...idle });
  }
  await invalidate(s);
  let w = startWriters(s, ids, 4);
  let t0 = process.hrtime.bigint();
  const online = await rebuildCountBitmap(db, wsOf(s)).catch((e) => ({ outcome: 'error', error: String(e).slice(0, 200) }) as const);
  const onlineMs = ms(t0);
  report('bitmap-rebuild-online', { label, ms: Math.round(onlineMs), ...online, writers: await w.stop() });
  expect(online.outcome).toBe('published');
  w = startWriters(s, ids, 4);
  await new Promise((res) => setTimeout(res, 10_000));
  report('bitmap-writers-baseline', { label, writers: await w.stop() });
  if (opts.blocking) {
    await invalidate(s);
    w = startWriters(s, ids, 4);
    t0 = process.hrtime.bigint();
    const blocking = await blockingRebuild(s).catch((e) => ({ chunks: 0, published: false, error: String(e).slice(0, 200) }));
    const blockingMs = ms(t0);
    report('bitmap-rebuild-blocking', { label, ms: Math.round(blockingMs), ...blocking, writers: await w.stop() });
    if (!blocking.published) expect((await rebuildCountBitmap(db, wsOf(s))).outcome).toBe('published');
  }
  expect((await countState(s)).state).toBe('valid');

  for (const d of bitmapDefs(s)) {
    const times: number[] = [];
    let got = { count: -1, path: '' };
    for (let i = 0; i < 22; i++) {
      t0 = process.hrtime.bigint();
      got = await inTenant(s.ws, (sc) => resolution.countWithPath(sc, d.def));
      times.push(ms(t0));
    }
    const independent = await independentCount(s, d);
    // the same bitmap formula without the 5,000,000 cap (the API caps; exactness above the cap is checked here)
    const uncapped = await inTenant(s.ws, async (sc) =>
      Number(
        (
          await sc.tx.$queryRawUnsafe<{ n: bigint }[]>(
            `WITH inc AS (SELECT chunk, bit_or(bits) AS v FROM audience_count_source_chunks WHERE source_id = ANY($1::uuid[]) GROUP BY chunk),
                  exc AS (SELECT chunk, bit_or(bits) AS v FROM audience_count_source_chunks WHERE source_id = ANY($2::uuid[]) GROUP BY chunk)
             SELECT coalesce(sum(bit_count(i.v & ~coalesce(e.v, repeat('0', 4096)::varbit) & ~coalesce(d.bits, repeat('0', 4096)::varbit))), 0)::bigint AS n
               FROM inc i LEFT JOIN exc e ON e.chunk = i.chunk LEFT JOIN audience_count_dead_chunks d ON d.chunk = i.chunk`,
            [...d.incLists, ...d.incTags],
            d.excLists,
          )
        )[0]!.n,
      ),
    );
    t0 = process.hrtime.bigint();
    const exactPath = await inTenant(s.ws, (sc) => exactOnly.count(sc, d.def)).then(
      (r) => r.count,
      (e) => (e as { code?: string }).code ?? 'error',
    );
    const exactMs = Math.round(ms(t0));
    report('bitmap-count', { label, def: d.name, path: got.path, bitmap: got.count, uncapped, independent, mismatch: uncapped - independent, exactPath, exactMs, ...stats(times.slice(2)) });
    expect(got.path).toBe('bitmap');
    expect(got.count).toBe(Math.min(independent, 5_000_000));
    expect(uncapped).toBe(independent);
  }
  t0 = process.hrtime.bigint();
  const rec = await reconcileCountBitmap(db, wsOf(s), { timeoutMs: 600_000 });
  report('bitmap-reconcile', { label, ms: Math.round(ms(t0)), ...rec });
  expect(rec.ok).toBe(true);
  const sizes = await withOwnerConnection(
    async (c) =>
      (
        await c.query(
          `SELECT (SELECT count(*) FROM audience_count_source_chunks WHERE workspace_id = $1)::int AS source_chunks,
                  (SELECT count(*) FROM audience_count_dead_chunks WHERE workspace_id = $1)::int AS dead_chunks,
                  pg_total_relation_size('audience_count_source_chunks')::bigint AS source_table_bytes,
                  pg_total_relation_size('audience_count_contact_seq')::bigint AS seq_table_bytes`,
          [s.ws.workspaceId],
        )
      ).rows[0],
  );
  report('bitmap-storage', { label, ...sizes });
}

/** Peak Node RSS while `fn` runs (sampled every 50 ms). */
async function withRss<T>(fn: () => Promise<T>) {
  const rss0 = process.memoryUsage().rss;
  let peak = rss0;
  const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 50);
  try {
    const r = await fn();
    return { r, rssGrowthMB: Math.round((peak - rss0) / 1048576) };
  } finally {
    clearInterval(timer);
  }
}

describe.skipIf(!process.env.AUDIENCE_SCALE)('Audience Resolution and Eligibility at scale', () => {
  beforeAll(async () => {
    if (REUSE_5M) {
      db = createDatabase({ url: testDatabaseUrls().app, maxConnections: 8 });
      return;
    }
    await resetTestDatabase();
    await withOwnerConnection((c) => c.query(`INSERT INTO users (id, email, email_normalized, display_name) VALUES ($1, 'b@x.test', 'b@x.test', 'B')`, [USER]));
    db = createDatabase({ url: testDatabaseUrls().app, maxConnections: 8 });
    const t0 = process.hrtime.bigint();
    await seedWorkspace(NOISE, { eligibility: false }); // noise tenant
    report('seed-noise', { contacts: NOISE, ms: Math.round(ms(t0)) });
  }, 3_600_000);
  afterAll(async () => db?.disconnect());

  for (const size of SIZES) {
    it(`${size.toLocaleString('en')} members: count, capture, page, cleanup`, { timeout: 7_200_000 }, async () => {
      const contacts = Math.round(size / 0.9405); // 1 % deleted, 5 % excluded
      let t0 = process.hrtime.bigint();
      const s = await seedWorkspace(contacts, { eligibility: size === SIZES[0] });
      report('seed', { size, contacts, ms: Math.round(ms(t0)) });
      await withOwnerConnection((c) => c.query(`ANALYZE contacts; ANALYZE list_memberships; ANALYZE contact_tags; ANALYZE lists; ANALYZE tags`));

      if (BITMAP_ONLY) return bitmapAtScale(String(size), s, { blocking: !!process.env.AUDIENCE_SCALE_BLOCKING });
      // count (exact, uncapped below 5 M)
      const counts: number[] = [];
      let counted = 0;
      for (let i = 0; i < 10; i++) {
        t0 = process.hrtime.bigint();
        counted = (await inTenant(s.ws, (sc) => resolution.count(sc, defOf(s)))).count;
        counts.push(ms(t0));
      }
      report('count', { size, members: counted, ...stats(counts) });

      // capture (3 runs, new key each), with temp/WAL/disk deltas
      const captures: number[] = [];
      const keys: string[] = [];
      for (let i = 0; i < 3; i++) {
        const before = await dbStats();
        const sizeBefore = await membersSize();
        const key = randomUUID();
        t0 = process.hrtime.bigint();
        const { r: ref, rssGrowthMB } = await withRss(() => inTenant(s.ws, (sc) => resolution.capture(sc, defOf(s), key, { kind: 'campaign_execution', id: randomUUID() })));
        const took = ms(t0);
        captures.push(took);
        keys.push(key);
        const after = await dbStats();
        expect(ref.size).toBe(counted);
        report('capture', {
          size,
          members: ref.size,
          ms: Math.round(took),
          tempBytes: Number(after.temp) - Number(before.temp),
          walBytes: await walBytes(before.lsn, after.lsn),
          membersTableGrowthBytes: (await membersSize()) - sizeBefore,
          nodeRssGrowthMB: rssGrowthMB,
        });
        if (i === 0) {
          const cmp = await exactCompare(s, ref.snapshotId);
          report('capture-exact', { size, ...cmp });
          expect([cmp.missing, cmp.extra, cmp.duplicates, cmp.order_violations, cmp.snapshot]).toEqual([0, 0, 0, 0, cmp.reference]);
        }
      }
      report('capture-summary', { size, ...stats(captures) });

      // page: random positions + one full walk
      const snapId = (await withOwnerConnection((c) => c.query(`SELECT id::text AS id FROM audience_snapshots WHERE capture_key = $1`, [keys[0]]))).rows[0].id as string;
      const ids = (await withOwnerConnection((c) => c.query(`SELECT x::text AS id FROM audience_snapshot_chunks, unnest(contact_ids) AS x WHERE snapshot_id = $1 AND random() < 0.002`, [snapId]))).rows.map(
        (r: { id: string }) => r.id,
      );
      const { encodeSnapshotCursor } = await import('@workeasy/audience-core');
      const pages: number[] = [];
      for (const after of ids.slice(0, 300)) {
        t0 = process.hrtime.bigint();
        await inTenant(s.ws, (sc) => resolution.page(sc, snapId, { cursor: encodeSnapshotCursor(snapId, after), limit: 1000 }));
        pages.push(ms(t0));
      }
      report('page-random', { size, ...stats(pages) });
      t0 = process.hrtime.bigint();
      let cursor: string | null = null;
      let walked = 0;
      let last = '';
      let unordered = 0;
      const rss0 = process.memoryUsage().rss;
      let peak = rss0;
      do {
        const p = await inTenant(s.ws, (sc) => resolution.page(sc, snapId, { cursor, limit: 1000 }));
        for (const x of p.contactIds) {
          if (x <= last) unordered++;
          last = x;
        }
        walked += p.contactIds.length;
        cursor = p.cursor;
        peak = Math.max(peak, process.memoryUsage().rss);
      } while (cursor);
      expect([walked, unordered]).toEqual([counted, 0]);
      report('page-walk', { size, members: walked, ascending: unordered === 0, ms: Math.round(ms(t0)), rssGrowthMB: Math.round((peak - rss0) / 1048576) });

      // cleanup: first release call (R1 in the campaign procedure), then the purge loop
      const ws = { orgId: s.ws.orgId, workspaceId: s.ws.workspaceId! };
      for (const key of keys) {
        t0 = process.hrtime.bigint();
        await inTenant(s.ws, (sc) => resolution.releaseByKey(sc, key, 'materialized'));
        const first = ms(t0);
        t0 = process.hrtime.bigint();
        const { calls } = await purgeUntilDone(db, resolution, ws, key, 'materialized');
        report('cleanup', { size, firstCallMs: Math.round(first), purgeMs: Math.round(ms(t0)), purgeCalls: calls, perCallMs: Math.round(ms(t0) / calls) });
      }

      // count bitmap (Phase 6.3 G2); the blocking rebuild comparison up to 1M only
      await bitmapAtScale(String(size), s, { blocking: size <= 1_000_000 });

      // eligibility batch sizes (decision D) — on the first size only, with realistic facts
      if (size === SIZES[0]) {
        for (const batch of [100, 500, 1000]) {
          const ev = new EligibilityEvaluator<Tx>(new PrismaEligibilityFactsReader(), 'bench-secret', undefined, { batchLimit: batch });
          const times: number[] = [];
          for (let i = 0; i < 30; i++) {
            const start = (i * 137) % (s.sample.length - batch);
            const contactIds = s.sample.slice(start, start + batch);
            const took = await inTenant(s.ws, async (sc) => {
              const t = process.hrtime.bigint();
              const r = await ev.evaluate(sc, { contactIds, channel: 'email', purpose: 'marketing', topicId: s.topic, topicPolicy: 'block_unsubscribed' });
              expect(r.results).toHaveLength(batch);
              return ms(t);
            });
            times.push(took);
          }
          report('eligibility', { batch, ...stats(times.slice(3)) }); // first 3 are warm-up
        }
      }
    });
  }

  it.skipIf(!CONCURRENT)(`4 concurrent captures (${CONCURRENT.toLocaleString('en')}-member audience each)`, { timeout: 7_200_000 }, async () => {
    const s = await seedWorkspace(Math.round(CONCURRENT / 0.9405), { eligibility: false });
    await withOwnerConnection((c) => c.query(`ANALYZE contacts; ANALYZE list_memberships; ANALYZE contact_tags`));
    const t0 = process.hrtime.bigint();
    const times = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const t = process.hrtime.bigint();
        const ref = await inTenant(s.ws, (sc) => resolution.capture(sc, defOf(s), randomUUID(), { kind: 'campaign_execution', id: randomUUID() }));
        return { ms: Math.round(ms(t)), members: ref.size };
      }),
    );
    report('capture-concurrent', { captures: 4, wallMs: Math.round(ms(t0)), each: times });
  });

  /**
   * The 5M capture gate (≤ 60 s): an audience just below the 5,000,000 limit. Count is recorded but not asserted (the
   * exact count at 5M is outside the D2 gate; the derived bitmap count is the approved architecture for it). Three
   * captures, exact set comparison against the row-by-row reference, random pages and the full purge.
   */
  /**
   * AUDIENCE_SCALE_REUSE_5M=1: continue on the 5M workspace an interrupted 5M run left in the test database (no reset,
   * no reseed). Records the crash state found, recovers it with a normal rebuild (lease takeover), then re-measures the
   * capture gate, exact equality and paging in a quiet state (autovacuum idle) BEFORE the bitmap section's writers
   * change the audience, and finally runs the bitmap section.
   */
  it.skipIf(!REUSE_5M)('5M reuse: crash recovery, quiet capture gate, bitmap', { timeout: 7_200_000 }, async () => {
    const s = await withOwnerConnection(async (c) => {
      const w = (await c.query(`SELECT org_id::text AS org, workspace_id::text AS ws, count(*)::int AS n FROM contacts GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 1`)).rows[0];
      const lists = (await c.query(`SELECT id::text, name FROM lists WHERE workspace_id = $1 ORDER BY name`, [w.ws])).rows as { id: string; name: string }[];
      const tag = (await c.query(`SELECT id::text FROM tags WHERE workspace_id = $1 AND name = 'tag'`, [w.ws])).rows[0].id as string;
      report('5m-reuse-found', { contacts: w.n, state: (await c.query(`SELECT state, generation::text AS g, rebuild_lease_until < now() AS lease_expired FROM audience_count_state WHERE workspace_id = $1`, [w.ws])).rows[0] });
      return {
        ws: { orgId: w.org, workspaceId: w.ws, userId: null },
        lists: lists.filter((l) => l.name.startsWith('list-')).map((l) => l.id),
        exclusion: lists.find((l) => l.name === 'exclude')!.id,
        tag,
        topic: '',
        sample: [],
      } as Seeded;
    });
    const awaitQuiet = async () => {
      for (;;) {
        const n = await withOwnerConnection(async (c) => (await c.query(`SELECT count(*)::int AS n FROM pg_stat_progress_vacuum`)).rows[0].n as number);
        if (n === 0) return;
        await new Promise((r) => setTimeout(r, 10_000));
      }
    };
    // not served while the interrupted rebuild's state remains
    const before = await inTenant(s.ws, (sc) => resolution.countWithPath(sc, { include: [{ type: 'list', listId: s.lists[0]! }], exclude: [] }));
    report('5m-reuse-before-recovery', { path: before.path, count: before.count });
    expect(before.path).toBe('exact');
    let t0 = process.hrtime.bigint();
    const recovered = await rebuildCountBitmap(db, wsOf(s));
    report('5m-reuse-recovery-rebuild', { ms: Math.round(ms(t0)), ...recovered });
    expect(recovered.outcome).toBe('published');

    // quiet state: the seeded tables vacuumed and analyzed up front, so no autovacuum competes with the measurement
    t0 = process.hrtime.bigint();
    await withOwnerConnection(async (c) => {
      await c.query(`SET statement_timeout = 0`);
      await c.query(`VACUUM (ANALYZE) contacts, list_memberships, contact_tags, contact_identities, audience_snapshot_chunks, audience_count_contact_seq`);
    });
    report('5m-reuse-vacuum', { ms: Math.round(ms(t0)) });
    await awaitQuiet();
    const captures: number[] = [];
    let snapshotId = '';
    const keys: string[] = [];
    for (let i = 0; i < 3; i++) {
      await awaitQuiet();
      const key = randomUUID();
      t0 = process.hrtime.bigint();
      const ref = await inTenant(s.ws, (sc) => resolution.capture(sc, defOf(s), key, { kind: 'campaign_execution', id: randomUUID() }));
      captures.push(ms(t0));
      keys.push(key);
      snapshotId ||= ref.snapshotId;
      report('5m-capture-quiet', { members: ref.size, ms: Math.round(captures.at(-1)!) });
    }
    report('5m-capture-quiet-summary', stats(captures));
    const cmp = await exactCompare(s, snapshotId);
    report('5m-capture-quiet-exact', cmp);
    expect([cmp.missing, cmp.extra, cmp.duplicates, cmp.order_violations, cmp.snapshot]).toEqual([0, 0, 0, 0, cmp.reference]);
    const sampleIds = (await withOwnerConnection((c) => c.query(`SELECT x::text AS id FROM audience_snapshot_chunks, unnest(contact_ids) AS x WHERE snapshot_id = $1 AND random() < 0.0002`, [snapshotId]))).rows.map((r: { id: string }) => r.id);
    const { encodeSnapshotCursor } = await import('@workeasy/audience-core');
    const pages: number[] = [];
    for (const after of sampleIds.slice(0, 300)) {
      t0 = process.hrtime.bigint();
      await inTenant(s.ws, (sc) => resolution.page(sc, snapshotId, { cursor: encodeSnapshotCursor(snapshotId, after), limit: 1000 }));
      pages.push(ms(t0));
    }
    report('5m-page-random-quiet', stats(pages));
    for (const key of keys) {
      await inTenant(s.ws, (sc) => resolution.releaseByKey(sc, key, 'materialized'));
      await purgeUntilDone(db, resolution, wsOf(s), key, 'materialized');
    }
    await bitmapAtScale('5M', s, { blocking: false });
  });

  it.skipIf(!process.env.AUDIENCE_SCALE_5M)('5M members: capture gate, exact equality, page, purge', { timeout: 7_200_000 }, async () => {
    let t0 = process.hrtime.bigint();
    const contacts = Number(process.env.AUDIENCE_SCALE_5M_CONTACTS ?? 5_315_257);
    const s = await seedWorkspace(contacts, { eligibility: false });
    report('5m-seed', { contacts, ms: Math.round(ms(t0)) });
    await withOwnerConnection((c) => c.query(`ANALYZE contacts; ANALYZE list_memberships; ANALYZE contact_tags; ANALYZE lists; ANALYZE tags`));

    t0 = process.hrtime.bigint();
    const counted = await inTenant(s.ws, (sc) => resolution.count(sc, defOf(s))).then(
      (r) => ({ ok: true, count: r.count }),
      (e) => ({ ok: false, error: (e as { code?: string }).code ?? (e as Error).message.slice(0, 120) }),
    );
    report('5m-count-exact-path', { ms: Math.round(ms(t0)), ...counted });

    const captures: number[] = [];
    const keys: string[] = [];
    let snapshotId = '';
    for (let i = 0; i < 3; i++) {
      const before = await dbStats();
      const key = randomUUID();
      t0 = process.hrtime.bigint();
      const { r: ref, rssGrowthMB } = await withRss(() => inTenant(s.ws, (sc) => resolution.capture(sc, defOf(s), key, { kind: 'campaign_execution', id: randomUUID() })));
      const took = ms(t0);
      const after = await dbStats();
      captures.push(took);
      keys.push(key);
      snapshotId ||= ref.snapshotId;
      report('5m-capture', { members: ref.size, ms: Math.round(took), tempBytes: Number(after.temp) - Number(before.temp), walBytes: await walBytes(before.lsn, after.lsn), nodeRssGrowthMB: rssGrowthMB });
    }
    report('5m-capture-summary', stats(captures));
    const cmp = await exactCompare(s, snapshotId);
    report('5m-capture-exact', cmp);
    expect([cmp.missing, cmp.extra, cmp.duplicates, cmp.order_violations, cmp.snapshot]).toEqual([0, 0, 0, 0, cmp.reference]);
    expect(cmp.snapshot).toBeLessThanOrEqual(5_000_000);
    expect(cmp.snapshot).toBeGreaterThan(4_900_000);

    const sampleIds = (await withOwnerConnection((c) => c.query(`SELECT x::text AS id FROM audience_snapshot_chunks, unnest(contact_ids) AS x WHERE snapshot_id = $1 AND random() < 0.0002`, [snapshotId]))).rows.map((r: { id: string }) => r.id);
    const { encodeSnapshotCursor } = await import('@workeasy/audience-core');
    const pages: number[] = [];
    for (const after of sampleIds.slice(0, 300)) {
      t0 = process.hrtime.bigint();
      await inTenant(s.ws, (sc) => resolution.page(sc, snapshotId, { cursor: encodeSnapshotCursor(snapshotId, after), limit: 1000 }));
      pages.push(ms(t0));
    }
    report('5m-page-random', stats(pages));

    const ws = { orgId: s.ws.orgId, workspaceId: s.ws.workspaceId! };
    for (const key of keys) {
      t0 = process.hrtime.bigint();
      await inTenant(s.ws, (sc) => resolution.releaseByKey(sc, key, 'materialized'));
      const first = ms(t0);
      t0 = process.hrtime.bigint();
      const { calls } = await purgeUntilDone(db, resolution, ws, key, 'materialized');
      report('5m-cleanup', { firstCallMs: Math.round(first), purgeMs: Math.round(ms(t0)), purgeCalls: calls, perCallMs: Math.round(ms(t0) / Math.max(1, calls)) });
    }
    // count bitmap LAST: its writers add members, which would change the audience the capture gate measures
    await bitmapAtScale('5M', s, { blocking: false });
  });

  /**
   * The frozen limit at full size: count and capture of an audience just above 5,000,000 members. Records each
   * outcome (success, AUDIENCE_TOO_LARGE, or a statement timeout) instead of failing on the first error, and checks
   * that a failed capture left no snapshot row and no member behind (atomicity at scale).
   */
  it.skipIf(!process.env.AUDIENCE_SCALE_LIMIT)(`capture limit: ${LIMIT_MEMBERS.toLocaleString('en')} members`, { timeout: 7_200_000 }, async () => {
    let t0 = process.hrtime.bigint();
    const contacts = Math.ceil(LIMIT_MEMBERS / 0.9405) + 20_000; // margin: the seeded membership is approximate
    const s = await seedWorkspace(contacts, { eligibility: false });
    report('limit-seed', { contacts, ms: Math.round(ms(t0)) });
    await withOwnerConnection((c) => c.query(`ANALYZE contacts; ANALYZE list_memberships; ANALYZE contact_tags; ANALYZE lists; ANALYZE tags`));
    const outcome = (e: unknown) => (e as { code?: string }).code ?? (e as Error).message.slice(0, 120);
    const members = await independentCount(s, bitmapDefs(s)[0]!);
    report('limit-members-independent', { members, overLimit: members > 5_000_000 });
    t0 = process.hrtime.bigint();
    const rb = await rebuildCountBitmap(db, wsOf(s));
    report('limit-bitmap-rebuild', { ms: Math.round(ms(t0)), ...rb });

    t0 = process.hrtime.bigint();
    const counted = await inTenant(s.ws, (sc) => resolution.countWithPath(sc, defOf(s))).then(
      (r) => ({ ok: true, count: r.count, capped: r.capped, path: r.path }),
      (e) => ({ ok: false, error: outcome(e) }),
    );
    report('limit-count', { ms: Math.round(ms(t0)), ...counted });
    if (members > 5_000_000) expect(counted).toMatchObject({ ok: true, count: 5_000_000, capped: true, path: 'bitmap' });
    const stateBefore = await countState(s);

    const key = randomUUID();
    t0 = process.hrtime.bigint();
    const captured = await inTenant(s.ws, (sc) => resolution.capture(sc, defOf(s), key, { kind: 'campaign_execution', id: randomUUID() })).then(
      (r) => ({ ok: true, size: r.size }),
      (e) => ({ ok: false, error: outcome(e) }),
    );
    const left = await withOwnerConnection(async (c) => ({
      snapshots: (await c.query(`SELECT count(*)::int AS n FROM audience_snapshots WHERE capture_key = $1`, [key])).rows[0].n as number,
      members: (await c.query(`SELECT coalesce(sum(cardinality(m.contact_ids)), 0)::int AS n FROM audience_snapshot_chunks m JOIN audience_snapshots s ON s.id = m.snapshot_id WHERE s.capture_key = $1`, [key])).rows[0].n as number,
    }));
    report('limit-capture', { ms: Math.round(ms(t0)), ...captured, committed: left });
    if (!captured.ok) expect(left).toEqual({ snapshots: 0, members: 0 });
    if (members > 5_000_000) expect(captured).toEqual({ ok: false, error: 'AUDIENCE_TOO_LARGE' });
    // a rejected capture publishes no bitmap state change (it writes nothing the triggers see)
    const stateAfter = await countState(s);
    report('limit-bitmap-state', { before: stateBefore, after: stateAfter });
    expect(stateAfter).toEqual(stateBefore);
  });
});
