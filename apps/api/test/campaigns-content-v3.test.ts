import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Agent, createOrg, resetTestDatabase, signUp, startTestApp, type TestApp, withOwnerConnection } from './support.js';

/**
 * email.content.v3 (docs/contracts/phase-7-content-amendment.md §C, C11–C17) through the real HTTP stack: drafts and
 * readiness (HTML, conditions), personalization v2 through the Audience port (custom fields formatted by Audience,
 * tenant names), preview branch selection, pre-flight custom-field checks blocking schedule, campaign.version.v3,
 * templates with v3 content, and tenancy.
 */
describe('campaign content v3 (dynamic content, personalization v2, HTML)', () => {
  let t: TestApp;
  let owner: Agent;
  let outsider: Agent;
  let W: string;
  let WB: string;
  let topicId: string;
  let listId: string;
  let pro: string; // contact on the Pro plan
  let free: string; // contact without a plan
  let foreignContact: string;
  const url = (p = '', ws = W) => `/v1/workspaces/${ws}/campaigns${p}`;
  const v3 = (blocks: unknown[], subject = 'Hi {{ contact.first_name | "there" }} from {{ organization.name }}') => ({ schema: 'email.content.v3', subject, preheader: '', body: { format: 'blocks', blocks } });
  const p = (id: string, text: string) => ({ id, type: 'paragraph', runs: [{ text }] });
  const dynamic = () =>
    v3([
      p('p1', 'Plan: {{ contact.custom.plan | "none" }}; newsletter: {{ contact.custom.newsletter | "?" }}'),
      {
        id: 'c1',
        type: 'conditional',
        when: { match: 'all', rules: [{ field: 'contact.custom.plan', op: 'equals', value: 'Pro annual' }] },
        then: [p('t1', 'Thanks for staying Pro')],
        else: [p('e1', 'Upgrade today'), { id: 'b1', type: 'button', label: 'Upgrade', href: 'https://example.com/up' }],
      },
      { id: 'x1', type: 'html', html: '<p>Workspace: <strong>{{ workspace.name }}</strong></p>' },
    ]);

  async function draft(content: unknown): Promise<{ id: string; version: number; body: any }> {
    const c = await owner.post(url(), { name: 'V3', channel: 'email', topicId });
    expect(c.status).toBe(201);
    const r = await owner.patch(url(`/${c.body.id}`), {
      expectedVersion: 1,
      audience: { include: [{ type: 'list', listId }], exclude: [] },
      sender: { senderIdentityId: null, fromName: 'Acme', replyTo: null },
      messages: [{ variantKey: 'default', content }],
    });
    expect(r.status, JSON.stringify(r.body).slice(0, 400)).toBe(200);
    return { id: c.body.id, version: r.body.version, body: r.body };
  }
  const codes = (body: { readiness?: unknown; readinessFindings?: { code: string }[] }) => (body.readinessFindings ?? []).map((f) => f.code);

  beforeAll(async () => {
    await resetTestDatabase();
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test' });
    owner = await signUp(t, undefined, 'Owner');
    ({ workspaceId: W } = await createOrg(owner, 'Dynamic Co'));
    await withOwnerConnection((c) => c.query(`UPDATE workspaces SET name = 'Main <b>WS</b>' WHERE id = $1`, [W]));
    topicId = (await owner.get(`/v1/workspaces/${W}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id;
    listId = (await owner.post(`/v1/workspaces/${W}/lists`, { name: 'Customers' })).body.id;
    const F = `/v1/workspaces/${W}/custom-fields`;
    expect((await owner.post(F, { key: 'plan', label: 'Plan', type: 'single_select', options: [{ key: 'pro_annual', label: 'Pro annual' }, { key: 'basic', label: 'Basic' }] })).status).toBe(201);
    expect((await owner.post(F, { key: 'newsletter', label: 'Newsletter', type: 'boolean' })).status).toBe(201);
    const old = await owner.post(F, { key: 'legacy_code', label: 'Legacy code', type: 'text' });
    expect((await owner.post(`${F}/${old.body.id}/archive`, {})).status).toBeLessThan(300);

    const a = await owner.post(`/v1/workspaces/${W}/contacts`, { email: 'pro@example.test', firstName: 'Pia', customFields: { plan: 'pro_annual', newsletter: true } });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    pro = a.body.id;
    free = (await owner.post(`/v1/workspaces/${W}/contacts`, { email: 'free@example.test', firstName: 'Fred' })).body.id;
    for (const id of [pro, free]) {
      expect((await owner.post(`/v1/workspaces/${W}/lists/${listId}/members`, { contactIds: [id] })).status).toBe(200);
      expect((await owner.post(`/v1/workspaces/${W}/contacts/${id}/consent`, { channel: 'email', action: 'subscribed', source: 'form', lawfulBasis: 'consent', evidenceNote: 'Form' })).status).toBeLessThan(300);
    }
    outsider = await signUp(t, undefined, 'Outsider');
    ({ workspaceId: WB } = await createOrg(outsider, 'Other Co'));
    foreignContact = (await outsider.post(`/v1/workspaces/${WB}/contacts`, { email: 'x@other.test', firstName: 'Xena' })).body.id;
  });
  afterAll(async () => t?.close());

  it('a complete v3 draft has no content findings; unsafe HTML and invalid conditions are findings with pointers', async () => {
    const ok = await draft(dynamic());
    expect(codes(ok.body).filter((c) => !['SENDER_NOT_CONFIGURED'].includes(c))).toEqual([]);
    const bad = await draft(
      v3([
        p('p1', 'Hi'),
        { id: 'x1', type: 'html', html: '<p onclick="steal()">x</p><script>alert(1)</script>' },
        { id: 'c1', type: 'conditional', when: { match: 'all', rules: [{ field: 'contact.custom.plan', op: 'equals' }] }, then: [], else: [] },
      ]),
    );
    const f = bad.body.readinessFindings as { code: string; field: string; message: string }[];
    expect(f.find((x) => x.code === 'HTML_UNSUPPORTED')).toMatchObject({ field: '/messages/0/content/body/blocks/1/html', message: expect.stringContaining('<script> element') });
    expect(f.map((x) => [x.code, x.field])).toEqual(expect.arrayContaining([['CONDITION_INVALID', '/messages/0/content/body/blocks/2/when/rules/0/value'], ['CONDITIONAL_EMPTY', '/messages/0/content/body/blocks/2']]));
  });

  it('the draft API refuses v3 shapes outside the contract (nesting, unknown block types, raw fields) with 400', async () => {
    const c = await owner.post(url(), { name: 'Shape', channel: 'email', topicId });
    const nested = v3([{ id: 'c', type: 'conditional', when: { match: 'all', rules: [] }, then: [{ id: 'n', type: 'conditional', when: { match: 'all', rules: [] }, then: [], else: [] }], else: [] }]);
    for (const content of [nested, v3([{ id: 's', type: 'script', code: 'x' }]), v3([{ id: 'x', type: 'html', html: 'a', unsafe: true }])]) {
      expect((await owner.patch(url(`/${c.body.id}`), { expectedVersion: 1, messages: [{ variantKey: 'default', content }] })).status).toBe(400);
    }
  });

  it('preview with a contact: custom fields formatted by Audience, the branch chosen per contact, tenant names escaped', async () => {
    const d = await draft(dynamic());
    const a = await owner.post(url(`/${d.id}/preview`), { contactId: pro });
    expect(a.status).toBe(200);
    expect(a.body.sample).toBe('contact');
    expect(a.body.subject).toBe('Hi Pia from Dynamic Co');
    expect(a.body.text).toContain('Plan: Pro annual; newsletter: Yes'); // option label, boolean Yes
    expect(a.body.text).toContain('Thanks for staying Pro');
    expect(a.body.text).not.toContain('Upgrade today');
    expect(a.body.html).toContain('Workspace: <strong>Main &lt;b&gt;WS&lt;/b&gt;</strong>');
    expect(a.body.missingTags).toEqual([]);

    const b = await owner.post(url(`/${d.id}/preview`), { contactId: free });
    expect(b.body.text).toContain('Plan: none; newsletter: ?');
    expect(b.body.text).toContain('Upgrade today');
    expect(b.body.missingTags).toEqual(expect.arrayContaining(['contact.custom.plan', 'contact.custom.newsletter']));
  });

  it('preview without a contact uses the example profile: labels marked "(example)", the real tenant names', async () => {
    const d = await draft(dynamic());
    const r = await owner.post(url(`/${d.id}/preview`), {});
    expect(r.status).toBe(200);
    expect(r.body.sample).toBe('example');
    expect(r.body.subject).toBe('Hi Alex from Dynamic Co');
    expect(r.body.text).toContain('Plan: Plan (example); newsletter: Newsletter (example)');
  });

  it('tenancy: another workspace’s contact is 404; another organization cannot preview', async () => {
    const d = await draft(dynamic());
    expect((await owner.post(url(`/${d.id}/preview`), { contactId: foreignContact })).status).toBe(404);
    expect((await outsider.post(url(`/${d.id}/preview`, WB), {})).status).toBe(404);
    expect((await outsider.post(url(`/${d.id}/preview`), {})).status).toBe(404);
  });

  it('pre-flight: an unknown custom field blocks scheduling; an archived one is a warning', async () => {
    const unknown = await draft(v3([p('p1', 'Code: {{ contact.custom.no_such_field }}')]));
    const pf = await owner.post(url(`/${unknown.id}/preflight`), {});
    expect(pf.status).toBe(200);
    expect(pf.body.readinessFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'PERSONALIZATION_FIELD_UNKNOWN', severity: 'error', details: { field: 'no_such_field' } })]));
    const s = await owner.post(url(`/${unknown.id}/schedule`), { mode: 'now', expectedVersion: unknown.version });
    expect(s.status).toBe(422);

    const archived = await draft(v3([p('p1', 'Code: {{ contact.custom.legacy_code | "-" }}')]));
    const pa = await owner.post(url(`/${archived.id}/preflight`), {});
    expect(pa.body.readinessFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'PERSONALIZATION_FIELD_ARCHIVED', severity: 'warning' })]));
  });

  it('schedule creates campaign.version.v3 (merge_tags_v2) with the canonical content; the event records the schema', async () => {
    const d = await draft(v3([p('p1', 'Hi {{ contact.first_name }}'), { id: 'x1', type: 'html', html: '<P>Upper <B>case</B></P>' }]));
    const s = await owner.post(url(`/${d.id}/schedule`), { mode: 'now', expectedVersion: d.version });
    expect(s.status, JSON.stringify(s.body).slice(0, 400)).toBe(200);
    const v = (await withOwnerConnection((c) => c.query(`SELECT schema, snapshot FROM campaign_versions WHERE campaign_id = $1`, [d.id]))).rows[0];
    expect(v.schema).toBe('campaign.version.v3');
    expect(v.snapshot.personalization).toEqual({ mode: 'merge_tags_v2' });
    expect(v.snapshot.messages[0].content.body.blocks[1].html).toBe('<p>Upper <b>case</b></p>'); // normalized, a fixed point
    const ev = (await withOwnerConnection((c) => c.query(`SELECT payload FROM domain_events WHERE aggregate_id = $1 AND type = 'campaign.version_created'`, [d.id]))).rows[0];
    expect(ev.payload.schema).toBe('campaign.version.v3');
    const history = await owner.get(url(`/${d.id}/versions`));
    expect(history.status).toBe(200);
  });

  it('v2 content is still versioned as campaign.version.v2 (unchanged)', async () => {
    const d = await draft({ schema: 'email.content.v2', subject: 'S', preheader: '', body: { format: 'blocks', blocks: [p('p1', 'Hi {{ contact.first_name }}')] } });
    expect((await owner.post(url(`/${d.id}/schedule`), { mode: 'now', expectedVersion: d.version })).status).toBe(200);
    const v = (await withOwnerConnection((c) => c.query(`SELECT schema, snapshot FROM campaign_versions WHERE campaign_id = $1`, [d.id]))).rows[0];
    expect(v.schema).toBe('campaign.version.v2');
    expect(v.snapshot.personalization).toEqual({ mode: 'merge_tags_v1' });
  });

  it('templates accept v3 content (unsafe HTML refused with 422), and applying one copies v3 into a draft', async () => {
    const T = `/v1/workspaces/${W}/templates`;
    const bad = await owner.post(T, { name: 'Unsafe', content: v3([{ id: 'x1', type: 'html', html: '<img src=x onerror=alert(1)>' }]) });
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.body.error.fields)).toEqual(['content/body/blocks/0/html']);
    const tpl = await owner.post(T, { name: 'Dynamic', content: dynamic() });
    expect(tpl.status, JSON.stringify(tpl.body).slice(0, 300)).toBe(201);
    expect(tpl.body.content.schema).toBe('email.content.v3');
    const k = await owner.post(url(), { name: 'From template', channel: 'email', topicId });
    const applied = await owner.post(url(`/${k.body.id}/apply-template`), { templateId: tpl.body.id, expectedVersion: 1 });
    expect(applied.status).toBe(200);
    expect(applied.body.draft.messages[0].content.schema).toBe('email.content.v3');
  });
});
