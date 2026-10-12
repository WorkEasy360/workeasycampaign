import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MailgunEmailAdapter } from '@workeasy/channels';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type InlineJobDispatcher, JOB_DISPATCHER } from '../src/common/jobs.js';
import type { AppConfig } from '../src/config/env.js';
import type { Database } from '@workeasy/db';
import { APP_CONFIG, DATABASE } from '../src/infrastructure/providers.js';
import type { DnsResolver } from '../src/modules/campaigns/domain/deliverability.js';
import { seedAudience } from './execution-support.js';
import { type Agent, createOrg, resetTestDatabase, signUp, startTestApp, type TestApp, withOwnerConnection } from './support.js';

const KEY = 'whsec-0123456789abcdef';

/**
 * Delivery feedback webhooks (Phase 7.9): a real execution through the Mailgun adapter (local double), then signed
 * provider events posted to /v1/webhooks/mailgun. Proves signature and replay handling, tenant resolution from the
 * provider routes only, deduplication, order independence, Audience effects (suppression, consent) and that nothing
 * personal is stored.
 */
describe('delivery webhooks', () => {
  let t: TestApp;
  let owner: Agent;
  let orgId: string;
  let W: string;
  let topicId: string;
  let server: Server;
  let n = 0;
  const records = new Map<string, string[]>();
  const dns: DnsResolver = { txt: async (name) => records.get(name) ?? null, cname: async () => null };
  const q = <T = Record<string, any>>(sql: string, args: unknown[] = []) => withOwnerConnection(async (c) => (await c.query(sql, args)).rows as T[]);
  const idle = async () => {
    const d = t.app.get(JOB_DISPATCHER, { strict: false }) as InlineJobDispatcher;
    for (let i = 0; i < 400; i++) {
      await d.idle();
      await new Promise((r) => setTimeout(r, 25));
      if (!(d as unknown as { running: Set<unknown> }).running.size) return;
    }
  };
  const inject = (app: TestApp, url: string, payload: string) =>
    (app.app.getHttpAdapter().getInstance() as { inject: (o: object) => Promise<{ statusCode: number; json: () => any }> }).inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload });

  function signed(eventData: Record<string, unknown>, opts: { key?: string; token?: string; age?: number } = {}) {
    const timestamp = String(Math.floor(Date.now() / 1000) - (opts.age ?? 0));
    const token = opts.token ?? randomUUID().replace(/-/g, '');
    const signature = createHmac('sha256', opts.key ?? KEY).update(timestamp + token).digest('hex');
    return JSON.stringify({ signature: { timestamp, token, signature }, 'event-data': eventData });
  }
  const event = (messageId: string, e: string, extra: Record<string, unknown> = {}, at = Date.now() / 1000) => ({
    id: `ev-${randomUUID()}`,
    event: e,
    timestamp: at,
    recipient: 'someone@seed.test',
    message: { headers: { 'message-id': messageId } },
    ...extra,
  });
  const post = (body: string, provider = 'mailgun') => inject(t, `/v1/webhooks/${provider}`, body);

  async function execution(count: number) {
    const listId = (await owner.post(`/v1/workspaces/${W}/lists`, { name: `w-${randomUUID().slice(0, 6)}` })).body.id;
    await seedAudience({ orgId, workspaceId: W, listId, n: count, eligible: count, secret: (t.app.get(APP_CONFIG, { strict: false }) as AppConfig).fingerprintSecret });
    const sender = (await q(`SELECT id FROM sender_identities WHERE workspace_id = $1 AND deleted_at IS NULL LIMIT 1`, [W]))[0]!.id;
    const C = (p = '') => `/v1/workspaces/${W}/campaigns${p}`;
    const c = await owner.post(C(), { name: 'Feedback', channel: 'email', topicId });
    const p = await owner.patch(C(`/${c.body.id}`), {
      expectedVersion: 1,
      audience: { include: [{ type: 'list', listId }], exclude: [] },
      sender: { senderIdentityId: sender, fromName: null, replyTo: null },
      messages: [{ variantKey: 'default', content: { schema: 'email.content.v2', subject: 'Hi', preheader: '', body: { format: 'blocks', blocks: [{ id: 'p1', type: 'paragraph', runs: [{ text: 'Hello' }] }] } } }],
    });
    const s = await owner.post(C(`/${c.body.id}/schedule`), { mode: 'now', expectedVersion: p.body.version });
    expect(s.status).toBe(200);
    await idle();
    const executionId = s.body.currentExecution.id as string;
    const routes = await q<{ provider_message_id: string; recipient_id: string; contact_id: string; address_identity_id: string | null }>(
      `SELECT r.provider_message_id, c.id AS recipient_id, c.contact_id, c.address_identity_id FROM provider_message_routes r JOIN campaign_recipients c ON c.id = r.delivery_id WHERE c.execution_id = $1 ORDER BY c.id`,
      [executionId],
    );
    expect(routes).toHaveLength(count);
    return { executionId, routes, campaignId: c.body.id as string };
  }
  const rollup = async (executionId: string) => (await q(`SELECT delivered, bounced_hard, bounced_soft, complained, unsubscribed, opened_unique, clicked_unique FROM execution_engagement WHERE execution_id = $1`, [executionId]))[0];

  beforeAll(async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: `<wh-${++n}-${randomUUID().slice(0, 8)}@mail.acme.com>` })));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const adapter = new MailgunEmailAdapter({ apiKey: 'key-0123456789', domain: 'mail.acme.com', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, timeoutMs: 2_000 });
    await resetTestDatabase();
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test', DELIVERY_SPF_INCLUDE: 'include:mailgun.org', DELIVERY_DKIM_SELECTOR: 'mx', DELIVERY_WEBHOOK_SIGNING_KEY: KEY, DELIVERY_TRACKING: 'opens,clicks' }, { dnsResolver: dns, deliveryAdapter: adapter });
    owner = await signUp(t, undefined, 'Owner');
    ({ orgId, workspaceId: W } = await createOrg(owner, 'Acme'));
    topicId = (await owner.get(`/v1/workspaces/${W}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id;
    const d = await owner.post(`/v1/workspaces/${W}/sending-domains`, { domain: 'mail.acme.com' });
    records.set('_workeasy.mail.acme.com', [`workeasy-verification=${d.body.records.find((r: { purpose: string }) => r.purpose === 'ownership').value.split('=')[1]}`]);
    records.set('mail.acme.com', ['v=spf1 include:mailgun.org ~all']);
    records.set('mx._domainkey.mail.acme.com', ['k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQ']);
    records.set('_dmarc.mail.acme.com', ['v=DMARC1; p=none']);
    expect((await owner.post(`/v1/workspaces/${W}/sending-domains/${d.body.id}/verify`, {})).body.status).toBe('verified');
    await owner.post(`/v1/workspaces/${W}/sender-identities`, { domainId: d.body.id, localPart: 'news', displayName: 'Acme News' });
  });
  afterAll(async () => {
    await t?.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('delivered, opened and clicked update unique engagement; a click implies an open; replays change nothing', async () => {
    const { executionId, routes } = await execution(3);
    const [a, b] = routes;
    const delivered = signed(event(a!.provider_message_id, 'delivered'));
    expect((await post(delivered)).json()).toEqual({ received: 1, recorded: 1, duplicates: 0, unrouted: 0 });
    await post(signed(event(b!.provider_message_id, 'delivered')));
    await post(signed(event(a!.provider_message_id, 'opened')));
    await post(signed(event(a!.provider_message_id, 'opened'))); // a second open: recorded, not unique
    await post(signed(event(b!.provider_message_id, 'clicked', { url: 'https://acme.com/x' })));
    expect(await rollup(executionId)).toEqual({ delivered: 2, bounced_hard: 0, bounced_soft: 0, complained: 0, unsubscribed: 0, opened_unique: 2, clicked_unique: 1 });

    // A provider retry (same token, same body) is acknowledged and changes nothing.
    const retry = await post(delivered);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({ received: 1, recorded: 0, duplicates: 1, unrouted: 0 });
    // The same event id under a new signature (re-sent webhook) is deduplicated too.
    const ev = event(a!.provider_message_id, 'clicked');
    await post(signed(ev));
    expect((await post(signed(ev))).json()).toMatchObject({ recorded: 0, duplicates: 1 });
    expect(await rollup(executionId)).toMatchObject({ delivered: 2, opened_unique: 2, clicked_unique: 2 });

    // Ids only: no address, URL or provider text stored.
    const stored = JSON.stringify(await q(`SELECT * FROM message_events WHERE execution_id = $1`, [executionId]));
    expect(stored).not.toMatch(/@seed\.test|acme\.com\/x|someone/);
    expect((await q(`SELECT DISTINCT org_id, workspace_id FROM message_events WHERE execution_id = $1`, [executionId]))).toEqual([{ org_id: orgId, workspace_id: W }]);
  });

  it('order does not matter: an open reported after a click keeps the earliest time and counts once', async () => {
    const { executionId, routes } = await execution(1);
    const id = routes[0]!.provider_message_id;
    const now = Math.floor(Date.now() / 1000);
    await post(signed(event(id, 'clicked', {}, now)));
    await post(signed(event(id, 'opened', {}, now - 60)));
    await post(signed(event(id, 'delivered', {}, now - 120)));
    expect(await rollup(executionId)).toMatchObject({ delivered: 1, opened_unique: 1, clicked_unique: 1 });
    const [e] = await q(`SELECT first_opened_at, first_clicked_at FROM recipient_engagement WHERE recipient_id = $1`, [routes[0]!.recipient_id]);
    expect(new Date(e!.first_opened_at).getTime()).toBe((now - 60) * 1000);
    expect(new Date(e!.first_clicked_at).getTime()).toBe(now * 1000);
  });

  it('a hard bounce (after a soft one) and a complaint suppress the address through Audience; a provider unsubscribe is the contact\'s own', async () => {
    const { executionId, routes } = await execution(3);
    const [x, y, z] = routes;
    await post(signed(event(x!.provider_message_id, 'failed', { severity: 'temporary', 'delivery-status': { code: 421 } })));
    expect(await rollup(executionId)).toMatchObject({ bounced_soft: 1, bounced_hard: 0 });
    await post(signed(event(x!.provider_message_id, 'failed', { severity: 'permanent', 'delivery-status': { code: 550 }, reason: 'bounce someone@seed.test' })));
    await post(signed(event(y!.provider_message_id, 'complained')));
    await post(signed(event(z!.provider_message_id, 'unsubscribed')));
    expect(await rollup(executionId)).toMatchObject({ bounced_soft: 0, bounced_hard: 1, complained: 1, unsubscribed: 1 });

    const identity = async (id: string | null) => (await q(`SELECT kind, value_normalized FROM contact_identities WHERE id = $1`, [id]))[0]!;
    for (const [r, reason] of [[x!, 'hard_bounce'], [y!, 'complaint']] as const) {
      const ident = await identity(r.address_identity_id);
      const sup = await q(`SELECT reason, source, channel, contact_id, created_by_user_id FROM suppressions WHERE workspace_id = $1 AND identity_kind = $2 AND value_normalized = $3 AND lifted_at IS NULL`, [W, ident.kind, ident.value_normalized]);
      expect(sup).toEqual([{ reason, source: 'system', channel: 'email', contact_id: null, created_by_user_id: null }]);
    }
    const [ev] = await q(`SELECT action, topic_id, actor_type, actor_id, source FROM consent_events WHERE contact_id = $1 ORDER BY recorded_at DESC LIMIT 1`, [z!.contact_id]);
    expect(ev).toEqual({ action: 'unsubscribed', topic_id: topicId, actor_type: 'contact', actor_id: z!.contact_id, source: 'provider_unsubscribe' });
    expect((await q(`SELECT detail FROM message_events WHERE recipient_id = $1 AND type = 'bounced'`, [x!.recipient_id]))[0]!.detail).toEqual({ reason: 'SMTP_550' });

    // Replaying the bounce does not create a second suppression.
    const before = (await q(`SELECT count(*)::int AS n FROM suppressions WHERE workspace_id = $1`, [W]))[0]!.n;
    await post(signed(event(x!.provider_message_id, 'failed', { severity: 'permanent', 'delivery-status': { code: 550 } })));
    expect((await q(`SELECT count(*)::int AS n FROM suppressions WHERE workspace_id = $1`, [W]))[0]!.n).toBe(before);
    expect(await rollup(executionId)).toMatchObject({ bounced_hard: 1 });
  });

  it('forged, stale, wrong-key and re-bodied signatures are refused and record nothing', async () => {
    const { executionId, routes } = await execution(1);
    const id = routes[0]!.provider_message_id;
    expect((await post(signed(event(id, 'delivered'), { key: 'another-key-0123456789' }))).statusCode).toBe(401);
    expect((await post(signed(event(id, 'delivered'), { age: 16 * 60 }))).statusCode).toBe(401);
    expect((await post(JSON.stringify({ 'event-data': event(id, 'delivered') }))).statusCode).toBe(401);
    expect((await post('not json')).statusCode).toBeGreaterThanOrEqual(400);
    // A captured signature (Mailgun signs timestamp + token, not the body) replayed with a different body.
    const token = randomUUID().replace(/-/g, '');
    expect((await post(signed(event(id, 'opened'), { token }))).statusCode).toBe(200);
    const forged = await post(signed(event(id, 'complained'), { token }));
    expect(forged.statusCode).toBe(401);
    expect(await rollup(executionId)).toMatchObject({ delivered: 0, complained: 0, opened_unique: 1 });
    expect((await q(`SELECT count(*)::int AS n FROM suppressions WHERE workspace_id = $1 AND reason = 'complaint' AND value_normalized = (SELECT value_normalized FROM contact_identities WHERE id = $2)`, [W, routes[0]!.address_identity_id]))[0]!.n).toBe(0);
  });

  it('unknown messages are acknowledged and ignored; unknown providers and unconfigured webhooks do not exist', async () => {
    expect((await post(signed(event(`nope-${randomUUID()}@mail.acme.com`, 'delivered')))).json()).toEqual({ received: 1, recorded: 0, duplicates: 0, unrouted: 1 });
    expect((await post(signed(event('x@mail.acme.com', 'accepted')))).json()).toEqual({ received: 0, recorded: 0, duplicates: 0, unrouted: 0 });
    expect((await post(signed(event('x@mail.acme.com', 'delivered')), 'sendgrid')).statusCode).toBe(404);
    expect((await post(signed(event('x@mail.acme.com', 'delivered')), 'Bad..Name')).statusCode).toBe(404);
    const plain = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test' });
    try {
      expect((await inject(plain, '/v1/webhooks/mailgun', signed(event('x@mail.acme.com', 'delivered')))).statusCode).toBe(404);
    } finally {
      await plain.close();
    }
  });

  it('analytics read the rollups: counts and rates, not-applicable for zero denominators, the basis stated', async () => {
    const { campaignId, routes } = await execution(4);
    const [a, b, c] = routes;
    for (const r of routes) await post(signed(event(r.provider_message_id, 'delivered')));
    await post(signed(event(a!.provider_message_id, 'opened')));
    await post(signed(event(b!.provider_message_id, 'clicked')));
    await post(signed(event(c!.provider_message_id, 'complained')));
    const res = await owner.get(`/v1/workspaces/${W}/campaigns/${campaignId}/results`);
    expect(res.status).toBe(200);
    const m = res.body.engagement;
    expect(res.body.engagementBasis).toEqual({ source: 'provider_webhooks', provider: 'mailgun', opensIncludeAutomated: true });
    expect(res.body.pipeline).toMatchObject({ runs: 1, sent: 4 });
    expect(m.delivered).toEqual({ available: true, value: 4 });
    expect(m.deliveryRate).toEqual({ available: true, value: 1 });
    expect(m.uniqueOpens).toEqual({ available: true, value: 2 }); // the click implies an open
    expect(m.openRate).toEqual({ available: true, value: 0.5 });
    expect(m.ctor).toEqual({ available: true, value: 0.5 });
    expect(m.bounced).toEqual({ available: true, value: 0 });
    expect(m.complaintRate).toEqual({ available: true, value: 0.25 });
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0].engagement).toEqual(m);
    expect(res.body.lastEventAt).not.toBeNull();
    // A run with no feedback yet: rates over zero are not applicable, counts are real zeros.
    const quiet = await execution(1);
    const qr = (await owner.get(`/v1/workspaces/${W}/campaigns/${quiet.campaignId}/results`)).body.engagement;
    expect(qr.delivered).toEqual({ available: true, value: 0 });
    expect(qr.openRate).toEqual({ available: false, reason: 'not_applicable' });
    expect(qr.deliveryRate).toEqual({ available: true, value: 0 });
    // The workspace view sums the same rollups.
    const all = (await owner.get(`/v1/workspaces/${W}/campaigns/analytics`)).body;
    const truth = (await q(`SELECT sum(delivered)::int AS d, sum(complained)::int AS c FROM execution_engagement WHERE workspace_id = $1`, [W]))[0]!;
    expect(all.engagement.delivered).toEqual({ available: true, value: truth.d });
    expect(all.engagement.complained).toEqual({ available: true, value: truth.c });
    expect(all.perCampaign.find((p: { campaignId: string }) => p.campaignId === campaignId).engagement).toEqual(m);
    expect(JSON.stringify(res.body)).not.toMatch(/@/);
  });

  it('events are attributed only to the tenant of the provider route; another organization sees nothing', async () => {
    const { executionId, routes } = await execution(1);
    await post(signed(event(routes[0]!.provider_message_id, 'delivered')));
    const other = await signUp(t, undefined, 'Other');
    const o = await createOrg(other, 'Other Co');
    // Through the application role and RLS, exactly as the API reads them.
    const db = t.app.get(DATABASE, { strict: false }) as Database;
    const visible = await db.withTenant({ orgId: o.orgId, workspaceId: o.workspaceId, userId: null }, async (tx) =>
      (await tx.$queryRaw<{ e: number; r: number; x: number }[]>`SELECT (SELECT count(*)::int FROM message_events) AS e, (SELECT count(*)::int FROM recipient_engagement) AS r, (SELECT count(*)::int FROM execution_engagement) AS x`)[0]);
    expect(visible).toEqual({ e: 0, r: 0, x: 0 });
    const own = await db.withTenant({ orgId, workspaceId: W, userId: null }, async (tx) => (await tx.$queryRaw<{ e: number }[]>`SELECT count(*)::int AS e FROM message_events`)[0]);
    expect(own!.e).toBeGreaterThan(0);
    expect(await rollup(executionId)).toMatchObject({ delivered: 1 });
  });
});
