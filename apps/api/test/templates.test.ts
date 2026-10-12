import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withAppConnection } from '@workeasy/db/testing';
import { type Agent, createOrg, emailOf, inviteAndAccept, resetTestDatabase, roleId, signUp, startTestApp, type TestApp, withOwnerConnection } from './support.js';

/**
 * Email templates (docs/contracts/phase-6-content-amendment.md §6, rows T1–T7) through the real HTTP stack:
 * CRUD with optimistic locking, strict content, permissions, tenancy (HTTP and database RLS), audit, "save as
 * template", and applying a template to a draft (copy semantics).
 */
describe('email templates API', () => {
  let t: TestApp;
  let owner: Agent;
  let viewer: Agent;
  let editorNoTemplates: Agent; // campaigns.update without templates.read
  let outsider: Agent;
  let orgId: string;
  let W: string;
  let WB: string;
  let topicId: string;
  const T = (p = '', ws = W) => `/v1/workspaces/${ws}/templates${p}`;
  const C = (p = '', ws = W) => `/v1/workspaces/${ws}/campaigns${p}`;
  const content = (subject = 'Monthly news') => ({
    schema: 'email.content.v2',
    subject,
    preheader: '',
    body: { format: 'blocks', blocks: [{ id: 'h1', type: 'heading', level: 1, runs: [{ text: 'News' }] }, { id: 'p1', type: 'paragraph', runs: [{ text: 'Hi {{ contact.first_name | "there" }}' }] }] },
  });
  const audits = (action: string) =>
    withOwnerConnection(async (c) => (await c.query(`SELECT target_id, metadata FROM audit_logs WHERE org_id = $1 AND action = $2 ORDER BY occurred_at`, [orgId, action])).rows as { target_id: string; metadata: Record<string, unknown> }[]);

  beforeAll(async () => {
    await resetTestDatabase();
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test' });
    owner = await signUp(t, undefined, 'Owner');
    ({ orgId, workspaceId: W } = await createOrg(owner, 'Templates Co'));
    topicId = (await owner.get(`/v1/workspaces/${W}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id;
    viewer = await signUp(t, undefined, 'Viewer');
    await inviteAndAccept(t, owner, viewer, orgId, 'member', [{ workspaceId: W, roleKey: 'viewer' }]);
    editorNoTemplates = await signUp(t, undefined, 'No templates');
    const custom = await owner.post(`/v1/organizations/${orgId}/roles`, { name: 'Campaign editors', scope: 'workspace', permissions: ['campaigns.read', 'campaigns.update', 'campaigns.create'] });
    expect(custom.status).toBe(201);
    const inv = await owner.post(`/v1/organizations/${orgId}/invitations`, { email: emailOf(editorNoTemplates), organizationRoleId: await roleId(owner, orgId, 'member'), workspaces: [{ workspaceId: W, roleId: custom.body.id }] });
    expect(inv.status).toBe(201);
    expect((await editorNoTemplates.post('/v1/invitations/accept', { token: t.mailer.tokenFrom(emailOf(editorNoTemplates), 'invitation') })).status).toBe(200);
    outsider = await signUp(t, undefined, 'Outsider');
    ({ workspaceId: WB } = await createOrg(outsider, 'Other Co'));
  });
  afterAll(async () => t?.close());

  describe('CRUD', () => {
    it('creates (canonical content), reads, lists without content, updates with the version, deletes; every change audited', async () => {
      const withEmpty = { ...content(), subject: '  Monthly news  ', body: { format: 'blocks', blocks: [...content().body.blocks, { id: 'p2', type: 'paragraph', runs: [{ text: 'x' }, { text: '' }] }] } };
      const created = await owner.post(T(), { name: 'Monthly', description: 'Our newsletter', content: withEmpty });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ name: 'Monthly', description: 'Our newsletter', version: 1, createdBy: { displayName: 'Owner' } });
      expect(created.body.content.subject).toBe('Monthly news');
      expect(created.body.content.body.blocks.at(-1)).toEqual({ id: 'p2', type: 'paragraph', runs: [{ text: 'x' }] });
      const id = created.body.id;

      expect((await viewer.get(T(`/${id}`))).body.content).toEqual(created.body.content);
      const list = await viewer.get(T());
      expect(list.status).toBe(200);
      expect(list.body.data[0]).toEqual({ id, name: 'Monthly', description: 'Our newsletter', category: null, subject: 'Monthly news', blockCount: 3, version: 1, updatedAt: created.body.updatedAt });

      const updated = await owner.patch(T(`/${id}`), { expectedVersion: 1, name: 'Monthly v2', content: content('New subject') });
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({ name: 'Monthly v2', version: 2, content: { subject: 'New subject' } });
      expect((await owner.patch(T(`/${id}`), { expectedVersion: 1, name: 'Stale' })).status).toBe(409);
      expect((await owner.patch(T(`/${id}`), { expectedVersion: 2, name: 'Monthly v2' })).body.version).toBe(2); // no change: no new version

      expect((await owner.delete(T(`/${id}`))).status).toBe(204);
      expect((await owner.get(T(`/${id}`))).status).toBe(404);
      expect((await owner.patch(T(`/${id}`), { expectedVersion: 3, name: 'Gone' })).status).toBe(404);
      expect((await audits('template.created')).map((a) => a.target_id)).toContain(id);
      expect((await audits('template.updated')).find((a) => a.target_id === id)?.metadata).toMatchObject({ changes: 'name,content' });
      expect((await audits('template.deleted')).map((a) => a.target_id)).toContain(id);
    });

    it('names are unique per workspace, case-insensitively, among live templates; a deleted name can be reused', async () => {
      const a = await owner.post(T(), { name: 'Welcome', content: content() });
      expect((await owner.post(T(), { name: ' welcome ', content: content() })).status).toBe(409);
      expect((await outsider.post(T('', WB), { name: 'Welcome', content: content() })).status).toBe(201);
      await owner.delete(T(`/${a.body.id}`));
      expect((await owner.post(T(), { name: 'WELCOME', content: content() })).status).toBe(201);
    });

    it.each([
      ['raw html', { ...content(), body: { format: 'blocks', blocks: [], html: '<b>x</b>' } }],
      ['script block', { ...content(), body: { format: 'blocks', blocks: [{ id: 'x', type: 'html', html: '<script>alert(1)</script>' }] } }],
      ['v1 content', { schema: 'email.content.v1', subject: 'S', preheader: '', body: { format: 'text', text: 'x' } }],
      ['workspaceId in the body', null],
    ])('content and bodies are strict: %s → 400', async (name, c) => {
      const body = c === null ? { name: `Strict ${name}`, content: content(), workspaceId: WB } : { name: `Strict ${name}`, content: c };
      expect((await owner.post(T(), body)).status).toBe(400);
    });

    it('content that is valid in shape but incomplete or unsafe is refused with 422, one field error per problem', async () => {
      const r = await owner.post(T(), {
        name: 'Broken',
        content: { ...content('Hi {{ contact.secret }}'), body: { format: 'blocks', blocks: [{ id: 'b1', type: 'button', label: 'Go', href: 'javascript:alert(1)' }, { id: 'i1', type: 'image', src: 'http://e.com/a.png', alt: 'A' }] } },
      });
      expect(r.status).toBe(422);
      expect(Object.keys(r.body.error.fields).sort()).toEqual(['content/body/blocks/0/href', 'content/body/blocks/1/src', 'content/subject']);
      expect((await owner.get(T('?q=Broken'))).body.data).toEqual([]);
    });

    it('keyset pagination and search', async () => {
      for (const n of ['Page A', 'Page B', 'Page C']) expect((await owner.post(T(), { name: n, content: content() })).status).toBe(201);
      const first = await owner.get(T('?q=page&limit=2'));
      expect(first.body.data.map((x: { name: string }) => x.name)).toEqual(['Page C', 'Page B']);
      const second = await owner.get(T(`?q=page&limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`));
      expect(second.body.data.map((x: { name: string }) => x.name)).toEqual(['Page A']);
      expect(second.body.nextCursor).toBeNull();
    });
  });

  describe('permissions and tenancy', () => {
    it('viewers read but cannot change templates', async () => {
      const a = await owner.post(T(), { name: 'Viewer test', content: content() });
      expect((await viewer.get(T(`/${a.body.id}`))).status).toBe(200);
      expect((await viewer.post(T(), { name: 'Nope', content: content() })).status).toBe(403);
      expect((await viewer.patch(T(`/${a.body.id}`), { expectedVersion: 1, name: 'Nope' })).status).toBe(403);
      expect((await viewer.delete(T(`/${a.body.id}`))).status).toBe(403);
    });

    it('another organization cannot see or change a template (404), and the database hides it (RLS)', async () => {
      const a = await owner.post(T(), { name: 'Private', content: content() });
      expect((await outsider.get(T(`/${a.body.id}`, WB))).status).toBe(404);
      expect((await outsider.patch(T(`/${a.body.id}`, WB), { expectedVersion: 1, name: 'Taken' })).status).toBe(404);
      expect((await outsider.delete(T(`/${a.body.id}`, WB))).status).toBe(404);
      expect((await outsider.get(T(`/${a.body.id}`))).status).toBe(404);
      const outsiderOrg = await withOwnerConnection(async (c) => (await c.query(`SELECT org_id FROM workspaces WHERE id = $1`, [WB])).rows[0].org_id as string);
      const seen = await withAppConnection({ orgId: outsiderOrg, workspaceId: WB }, async (c) => (await c.query(`SELECT count(*)::int AS n FROM email_templates WHERE id = $1`, [a.body.id])).rows[0].n);
      expect(seen).toBe(0);
      const ownWs = await withAppConnection({ orgId, workspaceId: W }, async (c) => (await c.query(`SELECT count(*)::int AS n FROM email_templates WHERE id = $1`, [a.body.id])).rows[0].n);
      expect(ownWs).toBe(1);
      await expect(
        withAppConnection({ orgId: outsiderOrg, workspaceId: WB }, (c) =>
          c.query(`INSERT INTO email_templates (id, org_id, workspace_id, name, name_key, content) VALUES (gen_random_uuid(), $1, $2, 'x', 'x', '{"schema":"email.content.v2"}')`, [orgId, W]),
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(withAppConnection({ orgId, workspaceId: W }, (c) => c.query(`DELETE FROM email_templates WHERE id = $1`, [a.body.id]))).rejects.toThrow(/permission denied/);
    });
  });

  describe('templates and campaigns', () => {
    async function draftCampaign(c: unknown = content('Draft')) {
      const k = await owner.post(C(), { name: 'Uses template', channel: 'email', topicId });
      const p = await owner.patch(C(`/${k.body.id}`), { expectedVersion: 1, messages: [{ variantKey: 'default', content: c }] });
      return { id: k.body.id as string, version: p.body.version as number };
    }

    it('apply copies the content into the draft (an ordinary edit: version, event); later template edits do not reach the campaign', async () => {
      const tpl = await owner.post(T(), { name: 'Apply me', content: content('From template') });
      const k = await draftCampaign();
      const r = await owner.post(C(`/${k.id}/apply-template`), { templateId: tpl.body.id, expectedVersion: k.version });
      expect(r.status).toBe(200);
      expect(r.body.version).toBe(k.version + 1);
      expect(r.body.draft.messages[0].content).toEqual(tpl.body.content);
      const events = await withOwnerConnection(async (c) => (await c.query(`SELECT type, payload FROM domain_events WHERE aggregate_id = $1 ORDER BY occurred_at`, [k.id])).rows);
      expect(events.at(-1)).toMatchObject({ type: 'campaign.updated' });
      expect((await audits('campaign.template_applied')).find((a) => a.target_id === k.id)?.metadata).toMatchObject({ templateId: tpl.body.id });

      // Applying the same content again changes nothing: no new version and no second audit entry (review L4: the audit
      // is written atomically with a real change only).
      const again = await owner.post(C(`/${k.id}/apply-template`), { templateId: tpl.body.id, expectedVersion: k.version + 1 });
      expect(again.status).toBe(200);
      expect(again.body.version).toBe(k.version + 1);
      expect((await audits('campaign.template_applied')).filter((a) => a.target_id === k.id)).toHaveLength(1);

      await owner.patch(T(`/${tpl.body.id}`), { expectedVersion: 1, content: content('Changed later') });
      expect((await owner.get(C(`/${k.id}`))).body.draft.messages[0].content.subject).toBe('From template');
      expect((await owner.post(C(`/${k.id}/apply-template`), { templateId: tpl.body.id, expectedVersion: k.version })).status).toBe(409);
    });

    it('apply needs templates.read as well as campaigns.update; another workspace’s template is not found', async () => {
      const tpl = await owner.post(T(), { name: 'Perm', content: content() });
      const k = await draftCampaign();
      const denied = await editorNoTemplates.post(C(`/${k.id}/apply-template`), { templateId: tpl.body.id, expectedVersion: k.version });
      expect(denied.status).toBe(403);
      expect((await owner.get(C(`/${k.id}`))).body.version).toBe(k.version);
      const foreign = await outsider.post(T('', WB), { name: 'Foreign', content: content() });
      expect((await owner.post(C(`/${k.id}/apply-template`), { templateId: foreign.body.id, expectedVersion: k.version })).status).toBe(404);
    });

    it('apply is refused once the campaign is no longer a draft', async () => {
      const tpl = await owner.post(T(), { name: 'Late', content: content() });
      const list = await owner.post(`/v1/workspaces/${W}/lists`, { name: `L-${Date.now()}` });
      const k = await owner.post(C(), { name: 'Scheduled', channel: 'email', topicId });
      const p = await owner.patch(C(`/${k.body.id}`), {
        expectedVersion: 1,
        audience: { include: [{ type: 'list', listId: list.body.id }], exclude: [] },
        sender: { senderIdentityId: null, fromName: 'Acme', replyTo: null },
        messages: [{ variantKey: 'default', content: content() }],
      });
      // An empty list has no eligible recipients: scheduling would be refused, so mark the campaign scheduled directly.
      await withOwnerConnection((c) => c.query(`UPDATE campaigns SET status = 'scheduled' WHERE id = $1`, [k.body.id]));
      const r = await owner.post(C(`/${k.body.id}/apply-template`), { templateId: tpl.body.id, expectedVersion: p.body.version });
      expect(r.status).toBe(422); // the same answer as any edit of a non-draft
      expect(r.body.error.code).toBe('CAMPAIGN_NOT_EDITABLE');
    });

    it('save as template: from a complete v2 draft (201); a v1 draft or an incomplete one is refused (422)', async () => {
      const k = await draftCampaign(content('Saved subject'));
      const saved = await owner.post(T(), { name: 'Saved from campaign', fromCampaignId: k.id });
      expect(saved.status).toBe(201);
      expect(saved.body.content.subject).toBe('Saved subject');
      expect((await audits('template.created')).find((a) => a.target_id === saved.body.id)?.metadata).toMatchObject({ fromCampaignId: k.id });
      const v1 = await draftCampaign({ schema: 'email.content.v1', subject: 'S', preheader: '', body: { format: 'text', text: 'x' } });
      expect((await owner.post(T(), { name: 'From v1', fromCampaignId: v1.id })).status).toBe(422);
      const broken = await draftCampaign(content('Hi {{ nope }}'));
      expect((await owner.post(T(), { name: 'From broken', fromCampaignId: broken.id })).status).toBe(422);
      expect((await owner.post(T(), { name: 'Both', fromCampaignId: k.id, content: content() })).status).toBe(400);
      expect((await owner.post(T(), { name: 'Foreign campaign', fromCampaignId: (await outsider.post(C('', WB), { name: 'X', channel: 'email' })).body.id })).status).toBe(404);
    });
  });
});

describe('email templates — roles, deletion and concurrency', () => {
  let t: TestApp;
  let owner: Agent;
  let editor: Agent;
  let orgId: string;
  let W: string;
  let topicId: string;
  const T = (p = '') => `/v1/workspaces/${W}/templates${p}`;
  const C = (p = '') => `/v1/workspaces/${W}/campaigns${p}`;
  const content = (subject = 'S') => ({ schema: 'email.content.v2', subject, preheader: '', body: { format: 'blocks', blocks: [{ id: 'p1', type: 'paragraph', runs: [{ text: 'Hi' }] }] } });

  beforeAll(async () => {
    await resetTestDatabase();
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test' });
    owner = await signUp(t, undefined, 'Owner');
    ({ orgId, workspaceId: W } = await createOrg(owner, 'Roles Co'));
    topicId = (await owner.get(`/v1/workspaces/${W}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id;
    editor = await signUp(t, undefined, 'Editor');
    await inviteAndAccept(t, owner, editor, orgId, 'member', [{ workspaceId: W, roleKey: 'editor' }]);
  });
  afterAll(async () => t?.close());

  it('the built-in editor role manages templates', async () => {
    const c = await editor.post(T(), { name: 'By editor', content: content() });
    expect(c.status).toBe(201);
    expect((await editor.patch(T(`/${c.body.id}`), { expectedVersion: 1, name: 'Renamed by editor' })).status).toBe(200);
    expect((await editor.delete(T(`/${c.body.id}`))).status).toBe(204);
  });

  it('a deleted template cannot be applied; a campaign that applied it earlier keeps its own copy', async () => {
    const tpl = await owner.post(T(), { name: 'Short-lived', content: content('Kept subject') });
    const k = await owner.post(C(), { name: 'Uses it', channel: 'email', topicId });
    const applied = await owner.post(C(`/${k.body.id}/apply-template`), { templateId: tpl.body.id, expectedVersion: 1 });
    expect(applied.status).toBe(200);
    expect((await owner.delete(T(`/${tpl.body.id}`))).status).toBe(204);
    expect((await owner.post(C(`/${k.body.id}/apply-template`), { templateId: tpl.body.id, expectedVersion: applied.body.version })).status).toBe(404);
    expect((await owner.get(C(`/${k.body.id}`))).body.draft.messages[0].content.subject).toBe('Kept subject');
  });

  it('concurrent updates of one template: exactly one wins, the other is a version conflict (no lost update)', async () => {
    const tpl = await owner.post(T(), { name: 'Contended', content: content() });
    const results = await Promise.all([
      owner.patch(T(`/${tpl.body.id}`), { expectedVersion: 1, content: content('From A') }),
      editor.patch(T(`/${tpl.body.id}`), { expectedVersion: 1, content: content('From B') }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = results.find((r) => r.status === 200)!.body.content.subject;
    const now = await owner.get(T(`/${tpl.body.id}`));
    expect(now.body).toMatchObject({ version: 2, content: { subject: winner } });
  });

  it('clone copies the content under a new name; the copy is independent; a deleted source cannot be cloned', async () => {
    const src = await owner.post(T(), { name: 'Original', content: content('Original subject') });
    const copy = await editor.post(T(), { name: 'Copy of original', fromTemplateId: src.body.id });
    expect(copy.status).toBe(201);
    expect(copy.body.content).toEqual(src.body.content);
    expect(copy.body.version).toBe(1);
    await owner.patch(T(`/${src.body.id}`), { expectedVersion: 1, content: content('Changed original') });
    expect((await owner.get(T(`/${copy.body.id}`))).body.content.subject).toBe('Original subject');
    await owner.delete(T(`/${src.body.id}`));
    expect((await owner.post(T(), { name: 'Copy of deleted', fromTemplateId: src.body.id })).status).toBe(404);
    expect((await owner.post(T(), { name: 'Both sources', fromTemplateId: copy.body.id, content: content() })).status).toBe(400);
  });

  it('concurrent clone and delete: the clone is either a full copy (201) or 404 — never partial', async () => {
    const src = await owner.post(T(), { name: 'Race source', content: content('Race subject') });
    const [clone, del] = await Promise.all([owner.post(T(), { name: 'Race clone', fromTemplateId: src.body.id }), owner.delete(T(`/${src.body.id}`))]);
    expect(del.status).toBe(204);
    expect([201, 404]).toContain(clone.status);
    if (clone.status === 201) expect(clone.body.content.subject).toBe('Race subject');
  });

  it('concurrent update and delete: exactly one outcome, no stale write after delete', async () => {
    const src = await owner.post(T(), { name: 'Upd-del', content: content() });
    const [upd, del] = await Promise.all([owner.patch(T(`/${src.body.id}`), { expectedVersion: 1, name: 'Upd-del renamed' }), owner.delete(T(`/${src.body.id}`))]);
    expect(del.status).toBe(204);
    expect([200, 404, 409]).toContain(upd.status);
    expect((await owner.get(T(`/${src.body.id}`))).status).toBe(404);
  });

  it('concurrent delete and apply: the apply either copies the template or is 404 — never a half state', async () => {
    const tpl = await owner.post(T(), { name: 'Racing', content: content('Racing subject') });
    const k = await owner.post(C(), { name: 'Race', channel: 'email', topicId });
    const [del, apply] = await Promise.all([owner.delete(T(`/${tpl.body.id}`)), owner.post(C(`/${k.body.id}/apply-template`), { templateId: tpl.body.id, expectedVersion: 1 })]);
    expect(del.status).toBe(204);
    expect([200, 404]).toContain(apply.status);
    const view = (await owner.get(C(`/${k.body.id}`))).body;
    if (apply.status === 200) expect(view.draft.messages[0].content.subject).toBe('Racing subject');
    else expect(view.version).toBe(1);
  });
});
