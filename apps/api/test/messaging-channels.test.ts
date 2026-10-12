import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MetaWhatsAppAdapter, TwilioSmsAdapter } from '@workeasy/channels';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type InlineJobDispatcher, JOB_DISPATCHER } from '../src/common/jobs.js';
import { ExecutionService } from '../src/modules/campaigns/application/execution.service.js';
import { ProviderDeliveryPort } from '../src/modules/campaigns/infrastructure/provider-delivery-port.js';
import { ADDRESS_LOOKUP, DATABASE } from '../src/infrastructure/providers.js';
import type { AddressLookup } from '@workeasy/audience-core';
import type { Database, Tx } from '@workeasy/db';
import { type Agent, createOrg, resetTestDatabase, signUp, startTestApp, type TestApp, withOwnerConnection } from './support.js';

/**
 * SMS (Twilio) and WhatsApp (Meta Cloud API) campaigns end to end (messaging amendment, 2026-10-09) against LOCAL
 * doubles of both provider APIs — nothing reaches a real provider or phone. Proves: channel availability follows
 * configuration; consent per channel; numbers sent in E.164; SMS text personalized with the STOP instruction; WhatsApp
 * approved template with personalized parameters; provider routes; signed status webhooks (and forged ones refused);
 * failures recorded without suppressing the number; invalid credentials wait instead of failing recipients; analytics say
 * what each channel cannot report.
 */
const SID = `AC${'a1'.repeat(16)}`;
const AUTH = 'twilio-auth-token-0123456789';
const CALLBACK = 'https://api.example.test/v1/webhooks/twilio';
const APP_SECRET = 'meta-app-secret-0123456789';
const VERIFY = 'meta-verify-token-0123456789';
const PHONE_ID = '1234567890';

describe('SMS and WhatsApp campaigns (provider doubles)', () => {
  let t: TestApp;
  let owner: Agent;
  let W: string;
  let topicId: string;
  let server: Server;
  let twilioStatus = 201;
  const twilio: Map<string, string>[] = [];
  const meta: Record<string, any>[] = [];
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
  const inject = (app: TestApp, method: string, url: string, headers: Record<string, string>, payload?: string) =>
    (app.app.getHttpAdapter().getInstance() as { inject: (o: object) => Promise<{ statusCode: number; body: string; json: () => any }> }).inject({ method, url, headers, payload });

  /** A contact with a number of the given kind and consent on the given channel (or none). */
  async function contact(listId: string, number: string, channel: 'sms' | 'whatsapp', consent: boolean, firstName = 'Ann') {
    const c = await owner.post(`/v1/workspaces/${W}/contacts`, { firstName, phone: number, listIds: [listId] });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    if (channel === 'whatsapp') expect((await owner.post(`/v1/workspaces/${W}/contacts/${c.body.id}/identities`, { kind: 'whatsapp', value: number })).status).toBe(201);
    if (consent) expect((await owner.post(`/v1/workspaces/${W}/contacts/${c.body.id}/consent`, { channel, action: 'subscribed', source: 'form', lawfulBasis: 'consent', evidenceNote: 'Form' })).status).toBe(201);
    return c.body.id as string;
  }
  async function campaign(channel: 'sms' | 'whatsapp', listId: string, content: unknown) {
    const c = await owner.post(C(), { name: `${channel} ${randomUUID().slice(0, 4)}`, channel, topicId });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const p = await owner.patch(C(`/${c.body.id}`), { expectedVersion: 1, audience: { include: [{ type: 'list', listId }], exclude: [] }, messages: [{ variantKey: 'default', content }] });
    expect(p.status, JSON.stringify(p.body).slice(0, 400)).toBe(200);
    return { id: c.body.id as string, version: p.body.version as number, view: p.body };
  }
  const twilioSignature = (params: Record<string, string>) =>
    createHmac('sha1', AUTH).update(CALLBACK + Object.keys(params).sort().map((k) => k + params[k]).join('')).digest('base64');

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks).toString('utf8');
      if (req.url?.includes('/Messages.json')) {
        twilio.push(new Map(new URLSearchParams(body)));
        if (twilioStatus === 401) return res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 20003, message: 'Authenticate' }));
        return res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ sid: `SM${randomUUID().replace(/-/g, '')}`, status: 'queued' }));
      }
      meta.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ messages: [{ id: `wamid.${randomUUID()}` }] }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await resetTestDatabase();
    t = await startTestApp(
      {
        CAMPAIGN_DELIVERY_MODE: 'test',
        SMS_PROVIDER: 'twilio',
        TWILIO_ACCOUNT_SID: SID,
        TWILIO_AUTH_TOKEN: AUTH,
        TWILIO_FROM: '+14155550000',
        TWILIO_STATUS_CALLBACK_URL: CALLBACK,
        WHATSAPP_PROVIDER: 'meta',
        WHATSAPP_ACCESS_TOKEN: 'meta-access-token-0123456789',
        WHATSAPP_PHONE_NUMBER_ID: PHONE_ID,
        WHATSAPP_APP_SECRET: APP_SECRET,
        WHATSAPP_VERIFY_TOKEN: VERIFY,
      },
      {
        smsAdapter: new TwilioSmsAdapter({ accountSid: SID, authToken: AUTH, from: '+14155550000', statusCallbackUrl: CALLBACK, baseUrl: base, timeoutMs: 2_000 }),
        whatsappAdapter: new MetaWhatsAppAdapter({ accessToken: 'meta-access-token-0123456789', phoneNumberId: PHONE_ID, baseUrl: base, timeoutMs: 2_000 }),
      },
    );
    t.app.get(ExecutionService, { strict: false }).configure({ jobRetryDelaysMs: [50, 50, 50] });
    owner = await signUp(t, undefined, 'Owner');
    ({ workspaceId: W } = await createOrg(owner, 'Messaging Co'));
    topicId = (await owner.get(`/v1/workspaces/${W}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id;
  });
  afterAll(async () => {
    await t?.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('SMS: consented numbers get the personalized text with the STOP instruction; status webhooks are verified and recorded', async () => {
    expect((await owner.get(C('/capabilities'))).body.channels).toEqual(expect.arrayContaining([{ channel: 'sms', enabled: true, sendingAvailable: true }]));
    const listId = (await owner.post(`/v1/workspaces/${W}/lists`, { name: 'sms list' })).body.id;
    await contact(listId, '+14155550101', 'sms', true, 'Ann');
    await contact(listId, '+14155550102', 'sms', true, 'Bo');
    await contact(listId, '+14155550103', 'sms', false, 'Cy'); // no SMS consent → skipped, never texted
    const c = await campaign('sms', listId, { schema: 'sms.content.v1', text: 'Hi {{ contact.first_name | "there" }}, 20% off today' });
    expect(c.view.readinessFindings.filter((f: { severity: string }) => f.severity === 'error')).toEqual([]);
    // Preview: exactly what the recipient gets.
    const pv = await owner.post(C(`/${c.id}/preview`), {});
    expect(pv.body.messaging).toMatchObject({ channel: 'sms', text: 'Hi Alex, 20% off today\nReply STOP to opt out.', encoding: 'GSM-7', segments: 1 });
    // Test sends are email-only, and say so.
    expect((await owner.post(C(`/${c.id}/test-send`), {})).status).toBe(422);

    twilio.length = 0;
    const s = await owner.post(C(`/${c.id}/schedule`), { mode: 'now', expectedVersion: c.version });
    expect(s.status, JSON.stringify(s.body).slice(0, 300)).toBe(200);
    await idle();
    const executionId = s.body.currentExecution.id as string;
    expect(twilio.map((m) => [m.get('To'), m.get('Body'), m.get('From'), m.get('StatusCallback')]).sort()).toEqual([
      ['+14155550101', 'Hi Ann, 20% off today\nReply STOP to opt out.', '+14155550000', CALLBACK],
      ['+14155550102', 'Hi Bo, 20% off today\nReply STOP to opt out.', '+14155550000', CALLBACK],
    ]);
    const by = Object.fromEntries((await q<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM campaign_recipients WHERE execution_id = $1 GROUP BY status`, [executionId])).map((r) => [r.status, r.n]));
    expect(by).toEqual({ sent: 2, skipped: 1 });
    const routes = await q<{ provider_message_id: string }>(`SELECT r.provider_message_id FROM provider_message_routes r JOIN campaign_recipients c ON c.id = r.delivery_id WHERE c.execution_id = $1 AND r.provider = 'twilio' ORDER BY 1`, [executionId]);
    expect(routes).toHaveLength(2);

    // Status callbacks: signed by Twilio over the callback URL + parameters.
    const post = (params: Record<string, string>, signature = twilioSignature(params)) =>
      inject(t, 'POST', '/v1/webhooks/twilio', { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature }, new URLSearchParams(params).toString());
    const delivered = { MessageSid: routes[0]!.provider_message_id, MessageStatus: 'delivered', AccountSid: SID };
    expect((await post(delivered)).json()).toMatchObject({ recorded: 1 });
    expect((await post(delivered)).json()).toMatchObject({ duplicates: 1 }); // a retry changes nothing
    const failed = { MessageSid: routes[1]!.provider_message_id, MessageStatus: 'undelivered', ErrorCode: '30003', AccountSid: SID };
    expect((await post(failed)).json()).toMatchObject({ recorded: 1 });
    expect((await post({ ...delivered, MessageStatus: 'delivered', To: '+1999' }, twilioSignature(delivered))).statusCode).toBe(401); // forged
    expect((await q(`SELECT count(*)::int AS n FROM suppressions WHERE workspace_id = $1`, [W]))[0]!.n).toBe(0); // failures never suppress a number

    const r = (await owner.get(C(`/${c.id}/results`))).body;
    expect(r.engagement.delivered).toEqual({ available: true, value: 1 });
    expect(r.engagement.bounced).toEqual({ available: true, value: 1 });
    for (const m of ['uniqueOpens', 'uniqueClicks', 'complained', 'unsubscribed', 'deferred']) expect(r.engagement[m]).toEqual({ available: false, reason: 'provider_unsupported' });
    expect(JSON.stringify(r)).not.toMatch(/\+1415555/);
  });

  it('WhatsApp: the approved template with personalized parameters; Meta webhooks verified (subscription + signature)', async () => {
    const listId = (await owner.post(`/v1/workspaces/${W}/lists`, { name: 'wa list' })).body.id;
    await contact(listId, '+919876543210', 'whatsapp', true, 'Ravi');
    const c = await campaign('whatsapp', listId, { schema: 'whatsapp.content.v1', template: { name: 'diwali_offer', language: 'en', parameters: ['{{ contact.first_name }}', '{{ organization.name }}'] } });
    expect(c.view.readinessFindings.filter((f: { severity: string }) => f.severity === 'error')).toEqual([]);
    meta.length = 0;
    const s = await owner.post(C(`/${c.id}/schedule`), { mode: 'now', expectedVersion: c.version });
    expect(s.status, JSON.stringify(s.body).slice(0, 300)).toBe(200);
    await idle();
    expect(meta).toHaveLength(1);
    expect(meta[0]!.path).toBe(`/v21.0/${PHONE_ID}/messages`);
    expect(meta[0]!.auth).toBe('Bearer meta-access-token-0123456789');
    expect(meta[0]!.body).toMatchObject({
      messaging_product: 'whatsapp',
      to: '919876543210',
      type: 'template',
      template: { name: 'diwali_offer', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ravi' }, { type: 'text', text: 'Messaging Co' }] }] },
    });
    const executionId = s.body.currentExecution.id as string;
    const [route] = await q<{ provider_message_id: string }>(`SELECT r.provider_message_id FROM provider_message_routes r JOIN campaign_recipients c ON c.id = r.delivery_id WHERE c.execution_id = $1 AND r.provider = 'whatsapp'`, [executionId]);

    // Subscription handshake.
    const v = await inject(t, 'GET', `/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1158201444`, {});
    expect([v.statusCode, v.body]).toEqual([200, '1158201444']);
    expect((await inject(t, 'GET', '/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong-token-0123456789&hub.challenge=1', {})).statusCode).toBe(403);
    // Signed status events.
    const statuses = (status: string) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: route!.provider_message_id, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '919876543210' }] } }] }] });
    const sign = (raw: string, secret = APP_SECRET) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
    for (const st of ['delivered', 'read']) {
      const raw = statuses(st);
      expect((await inject(t, 'POST', '/v1/webhooks/whatsapp', { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) }, raw)).json()).toMatchObject({ recorded: 1 });
    }
    const raw = statuses('failed');
    expect((await inject(t, 'POST', '/v1/webhooks/whatsapp', { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw, 'another-secret-0123456789') }, raw)).statusCode).toBe(401);
    const r = (await owner.get(C(`/${c.id}/results`))).body;
    expect(r.engagement.delivered).toEqual({ available: true, value: 1 });
    expect(r.engagement.uniqueOpens).toEqual({ available: true, value: 1 }); // read receipt
    expect(r.engagement.uniqueClicks).toEqual({ available: false, reason: 'provider_unsupported' });
    expect(r.engagementBasis).toMatchObject({ provider: 'whatsapp', opensIncludeAutomated: false });
  });

  it('SMS replies: STOP withdraws SMS consent (as the contact) where the number was texted; START undoes only that; signed only', async () => {
    const listId = (await owner.post(`/v1/workspaces/${W}/lists`, { name: 'stop list' })).body.id;
    const ann = await contact(listId, '+14155550121', 'sms', true, 'Ann');
    const bo = await contact(listId, '+14155550122', 'sms', true, 'Bo');
    // The same number in another workspace that never texted it: a STOP to our number must not touch it.
    const { workspaceId: W2 } = await createOrg(owner, 'Other Co');
    const other = (await owner.post(`/v1/workspaces/${W2}/contacts`, { firstName: 'Ann', phone: '+14155550121' })).body.id as string;
    expect((await owner.post(`/v1/workspaces/${W2}/contacts/${other}/consent`, { channel: 'sms', action: 'subscribed', source: 'form', lawfulBasis: 'consent', evidenceNote: 'Form' })).status).toBe(201);

    const send = async () => {
      const c = await campaign('sms', listId, { schema: 'sms.content.v1', text: 'Sale today' });
      twilio.length = 0;
      expect((await owner.post(C(`/${c.id}/schedule`), { mode: 'now', expectedVersion: c.version })).status).toBe(200);
      await idle();
      return twilio.map((m) => m.get('To')).sort();
    };
    expect(await send()).toEqual(['+14155550121', '+14155550122']);

    const state = async (contactId: string) => (await q<{ state: string; changed_by: string }>(`SELECT state, changed_by FROM consent_states WHERE contact_id = $1 AND channel = 'sms'`, [contactId]))[0];
    const events = async (contactId: string, source: string) => (await q<{ n: number }>(`SELECT count(*)::int AS n FROM consent_events WHERE contact_id = $1 AND channel = 'sms' AND source = $2`, [contactId, source]))[0]!.n;
    const reply = (params: Record<string, string>, signature = twilioSignature(params)) =>
      inject(t, 'POST', '/v1/webhooks/twilio', { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature }, new URLSearchParams(params).toString());
    const inbound = (from: string, body: string, extra: Record<string, string> = {}) => ({
      MessageSid: `SM${randomUUID().replace(/-/g, '')}`, SmsStatus: 'received', AccountSid: SID, From: from, To: '+14155550000', Body: body, NumMedia: '0', ...extra,
    });

    // Unsigned / forged: refused, nothing changes.
    const stop = inbound('+14155550121', ' stop ');
    expect((await reply(stop, twilioSignature({ ...stop, Body: 'HELLO' }))).statusCode).toBe(401);
    expect((await state(ann))!.state).toBe('granted');

    // STOP (Twilio default keyword, any case): TwiML back; the contact's own withdrawal in W only.
    const r = await reply(stop);
    expect([r.statusCode, r.body]).toEqual([200, '<?xml version="1.0" encoding="UTF-8"?><Response></Response>']);
    expect(await state(ann)).toEqual({ state: 'withdrawn', changed_by: 'contact' });
    expect(await events(ann, 'sms_stop')).toBe(1);
    expect((await state(other))!.state).toBe('granted');
    expect((await state(bo))!.state).toBe('granted');
    await reply(stop); // a provider retry: no second event
    expect(await events(ann, 'sms_stop')).toBe(1);
    // Staff cannot override the contact's own opt-out; the next campaign skips the number.
    expect((await owner.post(`/v1/workspaces/${W}/contacts/${ann}/consent`, { channel: 'sms', action: 'subscribed', source: 'form', lawfulBasis: 'consent', evidenceNote: 'Form' })).status).toBe(422);
    expect(await send()).toEqual(['+14155550122']);

    // HELP and ordinary replies change nothing; a number we never texted is acknowledged and ignored.
    expect((await reply(inbound('+14155550122', 'HELP'))).statusCode).toBe(200);
    expect((await reply(inbound('+14155550122', 'Thanks, see you there'))).statusCode).toBe(200);
    expect((await state(bo))!.state).toBe('granted');
    expect((await reply(inbound('+14155550199', 'STOP'))).statusCode).toBe(200);

    // START (Advanced Opt-Out marks it with OptOutType) restores exactly what STOP withdrew…
    await reply(inbound('+14155550121', 'Start', { OptOutType: 'START' }));
    expect(await state(ann)).toEqual({ state: 'granted', changed_by: 'contact' });
    expect(await events(ann, 'sms_start')).toBe(1);
    expect(await send()).toEqual(['+14155550121', '+14155550122']);
    // …and never grants consent that was not withdrawn by STOP (staff withdrawal stays).
    expect((await owner.post(`/v1/workspaces/${W}/contacts/${bo}/consent`, { channel: 'sms', action: 'revoked', source: 'admin', evidenceNote: 'Asked by phone' })).status).toBe(201);
    await reply(inbound('+14155550122', 'START', { OptOutType: 'START' }));
    expect((await state(bo))!.state).toBe('withdrawn');
    expect(await events(bo, 'sms_start')).toBe(0);
  });

  it('WhatsApp: "stopped marketing messages" (131050) withdraws the contact\'s WhatsApp consent; never a suppression', async () => {
    const listId = (await owner.post(`/v1/workspaces/${W}/lists`, { name: 'wa stop list' })).body.id;
    const id = await contact(listId, '+919876543299', 'whatsapp', true, 'Meena');
    const c = await campaign('whatsapp', listId, { schema: 'whatsapp.content.v1', template: { name: 'diwali_offer', language: 'en', parameters: [] } });
    const s = await owner.post(C(`/${c.id}/schedule`), { mode: 'now', expectedVersion: c.version });
    await idle();
    const [route] = await q<{ provider_message_id: string }>(`SELECT r.provider_message_id FROM provider_message_routes r JOIN campaign_recipients c ON c.id = r.delivery_id WHERE c.execution_id = $1`, [s.body.currentExecution.id]);
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: route!.provider_message_id, status: 'failed', timestamp: String(Math.floor(Date.now() / 1000)), errors: [{ code: 131050 }] }] } }] }] });
    const sig = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
    const post = () => inject(t, 'POST', '/v1/webhooks/whatsapp', { 'content-type': 'application/json', 'x-hub-signature-256': sig }, raw);
    expect((await post()).json()).toMatchObject({ recorded: 1 });
    expect((await post()).json()).toMatchObject({ duplicates: 1 });
    expect((await q(`SELECT state, changed_by FROM consent_states WHERE contact_id = $1 AND channel = 'whatsapp'`, [id]))[0]).toEqual({ state: 'withdrawn', changed_by: 'contact' });
    expect((await q(`SELECT count(*)::int AS n FROM consent_events WHERE contact_id = $1 AND source = 'whatsapp_opt_out'`, [id]))[0]!.n).toBe(1);
    expect((await q(`SELECT count(*)::int AS n FROM suppressions WHERE workspace_id = $1`, [W]))[0]!.n).toBe(0);
    expect((await owner.get(C(`/${c.id}/results`))).body.engagement.bounced).toEqual({ available: true, value: 1 });
  });

  it('invalid provider credentials: recipients wait (configuration back-off), none failed, nothing claimed as sent', async () => {
    const listId = (await owner.post(`/v1/workspaces/${W}/lists`, { name: 'bad creds' })).body.id;
    await contact(listId, '+14155550111', 'sms', true);
    const c = await campaign('sms', listId, { schema: 'sms.content.v1', text: 'Hello' });
    twilioStatus = 401;
    try {
      const s = await owner.post(C(`/${c.id}/schedule`), { mode: 'now', expectedVersion: c.version });
      await idle();
      const rows = await q<{ status: string }>(`SELECT status FROM campaign_recipients WHERE execution_id = $1`, [s.body.currentExecution.id]);
      expect(rows.some((x) => x.status === 'sent' || x.status === 'failed')).toBe(false);
      const e = (await owner.get(C(`/${c.id}/executions/${s.body.currentExecution.id}`))).body;
      expect(e.counts.sent).toBe(0);
    } finally {
      twilioStatus = 201;
    }
  });

  it('numbers are handed off in E.164 even when entered in national format (Audience address lookup)', async () => {
    const c = await owner.post(`/v1/workspaces/${W}/contacts`, { firstName: 'Nat', phone: '09812 345678', defaultCountry: 'IN' });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const [identity] = await q<{ id: string; value: string }>(`SELECT id, value FROM contact_identities WHERE contact_id = $1 AND kind = 'phone'`, [c.body.id]);
    expect(identity!.value).not.toBe('+919812345678'); // stored as entered
    const db = t.app.get(DATABASE, { strict: false }) as Database;
    const lookup = t.app.get(ADDRESS_LOOKUP, { strict: false }) as AddressLookup<Tx>;
    const ws = (await q<{ org_id: string }>(`SELECT org_id FROM workspaces WHERE id = $1`, [W]))[0]!;
    const [found] = await db.withTenant({ orgId: ws.org_id, workspaceId: W, userId: null }, (tx) => lookup.lookup({ tx, orgId: ws.org_id, workspaceId: W }, [identity!.id]));
    expect(found).toEqual({ identityId: identity!.id, kind: 'phone', value: '+919812345678' });
  });

  it('WhatsApp drafts must name an approved template; email-shaped content is refused for an SMS campaign', async () => {
    const listId = (await owner.post(`/v1/workspaces/${W}/lists`, { name: 'drafts' })).body.id;
    const wa = await campaign('whatsapp', listId, { schema: 'whatsapp.content.v1', template: { name: '', language: '', parameters: [] } });
    expect(wa.view.readinessFindings.map((f: { code: string }) => f.code)).toEqual(expect.arrayContaining(['TEMPLATE_MISSING']));
    const s = await owner.post(C(`/${wa.id}/schedule`), { mode: 'now', expectedVersion: wa.version });
    expect(s.status).toBe(422);
    const sms = await campaign('sms', listId, { schema: 'email.content.v1', subject: 'S', preheader: '', body: { format: 'text', text: 'B' } });
    expect(sms.view.readinessFindings.map((f: { code: string }) => f.code)).toContain('BODY_MISSING');
  });
});

describe('channels without a configured provider', () => {
  it('the email port never carries an SMS or WhatsApp hand-off (no silent fallback to email)', async () => {
    let sends = 0;
    const adapter = { provider: 'mailgun', send: async () => { sends++; return { ok: true, providerMessageId: 'x' }; } } as unknown as ConstructorParameters<typeof ProviderDeliveryPort>[1];
    const port = new ProviderDeliveryPort(null as never, adapter, null as never, null as never, { appUrl: 'https://app.example.test', unsubscribeSecret: 'u'.repeat(48), mode: 'live' });
    for (const channel of ['sms', 'whatsapp'] as const) {
      const item = { channel, orgId: randomUUID(), workspaceId: randomUUID(), executionId: randomUUID(), recipientId: randomUUID(), addressIdentityId: randomUUID(), idempotencyKey: 'k' };
      expect(await port.deliver(item as never)).toMatchObject({ ok: false, retryable: false, kind: 'configuration', code: 'CHANNEL_NOT_CONFIGURED' });
    }
    expect(sends).toBe(0);
  });

  it('SMS and WhatsApp are reported unavailable and cannot be created', async () => {
    const t = await startTestApp({});
    try {
      const owner = await signUp(t, undefined, 'Plain');
      const { workspaceId } = await createOrg(owner, 'Plain Co');
      const caps = (await owner.get(`/v1/workspaces/${workspaceId}/campaigns/capabilities`)).body;
      expect(caps.channels).toEqual([
        { channel: 'email', enabled: true, sendingAvailable: false },
        { channel: 'sms', enabled: false, sendingAvailable: false },
        { channel: 'whatsapp', enabled: false, sendingAvailable: false },
      ]);
      const r = await owner.post(`/v1/workspaces/${workspaceId}/campaigns`, { name: 'x', channel: 'sms' });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('CHANNEL_NOT_AVAILABLE');
      expect((await new (await import('./support.js')).Agent(t).get('/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1')).status).toBe(404);
    } finally {
      await t.close();
    }
  });
});
