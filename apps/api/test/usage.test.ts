import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type InlineJobDispatcher, JOB_DISPATCHER } from '../src/common/jobs.js';
import { messagesSentUsage } from '../src/common/usage.js';
import type { AppConfig } from '../src/config/env.js';
import { APP_CONFIG } from '../src/infrastructure/providers.js';
import { ExecutionService } from '../src/modules/campaigns/application/execution.service.js';
import { UsageService } from '../src/modules/usage/usage.service.js';
import { seedAudience } from './execution-support.js';
import { type Agent, createOrg, emailOf, resetTestDatabase, roleId, signUp, startTestApp, type TestApp, uploadCsv, withOwnerConnection } from './support.js';
import { withAppConnection } from '@workeasy/db/testing';

/**
 * Usage metering (Phase 7.13): counters recorded exactly once with their fact, test-mode sends never metered, daily
 * gauges idempotent per day, the organization summary permission-checked and tenant-isolated, and the ledger
 * append-only for the runtime role.
 */
describe('usage metering', () => {
  let t: TestApp;
  let owner: Agent;
  let member: Agent;
  let outsider: Agent;
  let orgId: string;
  let W: string;
  let otherOrg: string;
  const q = <T = Record<string, any>>(sql: string, args: unknown[] = []) => withOwnerConnection(async (c) => (await c.query(sql, args)).rows as T[]);
  const idle = async () => {
    const d = t.app.get(JOB_DISPATCHER, { strict: false }) as InlineJobDispatcher;
    for (let i = 0; i < 400; i++) {
      await d.idle();
      await new Promise((r) => setTimeout(r, 25));
      if (!(d as unknown as { running: Set<unknown> }).running.size) return;
    }
  };

  async function sendOnce(n: number) {
    const listId = (await owner.post(`/v1/workspaces/${W}/lists`, { name: `u-${randomUUID().slice(0, 6)}` })).body.id;
    await seedAudience({ orgId, workspaceId: W, listId, n, eligible: n, secret: (t.app.get(APP_CONFIG, { strict: false }) as AppConfig).fingerprintSecret });
    const topicId = (await owner.get(`/v1/workspaces/${W}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id;
    const c = await owner.post(`/v1/workspaces/${W}/campaigns`, { name: 'Usage', channel: 'email', topicId });
    const p = await owner.patch(`/v1/workspaces/${W}/campaigns/${c.body.id}`, {
      expectedVersion: 1,
      audience: { include: [{ type: 'list', listId }], exclude: [] },
      sender: { senderIdentityId: null, fromName: 'Acme', replyTo: null },
      messages: [{ variantKey: 'default', content: { schema: 'email.content.v1', subject: 'S', preheader: '', body: { format: 'text', text: 'B' } } }],
    });
    const s = await owner.post(`/v1/workspaces/${W}/campaigns/${c.body.id}/schedule`, { mode: 'now', expectedVersion: p.body.version });
    expect(s.status).toBe(200);
    await idle();
    return s.body.currentExecution.id as string;
  }

  beforeAll(async () => {
    await resetTestDatabase();
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test' });
    owner = await signUp(t, undefined, 'Owner');
    ({ orgId, workspaceId: W } = await createOrg(owner, 'Usage Co'));
    member = await signUp(t, undefined, 'Member');
    const inv = await owner.post(`/v1/organizations/${orgId}/invitations`, { email: emailOf(member), organizationRoleId: await roleId(owner, orgId, 'member'), workspaces: [{ workspaceId: W, roleId: await roleId(owner, orgId, 'viewer') }] });
    expect(inv.status).toBe(201);
    expect((await member.post('/v1/invitations/accept', { token: t.mailer.tokenFrom(emailOf(member), 'invitation') })).status).toBe(200);
    outsider = await signUp(t, undefined, 'Outsider');
    ({ orgId: otherOrg } = await createOrg(outsider, 'Other Co'));
  });
  afterAll(async () => t?.close());

  it('a campaign run is metered once, with its start; test-mode sends are never metered as messages', async () => {
    const executionId = await sendOnce(3);
    const rows = await q(`SELECT record_id, meter, quantity, workspace_id FROM usage_records WHERE org_id = $1 AND meter IN ('campaign.executions', 'messages.sent')`, [orgId]);
    expect(rows).toEqual([{ record_id: `campaign.executions:${executionId}`, meter: 'campaign.executions', quantity: '1', workspace_id: W }]);
    // A duplicate start (scheduler + command racing) does not meter twice.
    await t.app.get(ExecutionService, { strict: false }).startDue();
    expect((await q(`SELECT count(*)::int AS n FROM usage_records WHERE meter = 'campaign.executions' AND org_id = $1`, [orgId]))[0]!.n).toBe(1);
  });

  it('messages.sent: live delivery only, one record per batch keyed by its first sent recipient', () => {
    const tenant = { orgId: randomUUID(), workspaceId: randomUUID() };
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    expect(messagesSentUsage('test', tenant, 'e', ids, new Date())).toEqual([]);
    expect(messagesSentUsage('live', tenant, 'e', [], new Date())).toEqual([]);
    const [r] = messagesSentUsage('live', tenant, 'e', ids, new Date('2026-10-09T10:00:00Z'));
    expect(r).toMatchObject({ meter: 'messages.sent', quantity: 3, recordId: `messages.sent:e:${[...ids].sort()[0]}`, at: '2026-10-09T10:00:00.000Z' });
  });

  it('daily gauges: one snapshot per workspace and day (idempotent), the next day adds one', async () => {
    const usage = t.app.get(UsageService, { strict: false });
    await owner.post(`/v1/workspaces/${W}/templates`, { name: 'T1', content: { schema: 'email.content.v2', subject: 'S', preheader: '', body: { format: 'blocks', blocks: [{ id: 'p', type: 'paragraph', runs: [{ text: 'x' }] }] } } });
    const day1 = new Date('2026-10-09T12:00:00Z');
    expect(await usage.snapshotAll(day1)).toBeGreaterThanOrEqual(2);
    await usage.snapshotAll(day1);
    const g = await q(`SELECT meter, quantity::int AS quantity, at FROM usage_records WHERE workspace_id = $1 AND meter IN ('templates.active', 'contacts.active', 'storage.bytes') ORDER BY meter`, [W]);
    expect(g.map((x) => [x.meter, x.quantity])).toEqual([['contacts.active', 3], ['storage.bytes', 0], ['templates.active', 1]]);
    expect(new Date(g[0]!.at).toISOString()).toBe('2026-10-09T00:00:00.000Z');
    await usage.snapshotAll(new Date('2026-10-10T01:00:00Z'));
    expect((await q(`SELECT count(*)::int AS n FROM usage_records WHERE workspace_id = $1 AND meter = 'contacts.active'`, [W]))[0]!.n).toBe(2);
  });

  it('storage.bytes counts only import files still stored: a cancelled import deletes its file and stops counting', async () => {
    const usage = t.app.get(UsageService, { strict: false });
    const csv = 'email,first_name\nstore-1@example.test,Ann\nstore-2@example.test,Bo\n';
    const up = await uploadCsv(owner, W, csv);
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    await usage.snapshotAll(new Date('2026-11-01T12:00:00Z'));
    const bytes = async (day: string) => Number((await q(`SELECT quantity FROM usage_records WHERE record_id = $1`, [`storage.bytes:${W}:${day}`]))[0]!.quantity);
    expect(await bytes('2026-11-01')).toBe(Buffer.byteLength(csv));
    expect((await owner.post(`/v1/workspaces/${W}/imports/${up.body.id}/cancel`, {})).status).toBe(200);
    await usage.snapshotAll(new Date('2026-11-02T12:00:00Z'));
    expect(await bytes('2026-11-02')).toBe(0);
  });

  it('the organization summary: counters summed, gauges at their latest snapshot, per workspace; billing.manage only', async () => {
    const r = await owner.get(`/v1/organizations/${orgId}/usage?from=${encodeURIComponent('2026-10-01T00:00:00.000Z')}&to=${encodeURIComponent('2026-10-31T00:00:00.000Z')}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const m = Object.fromEntries(r.body.meters.map((x: { meter: string }) => [x.meter, x]));
    expect(m['campaign.executions']).toMatchObject({ kind: 'counter', total: 1, asOf: null, byWorkspace: [{ workspaceId: W, name: 'Main', value: 1 }] });
    expect(m['contacts.active']).toMatchObject({ kind: 'gauge', total: 3, asOf: '2026-10-10T00:00:00.000Z' });
    expect(m['messages.sent']).toMatchObject({ total: 0, byWorkspace: [] });
    expect(m['ai.tokens']).toMatchObject({ total: 0 });
    expect((await member.get(`/v1/organizations/${orgId}/usage`)).status).toBe(403);
    expect([403, 404]).toContain((await outsider.get(`/v1/organizations/${orgId}/usage`)).status);
    const other = await outsider.get(`/v1/organizations/${otherOrg}/usage`);
    expect(other.status).toBe(200);
    expect(other.body.meters.find((x: { meter: string }) => x.meter === 'campaign.executions').total).toBe(0);
    expect((await owner.get(`/v1/organizations/${orgId}/usage?from=${encodeURIComponent('2020-01-01T00:00:00.000Z')}&to=${encodeURIComponent('2026-01-01T00:00:00.000Z')}`)).status).toBe(400);
  });

  it('the ledger is append-only for the runtime role and isolated by organization', async () => {
    await withAppConnection({ orgId, workspaceId: W }, async (c) => {
      await expect(c.query(`UPDATE usage_records SET quantity = 0`)).rejects.toThrow(/permission denied/);
    });
    await withAppConnection({ orgId, workspaceId: W }, async (c) => {
      await expect(c.query(`DELETE FROM usage_records`)).rejects.toThrow(/permission denied/);
    });
    await withAppConnection({ orgId: otherOrg, workspaceId: null }, async (c) => {
      expect((await c.query(`SELECT count(*)::int AS n FROM usage_records WHERE org_id = $1`, [orgId])).rows[0].n).toBe(0);
      await expect(c.query(`INSERT INTO usage_records (record_id, org_id, meter, quantity, at) VALUES ('forged:12345', $1, 'messages.sent', 1, now())`, [orgId])).rejects.toThrow(/row-level security/);
    });
  });
});
