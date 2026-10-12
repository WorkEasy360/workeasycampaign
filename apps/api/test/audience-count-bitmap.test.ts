import { randomUUID } from 'node:crypto';
import { PrismaAudienceResolution, reconcileCountBitmap } from '@workeasy/audience-infra';
import { createDatabase, type Database } from '@workeasy/db';
import { testDatabaseUrls } from '@workeasy/db/testing';
import type { AudienceDefinitionV1 } from '@workeasy/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Agent, createOrg, resetTestDatabase, signUp, startTestApp, type TestApp, uploadCsv, waitForImport, withOwnerConnection } from './support.js';

/**
 * Phase 6.3 G2 — every Audience write path through the REAL API routes keeps the count bitmap VALID and exact
 * (docs/audit/phase-6.3-g2-closure.md). After each step: the bitmap state is still 'valid', the count is answered by
 * the bitmap, and it equals an independent SQL count (EXISTS / NOT EXISTS over contacts; never the bitmap itself).
 */
describe('count bitmap under every API write path', () => {
  let t: TestApp;
  let owner: Agent;
  let orgId: string;
  let W: string;
  let db: Database;
  const resolution = new PrismaAudienceResolution();
  const url = (p: string) => `/v1/workspaces/${W}${p}`;
  const src: Record<string, string> = {};
  const steps: string[] = [];

  const independent = (def: AudienceDefinitionV1) => {
    const ids = (t: 'list' | 'tag', sel: AudienceDefinitionV1['include']) => sel.flatMap((s) => (s.type === t ? [s.type === 'list' ? s.listId : s.tagId] : []));
    return withOwnerConnection(async (c) =>
      Number(
        (
          await c.query(
            `SELECT count(*) AS n FROM contacts c WHERE c.workspace_id = $1 AND c.deleted_at IS NULL AND c.erased_at IS NULL
               AND (EXISTS (SELECT 1 FROM list_memberships m WHERE m.contact_id = c.id AND m.list_id = ANY($2::uuid[]))
                 OR EXISTS (SELECT 1 FROM contact_tags m WHERE m.contact_id = c.id AND m.tag_id = ANY($3::uuid[])))
               AND NOT EXISTS (SELECT 1 FROM list_memberships m WHERE m.contact_id = c.id AND m.list_id = ANY($4::uuid[]))
               AND NOT EXISTS (SELECT 1 FROM contact_tags m WHERE m.contact_id = c.id AND m.tag_id = ANY($5::uuid[]))`,
            [W, ids('list', def.include), ids('tag', def.include), ids('list', def.exclude), ids('tag', def.exclude)],
          )
        ).rows[0].n,
      ),
    );
  };

  /** After a write: still VALID, answered by the bitmap, equal to the independent count, for every live-source definition. */
  async function check(step: string, live: string[]) {
    const state = await withOwnerConnection(async (c) => (await c.query(`SELECT state, reason FROM audience_count_state WHERE workspace_id = $1`, [W])).rows[0]);
    expect(state, step).toMatchObject({ state: 'valid' });
    const sel = (k: string) => (k.startsWith('L') ? { type: 'list' as const, listId: src[k]! } : { type: 'tag' as const, tagId: src[k]! });
    const defs: AudienceDefinitionV1[] = [
      ...live.map((k) => ({ include: [sel(k)], exclude: [] })),
      { include: live.map(sel), exclude: [] },
      ...(live.length >= 2 ? [{ include: [sel(live[0]!)], exclude: live.slice(1).map(sel) }] : []),
    ];
    for (const def of defs) {
      const got = await db.withTenant({ orgId, workspaceId: W, userId: null }, (tx) => resolution.countWithPath({ tx: tx as never, orgId, workspaceId: W }, def));
      expect(got.path, step).toBe('bitmap');
      expect(got.count, `${step} ${JSON.stringify(def)}`).toBe(await independent(def));
    }
    steps.push(step);
  }

  const contact = async (i: number, body: Record<string, unknown> = {}) => {
    const r = await owner.post(url('/contacts'), { email: `cb${i}-${randomUUID().slice(0, 8)}@bitmap.test`, ...body });
    expect(r.status).toBe(201);
    return r.body.id as string;
  };

  beforeAll(async () => {
    await resetTestDatabase();
    t = await startTestApp();
    owner = await signUp(t, undefined, 'Bitmap');
    ({ orgId, workspaceId: W } = await createOrg(owner, 'Bitmap Co'));
    db = createDatabase({ url: testDatabaseUrls().app, maxConnections: 2 });
  });
  afterAll(async () => {
    await db?.disconnect();
    await t?.close();
  });

  it('a new workspace starts VALID; every membership and liveness write through the API keeps it VALID and exact', { timeout: 300_000 }, async () => {
    for (const k of ['L1', 'L2', 'L3']) src[k] = (await owner.post(url('/lists'), { name: k })).body.id;
    for (const k of ['T1', 'T2']) src[k] = (await owner.post(url('/tags'), { name: k })).body.id;
    let live = ['L1', 'L2', 'L3', 'T1', 'T2'];
    await check('empty workspace', live);

    const ids: string[] = [];
    for (let i = 0; i < 40; i++) ids.push(await contact(i, { listIds: i % 2 ? [src.L1] : [src.L2], tagIds: i % 3 ? [] : [src.T1] }));
    await check('POST /contacts with listIds and tagIds', live);

    expect((await owner.post(url(`/lists/${src.L3}/members`), { contactIds: ids.slice(0, 25) })).status).toBe(200);
    await check('POST /lists/:id/members', live);
    expect((await owner.request('DELETE', url(`/lists/${src.L3}/members`), { contactIds: ids.slice(0, 10) })).status).toBe(200);
    await check('DELETE /lists/:id/members', live);

    expect((await owner.put(url(`/contacts/${ids[1]}/tags/${src.T2}`), {})).status).toBeLessThan(300);
    await check('PUT /contacts/:id/tags/:tagId', live);
    expect((await owner.request('DELETE', url(`/contacts/${ids[0]}/tags/${src.T1}`))).status).toBeLessThan(300);
    await check('DELETE /contacts/:id/tags/:tagId', live);

    for (const [action, extra] of [
      ['add_to_list', { listId: src.L1 }],
      ['remove_from_list', { listId: src.L2 }],
      ['tag', { tagId: src.T2 }],
      ['untag', { tagId: src.T1 }],
      ['suppress', { channel: 'all', reason: 'manual' }],
      ['unsubscribe', {}],
    ] as const) {
      const r = await owner.post(url('/contacts/bulk'), { action, ...extra, selection: { contactIds: ids.slice(5, 30) } });
      expect(r.status, action).toBeLessThan(300);
      await check(`POST /contacts/bulk ${action}`, live);
    }

    expect((await owner.request('DELETE', url(`/contacts/${ids[30]}`))).status).toBe(204);
    await check('DELETE /contacts/:id (soft delete)', live);
    expect((await owner.post(url(`/contacts/${ids[30]}/restore`))).status).toBe(200);
    await check('POST /contacts/:id/restore', live);
    expect((await owner.post(url(`/contacts/${ids[31]}/erase`), { confirm: 'ERASE' })).status).toBe(204);
    await check('POST /contacts/:id/erase', live);
    expect((await owner.post(url('/contacts/bulk'), { action: 'delete', selection: { contactIds: ids.slice(32, 36) } })).status).toBeLessThan(300);
    await check('POST /contacts/bulk delete', live);

    expect((await owner.patch(url(`/contacts/${ids[2]}`), { firstName: 'Renamed', version: 1 })).status).toBeLessThan(500);
    await check('PATCH /contacts/:id (no membership change)', live);
    expect((await owner.post(url(`/lists/${src.L3}/archive`))).status).toBeLessThan(300);
    await check('POST /lists/:id/archive', live);
    expect((await owner.post(url(`/lists/${src.L3}/restore`))).status).toBeLessThan(300);

    const csv = ['email', 'imp1@bitmap.test', 'imp2@bitmap.test', 'imp3@bitmap.test'].join('\n');
    const up = await uploadCsv(owner, W, csv);
    await owner.put(url(`/imports/${up.body.id}/mapping`), { mapping: { 0: 'email' }, options: { mode: 'create_or_update', listIds: [src.L2], tagIds: [src.T2] }, version: up.body.version });
    await owner.post(url(`/imports/${up.body.id}/dry-run`));
    expect((await owner.post(url(`/imports/${up.body.id}/start`))).status).toBe(202);
    expect((await waitForImport(owner, W, up.body.id)).status).toBe('completed');
    await check('CSV import with listIds and tagIds', live);

    expect((await owner.request('DELETE', url(`/tags/${src.T2}`))).status).toBeLessThan(300);
    live = live.filter((k) => k !== 'T2');
    await check('DELETE /tags/:id (untags contacts)', live);
    expect((await owner.request('DELETE', url(`/lists/${src.L2}`))).status).toBeLessThan(300);
    live = live.filter((k) => k !== 'L2');
    await check('DELETE /lists/:id (deletes memberships)', live);

    // the maintained bitmap reconciles clean: no difference, no (false) invalidation
    expect(await reconcileCountBitmap(db, { orgId, workspaceId: W })).toMatchObject({ ok: true, sourceDiff: 0, deadDiff: 0, positionsMissing: 0 });
    console.log(JSON.stringify({ apiMatrixSteps: steps.length }));
    expect(steps.length).toBeGreaterThanOrEqual(20);
  });
});
