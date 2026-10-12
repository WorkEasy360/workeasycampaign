import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MailgunEmailAdapter } from '@workeasy/channels';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type InlineJobDispatcher, JOB_DISPATCHER } from '../src/common/jobs.js';
import type { AppConfig } from '../src/config/env.js';
import { APP_CONFIG } from '../src/infrastructure/providers.js';
import { ExecutionService } from '../src/modules/campaigns/application/execution.service.js';
import type { DnsResolver } from '../src/modules/campaigns/domain/deliverability.js';
import { seedAudience } from './execution-support.js';
import { type Agent, createOrg, resetTestDatabase, signUp, startTestApp, type TestApp, withOwnerConnection } from './support.js';

/**
 * Live delivery mode (owner-authorized 2026-10-09; OFF unless configured), end to end against a LOCAL double of the
 * Mailgun API — no real provider, no real mailbox. Proves the live wiring: sender problems block scheduling, each
 * message goes through its sender's own verified domain, sends are metered exactly once, test sends come from the
 * verified sender, and nothing claims a test mode.
 */
describe('live delivery (provider double)', () => {
  let t: TestApp;
  let owner: Agent;
  let orgId: string;
  let W: string;
  let topicId: string;
  let server: Server;
  const received: { path: string; fields: Map<string, string> }[] = [];
  const records = new Map<string, string[]>();
  const dns: DnsResolver = { txt: async (n) => records.get(n) ?? null, cname: async () => null };
  const q = <T = Record<string, any>>(sql: string, args: unknown[] = []) => withOwnerConnection(async (c) => (await c.query(sql, args)).rows as T[]);
  const idle = async () => {
    const d = t.app.get(JOB_DISPATCHER, { strict: false }) as InlineJobDispatcher;
    for (let i = 0; i < 400; i++) {
      await d.idle();
      await new Promise((r) => setTimeout(r, 25));
      if (!(d as unknown as { running: Set<unknown> }).running.size) return;
    }
  };
  const C = (p = '') => `/v1/workspaces/${W}/campaigns${p}`;

  async function draft(senderIdentityId: string | null, n: number) {
    const listId = (await owner.post(`/v1/workspaces/${W}/lists`, { name: `live-${randomUUID().slice(0, 6)}` })).body.id;
    await seedAudience({ orgId, workspaceId: W, listId, n, eligible: n, secret: (t.app.get(APP_CONFIG, { strict: false }) as AppConfig).fingerprintSecret });
    const c = await owner.post(C(), { name: 'Live', channel: 'email', topicId });
    const p = await owner.patch(C(`/${c.body.id}`), {
      expectedVersion: 1,
      audience: { include: [{ type: 'list', listId }], exclude: [] },
      sender: { senderIdentityId, fromName: null, replyTo: null },
      messages: [{ variantKey: 'default', content: { schema: 'email.content.v2', subject: 'Hello', preheader: '', body: { format: 'blocks', blocks: [{ id: 'p1', type: 'paragraph', runs: [{ text: 'Hi' }] }] } } }],
    });
    expect(p.status, JSON.stringify(p.body).slice(0, 300)).toBe(200);
    return { id: c.body.id as string, version: p.body.version as number };
  }

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const form = await new Request('http://x', { method: 'POST', headers: { 'content-type': req.headers['content-type']! }, body: Buffer.concat(chunks) }).formData();
      received.push({ path: req.url ?? '', fields: new Map([...form.entries()].map(([k, v]) => [k, String(v)])) });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: `<live-${received.length}-${randomUUID().slice(0, 6)}@mail.acme.com>` }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    // No fallback domain: every send must name its sender's domain.
    const adapter = new MailgunEmailAdapter({ apiKey: 'key-0123456789', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, timeoutMs: 2_000 });
    await resetTestDatabase();
    t = await startTestApp(
      {
        CAMPAIGN_DELIVERY_MODE: 'live',
        DELIVERY_PROVIDER: 'mailgun',
        MAILGUN_API_KEY: 'key-0123456789-not-used',
        DELIVERY_WEBHOOK_SIGNING_KEY: 'w'.repeat(32),
        DELIVERY_SPF_INCLUDE: 'include:mailgun.org',
        DELIVERY_DKIM_SELECTOR: 'mx',
      },
      { dnsResolver: dns, deliveryAdapter: adapter },
    );
    t.app.get(ExecutionService, { strict: false }).configure({ jobRetryDelaysMs: [50, 50, 50] });
    owner = await signUp(t, undefined, 'Owner');
    ({ orgId, workspaceId: W } = await createOrg(owner, 'Live Co'));
    topicId = (await owner.get(`/v1/workspaces/${W}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id;
  });
  afterAll(async () => {
    await t?.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('reports live (no test-mode claim) and blocks scheduling without a verified sender — nothing reaches the provider', async () => {
    expect((await owner.get(C('/capabilities'))).body).toMatchObject({ deliveryMode: 'live', channels: [{ channel: 'email', sendingAvailable: true }, expect.anything(), expect.anything()] });
    const c = await draft(null, 2);
    const view = (await owner.get(C(`/${c.id}`))).body;
    expect(view.readinessFindings.find((f: { code: string }) => f.code === 'SENDER_NOT_CONFIGURED')).toMatchObject({ severity: 'error' });
    const s = await owner.post(C(`/${c.id}/schedule`), { mode: 'now', expectedVersion: c.version });
    expect(s.status).toBe(422);
    expect(s.body.error.code).toBe('PREFLIGHT_FAILED');
    expect(received).toHaveLength(0);
    // A sender on a domain that is not verified is blocking too.
    const d = await owner.post(`/v1/workspaces/${W}/sending-domains`, { domain: 'pending.acme.com' });
    const sid = (await owner.post(`/v1/workspaces/${W}/sender-identities`, { domainId: d.body.id, localPart: 'news', displayName: 'Acme' })).body.id;
    const c2 = await draft(sid, 1);
    const s2 = await owner.post(C(`/${c2.id}/schedule`), { mode: 'now', expectedVersion: c2.version });
    expect(s2.status).toBe(422);
    expect(s2.body.error.findings.map((f: { code: string }) => f.code)).toContain('SENDER_NOT_VERIFIED');
    // Test sends: refused without a verified sender, with a clear reason.
    const ts = await owner.post(C(`/${c2.id}/test-send`), {});
    expect(ts.status).toBe(422);
    expect(received).toHaveLength(0);
  });

  it('with a verified sender: every message goes through that customer domain, is metered once, and the test send comes from it', async () => {
    const d = await owner.post(`/v1/workspaces/${W}/sending-domains`, { domain: 'mail.acme.com' });
    records.set('_workeasy.mail.acme.com', [`workeasy-verification=${d.body.records.find((r: { purpose: string }) => r.purpose === 'ownership').value.split('=')[1]}`]);
    records.set('mail.acme.com', ['v=spf1 include:mailgun.org ~all']);
    records.set('mx._domainkey.mail.acme.com', ['k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQ']);
    records.set('_dmarc.mail.acme.com', ['v=DMARC1; p=none']);
    expect((await owner.post(`/v1/workspaces/${W}/sending-domains/${d.body.id}/verify`, {})).body.status).toBe('verified');
    const sid = (await owner.post(`/v1/workspaces/${W}/sender-identities`, { domainId: d.body.id, localPart: 'news', displayName: 'Acme News' })).body.id;

    const c = await draft(sid, 3);
    const ts = await owner.post(C(`/${c.id}/test-send`), {});
    expect(ts.status, JSON.stringify(ts.body)).toBe(200);
    expect(received.at(-1)!.path).toBe('/v3/mail.acme.com/messages');
    expect(received.at(-1)!.fields.get('from')).toBe('"Acme News" <news@mail.acme.com>');
    expect(received.at(-1)!.fields.get('h:X-Workeasy-Test')).toBe('1');

    received.length = 0;
    const s = await owner.post(C(`/${c.id}/schedule`), { mode: 'now', expectedVersion: c.version });
    expect(s.status, JSON.stringify(s.body).slice(0, 300)).toBe(200);
    await idle();
    const executionId = s.body.currentExecution.id as string;
    expect(received).toHaveLength(3);
    expect(received.every((r) => r.path === '/v3/mail.acme.com/messages' && r.fields.get('from') === '"Acme News" <news@mail.acme.com>')).toBe(true);
    expect((await q(`SELECT status, count(*)::int AS n FROM campaign_recipients WHERE execution_id = $1 GROUP BY status`, [executionId]))).toEqual([{ status: 'sent', n: 3 }]);
    // Usage: live sends are metered, exactly once per batch, matching what was sent.
    const usage = await q(`SELECT sum(quantity)::int AS n, count(*)::int AS records FROM usage_records WHERE meter = 'messages.sent' AND org_id = $1`, [orgId]);
    expect(usage[0]).toEqual({ n: 3, records: 1 });
    // Analytics say live — never "test mode".
    expect((await owner.get(C(`/${c.id}/results`))).body.deliveryMode).toBe('live');
  });
});
