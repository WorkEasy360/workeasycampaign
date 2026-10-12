import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withAppConnection } from '@workeasy/db/testing';
import { type Agent, createOrg, inviteAndAccept, resetTestDatabase, signUp, startTestApp, type TestApp, withOwnerConnection } from './support.js';

/**
 * Template version history, restore and categories (Phase 7.1, docs/contracts/phase-7-content-amendment.md §T) through
 * the real HTTP stack: immutable history keyed by the template's version, restore as a NEW version, optimistic locking,
 * deleted-template protection, clone independence, categories, permissions, tenancy (HTTP and database) and audit.
 */
describe('template history, restore and categories (7.1)', () => {
  let t: TestApp;
  let owner: Agent;
  let viewer: Agent;
  let editor: Agent;
  let outsider: Agent;
  let orgId: string;
  let W: string;
  let WB: string;
  const T = (p = '', ws = W) => `/v1/workspaces/${ws}/templates${p}`;
  const content = (subject: string, text = 'Body') => ({
    schema: 'email.content.v2',
    subject,
    preheader: '',
    body: { format: 'blocks', blocks: [{ id: 'p1', type: 'paragraph', runs: [{ text }] }] },
  });
  const audits = (action: string, targetId: string) =>
    withOwnerConnection(async (c) => (await c.query(`SELECT metadata FROM audit_logs WHERE org_id = $1 AND action = $2 AND target_id = $3 ORDER BY occurred_at`, [orgId, action, targetId])).rows as { metadata: Record<string, unknown> }[]);
  const historyRows = (templateId: string) =>
    withOwnerConnection(async (c) => (await c.query(`SELECT version, change FROM email_template_versions WHERE template_id = $1 ORDER BY version`, [templateId])).rows as { version: number; change: string }[]);

  beforeAll(async () => {
    await resetTestDatabase();
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test' });
    owner = await signUp(t, undefined, 'Owner');
    ({ orgId, workspaceId: W } = await createOrg(owner, 'History Co'));
    viewer = await signUp(t, undefined, 'Viewer');
    await inviteAndAccept(t, owner, viewer, orgId, 'member', [{ workspaceId: W, roleKey: 'viewer' }]);
    editor = await signUp(t, undefined, 'Editor');
    await inviteAndAccept(t, owner, editor, orgId, 'member', [{ workspaceId: W, roleKey: 'editor' }]);
    outsider = await signUp(t, undefined, 'Outsider');
    ({ workspaceId: WB } = await createOrg(outsider, 'Other Co'));
  });
  afterAll(async () => t?.close());

  it('every create and update records the state after the change; history is newest first with the actor', async () => {
    const c = await owner.post(T(), { name: 'Newsletter', description: 'first', content: content('One') });
    expect(c.status).toBe(201);
    const id = c.body.id as string;
    expect((await editor.patch(T(`/${id}`), { expectedVersion: 1, content: content('Two') })).status).toBe(200);
    expect((await owner.patch(T(`/${id}`), { expectedVersion: 2, description: 'third' })).status).toBe(200);
    expect((await owner.patch(T(`/${id}`), { expectedVersion: 3, description: 'third' })).body.version).toBe(3); // no change, no version

    const h = await viewer.get(T(`/${id}/versions`));
    expect(h.status).toBe(200);
    expect(h.body.data.map((v: { version: number; change: string; subject: string }) => [v.version, v.change, v.subject])).toEqual([
      [3, 'updated', 'Two'],
      [2, 'updated', 'Two'],
      [1, 'created', 'One'],
    ]);
    expect(h.body.data[1].createdBy).toMatchObject({ displayName: 'Editor' });
    expect(h.body.nextCursor).toBeNull();

    const v1 = await viewer.get(T(`/${id}/versions/1`));
    expect(v1.status).toBe(200);
    expect(v1.body).toMatchObject({ version: 1, change: 'created', restoredFromVersion: null, name: 'Newsletter', description: 'first', category: null, content: { subject: 'One' } });
    expect(await historyRows(id)).toEqual([
      { version: 1, change: 'created' },
      { version: 2, change: 'updated' },
      { version: 3, change: 'updated' },
    ]);
  });

  it('restore creates a NEW version copied from an older one (name kept), audited; restoring the current state changes nothing', async () => {
    const c = await owner.post(T(), { name: 'Promo', description: 'orig', category: 'Sales', content: content('Original', 'old body') });
    const id = c.body.id as string;
    await owner.patch(T(`/${id}`), { expectedVersion: 1, name: 'Promo renamed', description: 'changed', category: null, content: content('Changed', 'new body') });

    const r = await owner.post(T(`/${id}/restore`), { version: 1, expectedVersion: 2 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ version: 3, name: 'Promo renamed', description: 'orig', category: 'Sales', content: { subject: 'Original' } });
    expect(r.body.content.body.blocks[0].runs[0].text).toBe('old body');
    const h = (await owner.get(T(`/${id}/versions`))).body.data;
    expect(h[0]).toMatchObject({ version: 3, change: 'restored', restoredFromVersion: 1, subject: 'Original' });
    expect(h.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]); // nothing rewritten
    const restoredAudits = await audits('template.restored', id);
    expect(restoredAudits).toHaveLength(1);
    expect(restoredAudits[0]!.metadata).toMatchObject({ fromVersion: 1, version: 3 });

    const again = await owner.post(T(`/${id}/restore`), { version: 1, expectedVersion: 3 });
    expect(again.status).toBe(200);
    expect(again.body.version).toBe(3);
    expect((await historyRows(id)).length).toBe(3);
  });

  it('restore is optimistic (stale version → 409), and unknown or malformed versions are 404', async () => {
    const id = (await owner.post(T(), { name: 'Locked', content: content('A') })).body.id as string;
    await owner.patch(T(`/${id}`), { expectedVersion: 1, content: content('B') });
    expect((await owner.post(T(`/${id}/restore`), { version: 1, expectedVersion: 1 })).status).toBe(409);
    expect((await owner.post(T(`/${id}/restore`), { version: 9, expectedVersion: 2 })).status).toBe(404);
    for (const bad of ['0', 'abc', '-1', '1.5', '99999999999', '01']) expect((await owner.get(T(`/${id}/versions/${bad}`))).status, bad).toBe(404);
    expect((await owner.get(T(`/${id}/versions/7`))).status).toBe(404);
    expect((await owner.post(T(`/${id}/restore`), { version: 1 })).status).toBe(400);
    expect((await owner.post(T(`/${id}/restore`), { version: 1, expectedVersion: 2, name: 'x' })).status).toBe(400);
  });

  it('concurrent restore and update of one template: exactly one wins; history has no duplicate or lost version', async () => {
    const id = (await owner.post(T(), { name: 'Race', content: content('R1') })).body.id as string;
    await owner.patch(T(`/${id}`), { expectedVersion: 1, content: content('R2') });
    const results = await Promise.all([owner.post(T(`/${id}/restore`), { version: 1, expectedVersion: 2 }), editor.patch(T(`/${id}`), { expectedVersion: 2, content: content('R3') })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await historyRows(id)).toHaveLength(3);
    const now = (await owner.get(T(`/${id}`))).body;
    const last = (await owner.get(T(`/${id}/versions/3`))).body;
    expect(last.content).toEqual(now.content);
  });

  it('history pages with a signed cursor scoped to the template', async () => {
    const id = (await owner.post(T(), { name: 'Paged', content: content('P1') })).body.id as string;
    for (let v = 1; v < 5; v++) await owner.patch(T(`/${id}`), { expectedVersion: v, content: content(`P${v + 1}`) });
    const p1 = await owner.get(T(`/${id}/versions?limit=2`));
    expect(p1.body.data.map((v: { version: number }) => v.version)).toEqual([5, 4]);
    const p2 = await owner.get(T(`/${id}/versions?limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`));
    expect(p2.body.data.map((v: { version: number }) => v.version)).toEqual([3, 2]);
    const p3 = await owner.get(T(`/${id}/versions?limit=2&cursor=${encodeURIComponent(p2.body.nextCursor)}`));
    expect(p3.body).toMatchObject({ nextCursor: null });
    expect(p3.body.data.map((v: { version: number }) => v.version)).toEqual([1]);
    const other = (await owner.post(T(), { name: 'Other', content: content('O') })).body.id as string;
    expect((await owner.get(T(`/${other}/versions?cursor=${encodeURIComponent(p1.body.nextCursor)}`))).status).toBe(400); // scoped
    expect((await owner.get(T(`/${id}/versions?cursor=forged.cursor`))).status).toBe(400);
  });

  it('a deleted template has no reachable history and cannot be restored; its rows stay (immutable)', async () => {
    const id = (await owner.post(T(), { name: 'Doomed', content: content('D1') })).body.id as string;
    await owner.patch(T(`/${id}`), { expectedVersion: 1, content: content('D2') });
    expect((await owner.delete(T(`/${id}`))).status).toBe(204);
    expect((await owner.get(T(`/${id}/versions`))).status).toBe(404);
    expect((await owner.get(T(`/${id}/versions/1`))).status).toBe(404);
    expect((await owner.post(T(`/${id}/restore`), { version: 1, expectedVersion: 3 })).status).toBe(404);
    expect(await historyRows(id)).toHaveLength(2);
  });

  it('a clone starts its own history at version 1; later edits of either do not reach the other', async () => {
    const src = (await owner.post(T(), { name: 'Source', category: 'Onboarding', content: content('S1') })).body.id as string;
    await owner.patch(T(`/${src}`), { expectedVersion: 1, content: content('S2') });
    const clone = await owner.post(T(), { name: 'Copy', fromTemplateId: src });
    expect(clone.status).toBe(201);
    expect(clone.body).toMatchObject({ version: 1, category: null, content: { subject: 'S2' } });
    await owner.patch(T(`/${src}`), { expectedVersion: 2, content: content('S3') });
    expect((await owner.get(T(`/${clone.body.id}`))).body.content.subject).toBe('S2');
    expect(await historyRows(clone.body.id)).toEqual([{ version: 1, change: 'created' }]);
  });

  it('categories: set, filter (case-insensitive), list distinct, clear; validated', async () => {
    const a = (await owner.post(T(), { name: 'Cat A', category: 'Newsletters', content: content('A') })).body;
    const b = (await owner.post(T(), { name: 'Cat B', category: 'newsletters', content: content('B') })).body;
    await owner.post(T(), { name: 'Cat C', category: 'Transactional-ish', content: content('C') });
    const filtered = await viewer.get(T('?category=NEWSLETTERS'));
    expect(filtered.status).toBe(200);
    expect(filtered.body.data.map((x: { id: string }) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(filtered.body.data[0].category).toMatch(/newsletters/i);
    const cats = await viewer.get(`/v1/workspaces/${W}/template-categories`);
    expect(cats.status).toBe(200);
    expect(cats.body.data.filter((x: string) => /newsletters/i.test(x))).toHaveLength(1);
    expect(cats.body.data).toContain('Transactional-ish');
    const cleared = await owner.patch(T(`/${a.id}`), { expectedVersion: 1, category: null });
    expect(cleared.body).toMatchObject({ category: null, version: 2 });
    expect((await owner.post(T(), { name: 'Bad', category: 'x'.repeat(61), content: content('X') })).status).toBe(400);
    expect((await owner.post(T(), { name: 'Bad', category: '   ', content: content('X') })).status).toBe(400);
  });

  it('permissions: viewers read history but cannot restore; another organization gets 404; the database hides and protects the rows', async () => {
    const id = (await owner.post(T(), { name: 'Guarded', content: content('G1') })).body.id as string;
    await owner.patch(T(`/${id}`), { expectedVersion: 1, content: content('G2') });
    expect((await viewer.get(T(`/${id}/versions`))).status).toBe(200);
    expect((await viewer.post(T(`/${id}/restore`), { version: 1, expectedVersion: 2 })).status).toBe(403);
    expect((await outsider.get(T(`/${id}/versions`, WB))).status).toBe(404);
    expect((await outsider.get(T(`/${id}/versions`))).status).toBe(404);
    expect((await outsider.post(T(`/${id}/restore`, WB), { version: 1, expectedVersion: 2 })).status).toBe(404);
    expect((await outsider.get(`/v1/workspaces/${W}/template-categories`)).status).toBe(404);

    const outsiderOrg = await withOwnerConnection(async (c) => (await c.query(`SELECT org_id FROM workspaces WHERE id = $1`, [WB])).rows[0].org_id as string);
    const seen = await withAppConnection({ orgId: outsiderOrg, workspaceId: WB }, async (c) => (await c.query(`SELECT count(*)::int AS n FROM email_template_versions WHERE template_id = $1`, [id])).rows[0].n);
    expect(seen).toBe(0);
    expect(await withAppConnection({ orgId, workspaceId: W }, async (c) => (await c.query(`SELECT count(*)::int AS n FROM email_template_versions WHERE template_id = $1`, [id])).rows[0].n)).toBe(2);
    await expect(withAppConnection({ orgId, workspaceId: W }, (c) => c.query(`UPDATE email_template_versions SET name = 'x' WHERE template_id = $1`, [id]))).rejects.toThrow(/permission denied/);
    await expect(withAppConnection({ orgId, workspaceId: W }, (c) => c.query(`DELETE FROM email_template_versions WHERE template_id = $1`, [id]))).rejects.toThrow(/permission denied/);
    await expect(withOwnerConnection((c) => c.query(`UPDATE email_template_versions SET name = 'x' WHERE template_id = $1`, [id]))).rejects.toThrow();
    await expect(
      withAppConnection({ orgId: outsiderOrg, workspaceId: WB }, (c) =>
        c.query(
          `INSERT INTO email_template_versions (id, org_id, workspace_id, template_id, version, change, name, description, content) VALUES (gen_random_uuid(), $1, $2, $3, 9, 'updated', 'x', '', '{"schema":"email.content.v2"}')`,
          [orgId, W, id],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
