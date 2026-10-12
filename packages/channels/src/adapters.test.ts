import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { failureKind } from './adapter.js';
import { MailgunEmailAdapter } from './email/mailgun.js';
import { classifySmtpError } from './email/smtp.js';

/**
 * Provider adapters (Phase 7.7; docs/architecture/delivery-providers.md): the outcome taxonomy, the Mailgun messages API
 * against a deterministic local HTTP double, signed webhooks (valid, tampered, stale, malformed) and event mapping.
 */
const payload = { from: 'Acme <news@mail.acme.test>', to: 'ann@example.test', subject: 'Hi', text: 'Hello', html: '<p>Hello</p>', headers: { 'List-Unsubscribe': '<https://u.example/x>', 'X-Bad\r\nInjected': 'no' } };
const ctx = { orgId: 'o', deliveryId: '01a11c56-0baf-73f4-84cf-aaa6798329a2', idempotencyKey: '01a11c56-0baf-73f4-84cf-aaa6798329a2' };

describe('Mailgun messages API (local double)', () => {
  let server: Server;
  let base: string;
  const seen: { auth?: string; path?: string; fields: Map<string, string> }[] = [];
  let reply: (res: ServerResponse) => void = (res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: '<20261009.1@mail.acme.test>', message: 'Queued. Thank you.' }));

  beforeAll(async () => {
    server = createServer(async (req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const form = await new Request('http://x', { method: 'POST', headers: { 'content-type': req.headers['content-type']! }, body: Buffer.concat(chunks) }).formData();
      seen.push({ auth: req.headers.authorization, path: req.url, fields: new Map([...form.entries()].map(([k, v]) => [k, String(v)])) });
      reply(res);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const adapter = (o: Partial<ConstructorParameters<typeof MailgunEmailAdapter>[0]> = {}) => new MailgunEmailAdapter({ apiKey: 'key-0123456789', domain: 'mail.acme.test', baseUrl: base, timeoutMs: 2_000, ...o });

  it('sends the documented form with basic auth; accepted → the provider message id', async () => {
    const r = await adapter().send(payload, ctx);
    expect(r).toEqual({ ok: true, providerMessageId: '20261009.1@mail.acme.test' });
    const s = seen.at(-1)!;
    expect(s.path).toBe('/v3/mail.acme.test/messages');
    expect(s.auth).toBe(`Basic ${Buffer.from('api:key-0123456789').toString('base64')}`);
    expect(Object.fromEntries(s.fields)).toMatchObject({ from: payload.from, to: payload.to, subject: 'Hi', text: 'Hello', html: '<p>Hello</p>', 'h:List-Unsubscribe': '<https://u.example/x>', 'v:workeasy-delivery': ctx.deliveryId });
    expect([...s.fields.keys()].some((k) => k.includes('Injected'))).toBe(false); // header injection dropped
    // Tracking is requested explicitly on every message; off unless configured.
    expect(Object.fromEntries(s.fields)).toMatchObject({ 'o:tracking-opens': 'no', 'o:tracking-clicks': 'no' });
    await adapter({ tracking: { opens: true, clicks: false } }).send(payload, ctx);
    expect(Object.fromEntries(seen.at(-1)!.fields)).toMatchObject({ 'o:tracking-opens': 'yes', 'o:tracking-clicks': 'no' });
  });

  it.each([
    [429, { 'retry-after': '120' }, { retryable: true, kind: 'throttled', retryAfterSeconds: 120, code: 'MAILGUN_429' }],
    [429, {}, { retryable: true, kind: 'throttled', retryAfterSeconds: 60 }],
    [400, {}, { retryable: false, kind: 'rejected', code: 'MAILGUN_400' }],
    [401, {}, { retryable: false, kind: 'configuration', code: 'MAILGUN_401' }],
    [404, {}, { retryable: false, kind: 'configuration' }],
    [500, {}, { retryable: true, kind: 'transient', code: 'MAILGUN_500' }],
    [503, {}, { retryable: true, kind: 'transient' }],
  ] as const)('HTTP %s → %o', async (status, headers, expected) => {
    reply = (res) => res.writeHead(status, { 'content-type': 'application/json', ...headers }).end('{"message":"x"}');
    expect(await adapter().send(payload, ctx)).toMatchObject({ ok: false, ...expected });
  });

  it('sends through the sender\x27s own verified domain; without a domain (or with a malformed one) nothing is sent', async () => {
    const before = seen.length;
    await adapter().send(payload, { ...ctx, senderDomain: 'news.customer-one.example' });
    expect(seen.at(-1)!.path).toBe('/v3/news.customer-one.example/messages');
    const noDomain = new MailgunEmailAdapter({ apiKey: 'key-0123456789', baseUrl: base, timeoutMs: 2_000 });
    expect(await noDomain.send(payload, ctx)).toMatchObject({ ok: false, kind: 'configuration', code: 'MAILGUN_NO_DOMAIN' });
    for (const bad of ['../../v4/x', 'a/b.example', 'x.example?y=1', '-bad.example', 'nodot']) {
      expect(await noDomain.send(payload, { ...ctx, senderDomain: bad })).toMatchObject({ ok: false, kind: 'configuration' });
    }
    expect(seen.length).toBe(before + 1); // only the valid one reached the provider
  });

  it('a refused connection is transient (nothing sent); a timeout is unknown (never retried, no duplicate)', async () => {
    // A port that was just released: nothing listens there, so the connection is refused before any byte is sent.
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const refused = new MailgunEmailAdapter({ apiKey: 'key-0123456789', domain: 'mail.acme.test', baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 2_000 });
    expect(await refused.send(payload, ctx)).toMatchObject({ ok: false, retryable: true, kind: 'transient', code: 'MAILGUN_ECONNREFUSED' });
    reply = () => undefined; // never answers
    const r = await adapter({ timeoutMs: 200 }).send(payload, ctx);
    expect(r).toMatchObject({ ok: false, retryable: false, kind: 'unknown', code: 'MAILGUN_TIMEOUT' });
  });

  it('accepted without an id is unknown, not guessed', async () => {
    reply = (res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    expect(await adapter().send(payload, ctx)).toMatchObject({ ok: false, kind: 'unknown', code: 'MAILGUN_NO_ID' });
  });

  it('refuses unsafe configuration', () => {
    expect(() => new MailgunEmailAdapter({ apiKey: 'key-0123456789', domain: 'mail.acme.test', baseUrl: 'http://api.mailgun.net' })).toThrow(/https/);
    expect(() => new MailgunEmailAdapter({ apiKey: 'k', domain: 'mail.acme.test' })).toThrow(/API key/);
    expect(() => new MailgunEmailAdapter({ apiKey: 'key-0123456789', domain: 'bad domain/../x' })).toThrow(/domain/);
  });
});

describe('Mailgun webhooks', () => {
  const key = 'whsec-0123456789abcdef';
  const now = 1_791_500_000_000;
  const a = new MailgunEmailAdapter({ apiKey: 'key-0123456789', domain: 'mail.acme.test', now: () => now });
  const signed = (event: Record<string, unknown>, ts = String(Math.floor(now / 1000)), token = 'tok-1', k = key) => {
    const signature = createHmac('sha256', k).update(ts + token).digest('hex');
    return Buffer.from(JSON.stringify({ signature: { timestamp: ts, token, signature }, 'event-data': event }));
  };
  const ev = (over: Record<string, unknown>) => ({ id: 'evt-1', timestamp: now / 1000, message: { headers: { 'message-id': '<20261009.1@mail.acme.test>' } }, ...over });

  it('accepts a correctly signed, fresh webhook', () => {
    expect(a.verifyCallback(signed(ev({ event: 'delivered' })), {}, { signingSecret: key })).toBe(true);
  });

  it('refuses a wrong key, a tampered signature, a stale or future timestamp, and malformed bodies', () => {
    expect(a.verifyCallback(signed(ev({ event: 'delivered' }), undefined, undefined, 'other-key'), {}, { signingSecret: key })).toBe(false);
    const body = JSON.parse(signed(ev({ event: 'delivered' })).toString());
    body.signature.token = 'tok-2'; // signature no longer matches
    expect(a.verifyCallback(Buffer.from(JSON.stringify(body)), {}, { signingSecret: key })).toBe(false);
    expect(a.verifyCallback(signed(ev({ event: 'delivered' }), String(Math.floor(now / 1000) - 16 * 60)), {}, { signingSecret: key })).toBe(false);
    expect(a.verifyCallback(signed(ev({ event: 'delivered' }), String(Math.floor(now / 1000) + 3600)), {}, { signingSecret: key })).toBe(false);
    for (const raw of ['', 'not json', '{}', '{"signature":{"timestamp":"1","token":"t","signature":"zz"}}']) {
      expect(a.verifyCallback(Buffer.from(raw), {}, { signingSecret: key })).toBe(false);
    }
    expect(a.verifyCallback(signed(ev({ event: 'delivered' })), {}, { signingSecret: '' })).toBe(false);
  });

  it('maps events to the internal taxonomy (provider message id only; no tenant from the payload)', () => {
    const parse = (over: Record<string, unknown>) => a.parseCallback({ 'event-data': ev(over) });
    expect(parse({ event: 'delivered' })).toEqual([{ type: 'message.delivered', providerMessageId: '20261009.1@mail.acme.test', occurredAt: new Date(now), props: { eventId: 'evt-1', provider: 'mailgun' } }]);
    expect(parse({ event: 'failed', severity: 'permanent', 'delivery-status': { code: 550 } })[0]).toMatchObject({ type: 'message.bounced', props: { bounce: 'hard', reason: 'SMTP_550' } });
    expect(parse({ event: 'failed', severity: 'temporary', 'delivery-status': { code: 451 } })[0]).toMatchObject({ type: 'message.deferred', props: { reason: 'SMTP_451' } });
    expect(parse({ event: 'complained' })[0]!.type).toBe('message.complained');
    expect(parse({ event: 'unsubscribed' })[0]!.type).toBe('message.unsubscribed');
    expect(parse({ event: 'accepted' })).toEqual([]);
    expect(parse({ event: 'delivered', message: {} })).toEqual([]); // no message id: unattributable
    expect(a.parseCallback({ 'event-data': { ...ev({ event: 'delivered' }), orgId: 'attacker-org' } })[0]).not.toHaveProperty('orgId');
  });
});

describe('SMTP classification', () => {
  it.each([
    [{ responseCode: 421 }, 'throttled', true],
    [{ responseCode: 452 }, 'throttled', true],
    [{ responseCode: 450 }, 'transient', true],
    [{ responseCode: 451 }, 'transient', true],
    [{ responseCode: 550 }, 'rejected', false],
    [{ responseCode: 554 }, 'rejected', false],
    [{ responseCode: 535 }, 'configuration', false],
    [{ code: 'EAUTH' }, 'configuration', false],
    [{ code: 'ECONNECTION', command: 'CONN' }, 'transient', true],
    [{ code: 'EDNS' }, 'transient', true],
    [{ code: 'ETIMEDOUT', command: 'DATA' }, 'unknown', false],
    [{ code: 'ESOCKET', command: 'DATA' }, 'unknown', false],
    [{ code: 'ETIMEDOUT', command: 'RCPT TO' }, 'transient', true],
  ] as const)('%o → %s', (err, kind, retryable) => {
    const r = classifySmtpError(err);
    expect([r.kind, r.retryable]).toEqual([kind, retryable]);
  });

  it('results without a kind keep their old meaning', () => {
    expect(failureKind({ ok: false, retryable: true, code: 'x', message: '' })).toBe('transient');
    expect(failureKind({ ok: false, retryable: false, code: 'x', message: '' })).toBe('rejected');
  });
});
