import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Agent, createOrg, emailOf, resetTestDatabase, roleId, signUp, startTestApp, type TestApp, withOwnerConnection } from './support.js';

/**
 * Content amendment (docs/contracts/phase-6-content-amendment.md) through the real HTTP stack: email.content.v2
 * drafts and readiness, campaign.version.v2 snapshots, historical v1 versions, and the preview endpoint with the
 * Audience Profiles port (permissions, tenancy, erasure, escaping, read-only).
 */
describe('campaign content v2, versions and preview', () => {
  let t: TestApp;
  let owner: Agent;
  let campaignsOnly: Agent; // campaigns.read without contacts.read
  let outsider: Agent;
  let orgId: string;
  let W: string;
  let WB: string;
  let topicId: string;
  let listId: string;
  let contactId: string;
  const url = (p = '', ws = W) => `/v1/workspaces/${ws}/campaigns${p}`;

  const v2 = (subject: string, blocks: unknown[]) => ({ schema: 'email.content.v2', subject, preheader: '', body: { format: 'blocks', blocks } });
  const good = () =>
    v2('Hello {{ contact.first_name | "there" }}', [
      { id: 'h1', type: 'heading', level: 1, runs: [{ text: 'Autumn news' }] },
      { id: 'p1', type: 'paragraph', runs: [{ text: 'Hi {{ contact.first_name }}, read ' }, { text: 'more', href: 'https://example.com/more' }] },
      { id: 'b1', type: 'button', label: 'Shop', href: 'https://example.com/shop' },
    ]);

  async function draft(content: unknown, name = 'Content'): Promise<{ id: string; version: number; body: any }> {
    const c = await owner.post(url(), { name, channel: 'email', topicId });
    expect(c.status).toBe(201);
    const p = await owner.patch(url(`/${c.body.id}`), {
      expectedVersion: 1,
      audience: { include: [{ type: 'list', listId }], exclude: [] },
      sender: { senderIdentityId: null, fromName: 'Acme', replyTo: null },
      messages: [{ variantKey: 'default', content }],
    });
    return { id: c.body.id, version: p.body.version, body: p.body };
  }
  const counts = () =>
    withOwnerConnection(async (c) => {
      const e = await c.query(`SELECT count(*)::int AS n FROM domain_events WHERE workspace_id = $1`, [W]);
      const a = await c.query(`SELECT count(*)::int AS n FROM audit_logs WHERE org_id = $1`, [orgId]);
      return { events: e.rows[0].n as number, audits: a.rows[0].n as number };
    });

  beforeAll(async () => {
    await resetTestDatabase();
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test' });
    owner = await signUp(t, undefined, 'Owner');
    ({ orgId, workspaceId: W } = await createOrg(owner, 'Content Co'));
    topicId = (await owner.get(`/v1/workspaces/${W}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id;
    listId = (await owner.post(`/v1/workspaces/${W}/lists`, { name: 'Customers' })).body.id;
    const c = await owner.post(`/v1/workspaces/${W}/contacts`, { email: 'ann@example.test', firstName: '<script>alert(1)</script>Ann', lastName: 'Lee' });
    expect(c.status).toBe(201);
    contactId = c.body.id;
    expect((await owner.post(`/v1/workspaces/${W}/lists/${listId}/members`, { contactIds: [contactId] })).status).toBe(200);
    expect((await owner.post(`/v1/workspaces/${W}/contacts/${contactId}/consent`, { channel: 'email', action: 'subscribed', source: 'form', lawfulBasis: 'consent', evidenceNote: 'Form' })).status).toBeLessThan(300);

    campaignsOnly = await signUp(t, undefined, 'Campaigns only');
    const custom = await owner.post(`/v1/organizations/${orgId}/roles`, { name: 'Campaign readers', scope: 'workspace', permissions: ['campaigns.read'] });
    expect(custom.status).toBe(201);
    const inv = await owner.post(`/v1/organizations/${orgId}/invitations`, {
      email: emailOf(campaignsOnly),
      organizationRoleId: await roleId(owner, orgId, 'member'),
      workspaces: [{ workspaceId: W, roleId: custom.body.id }],
    });
    expect(inv.status).toBe(201);
    expect((await campaignsOnly.post('/v1/invitations/accept', { token: t.mailer.tokenFrom(emailOf(campaignsOnly), 'invitation') })).status).toBe(200);

    outsider = await signUp(t, undefined, 'Outsider');
    ({ workspaceId: WB } = await createOrg(outsider, 'Other Co'));
  });
  afterAll(async () => t?.close());

  describe('drafts', () => {
    it('a v2 draft saves and reads back exactly; a ready one has no message findings', async () => {
      const d = await draft(good());
      expect(d.body.draft.messages[0].content).toEqual(good());
      expect(d.body.readinessFindings.filter((f: { section: string }) => f.section === 'message')).toEqual([]);
    });

    it('content problems are findings with JSON pointers into the draft (the save is not refused)', async () => {
      const d = await draft(
        v2('Hi {{ contact.password }}', [
          { id: 'p1', type: 'paragraph', runs: [{ text: 'x', href: 'https://e.com/{{ contact.email }}' }] },
          { id: 'b1', type: 'button', label: '', href: 'javascript:alert(1)' },
          { id: 'i1', type: 'image', src: 'http://e.com/a.png', alt: '' },
        ]),
      );
      const f = d.body.readinessFindings.filter((x: { section: string }) => x.section === 'message').map((x: { code: string; field: string }) => `${x.code} ${x.field}`);
      expect(f).toEqual([
        'MERGE_TAG_INVALID /messages/0/content/subject',
        'LINK_INVALID /messages/0/content/body/blocks/0/runs/0/href',
        'BUTTON_LABEL_MISSING /messages/0/content/body/blocks/1/label',
        'LINK_INVALID /messages/0/content/body/blocks/1/href',
        'IMAGE_INVALID /messages/0/content/body/blocks/2/src',
        'IMAGE_INVALID /messages/0/content/body/blocks/2/alt',
      ]);
      expect(d.body.readiness).toBe('not_ready');
    });

    it.each([
      ['raw html field', { ...good(), body: { format: 'blocks', blocks: [], html: '<b>x</b>' } }],
      ['html block type', v2('S', [{ id: 'x1', type: 'html', html: '<script>alert(1)</script>' }])],
      ['event attribute on a block', v2('S', [{ id: 'p1', type: 'paragraph', runs: [{ text: 'x' }], onclick: 'alert(1)' }])],
      ['style on a run', v2('S', [{ id: 'p1', type: 'paragraph', runs: [{ text: 'x', style: 'color:red' }] }])],
      ['bad block id', v2('S', [{ id: 'P 1', type: 'divider' }])],
      ['unknown content schema', { schema: 'email.content.v3', subject: 'S', preheader: '', body: { format: 'html', html: '<p>x</p>' } }],
    ])('the draft contract is strict: %s → 400', async (_name, content) => {
      const c = await owner.post(url(), { name: 'Strict', channel: 'email', topicId });
      const r = await owner.patch(url(`/${c.body.id}`), { expectedVersion: 1, messages: [{ variantKey: 'default', content }] });
      expect(r.status).toBe(400);
    });
  });

  describe('versions', () => {
    it('sending a v2 draft stores a campaign.version.v2 snapshot with merge_tags_v1, the canonical content and a verifiable hash', async () => {
      const d = await draft(v2('  Hi {{ contact.first_name }}  ', [{ id: 'p0', type: 'paragraph', runs: [{ text: '' }] }, ...good().body.blocks]));
      const s = await owner.post(url(`/${d.id}/schedule`), { mode: 'now', expectedVersion: d.version });
      expect(s.status).toBe(200);
      const versions = (await owner.get(url(`/${d.id}/versions`))).body.data;
      const detail = (await owner.get(url(`/${d.id}/versions/${versions[0].id}`))).body;
      expect(detail.snapshot.schema).toBe('campaign.version.v2');
      expect(detail.snapshot.personalization).toEqual({ mode: 'merge_tags_v1' });
      expect(detail.snapshot.messages[0].content.subject).toBe('Hi {{ contact.first_name }}');
      expect(detail.snapshot.messages[0].content.body.blocks.map((b: { id: string }) => b.id)).toEqual(['h1', 'p1', 'b1']);
      const row = await withOwnerConnection(async (c) => (await c.query(`SELECT schema, snapshot, content_hash FROM campaign_versions WHERE id = $1`, [versions[0].id])).rows[0]);
      expect(row.schema).toBe('campaign.version.v2');
      expect(createHash('sha256').update(canonical(row.snapshot)).digest('hex')).toBe(row.content_hash);
      const ev = await withOwnerConnection(async (c) => (await c.query(`SELECT payload FROM domain_events WHERE aggregate_id = $1 AND type = 'campaign.version_created'`, [d.id])).rows[0]);
      expect(ev.payload.schema).toBe('campaign.version.v2');
    });

    it('a v1 text draft still sends; its version is v2 with v1 content and personalization none', async () => {
      const d = await draft({ schema: 'email.content.v1', subject: 'Plain', preheader: '', body: { format: 'text', text: ' Hello {{ contact.first_name }} ' } });
      expect((await owner.post(url(`/${d.id}/schedule`), { mode: 'now', expectedVersion: d.version })).status).toBe(200);
      const v = (await owner.get(url(`/${d.id}/versions`))).body.data[0];
      const snap = (await owner.get(url(`/${d.id}/versions/${v.id}`))).body.snapshot;
      expect(snap.schema).toBe('campaign.version.v2');
      expect(snap.personalization).toEqual({ mode: 'none' });
      expect(snap.messages[0].content).toEqual({ schema: 'email.content.v1', subject: 'Plain', preheader: '', body: { format: 'text', text: 'Hello {{ contact.first_name }}' } });
    });

    it('a historical campaign.version.v1 row is returned AS STORED, and can be restored and cloned', async () => {
      const d = await draft(good(), 'Historical');
      const v1 = {
        schema: 'campaign.version.v1',
        channel: 'email',
        purpose: 'marketing',
        topic: { topicIds: [topicId], policy: 'block_unsubscribed' },
        audience: { include: [{ type: 'list', listId }], exclude: [] },
        sender: { senderIdentityId: null, fromName: 'Acme', replyTo: null },
        messages: [{ variantKey: 'default', content: { schema: 'email.content.v1', subject: 'Old', preheader: '', body: { format: 'text', text: 'Old body' } } }],
        tracking: { opens: false, clicks: false },
        compliance: { unsubscribeLink: 'required', listUnsubscribeHeader: 'required' },
        personalization: { mode: 'none' },
        schedule: { mode: 'now', sendAt: null, timezone: 'UTC' },
        abTest: null,
      };
      const versionId = await withOwnerConnection(async (c) => {
        const r = await c.query(
          `INSERT INTO campaign_versions (id, org_id, workspace_id, campaign_id, number, schema, snapshot, content_hash, reason)
           VALUES (gen_random_uuid(), $1, $2, $3, 1, 'campaign.version.v1', $4, $5, 'sent_now') RETURNING id`,
          [orgId, W, d.id, JSON.stringify(v1), createHash('sha256').update(canonical(v1)).digest('hex')],
        );
        return r.rows[0].id as string;
      });
      const detail = await owner.get(url(`/${d.id}/versions/${versionId}`));
      expect(detail.status).toBe(200);
      expect(detail.body.snapshot).toEqual(v1);
      const restored = await owner.post(url(`/${d.id}/versions/${versionId}/restore`), { expectedVersion: d.version });
      expect(restored.status).toBe(200);
      expect(restored.body.draft.messages[0].content).toEqual(v1.messages[0]!.content);
      const clone = await owner.post(url(`/${d.id}/clone`), { name: 'From v1', versionId });
      expect(clone.status).toBe(201);
      expect(clone.body.draft.messages[0].content.schema).toBe('email.content.v1');
    });
  });

  describe('preview (amendment §5)', () => {
    it('renders the draft with the example profile: personalized, escaped, with the compliance footer', async () => {
      const d = await draft(good());
      const r = await owner.post(url(`/${d.id}/preview`), {});
      expect(r.status).toBe(200);
      expect(r.body.sample).toBe('example');
      expect(r.body.subject).toBe('Hello Alex');
      expect(r.body.html).toContain('Hi Alex, read');
      expect(r.body.html).toContain('href="https://example.com/shop"');
      expect(r.body.html).toContain('Unsubscribe');
      expect(r.body.text).toContain('Shop: https://example.com/shop');
      expect(r.body.missingTags).toEqual([]);
      expect(r.headers['cache-control']).toBe('no-store'); // contains rendered personal data: never cached
    });

    it('renders with a real contact through the Audience port; hostile field values stay text', async () => {
      const d = await draft(good());
      const r = await owner.post(url(`/${d.id}/preview`), { contactId });
      expect(r.status).toBe(200);
      expect(r.body.sample).toBe('contact');
      expect(r.body.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;Ann');
      expect(r.body.html).not.toContain('<script>');
      expect(r.body.missingTags).toEqual([]);
    });

    it('reports merge fields the contact has no value for', async () => {
      const d = await draft(v2('{{ contact.company | "your team" }}', [{ id: 'p1', type: 'paragraph', runs: [{ text: 'At {{ contact.company }}' }] }]));
      const r = await owner.post(url(`/${d.id}/preview`), { contactId });
      expect(r.body.subject).toBe('your team');
      expect(r.body.missingTags).toEqual(['contact.company']);
    });

    it('a contact needs contacts.read; without one the example preview still works', async () => {
      const d = await draft(good());
      const denied = await campaignsOnly.post(url(`/${d.id}/preview`), { contactId });
      expect(denied.status).toBe(403);
      expect(JSON.stringify(denied.body)).not.toContain('Ann');
      expect((await campaignsOnly.post(url(`/${d.id}/preview`), {})).status).toBe(200);
    });

    it('tenancy: another workspace cannot preview this campaign, and a contact of another workspace is not found', async () => {
      const d = await draft(good());
      expect((await outsider.post(url(`/${d.id}/preview`, WB), {})).status).toBe(404);
      expect((await outsider.post(url(`/${d.id}/preview`), {})).status).toBe(404); // not a member: the workspace is not disclosed
      const foreign = await outsider.post(`/v1/workspaces/${WB}/contacts`, { email: 'zed@example.test', firstName: 'Zed' });
      const r = await owner.post(url(`/${d.id}/preview`), { contactId: foreign.body.id });
      expect(r.status).toBe(404);
      expect(JSON.stringify(r.body)).not.toContain('Zed');
    });

    it('erased and unknown contacts are not found; bodies are strict', async () => {
      const d = await draft(good());
      const c = await owner.post(`/v1/workspaces/${W}/contacts`, { email: 'gone@example.test', firstName: 'Gone' });
      expect((await owner.post(`/v1/workspaces/${W}/contacts/${c.body.id}/erase`, { confirm: 'ERASE' })).status).toBe(204);
      expect((await owner.post(url(`/${d.id}/preview`), { contactId: c.body.id })).status).toBe(404);
      expect((await owner.post(url(`/${d.id}/preview`), { contactId: '01a11850-b308-7102-9271-54fa8ea2c893' })).status).toBe(404);
      expect((await owner.post(url(`/${d.id}/preview`), { contactId: 'nope' })).status).toBe(400);
      expect((await owner.post(url(`/${d.id}/preview`), { workspaceId: WB })).status).toBe(400);
    });

    it('is read-only: no events, no audit entries, no changes to the campaign', async () => {
      const d = await draft(good());
      const before = await counts();
      const view = (await owner.get(url(`/${d.id}`))).body;
      await owner.post(url(`/${d.id}/preview`), {});
      await owner.post(url(`/${d.id}/preview`), { contactId });
      expect(await counts()).toEqual(before);
      expect((await owner.get(url(`/${d.id}`))).body).toEqual(view);
    });

    it('previews v1 text drafts verbatim (no merge interpretation)', async () => {
      const d = await draft({ schema: 'email.content.v1', subject: 'Hi {{ contact.first_name }}', preheader: '', body: { format: 'text', text: '<b>Hi</b> {{ contact.first_name }}' } });
      const r = await owner.post(url(`/${d.id}/preview`), { contactId });
      expect(r.body.subject).toBe('Hi {{ contact.first_name }}');
      expect(r.body.html).toContain('&lt;b&gt;Hi&lt;/b&gt; {{ contact.first_name }}');
    });
  });
});

/** Canonical JSON (sorted keys, no whitespace) — the content-hash definition of contract §4.2. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`;
}
