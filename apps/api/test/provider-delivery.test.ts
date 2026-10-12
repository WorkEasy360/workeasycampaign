import { randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MailgunEmailAdapter } from '@workeasy/channels';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type InlineJobDispatcher, JOB_DISPATCHER } from '../src/common/jobs.js';
import type { AppConfig } from '../src/config/env.js';
import { APP_CONFIG } from '../src/infrastructure/providers.js';
import { ExecutionService } from '../src/modules/campaigns/application/execution.service.js';
import { verifyUnsubscribeToken } from '../src/modules/campaigns/application/unsubscribe.js';
import type { DnsResolver } from '../src/modules/campaigns/domain/deliverability.js';
import { seedAudience } from './execution-support.js';
import { Agent, createOrg, resetTestDatabase, signUp, startTestApp, type TestApp, withOwnerConnection } from './support.js';

/**
 * The production delivery port end to end (Phase 7.7/7.8): a real campaign execution through ProviderDeliveryPort and
 * the Mailgun adapter, against a local HTTP double of the provider. Proves what the provider receives (personalized
 * content, verified From, RFC 8058 headers, a working per-recipient unsubscribe link), the provider message routes, the
 * sender-verification gate, and that no address or content is written to the database.
 */
describe('provider delivery end to end', () => {
  let t: TestApp;
  let owner: Agent;
  let orgId: string;
  let W: string;
  let topicId: string;
  let secret: string;
  let sessionSecret: string;
  let server: Server;
  const received: Map<string, string>[] = [];
  let reply: (res: ServerResponse, n: number) => void = (res, n) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: `<msg-${n}@mail.acme.com>` }));
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

  async function verifiedSender(): Promise<string> {
    const d = await owner.post(`/v1/workspaces/${W}/sending-domains`, { domain: 'mail.acme.com' });
    const token = d.body.records.find((r: { purpose: string }) => r.purpose === 'ownership').value.split('=')[1];
    records.set('_workeasy.mail.acme.com', [`workeasy-verification=${token}`]);
    records.set('mail.acme.com', ['v=spf1 include:mailgun.org ~all']);
    records.set('mx._domainkey.mail.acme.com', ['k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQ']);
    records.set('_dmarc.mail.acme.com', ['v=DMARC1; p=none']);
    expect((await owner.post(`/v1/workspaces/${W}/sending-domains/${d.body.id}/verify`, {})).body.status).toBe('verified');
    return (await owner.post(`/v1/workspaces/${W}/sender-identities`, { domainId: d.body.id, localPart: 'news', displayName: 'Acme News', replyTo: 'hello@acme.com' })).body.id as string;
  }
  async function send(senderIdentityId: string | null, n = 3) {
    const listId = (await owner.post(`/v1/workspaces/${W}/lists`, { name: `p-${randomUUID().slice(0, 6)}` })).body.id;
    await seedAudience({ orgId, workspaceId: W, listId, n, eligible: n, secret });
    const C = (p = '') => `/v1/workspaces/${W}/campaigns${p}`;
    const c = await owner.post(C(), { name: 'Live-shaped', channel: 'email', topicId });
    const p = await owner.patch(C(`/${c.body.id}`), {
      expectedVersion: 1,
      audience: { include: [{ type: 'list', listId }], exclude: [] },
      sender: { senderIdentityId, fromName: null, replyTo: null },
      messages: [{ variantKey: 'default', content: { schema: 'email.content.v2', subject: 'Hi {{ contact.first_name | "there" }}', preheader: '', body: { format: 'blocks', blocks: [{ id: 'p1', type: 'paragraph', runs: [{ text: 'Hello {{ contact.first_name | "friend" }}' }] }] } } }],
    });
    const s = await owner.post(C(`/${c.body.id}/schedule`), { mode: 'now', expectedVersion: p.body.version });
    expect(s.status, JSON.stringify(s.body).slice(0, 300)).toBe(200);
    await idle();
    return { campaignId: c.body.id as string, executionId: s.body.currentExecution.id as string };
  }

  beforeAll(async () => {
    let n = 0;
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const form = await new Request('http://x', { method: 'POST', headers: { 'content-type': req.headers['content-type']! }, body: Buffer.concat(chunks) }).formData();
      received.push(new Map([...form.entries()].map(([k, v]) => [k, String(v)])));
      reply(res, ++n);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const adapter = new MailgunEmailAdapter({ apiKey: 'key-0123456789', domain: 'mail.acme.com', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, timeoutMs: 2_000 });
    await resetTestDatabase();
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test', DELIVERY_SPF_INCLUDE: 'include:mailgun.org', DELIVERY_DKIM_SELECTOR: 'mx' }, { dnsResolver: dns, deliveryAdapter: adapter });
    const config = t.app.get(APP_CONFIG, { strict: false }) as AppConfig;
    secret = config.fingerprintSecret;
    sessionSecret = config.sessionSecret;
    t.app.get(ExecutionService, { strict: false }).configure({ jobRetryDelaysMs: [50, 50, 50] });
    owner = await signUp(t, undefined, 'Owner');
    ({ orgId, workspaceId: W } = await createOrg(owner, 'Acme'));
    topicId = (await owner.get(`/v1/workspaces/${W}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id;
  });
  afterAll(async () => {
    await t?.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('without a verified sender nothing is handed to the provider; recipients wait (configuration back-off), none failed', async () => {
    received.length = 0;
    const { executionId } = await send(null, 2);
    expect(received).toHaveLength(0);
    const by = await q<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM campaign_recipients WHERE execution_id = $1 GROUP BY status`, [executionId]);
    expect(by.find((b) => b.status === 'failed')).toBeUndefined();
    await owner.post(`/v1/workspaces/${W}/campaigns/${(await q(`SELECT campaign_id FROM campaign_executions WHERE id = $1`, [executionId]))[0]!.campaign_id}/cancel`, { expectedVersion: (await q(`SELECT c.version FROM campaigns c JOIN campaign_executions e ON e.campaign_id = c.id WHERE e.id = $1`, [executionId]))[0]!.version });
    await idle();
  });

  it('each recipient gets a personalized email from the verified sender with RFC 8058 headers and a working unsubscribe link', async () => {
    received.length = 0;
    const senderId = await verifiedSender();
    const { campaignId, executionId } = await send(senderId, 3);
    expect(received).toHaveLength(3);
    const recipients = await q<{ id: string; status: string }>(`SELECT id, status FROM campaign_recipients WHERE execution_id = $1`, [executionId]);
    expect(recipients.every((r) => r.status === 'sent')).toBe(true);
    for (const m of received) {
      expect(m.get('from')).toBe('"Acme News" <news@mail.acme.com>');
      expect(m.get('h:Reply-To')).toBe('hello@acme.com');
      expect(m.get('to')).toMatch(/^x\d+-.+@seed\.test$/);
      expect(m.get('subject')).toBe('Hi there');
      expect(m.get('text')).toContain('Hello friend');
      expect(m.get('h:List-Unsubscribe-Post')).toBe('List-Unsubscribe=One-Click');
      expect(m.get('h:X-Workeasy-Campaign')).toBe(campaignId);
      const oneClick = /^<(.+)>$/.exec(m.get('h:List-Unsubscribe')!)![1]!;
      const token = oneClick.split('/').at(-1)!;
      const claims = verifyUnsubscribeToken(sessionSecret, token)!;
      expect(claims.recipientId).toBe(m.get('v:workeasy-delivery'));
      expect(m.get('html')).toContain(`/unsubscribe/${token}`);
    }
    // The link in the email works and is recorded by Audience.
    const token = /^<(.+)>$/.exec(received[0]!.get('h:List-Unsubscribe')!)![1]!.split('/').at(-1)!;
    expect((await new Agent(t).post(`/v1/unsubscribe/${token}`, { scope: 'topic' })).body).toMatchObject({ unsubscribed: true, changed: true });
    // Without provider webhooks, only our own unsubscribe link is measured; everything else says "not tracked".
    const results = (await owner.get(`/v1/workspaces/${W}/campaigns/${campaignId}/results`)).body;
    expect(results.engagement.unsubscribed).toEqual({ available: true, value: 1 });
    expect(results.engagement.delivered).toEqual({ available: false, reason: 'tracking_not_enabled' });
    expect(results.engagement.uniqueOpens).toEqual({ available: false, reason: 'tracking_not_enabled' });
    expect(results.engagementBasis).toBeNull();
    // Provider routes (tenant + recipient by provider message id) for webhooks.
    const routes = await q(`SELECT provider, provider_message_id, org_id, workspace_id, delivery_id FROM provider_message_routes WHERE delivery_id = ANY($1::uuid[])`, [recipients.map((r) => r.id)]);
    expect(routes).toHaveLength(3);
    expect(routes.every((r) => r.provider === 'mailgun' && r.org_id === orgId && r.workspace_id === W && /^msg-\d+@mail\.acme\.com$/.test(r.provider_message_id))).toBe(true);
    // No address and no rendered content in the execution's rows.
    const rows = JSON.stringify(await q(`SELECT * FROM campaign_recipients WHERE execution_id = $1`, [executionId]));
    expect(rows).not.toMatch(/@seed\.test|Hello friend/);
  });

  it('a provider timeout is "unknown" (never resent); a 429 waits and then sends', async () => {
    received.length = 0;
    const senderId = (await q(`SELECT id FROM sender_identities WHERE workspace_id = $1 AND deleted_at IS NULL LIMIT 1`, [W]))[0]!.id;
    let calls = 0;
    reply = (res, n) => {
      calls++;
      if (calls === 1) return res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' }).end('{}');
      if (calls === 2) return; // hangs → adapter timeout → unknown
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: `<m-${n}@mail.acme.com>` }));
    };
    const { executionId } = await send(senderId, 3);
    for (let i = 0; i < 100 && (await q(`SELECT status FROM campaign_executions WHERE id = $1`, [executionId]))[0]!.status !== 'completed'; i++) {
      await new Promise((r) => setTimeout(r, 200));
      await idle();
    }
    const by = Object.fromEntries((await q<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM campaign_recipients WHERE execution_id = $1 GROUP BY status`, [executionId])).map((r) => [r.status, r.n]));
    expect(by).toEqual({ sent: 2, unknown: 1 });
  }, 60_000);
});
