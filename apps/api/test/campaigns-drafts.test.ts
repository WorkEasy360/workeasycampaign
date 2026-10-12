import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Agent, createOrg, inviteAndAccept, resetTestDatabase, roleId, signUp, startTestApp, type TestApp, withOwnerConnection } from './support.js';

/**
 * Milestone 6.6 — campaign draft API (docs/contracts/phase-6-campaign.md §15 rows 1–9, 18–19) through the real HTTP
 * stack: authentication, route and composite permissions, strict validation, optimistic concurrency (expectedVersion
 * before any outcome), idempotency, soft delete/restore, clone, history reads, tenant isolation (IDOR sweep), events.
 */
describe('campaign drafts API (6.6)', () => {
  let t: TestApp;
  let owner: Agent;
  let editor: Agent;
  let viewer: Agent;
  let writer: Agent; // custom role: campaigns.read/create/update only (no lists.read, no topics.read)
  let outsider: Agent; // owner of another organization
  let orgId: string;
  let W: string;
  let WB: string;
  let topicId: string;
  let listId: string;
  let foreignTopicId: string;
  const url = (p = '', ws = W) => `/v1/workspaces/${ws}/campaigns${p}`;
  const events = (aggregateId: string) =>
    withOwnerConnection(async (c) => (await c.query(`SELECT type, payload FROM domain_events WHERE aggregate_id = $1 ORDER BY occurred_at, id`, [aggregateId])).rows as { type: string; payload: Record<string, unknown> }[]);
  const audits = (targetId: string) =>
    withOwnerConnection(async (c) => (await c.query(`SELECT action FROM audit_logs WHERE target_id = $1 ORDER BY occurred_at`, [targetId])).rows.map((r) => r.action as string));
  const create = async (agent: Agent, body: Record<string, unknown> = {}) => {
    const r = await agent.post(url(), { name: 'Spring launch', channel: 'email', ...body });
    if (r.status !== 201) throw new Error(`create failed ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as { id: string; version: number; [k: string]: unknown };
  };

  beforeAll(async () => {
    await resetTestDatabase();
    t = await startTestApp();
    owner = await signUp(t, undefined, 'Owner');
    ({ orgId, workspaceId: W } = await createOrg(owner, 'Campaign Co'));
    editor = await signUp(t, undefined, 'Editor');
    viewer = await signUp(t, undefined, 'Viewer');
    writer = await signUp(t, undefined, 'Writer');
    await inviteAndAccept(t, owner, editor, orgId, 'member', [{ workspaceId: W, roleKey: 'editor' }]);
    await inviteAndAccept(t, owner, viewer, orgId, 'member', [{ workspaceId: W, roleKey: 'viewer' }]);
    const custom = await owner.post(`/v1/organizations/${orgId}/roles`, { name: 'Campaign writer', scope: 'workspace', permissions: ['campaigns.read', 'campaigns.create', 'campaigns.update'] });
    expect(custom.status).toBe(201);
    const inv = await owner.post(`/v1/organizations/${orgId}/invitations`, {
      email: (writer as Agent & { email: string }).email,
      organizationRoleId: await roleId(owner, orgId, 'member'),
      workspaces: [{ workspaceId: W, roleId: custom.body.id }],
    });
    expect(inv.status).toBe(201);
    expect((await writer.post('/v1/invitations/accept', { token: t.mailer.tokenFrom((writer as Agent & { email: string }).email, 'invitation') })).status).toBe(200);
    outsider = await signUp(t, undefined, 'Outsider');
    ({ workspaceId: WB } = await createOrg(outsider, 'Other Co'));
    topicId = (await owner.get(`/v1/workspaces/${W}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id;
    foreignTopicId = (await outsider.get(`/v1/workspaces/${WB}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id;
    listId = (await owner.post(`/v1/workspaces/${W}/lists`, { name: 'Newsletter' })).body.id;
  });
  afterAll(async () => t?.close());

  it('capabilities: delivery disabled by default; email enabled but not sendable; sms/whatsapp disabled', async () => {
    const r = await viewer.get(url('/capabilities'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      deliveryMode: 'disabled',
      channels: [
        { channel: 'email', enabled: true, sendingAvailable: false },
        { channel: 'sms', enabled: false, sendingAvailable: false },
        { channel: 'whatsapp', enabled: false, sendingAvailable: false },
      ],
    });
  });

  it('create: 201 draft view, readiness and actions computed server-side, campaign.created (clonedFrom null) + audit', async () => {
    const r = await owner.post(url(), { name: '  Spring launch  ', channel: 'email', topicId });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: 'Spring launch', channel: 'email', purpose: 'marketing', status: 'draft', version: 1, deletedAt: null, currentVersion: null, currentExecution: null });
    expect(r.body.draft).toEqual({
      topicId,
      audience: { include: [], exclude: [] },
      sender: { senderIdentityId: null, fromName: null, replyTo: null },
      messages: [],
      schedule: { mode: 'now', sendAt: null, timezone: 'UTC' },
    });
    expect(r.body.readiness).toBe('not_ready');
    const codes = r.body.readinessFindings.map((f: { code: string }) => f.code);
    expect(codes).toEqual(expect.arrayContaining(['AUDIENCE_EMPTY_DEFINITION', 'SUBJECT_MISSING', 'BODY_MISSING', 'DELIVERY_NOT_AVAILABLE']));
    expect(r.body.allowedActions).toEqual(['update', 'clone', 'delete']);
    expect(r.body.blockedActions).toEqual(expect.arrayContaining([{ action: 'schedule', reason: 'DELIVERY_NOT_AVAILABLE' }, { action: 'send_now', reason: 'DELIVERY_NOT_AVAILABLE' }]));
    expect(r.body.createdBy).toMatchObject({ displayName: 'Owner' });
    expect(await events(r.body.id)).toEqual([{ type: 'campaign.created', payload: { channel: 'email', clonedFrom: null } }]);
    expect(await audits(r.body.id)).toEqual(['campaign.created']);
  });

  it('create: strict body (tenancy fields refused), disabled channels, foreign topic, Idempotency-Key replay', async () => {
    for (const extra of [{ workspaceId: WB }, { orgId: randomUUID() }, { ownerId: randomUUID() }, { status: 'scheduled' }]) {
      const r = await owner.post(url(), { name: 'x', channel: 'email', ...extra });
      expect(r.status, JSON.stringify(extra)).toBe(400);
      expect(r.body.error.code).toBe('validation_failed');
    }
    const sms = await owner.post(url(), { name: 'x', channel: 'sms' });
    expect([sms.status, sms.body.error.code]).toEqual([422, 'CHANNEL_NOT_AVAILABLE']);
    const foreign = await owner.post(url(), { name: 'x', channel: 'email', topicId: foreignTopicId });
    expect([foreign.status, foreign.body.error.fields?.topicId]).toEqual([400, ['Not a topic of this workspace']]);
    expect(foreign.body.error.message).not.toMatch(/foreign key|constraint|campaigns_/i);

    const headers = { headers: { 'idempotency-key': `create-${randomUUID()}` } };
    const first = await owner.request('POST', url(), { name: 'Once', channel: 'email' }, headers);
    const replay = await owner.request('POST', url(), { name: 'Once', channel: 'email' }, headers);
    expect([first.status, replay.status]).toEqual([201, 201]);
    expect(replay.body.id).toBe(first.body.id);
    const conflict = await owner.request('POST', url(), { name: 'Different', channel: 'email' }, headers);
    expect(conflict.body.error.code).toBe('idempotency_conflict');
    expect(await withOwnerConnection(async (c) => (await c.query(`SELECT count(*)::int AS n FROM campaigns WHERE name = 'Once'`)).rows[0].n)).toBe(1);
  });

  it('RBAC: viewer reads only; editor edits; custom role needs topics.read / lists.read for the topic and new sources (audited)', async () => {
    const c = await create(owner);
    expect((await viewer.get(url(`/${c.id}`))).status).toBe(200);
    expect((await viewer.post(url(), { name: 'v', channel: 'email' })).status).toBe(403);
    expect((await viewer.patch(url(`/${c.id}`), { expectedVersion: 1, name: 'v' })).status).toBe(403);
    expect((await viewer.request('DELETE', url(`/${c.id}`), { expectedVersion: 1 })).status).toBe(403);
    expect((await viewer.post(url(`/${c.id}/clone`), {})).status).toBe(403);
    const viewerView = (await viewer.get(url(`/${c.id}`))).body;
    expect(viewerView.allowedActions).toEqual([]);
    expect(viewerView.blockedActions).toEqual(expect.arrayContaining([{ action: 'update', reason: 'PERMISSION_DENIED' }]));

    const e = await editor.patch(url(`/${c.id}`), { expectedVersion: 1, name: 'Edited' });
    expect([e.status, e.body.version, e.body.name]).toEqual([200, 2, 'Edited']);

    expect((await writer.post(url(), { name: 'w', channel: 'email', topicId })).status).toBe(403);
    const mine = await create(writer);
    expect((await writer.patch(url(`/${mine.id}`), { expectedVersion: 1, audience: { include: [{ type: 'list', listId }], exclude: [] } })).status).toBe(403);
    expect((await writer.patch(url(`/${mine.id}`), { expectedVersion: 1, topicId })).status).toBe(403);
    expect((await writer.patch(url(`/${mine.id}`), { expectedVersion: 1, name: 'Allowed' })).status).toBe(200);
    const denied = await withOwnerConnection(async (cl) => (await cl.query(`SELECT metadata FROM audit_logs WHERE action = 'access.denied' AND metadata->>'operation' LIKE 'campaign.%' ORDER BY occurred_at`)).rows.map((r) => r.metadata));
    expect(denied).toEqual(expect.arrayContaining([expect.objectContaining({ permission: 'lists.read', operation: 'campaign.update' }), expect.objectContaining({ permission: 'topics.read' })]));
    // the denied change was not applied
    expect((await owner.get(url(`/${mine.id}`))).body.draft.audience.include).toEqual([]);
  });

  it('PATCH: expectedVersion is checked before anything else — stale (even as a no-op) is version_conflict; concurrent writers: one wins', async () => {
    const c = await create(owner);
    const ok = await owner.patch(url(`/${c.id}`), { expectedVersion: 1, name: 'Renamed' });
    expect(ok.body.version).toBe(2);
    const staleNoop = await owner.patch(url(`/${c.id}`), { expectedVersion: 1, name: 'Renamed' });
    expect([staleNoop.status, staleNoop.body.error.code]).toEqual([409, 'version_conflict']);
    const currentNoop = await owner.patch(url(`/${c.id}`), { expectedVersion: 2, name: 'Renamed' });
    expect([currentNoop.status, currentNoop.body.version]).toEqual([200, 2]); // nothing changed: no write, no event
    expect((await events(c.id)).map((e) => e.type)).toEqual(['campaign.created', 'campaign.updated']);

    const writers = await Promise.all(['A', 'B', 'C', 'D'].map((n) => owner.patch(url(`/${c.id}`), { expectedVersion: 2, name: `Writer ${n}` })));
    expect(writers.map((w) => w.status).sort()).toEqual([200, 409, 409, 409]);
    const final = (await owner.get(url(`/${c.id}`))).body;
    expect(final.version).toBe(3);
    expect(final.name).toBe(writers.find((w) => w.status === 200)!.body.name);
  });

  it('PATCH: whole-field replacement, findings recomputed, event carries field NAMES only (no content)', async () => {
    const c = await create(owner, { topicId });
    const content = { schema: 'email.content.v1', subject: 'Big secret subject', preheader: '', body: { format: 'text', text: 'Private body text' } };
    const r = await owner.patch(url(`/${c.id}`), {
      expectedVersion: 1,
      audience: { include: [{ type: 'list', listId }], exclude: [] },
      sender: { senderIdentityId: null, fromName: 'Acme', replyTo: 'hello@acme.test' },
      messages: [{ variantKey: 'default', content }],
      schedule: { mode: 'at', sendAt: new Date(Date.now() + 86_400_000).toISOString(), timezone: 'Asia/Kolkata' },
    });
    expect(r.status).toBe(200);
    expect(r.body.readinessFindings.map((f: { code: string }) => f.code).sort()).toEqual(['DELIVERY_NOT_AVAILABLE', 'SENDER_NOT_CONFIGURED']);
    const updated = (await events(c.id)).find((e) => e.type === 'campaign.updated')!;
    expect(updated.payload).toEqual({ changes: ['audience', 'sender', 'messages', 'schedule'] });
    expect(JSON.stringify(await events(c.id))).not.toMatch(/secret|Private|Acme|hello@/);
    // unknown fields and malformed values are 400; sizes above version limits are findings, not errors
    expect((await owner.patch(url(`/${c.id}`), { expectedVersion: 2, workspaceId: WB, name: 'x' })).status).toBe(400);
    const long = await owner.patch(url(`/${c.id}`), { expectedVersion: 2, messages: [{ variantKey: 'default', content: { ...content, subject: 's'.repeat(250) } }] });
    expect(long.status).toBe(200);
    expect(long.body.readinessFindings.map((f: { code: string }) => f.code)).toContain('SUBJECT_TOO_LONG');
  });

  it('delete / restore: soft, versioned, no-ops, list and counts exclude deleted, deleted campaigns are read-only', async () => {
    const c = await create(owner);
    expect((await owner.request('DELETE', url(`/${c.id}`), { expectedVersion: 9 })).body.error.code).toBe('version_conflict');
    const del = await owner.request('DELETE', url(`/${c.id}`), { expectedVersion: 1 });
    expect([del.status, del.body.version, del.body.deletedAt !== null]).toEqual([200, 2, true]);
    expect(del.body.allowedActions).toEqual(['restore']);
    const again = await owner.request('DELETE', url(`/${c.id}`), { expectedVersion: 2 });
    expect([again.status, again.body.version]).toEqual([200, 2]);
    expect((await owner.patch(url(`/${c.id}`), { expectedVersion: 2, name: 'x' })).body.error.code).toBe('INVALID_TRANSITION');
    expect((await owner.get(url('?limit=100'))).body.data.map((x: { id: string }) => x.id)).not.toContain(c.id);
    expect((await owner.get(url('?deleted=only&limit=100'))).body.data.map((x: { id: string }) => x.id)).toContain(c.id);
    const before = (await owner.get(url('/counts'))).body;
    const res = await owner.post(url(`/${c.id}/restore`), {});
    expect([res.status, res.body.deletedAt, res.body.version]).toEqual([200, null, 3]);
    expect((await owner.post(url(`/${c.id}/restore`), {})).body.version).toBe(3); // no-op
    expect((await owner.get(url('/counts'))).body.draft).toBe(before.draft + 1);
    expect((await events(c.id)).map((e) => e.type)).toEqual(['campaign.created', 'campaign.deleted', 'campaign.restored']);
    expect(await audits(c.id)).toEqual(['campaign.created', 'campaign.deleted', 'campaign.restored']);
    // no hard delete exists anywhere
    expect(await withOwnerConnection(async (cl) => (await cl.query(`SELECT count(*)::int AS n FROM campaigns WHERE id = $1`, [c.id])).rows[0].n)).toBe(1);
  });

  it('clone: new identity, source untouched, campaign.created with clonedFrom — from the draft and from a version', async () => {
    const src = await create(owner, { topicId });
    await owner.patch(url(`/${src.id}`), { expectedVersion: 1, audience: { include: [{ type: 'list', listId }], exclude: [] } });
    const r = await owner.post(url(`/${src.id}/clone`), {});
    expect(r.status).toBe(201);
    expect(r.body.id).not.toBe(src.id);
    expect(r.body).toMatchObject({ name: 'Spring launch (copy)', status: 'draft', version: 1, currentVersion: null, currentExecution: null });
    expect(r.body.draft.audience).toEqual({ include: [{ type: 'list', listId }], exclude: [] });
    expect((await owner.get(url(`/${src.id}`))).body.version).toBe(2); // source unchanged
    expect(await events(r.body.id)).toEqual([{ type: 'campaign.created', payload: { channel: 'email', clonedFrom: { campaignId: src.id, versionId: null } } }]);
    expect(await withOwnerConnection(async (c) => (await c.query(`SELECT count(*)::int AS n FROM domain_events WHERE type = 'campaign.cloned'`)).rows[0].n)).toBe(0);
    // editing the clone never changes the source (no shared mutable state)
    await owner.patch(url(`/${r.body.id}`), { expectedVersion: 1, audience: { include: [], exclude: [] } });
    expect((await owner.get(url(`/${src.id}`))).body.draft.audience.include).toHaveLength(1);

    // from a version (versions are created by schedule in 6.8; inserted here as a fixture)
    const snapshot = {
      schema: 'campaign.version.v1', channel: 'email', purpose: 'marketing', topic: { topicIds: [topicId], policy: 'block_unsubscribed' },
      audience: { include: [{ type: 'list', listId }], exclude: [] }, sender: { senderIdentityId: null, fromName: 'V1', replyTo: null },
      messages: [{ variantKey: 'default', content: { schema: 'email.content.v1', subject: 'From v1', preheader: '', body: { format: 'text', text: 'v1 body' } } }],
      tracking: { opens: false, clicks: false }, compliance: { unsubscribeLink: 'required', listUnsubscribeHeader: 'required' },
      personalization: { mode: 'none' }, schedule: { mode: 'now', sendAt: null, timezone: 'UTC' }, abTest: null,
    };
    const versionId = randomUUID();
    await withOwnerConnection((c) =>
      c.query(`INSERT INTO campaign_versions (id, org_id, workspace_id, campaign_id, number, schema, snapshot, content_hash, reason) SELECT $1, org_id, workspace_id, id, 1, 'campaign.version.v1', $3::jsonb, $4, 'scheduled' FROM campaigns WHERE id = $2`, [
        versionId, src.id, JSON.stringify(snapshot), createHash('sha256').update('x').digest('hex'),
      ]),
    );
    const fromVersion = await owner.post(url(`/${src.id}/clone`), { versionId, name: 'From version' });
    expect(fromVersion.status).toBe(201);
    expect(fromVersion.body.draft.messages[0].content.subject).toBe('From v1');
    expect(fromVersion.body.draft.sender.fromName).toBe('V1');
    expect((await events(fromVersion.body.id))[0]!.payload).toEqual({ channel: 'email', clonedFrom: { campaignId: src.id, versionId } });
    expect((await owner.post(url(`/${src.id}/clone`), { versionId: randomUUID() })).status).toBe(404);

    const versions = await viewer.get(url(`/${src.id}/versions`));
    expect(versions.body).toMatchObject({ data: [{ id: versionId, number: 1, reason: 'scheduled' }], nextCursor: null });
    const detail = await viewer.get(url(`/${src.id}/versions/${versionId}`));
    expect(detail.body.snapshot).toEqual(snapshot);
    expect((await viewer.get(url(`/${r.body.id}/versions/${versionId}`))).status).toBe(404); // version of another campaign
  });

  it('list: deterministic keyset pagination, filters, name search; bad cursor is 400', async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await create(owner, { name: `Paged ${i}` })).id);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r: { status: number; body: { data: { id: string }[]; nextCursor: string | null } } = await owner.get(url(`?q=Paged&limit=2${cursor ? `&cursor=${cursor}` : ''}`));
      expect(r.status).toBe(200);
      seen.push(...r.body.data.map((x: { id: string }) => x.id));
      cursor = r.body.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(ids));
    expect(seen).toEqual([...ids].reverse()); // newest change first
    expect((await owner.get(url('?status=scheduled'))).body.data).toEqual([]);
    expect((await owner.get(url('?status=draft&status=failed&limit=1'))).status).toBe(200);
    expect((await owner.get(url('?cursor=nope'))).status).toBe(400);
    expect((await owner.get(url('?limit=1000'))).status).toBe(400);
    const item = (await owner.get(url('?limit=1'))).body.data[0];
    expect(Object.keys(item).sort()).toEqual(['allowedActions', 'channel', 'createdAt', 'currentExecution', 'deletedAt', 'id', 'name', 'readiness', 'status', 'topicId', 'updatedAt', 'version']);
  });

  it('tenant isolation (IDOR sweep): another organization can neither see nor act on a campaign, by any route', async () => {
    const c = await create(owner);
    // the outsider using its OWN workspace path with our campaign id: indistinguishable from a missing campaign
    const sweep: [string, () => Promise<{ status: number }>][] = [
      ['get', () => outsider.get(url(`/${c.id}`, WB))],
      ['patch', () => outsider.patch(url(`/${c.id}`, WB), { expectedVersion: 1, name: 'pwned' })],
      ['delete', () => outsider.request('DELETE', url(`/${c.id}`, WB), { expectedVersion: 1 })],
      ['restore', () => outsider.post(url(`/${c.id}/restore`, WB), {})],
      ['clone', () => outsider.post(url(`/${c.id}/clone`, WB), {})],
      ['versions', () => outsider.get(url(`/${c.id}/versions`, WB))],
    ];
    for (const [name, call] of sweep) expect((await call()).status, name).toBe(404);
    expect((await outsider.get(url('', WB))).body.data.map((x: { id: string }) => x.id)).not.toContain(c.id);
    // the outsider using OUR workspace path: not a member, so even the workspace's existence is not confirmed (404)
    expect((await outsider.get(url(`/${c.id}`))).status).toBe(404);
    expect((await outsider.post(url(), { name: 'x', channel: 'email' })).status).toBe(404);
    // nothing changed
    const after = (await owner.get(url(`/${c.id}`))).body;
    expect([after.name, after.version, after.deletedAt]).toEqual(['Spring launch', 1, null]);
  });

  it('unauthenticated requests are refused', async () => {
    const { Agent: AgentClass } = await import('./support.js');
    const anon = new AgentClass(t);
    for (const r of [await anon.get(url()), await anon.get(url('/capabilities')), await anon.post(url(), { name: 'x', channel: 'email' })]) expect(r.status).toBe(401);
  });
});
