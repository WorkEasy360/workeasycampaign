import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { failureKind, type ProviderResult } from './adapter.js';
import { TwilioSmsAdapter } from './sms/twilio.js';
import { MetaWhatsAppAdapter } from './whatsapp/meta.js';

/**
 * SMS (Twilio) and WhatsApp (Meta Cloud API) adapters against deterministic local HTTP doubles: the exact request, the
 * outcome taxonomy, refusals without a request, unsafe configuration, signed callbacks and event mapping.
 */
const ctx = { orgId: 'o', deliveryId: '01a11c56-0baf-73f4-84cf-aaa6798329a2', idempotencyKey: '01a11c56-0baf-73f4-84cf-aaa6798329a2' };
const SID = 'AC' + '0123456789abcdef'.repeat(2);
const MG = 'MG' + 'fedcba9876543210'.repeat(2);
const TOKEN = 'twilio-auth-token-0123456789';
const WA_TOKEN = 'EAAG-access-token-0123456789';
const MSG_SID = 'SM' + 'a'.repeat(32);

type Seen = { method?: string; path?: string; auth?: string; contentType?: string; body: string };

function double() {
  const state = {
    server: undefined as unknown as Server,
    base: '',
    seen: [] as Seen[],
    reply: (_res: ServerResponse) => undefined as void,
  };
  beforeAll(async () => {
    state.server = createServer(async (req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      state.seen.push({ method: req.method, path: req.url, auth: req.headers.authorization, contentType: req.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') });
      state.reply(res);
    });
    await new Promise<void>((r) => state.server.listen(0, '127.0.0.1', () => r()));
    state.base = `http://127.0.0.1:${(state.server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => { state.server.closeAllConnections(); state.server.close(() => r()); }));
  return state;
}

async function closedPort(): Promise<number> {
  const closed = createServer();
  await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
  const port = (closed.address() as AddressInfo).port;
  await new Promise<void>((r) => closed.close(() => r()));
  return port;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => (res: ServerResponse) =>
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
const kindOf = (r: ProviderResult) => (r.ok ? 'ok' : failureKind(r));

describe('Twilio Messages API (local double)', () => {
  const d = double();
  const adapter = (o: Partial<ConstructorParameters<typeof TwilioSmsAdapter>[0]> = {}) =>
    new TwilioSmsAdapter({ accountSid: SID, authToken: TOKEN, from: '+15005550006', baseUrl: d.base, timeoutMs: 2_000, ...o });
  const payload = { from: '+15005550006', to: '+44 (20) 7946-0018', text: 'Sale today. Reply STOP to opt out' };

  it('validates and normalizes E.164 addresses', () => {
    const a = adapter();
    expect(a.validateAddress('+1 (415) 555-2671')).toEqual({ valid: true, normalized: '+14155552671' });
    for (const bad of ['14155552671', '+0123456789', '+12', 'call me', '+1415555267100000']) expect(a.validateAddress(bad)).toEqual({ valid: false, reason: 'not_e164' });
  });

  it('posts the documented form with basic auth; accepted → the message SID', async () => {
    d.reply = json(201, { sid: MSG_SID, status: 'queued' });
    const r = await adapter({ statusCallbackUrl: 'https://hooks.example.test/v1/webhooks/twilio' }).send(payload, ctx);
    expect(r).toEqual({ ok: true, providerMessageId: MSG_SID });
    const s = d.seen.at(-1)!;
    expect(s.method).toBe('POST');
    expect(s.path).toBe(`/2010-04-01/Accounts/${SID}/Messages.json`);
    expect(s.auth).toBe(`Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`);
    expect(s.contentType).toMatch(/^application\/x-www-form-urlencoded/);
    expect(Object.fromEntries(new URLSearchParams(s.body))).toEqual({ To: '+442079460018', From: '+15005550006', Body: payload.text, StatusCallback: 'https://hooks.example.test/v1/webhooks/twilio' });
  });

  it('sends through a messaging service instead of a from number', async () => {
    d.reply = json(201, { sid: MSG_SID });
    await new TwilioSmsAdapter({ accountSid: SID, authToken: TOKEN, messagingServiceSid: MG, baseUrl: d.base }).send(payload, ctx);
    const fields = Object.fromEntries(new URLSearchParams(d.seen.at(-1)!.body));
    expect(fields).toMatchObject({ MessagingServiceSid: MG });
    expect(fields).not.toHaveProperty('From');
    expect(fields).not.toHaveProperty('StatusCallback');
  });

  it.each([
    [429, {}, { 'retry-after': '120' }, { retryable: true, kind: 'throttled', retryAfterSeconds: 120, code: 'TWILIO_429' }],
    [429, { code: 20429 }, { 'retry-after': '99999' }, { kind: 'throttled', retryAfterSeconds: 3600, code: 'TWILIO_20429' }],
    [429, {}, {}, { kind: 'throttled', retryAfterSeconds: 60 }],
    [401, { code: 20003, message: 'Authenticate' }, {}, { retryable: false, kind: 'configuration', code: 'TWILIO_20003' }],
    [403, {}, {}, { kind: 'configuration', code: 'TWILIO_403' }],
    [400, { code: 21610, message: 'Attempt to send to unsubscribed recipient +442079460018' }, {}, { retryable: false, kind: 'rejected', code: 'TWILIO_21610', message: 'rejected' }],
    [400, { code: 21211, message: "The 'To' number +442079460018 is not a valid phone number." }, {}, { kind: 'rejected', code: 'TWILIO_21211' }],
    [400, { code: 21614 }, {}, { kind: 'rejected', code: 'TWILIO_21614' }],
    [400, { code: 21408 }, {}, { kind: 'rejected', code: 'TWILIO_21408' }],
    [400, 'not json', {}, { kind: 'rejected', code: 'TWILIO_400' }],
    [500, {}, {}, { retryable: true, kind: 'transient', code: 'TWILIO_500' }],
    [503, { code: 20500 }, {}, { retryable: true, kind: 'transient', code: 'TWILIO_20500' }],
  ] as const)('HTTP %s %o → %o', async (status, body, headers, expected) => {
    d.reply = typeof body === 'string' ? (res) => res.writeHead(status).end(body) : json(status, body, headers);
    const r = await adapter().send(payload, ctx);
    expect(r).toMatchObject({ ok: false, ...expected });
    if (!r.ok) expect(r.message).not.toContain('+44'); // provider text (may echo the number) never surfaced
  });

  it('accepted without a SID is unknown, not guessed', async () => {
    d.reply = json(201, { status: 'queued' });
    const r = await adapter().send(payload, ctx);
    expect(r).toMatchObject({ ok: false, retryable: false, kind: 'unknown', code: 'TWILIO_NO_ID' });
    expect(kindOf(r)).toBe('unknown');
  });

  it('a refused connection is transient (nothing sent); a timeout is unknown (never retried, no duplicate)', async () => {
    const port = await closedPort();
    const refused = await adapter({ baseUrl: `http://127.0.0.1:${port}` }).send(payload, ctx);
    expect(refused).toMatchObject({ ok: false, retryable: true, kind: 'transient', code: 'TWILIO_ECONNREFUSED' });
    d.reply = () => undefined; // never answers
    expect(await adapter({ timeoutMs: 200 }).send(payload, ctx)).toMatchObject({ ok: false, retryable: false, kind: 'unknown', code: 'TWILIO_TIMEOUT' });
  });

  it('refuses an invalid recipient without any request', async () => {
    const before = d.seen.length;
    for (const to of ['ann@example.test', '0207 946 0018', '+0', '']) {
      expect(await adapter().send({ ...payload, to }, ctx)).toEqual({ ok: false, retryable: false, kind: 'rejected', code: 'TWILIO_INVALID_NUMBER', message: 'invalid number' });
    }
    expect(d.seen.length).toBe(before);
  });

  it('refuses unsafe configuration', () => {
    const ok = { accountSid: SID, authToken: TOKEN, from: '+15005550006' };
    expect(() => new TwilioSmsAdapter(ok)).not.toThrow();
    expect(() => new TwilioSmsAdapter({ ...ok, baseUrl: 'http://api.twilio.com' })).toThrow(/https/);
    expect(() => new TwilioSmsAdapter({ ...ok, accountSid: 'AC123' })).toThrow(/account SID/);
    expect(() => new TwilioSmsAdapter({ ...ok, accountSid: SID.toUpperCase().replace(/^AC/, 'AC') })).toThrow(/account SID/);
    expect(() => new TwilioSmsAdapter({ ...ok, authToken: 'short' })).toThrow(/auth token/);
    expect(() => new TwilioSmsAdapter({ accountSid: SID, authToken: TOKEN })).toThrow(/exactly one/);
    expect(() => new TwilioSmsAdapter({ ...ok, messagingServiceSid: MG })).toThrow(/exactly one/);
    expect(() => new TwilioSmsAdapter({ ...ok, from: '15005550006' })).toThrow(/E\.164/);
    expect(() => new TwilioSmsAdapter({ accountSid: SID, authToken: TOKEN, messagingServiceSid: 'MG1' })).toThrow(/messaging service/);
    expect(() => new TwilioSmsAdapter({ ...ok, statusCallbackUrl: 'http://hooks.example.test/x' })).toThrow(/callback/);
  });
});

describe('Twilio status callbacks', () => {
  const url = 'https://hooks.example.test/v1/webhooks/twilio';
  const now = 1_791_500_000_000;
  const a = new TwilioSmsAdapter({ accountSid: SID, authToken: TOKEN, from: '+15005550006', statusCallbackUrl: url, now: () => now });
  const params = { MessageSid: MSG_SID, MessageStatus: 'delivered', AccountSid: SID, To: '+442079460018', ApiVersion: '2010-04-01' };
  const raw = Buffer.from(new URLSearchParams(params).toString());
  // Twilio's documented algorithm: url + each param (sorted by key) as key+value, HMAC-SHA1, base64.
  const sign = (p: Record<string, string>, u = url, k = TOKEN) => createHmac('sha1', k).update(u + Object.keys(p).sort().map((key) => key + p[key]).join('')).digest('base64');

  it('accepts a correctly signed callback', () => {
    expect(a.verifyCallback(raw, { 'x-twilio-signature': sign(params) }, { signingSecret: TOKEN })).toBe(true);
  });

  it('refuses a wrong secret, a tampered body, a missing header, a different URL, and no configured URL', () => {
    const header = { 'x-twilio-signature': sign(params) };
    expect(a.verifyCallback(raw, header, { signingSecret: 'another-token-0123456789' })).toBe(false);
    expect(a.verifyCallback(raw, { 'x-twilio-signature': sign(params, url, 'another-token-0123456789') }, { signingSecret: TOKEN })).toBe(false);
    expect(a.verifyCallback(Buffer.from(new URLSearchParams({ ...params, MessageStatus: 'failed' }).toString()), header, { signingSecret: TOKEN })).toBe(false);
    expect(a.verifyCallback(raw, {}, { signingSecret: TOKEN })).toBe(false);
    expect(a.verifyCallback(raw, { 'x-twilio-signature': 'garbage' }, { signingSecret: TOKEN })).toBe(false);
    expect(a.verifyCallback(raw, { 'x-twilio-signature': sign(params, 'https://evil.example/v1/webhooks/twilio') }, { signingSecret: TOKEN })).toBe(false);
    expect(a.verifyCallback(raw, header, { signingSecret: '' })).toBe(false);
    const noUrl = new TwilioSmsAdapter({ accountSid: SID, authToken: TOKEN, from: '+15005550006' });
    expect(noUrl.verifyCallback(raw, header, { signingSecret: TOKEN })).toBe(false);
  });

  it('maps statuses to the internal taxonomy (provider message id only; no tenant from the payload)', () => {
    const parse = (over: Record<string, string>) => a.parseCallback({ ...params, ...over });
    expect(parse({})).toEqual([{ type: 'message.delivered', providerMessageId: MSG_SID, occurredAt: new Date(now), props: { eventId: `${MSG_SID}:delivered`, provider: 'twilio' } }]);
    expect(parse({ MessageStatus: 'undelivered', ErrorCode: '30005' })).toEqual([
      { type: 'message.bounced', providerMessageId: MSG_SID, occurredAt: new Date(now), props: { eventId: `${MSG_SID}:undelivered`, provider: 'twilio', bounce: 'hard', reason: 'TWILIO_30005' } },
    ]);
    expect(parse({ MessageStatus: 'failed' })[0]).toMatchObject({ type: 'message.bounced', props: { bounce: 'hard', reason: 'TWILIO_FAILED', eventId: `${MSG_SID}:failed` } });
    for (const status of ['sent', 'queued', 'sending', 'accepted']) expect(parse({ MessageStatus: status })).toEqual([]);
    expect(a.parseCallback(new URLSearchParams(params))[0]!.type).toBe('message.delivered'); // URLSearchParams accepted
    expect(a.parseCallback({ MessageStatus: 'delivered' })).toEqual([]); // no MessageSid: unattributable
    for (const bad of [null, undefined, 'x', 42, [], { MessageSid: MSG_SID }]) expect(a.parseCallback(bad)).toEqual([]);
    expect(a.parseCallback({ ...params, orgId: 'attacker-org' })[0]).not.toHaveProperty('orgId');
  });

  it('recognizes replies to the number: STOP / START / HELP keywords and Advanced Opt-Out, nothing else', () => {
    const reply = (Body: string, extra: Record<string, string> = {}) => a.parseInbound({ MessageSid: MSG_SID, SmsStatus: 'received', AccountSid: SID, From: '+14155550123', To: '+15005550006', Body, ...extra });
    for (const w of ['STOP', ' stop ', 'Unsubscribe', 'cancel', 'END', 'quit', 'STOPALL', 'revoke', 'optout']) expect(reply(w)).toEqual({ from: '+14155550123', messageSid: MSG_SID, intent: 'opt_out' });
    for (const w of ['START', 'yes', 'unstop']) expect(reply(w)!.intent).toBe('opt_in');
    for (const w of ['HELP', 'info']) expect(reply(w)!.intent).toBe('help');
    // Only the whole message is a keyword (as Twilio matches it); a sentence is an ordinary reply.
    for (const w of ['please stop texting me tomorrow', 'STOP!!', '', 'Stopwatch']) expect(reply(w)!.intent).toBe('other');
    // Advanced Opt-Out tells us directly (custom keywords included).
    expect(reply('ARRET', { OptOutType: 'STOP' })!.intent).toBe('opt_out');
    expect(reply('ok', { OptOutType: 'START' })!.intent).toBe('opt_in');
    // Status callbacks, unattributable or malformed bodies are not inbound messages.
    expect(a.parseInbound(params)).toBeNull();
    expect(a.parseInbound({ MessageSid: MSG_SID, Body: 'STOP' })).toBeNull(); // no From
    expect(a.parseInbound({ MessageSid: MSG_SID, From: 'not-a-number', Body: 'STOP' })).toBeNull();
    expect(a.parseInbound({ From: '+14155550123', Body: 'STOP' })).toBeNull(); // no message id
    for (const bad of [null, undefined, 'x', 42, []]) expect(a.parseInbound(bad)).toBeNull();
    expect(a.parseInbound(new URLSearchParams({ SmsSid: MSG_SID, From: '+14155550123', Body: 'stop' }))!.intent).toBe('opt_out');
  });
});

describe('Meta WhatsApp Cloud API (local double)', () => {
  const d = double();
  const adapter = (o: Partial<ConstructorParameters<typeof MetaWhatsAppAdapter>[0]> = {}) =>
    new MetaWhatsAppAdapter({ accessToken: WA_TOKEN, phoneNumberId: '106540352242922', baseUrl: d.base, timeoutMs: 2_000, ...o });
  const template = { name: 'spring_sale', language: 'en_US', variables: { '2': 'SPRING20', '10': 'tomorrow', '1': 'Ann' } };
  const payload = { from: '', to: '+44 7700 900123', text: 'Hi Ann', template };
  const WAMID = 'wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBJDQjZCMzlEQUE4OTJBMTE4RTUA';

  it('validates E.164 (keeps the +)', () => {
    expect(adapter().validateAddress('+44 7700-900123')).toEqual({ valid: true, normalized: '+447700900123' });
    expect(adapter().validateAddress('447700900123')).toEqual({ valid: false, reason: 'not_e164' });
  });

  it('posts the documented template message with a bearer token; accepted → the wamid', async () => {
    d.reply = json(200, { messaging_product: 'whatsapp', contacts: [{ input: '447700900123', wa_id: '447700900123' }], messages: [{ id: WAMID }] });
    const r = await adapter().send(payload, ctx);
    expect(r).toEqual({ ok: true, providerMessageId: WAMID });
    const s = d.seen.at(-1)!;
    expect(s.method).toBe('POST');
    expect(s.path).toBe('/v21.0/106540352242922/messages');
    expect(s.auth).toBe(`Bearer ${WA_TOKEN}`);
    expect(s.contentType).toMatch(/^application\/json/);
    expect(JSON.parse(s.body)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '447700900123',
      type: 'template',
      template: {
        name: 'spring_sale',
        language: { code: 'en_US' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ann' }, { type: 'text', text: 'SPRING20' }, { type: 'text', text: 'tomorrow' }] }],
      },
    });
    await adapter({ apiVersion: 'v22.0' }).send({ ...payload, template: { name: 'hello_world', language: 'en', variables: {} } }, ctx);
    const s2 = d.seen.at(-1)!;
    expect(s2.path).toBe('/v22.0/106540352242922/messages');
    expect(JSON.parse(s2.body).template).toEqual({ name: 'hello_world', language: { code: 'en' }, components: [] });
  });

  it.each([
    [429, {}, { 'retry-after': '30' }, { retryable: true, kind: 'throttled', retryAfterSeconds: 30, code: 'WHATSAPP_429' }],
    [400, { error: { code: 130429, message: 'Rate limit hit' } }, {}, { retryable: true, kind: 'throttled', retryAfterSeconds: 60, code: 'WHATSAPP_130429' }],
    [400, { error: { code: 131056 } }, {}, { kind: 'throttled', code: 'WHATSAPP_131056' }],
    [400, { error: { code: 4 } }, {}, { kind: 'throttled', code: 'WHATSAPP_4' }],
    [400, { error: { code: 80007 } }, {}, { kind: 'throttled' }],
    [400, { error: { code: 131048 } }, {}, { kind: 'throttled' }],
    [401, { error: { code: 190, error_subcode: 463, message: 'Session has expired' } }, {}, { retryable: false, kind: 'configuration', code: 'WHATSAPP_190' }],
    [400, { error: { code: 190 } }, {}, { kind: 'configuration', code: 'WHATSAPP_190' }],
    [401, {}, {}, { kind: 'configuration', code: 'WHATSAPP_401' }],
    [400, { error: { code: 131026, message: 'Message undeliverable to +447700900123' } }, {}, { retryable: false, kind: 'rejected', code: 'WHATSAPP_131026', message: 'rejected' }],
    [400, { error: { code: 131047 } }, {}, { kind: 'rejected', code: 'WHATSAPP_131047' }],
    [400, { error: { code: 131051 } }, {}, { kind: 'rejected', code: 'WHATSAPP_131051' }],
    [400, { error: { code: 131050 } }, {}, { retryable: false, kind: 'rejected', code: 'WHATSAPP_131050' }], // stopped marketing messages
    [400, { error: { code: 132000 } }, {}, { kind: 'rejected', code: 'WHATSAPP_132000' }],
    [400, { error: { code: 132015 } }, {}, { kind: 'rejected', code: 'WHATSAPP_132015' }],
    [400, { error: { code: 100 } }, {}, { kind: 'rejected', code: 'WHATSAPP_100' }],
    [500, { error: { code: 1 } }, {}, { retryable: true, kind: 'transient', code: 'WHATSAPP_1' }],
    [503, {}, {}, { retryable: true, kind: 'transient', code: 'WHATSAPP_503' }],
  ] as const)('HTTP %s %o → %o', async (status, body, headers, expected) => {
    d.reply = json(status, body, headers);
    const r = await adapter().send(payload, ctx);
    expect(r).toMatchObject({ ok: false, ...expected });
    if (!r.ok) expect(r.message).not.toContain('+44');
  });

  it('accepted without a message id is unknown, not guessed', async () => {
    for (const body of [{}, { messages: [] }, { messages: [{}] }]) {
      d.reply = json(200, body);
      const r = await adapter().send(payload, ctx);
      expect(r).toMatchObject({ ok: false, retryable: false, kind: 'unknown', code: 'WHATSAPP_NO_ID' });
      expect(kindOf(r)).toBe('unknown');
    }
  });

  it('a refused connection is transient (nothing sent); a timeout is unknown (never retried, no duplicate)', async () => {
    const port = await closedPort();
    expect(await adapter({ baseUrl: `http://127.0.0.1:${port}` }).send(payload, ctx)).toMatchObject({ ok: false, retryable: true, kind: 'transient', code: 'WHATSAPP_ECONNREFUSED' });
    d.reply = () => undefined; // never answers
    expect(await adapter({ timeoutMs: 200 }).send(payload, ctx)).toMatchObject({ ok: false, retryable: false, kind: 'unknown', code: 'WHATSAPP_TIMEOUT' });
  });

  it('refuses a missing or invalid template and an invalid recipient without any request', async () => {
    const before = d.seen.length;
    const a = adapter();
    expect(await a.send({ ...payload, template: undefined }, ctx)).toEqual({ ok: false, retryable: false, kind: 'rejected', code: 'WHATSAPP_TEMPLATE_REQUIRED', message: 'template required' });
    for (const t of [
      { ...template, name: 'Spring Sale' },
      { ...template, name: '../x' },
      { ...template, language: 'english' },
      { ...template, language: 'en-US' },
      { ...template, variables: { a: 'x' } },
    ]) {
      expect(await a.send({ ...payload, template: t }, ctx)).toMatchObject({ ok: false, kind: 'rejected', code: 'WHATSAPP_TEMPLATE_INVALID' });
    }
    expect(await a.send({ ...payload, to: '447700900123' }, ctx)).toMatchObject({ ok: false, kind: 'rejected', code: 'WHATSAPP_INVALID_NUMBER' });
    expect(d.seen.length).toBe(before);
  });

  it('refuses unsafe configuration', () => {
    const ok = { accessToken: WA_TOKEN, phoneNumberId: '106540352242922' };
    expect(() => new MetaWhatsAppAdapter(ok)).not.toThrow();
    expect(() => new MetaWhatsAppAdapter({ ...ok, baseUrl: 'http://graph.facebook.com' })).toThrow(/https/);
    expect(() => new MetaWhatsAppAdapter({ ...ok, phoneNumberId: '1065/../me' })).toThrow(/phone number id/);
    expect(() => new MetaWhatsAppAdapter({ ...ok, phoneNumberId: '123' })).toThrow(/phone number id/);
    expect(() => new MetaWhatsAppAdapter({ ...ok, accessToken: 'short' })).toThrow(/access token/);
    expect(() => new MetaWhatsAppAdapter({ ...ok, apiVersion: 'v21' })).toThrow(/API version/);
    expect(() => new MetaWhatsAppAdapter({ ...ok, apiVersion: '../v1.0' })).toThrow(/API version/);
  });
});

describe('Meta WhatsApp webhooks', () => {
  const secret = 'meta-app-secret-0123456789';
  const a = new MetaWhatsAppAdapter({ accessToken: WA_TOKEN, phoneNumberId: '106540352242922' });
  const ts = 1_791_500_000;
  const st = (over: Record<string, unknown>) => ({ id: 'wamid.ABC', status: 'delivered', timestamp: String(ts), recipient_id: '447700900123', ...over });
  const hook = (statuses: unknown[], extra: Record<string, unknown> = {}) => ({
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA_ID', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '106540352242922' }, statuses, ...extra } }] }],
  });
  const sig = (raw: Buffer, k = secret) => `sha256=${createHmac('sha256', k).update(raw).digest('hex')}`;

  it('accepts a correctly signed webhook; refuses a wrong secret, a tampered body, a missing or malformed header', () => {
    const raw = Buffer.from(JSON.stringify(hook([st({})])));
    expect(a.verifyCallback(raw, { 'x-hub-signature-256': sig(raw) }, { signingSecret: secret })).toBe(true);
    expect(a.verifyCallback(raw, { 'x-hub-signature-256': sig(raw, 'another-secret') }, { signingSecret: secret })).toBe(false);
    expect(a.verifyCallback(raw, { 'x-hub-signature-256': sig(raw) }, { signingSecret: 'another-secret' })).toBe(false);
    const tampered = Buffer.from(JSON.stringify(hook([st({ status: 'read' })])));
    expect(a.verifyCallback(tampered, { 'x-hub-signature-256': sig(raw) }, { signingSecret: secret })).toBe(false);
    expect(a.verifyCallback(raw, {}, { signingSecret: secret })).toBe(false);
    for (const h of ['', sig(raw).slice(7), 'sha1=' + sig(raw).slice(7), sig(raw).toUpperCase(), sig(raw).slice(0, -2)]) {
      expect(a.verifyCallback(raw, { 'x-hub-signature-256': h }, { signingSecret: secret })).toBe(false);
    }
    expect(a.verifyCallback(raw, { 'x-hub-signature-256': sig(raw, '') }, { signingSecret: '' })).toBe(false);
  });

  it('answers the subscription handshake only for subscribe + the right token', () => {
    const q = { 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me-123', 'hub.challenge': '1158201444' };
    expect(MetaWhatsAppAdapter.verifySubscription(q, 'verify-me-123')).toBe('1158201444');
    expect(MetaWhatsAppAdapter.verifySubscription(q, 'verify-me-124')).toBeNull();
    expect(MetaWhatsAppAdapter.verifySubscription(q, 'verify-me')).toBeNull();
    expect(MetaWhatsAppAdapter.verifySubscription({ ...q, 'hub.mode': 'unsubscribe' }, 'verify-me-123')).toBeNull();
    expect(MetaWhatsAppAdapter.verifySubscription({ ...q, 'hub.verify_token': undefined }, 'verify-me-123')).toBeNull();
    expect(MetaWhatsAppAdapter.verifySubscription({ ...q, 'hub.verify_token': '' }, '')).toBeNull();
    expect(MetaWhatsAppAdapter.verifySubscription({ ...q, 'hub.challenge': undefined }, 'verify-me-123')).toBeNull();
    expect(MetaWhatsAppAdapter.verifySubscription({ ...q, 'hub.challenge': '<script>' }, 'verify-me-123')).toBeNull();
  });

  it('maps statuses to the internal taxonomy (provider message id only; no tenant from the payload)', () => {
    const at = new Date(ts * 1000);
    expect(a.parseCallback(hook([st({})]))).toEqual([{ type: 'message.delivered', providerMessageId: 'wamid.ABC', occurredAt: at, props: { eventId: 'wamid.ABC:delivered', provider: 'whatsapp' } }]);
    expect(a.parseCallback(hook([st({ status: 'read' })]))).toEqual([{ type: 'message.opened', providerMessageId: 'wamid.ABC', occurredAt: at, props: { eventId: 'wamid.ABC:read', provider: 'whatsapp' } }]);
    expect(a.parseCallback(hook([st({ status: 'failed', errors: [{ code: 131026, title: 'Message undeliverable' }] })]))).toEqual([
      { type: 'message.bounced', providerMessageId: 'wamid.ABC', occurredAt: at, props: { eventId: 'wamid.ABC:failed', provider: 'whatsapp', bounce: 'hard', reason: 'WHATSAPP_131026' } },
    ]);
    expect(a.parseCallback(hook([st({ status: 'failed' })]))[0]).toMatchObject({ props: { reason: 'WHATSAPP_FAILED' } });
    expect(a.parseCallback(hook([st({ status: 'sent' })]))).toEqual([]);
    // Several statuses in one delivery; invalid ones skipped.
    const many = a.parseCallback(hook([st({ id: 'wamid.1' }), st({ id: 'wamid.2', status: 'read' }), st({ id: 'wamid.3', timestamp: 'nope' }), st({ id: undefined }), null]));
    expect(many.map((e) => [e.providerMessageId, e.type])).toEqual([['wamid.1', 'message.delivered'], ['wamid.2', 'message.opened']]);
    // Inbound messages are ignored.
    expect(a.parseCallback(hook([], { messages: [{ from: '447700900123', id: 'wamid.IN', type: 'text', text: { body: 'STOP' } }] }))).toEqual([]);
    expect(a.parseCallback({ ...hook([st({})]), entry: [{ changes: [{ field: 'message_template_status_update', value: { statuses: [st({})] } }] }] })).toEqual([]);
    for (const bad of [null, undefined, 'x', [], {}, { object: 'page', entry: hook([st({})]).entry }, { object: 'whatsapp_business_account', entry: 'x' }, { object: 'whatsapp_business_account', entry: [null, { changes: 'x' }] }]) {
      expect(a.parseCallback(bad)).toEqual([]);
    }
    expect(a.parseCallback(hook([st({ orgId: 'attacker-org' })]))[0]).not.toHaveProperty('orgId');
  });
});
