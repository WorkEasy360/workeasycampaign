/**
 * Plan robustness (found by the 6.3.10 benchmark): count, capture and the release purge must stay linear when the
 * tables have NO statistics (fresh import, new workspace, freshly captured snapshot members). Before the fix, a
 * 20,000-member capture ran past the 300 s statement timeout and a release chunk past 15 s, because the planner,
 * estimating one row, chose nested loops with an inner scan per outer row. Bounds below are generous on purpose:
 * the linear plans take well under a second here; the quadratic ones took minutes.
 */
import { randomUUID } from 'node:crypto';
import { createDatabase, type Database, type TenantContext } from '@workeasy/db';
import { resetTestDatabase, testDatabaseUrls, withOwnerConnection } from '@workeasy/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CAPTURE_TRANSACTION_TIMEOUT_MS, PrismaAudienceResolution, purgeUntilDone } from '../src/index.js';

const N = 20_000;
let db: Database;
const org = randomUUID();
const ws: TenantContext = { orgId: org, workspaceId: randomUUID(), userId: null };
const list = randomUUID();
const exclusion = randomUUID();

beforeAll(async () => {
  await resetTestDatabase(); // TRUNCATE: the tables start without statistics (reltuples = -1)
  await withOwnerConnection(async (c) => {
    const user = randomUUID();
    await c.query(`INSERT INTO users (id, email, email_normalized, display_name) VALUES ($1, 'pl@x.test', 'pl@x.test', 'P')`, [user]);
    await c.query(`INSERT INTO organizations (id, name, slug, created_by_user_id) VALUES ($1, 'plans', 'plans', $2)`, [org, user]);
    await c.query(`INSERT INTO workspaces (id, org_id, name, slug) VALUES ($1, $2, 'p', 'p')`, [ws.workspaceId, org]);
    await c.query(`INSERT INTO lists (id, org_id, workspace_id, name, name_key) VALUES ($1, $2, $3, 'l', 'l'), ($4, $2, $3, 'x', 'x')`, [list, org, ws.workspaceId, exclusion]);
    await c.query(`CREATE TEMP TABLE t AS SELECT g, gen_random_uuid() AS id FROM generate_series(1, $1::int) g`, [N]);
    await c.query(`INSERT INTO contacts (id, org_id, workspace_id) SELECT id, $1::uuid, $2::uuid FROM t`, [org, ws.workspaceId]);
    await c.query(`INSERT INTO list_memberships (org_id, workspace_id, list_id, contact_id) SELECT $1::uuid, $2::uuid, $3::uuid, id FROM t`, [org, ws.workspaceId, list]);
    await c.query(`INSERT INTO list_memberships (org_id, workspace_id, list_id, contact_id) SELECT $1::uuid, $2::uuid, $3::uuid, id FROM t WHERE g % 10 = 0`, [org, ws.workspaceId, exclusion]);
    const stats = await c.query(`SELECT max(reltuples) AS r FROM pg_class WHERE relname IN ('contacts', 'list_memberships', 'audience_snapshot_chunks')`);
    expect(Number(stats.rows[0].r)).toBeLessThan(0); // never analyzed
  });
  db = createDatabase({ url: testDatabaseUrls().app, maxConnections: 2 });
});
afterAll(async () => db?.disconnect());

describe('plans stay linear without table statistics', () => {
  const resolution = new PrismaAudienceResolution();
  const scope = <T>(fn: (s: { tx: Parameters<Parameters<Database['withTenant']>[1]>[0]; orgId: string; workspaceId: string }) => Promise<T>) =>
    db.withTenant(ws, (tx) => fn({ tx, orgId: org, workspaceId: ws.workspaceId! }), { timeout: CAPTURE_TRANSACTION_TIMEOUT_MS });
  const def = { include: [{ type: 'list' as const, listId: list }], exclude: [{ type: 'list' as const, listId: exclusion }] };

  it(`count, capture and release of ${N.toLocaleString('en')} members complete in seconds, with exact results`, { timeout: 120_000 }, async () => {
    let t = Date.now();
    expect((await scope((s) => resolution.count(s, def))).count).toBe(N * 0.9);
    expect(Date.now() - t).toBeLessThan(10_000);

    const key = randomUUID();
    t = Date.now();
    const ref = await scope((s) => resolution.capture(s, def, key, { kind: 'campaign_execution', id: randomUUID() }));
    expect(ref.size).toBe(N * 0.9);
    expect(Date.now() - t).toBeLessThan(20_000);

    t = Date.now();
    expect(await scope((s) => resolution.releaseByKey(s, key, 'materialized'))).toEqual({ released: true, membersRemaining: true });
    expect(Date.now() - t).toBeLessThan(5_000);
    t = Date.now();
    const { calls } = await purgeUntilDone(db, resolution, { orgId: org, workspaceId: ws.workspaceId! }, key, 'materialized');
    expect(calls).toBe(1); // 18,000 members = 18 chunks: 10 chunks (10,000 ids) in the first call, the remaining 8 here
    expect(Date.now() - t).toBeLessThan(5_000);
    const left = await withOwnerConnection(async (c) => (await c.query(`SELECT coalesce(sum(cardinality(contact_ids)), 0)::int AS n FROM audience_snapshot_chunks`)).rows[0].n);
    expect(left).toBe(0);
  });
});
