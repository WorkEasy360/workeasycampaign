import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withAppConnection } from '@workeasy/db/testing';
import { type Agent, createOrg, inviteAndAccept, resetTestDatabase, signUp, startTestApp, type TestApp, withOwnerConnection } from './support.js';

/**
 * Reusable saved blocks (docs/contracts/phase-7-content-amendment.md §S) through the real HTTP stack: CRUD with
 * optimistic locking, v3 validation (unsafe HTML refused), canonical storage, permissions, tenancy (HTTP and RLS),
 * audit, keyset pagination and search.
 */
describe('saved blocks (snippets)', () => {
  let t: TestApp;
  let owner: Agent;
  let viewer: Agent;
  let outsider: Agent;
  let orgId: string;
  let W: string;
  let WB: string;
  const S = (p = '', ws = W) => `/v1/workspaces/${ws}/snippets${p}`;
  const footer = () => [
    { id: 'p1', type: 'paragraph', runs: [{ text: 'Follow us' }] },
    { id: 'x1', type: 'html', html: '<P>Upper</P>' },
    { id: 'c1', type: 'conditional', when: { match: 'all', rules: [{ field: 'contact.first_name', op: 'is_set' }] }, then: [{ id: 't1', type: 'paragraph', runs: [{ text: 'Hi {{ contact.first_name }}' }] }], else: [] },
  ];

  beforeAll(async () => {
    await resetTestDatabase();
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test' });
    owner = await signUp(t, undefined, 'Owner');
    ({ orgId, workspaceId: W } = await createOrg(owner, 'Snippets Co'));
    viewer = await signUp(t, undefined, 'Viewer');
    await inviteAndAccept(t, owner, viewer, orgId, 'member', [{ workspaceId: W, roleKey: 'viewer' }]);
    outsider = await signUp(t, undefined, 'Outsider');
    ({ workspaceId: WB } = await createOrg(outsider, 'Other Co'));
  });
  afterAll(async () => t?.close());

  it('creates (canonical), reads, lists, renames with the version, deletes; every change audited', async () => {
    const c = await owner.post(S(), { name: 'Footer', blocks: footer() });
    expect(c.status, JSON.stringify(c.body).slice(0, 300)).toBe(201);
    expect(c.body).toMatchObject({ name: 'Footer', version: 1, createdBy: { displayName: 'Owner' } });
    expect(c.body.blocks[1].html).toBe('<p>Upper</p>');
    const id = c.body.id as string;
    expect((await viewer.get(S(`/${id}`))).body.blocks).toEqual(c.body.blocks);
    expect((await viewer.get(S())).body.data[0]).toEqual({ id, name: 'Footer', blockCount: 3, version: 1, updatedAt: c.body.updatedAt });
    expect((await owner.patch(S(`/${id}`), { expectedVersion: 1, name: 'Footer v2' })).body.version).toBe(2);
    expect((await owner.patch(S(`/${id}`), { expectedVersion: 1, name: 'Stale' })).status).toBe(409);
    expect((await owner.delete(S(`/${id}`))).status).toBe(204);
    expect((await owner.get(S(`/${id}`))).status).toBe(404);
    const audits = await withOwnerConnection(async (cl) => (await cl.query(`SELECT action FROM audit_logs WHERE target_id = $1 ORDER BY occurred_at`, [id])).rows.map((r) => r.action));
    expect(audits).toEqual(['snippet.created', 'snippet.updated', 'snippet.deleted']);
  });

  it('blocks are validated with the v3 rules: unsafe HTML and bad links are 422 with pointers; shapes outside the contract are 400', async () => {
    const bad = await owner.post(S(), { name: 'Bad', blocks: [{ id: 'x', type: 'html', html: '<a href="javascript:alert(1)">x</a>' }, { id: 'b', type: 'button', label: 'Go', href: 'ftp://x' }] });
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.body.error.fields).sort()).toEqual(['blocks/0/html', 'blocks/1/href']);
    expect((await owner.post(S(), { name: 'Empty', blocks: [] })).status).toBe(422);
    expect((await owner.post(S(), { name: 'Shape', blocks: [{ id: 'x', type: 'script' }] })).status).toBe(400);
    expect((await owner.post(S(), { name: 'Many', blocks: Array.from({ length: 21 }, (_, i) => ({ id: `p${i}`, type: 'paragraph', runs: [{ text: 'x' }] })) })).status).toBe(400);
  });

  it('names are unique among live snippets (case-insensitive); search and keyset pages', async () => {
    expect((await owner.post(S(), { name: 'Header', blocks: footer() })).status).toBe(201);
    expect((await owner.post(S(), { name: 'HEADER', blocks: footer() })).status).toBe(409);
    for (let i = 0; i < 3; i++) await owner.post(S(), { name: `Promo ${i}`, blocks: footer() });
    const found = await owner.get(S('?q=promo&limit=2'));
    expect(found.body.data).toHaveLength(2);
    const next = await owner.get(S(`?q=promo&limit=2&cursor=${encodeURIComponent(found.body.nextCursor)}`));
    expect(next.body.data).toHaveLength(1);
    expect((await owner.get(S(`?limit=2&cursor=${encodeURIComponent(found.body.nextCursor)}`))).status).toBe(400); // cursor scoped to the search
  });

  it('viewers read but cannot change; another organization gets 404; the database hides and protects the rows', async () => {
    const id = (await owner.post(S(), { name: 'Guarded', blocks: footer() })).body.id as string;
    expect((await viewer.get(S(`/${id}`))).status).toBe(200);
    expect((await viewer.post(S(), { name: 'Nope', blocks: footer() })).status).toBe(403);
    expect((await viewer.patch(S(`/${id}`), { expectedVersion: 1, name: 'x' })).status).toBe(403);
    expect((await viewer.delete(S(`/${id}`))).status).toBe(403);
    expect((await outsider.get(S(`/${id}`, WB))).status).toBe(404);
    expect((await outsider.get(S(`/${id}`))).status).toBe(404);
    const outsiderOrg = await withOwnerConnection(async (c) => (await c.query(`SELECT org_id FROM workspaces WHERE id = $1`, [WB])).rows[0].org_id as string);
    expect(await withAppConnection({ orgId: outsiderOrg, workspaceId: WB }, async (c) => (await c.query(`SELECT count(*)::int AS n FROM email_snippets WHERE id = $1`, [id])).rows[0].n)).toBe(0);
    await expect(withAppConnection({ orgId, workspaceId: W }, (c) => c.query(`DELETE FROM email_snippets WHERE id = $1`, [id]))).rejects.toThrow(/permission denied/);
    await expect(
      withAppConnection({ orgId: outsiderOrg, workspaceId: WB }, (c) =>
        c.query(`INSERT INTO email_snippets (id, org_id, workspace_id, name, name_key, content) VALUES (gen_random_uuid(), $1, $2, 'x', 'x', '{"schema":"email.snippet.v1","blocks":[]}')`, [orgId, W]),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
