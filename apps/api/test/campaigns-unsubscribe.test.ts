import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type InlineJobDispatcher, JOB_DISPATCHER } from '../src/common/jobs.js';
import type { AppConfig } from '../src/config/env.js';
import { APP_CONFIG } from '../src/infrastructure/providers.js';
import { issueUnsubscribeToken, listUnsubscribeHeaders, unsubscribeLinks, verifyUnsubscribeToken } from '../src/modules/campaigns/application/unsubscribe.js';
import { seedAudience } from './execution-support.js';
import { Agent, createOrg, resetTestDatabase, signUp, startTestApp, type TestApp, withOwnerConnection } from './support.js';

/**
 * Unsubscribe (Phase 7.8; campaign amendment §U) through the real HTTP stack: signed links are the only authority;
 * GET changes nothing; POST is recorded by Audience (actor contact, evidence ids only) for the campaign's topic or all
 * marketing email; RFC 8058 one-click without session or CSRF; idempotent; future sends respect it.
 */
describe('unsubscribe links', () => {
  let t: TestApp;
  let owner: Agent;
  let orgId: string;
  let W: string;
  let topicId: string;
  let secret: string;
  let sessionSecret: string;
  const q = <T = Record<string, any>>(sql: string, args: unknown[] = []) => withOwnerConnection(async (c) => (await c.query(sql, args)).rows as T[]);
  const idle = async () => {
    const d = t.app.get(JOB_DISPATCHER, { strict: false }) as InlineJobDispatcher;
    for (let i = 0; i < 400; i++) {
      await d.idle();
      await new Promise((r) => setTimeout(r, 25));
      if (!(d as unknown as { running: Set<unknown> }).running.size) return;
    }
  };
  const anonymous = () => new Agent(t);
  const raw = (method: string, url: string, headers: Record<string, string>, payload: string) => (t.app.getHttpAdapter().getInstance() as { inject: (o: object) => Promise<{ statusCode: number; json: () => unknown }> }).inject({ method, url, headers, payload });

  /** A finished send-now campaign; returns its recipients (id, contact). */
  async function sent(n = 3, listId?: string) {
    listId ??= (await owner.post(`/v1/workspaces/${W}/lists`, { name: `u-${randomUUID().slice(0, 6)}` })).body.id as string;
    if (n) await seedAudience({ orgId, workspaceId: W, listId, n, eligible: n, secret });
    const C = (p = '') => `/v1/workspaces/${W}/campaigns${p}`;
    const c = await owner.post(C(), { name: 'Newsletter', channel: 'email', topicId });
    const p = await owner.patch(C(`/${c.body.id}`), {
      expectedVersion: 1,
      audience: { include: [{ type: 'list', listId }], exclude: [] },
      messages: [{ variantKey: 'default', content: { schema: 'email.content.v1', subject: 'S', preheader: '', body: { format: 'text', text: 'B' } } }],
    });
    const s = await owner.post(C(`/${c.body.id}/schedule`), { mode: 'now', expectedVersion: p.body.version });
    expect(s.status, JSON.stringify(s.body).slice(0, 200)).toBe(200);
    await idle();
    const ex = s.body.currentExecution.id as string;
    const recipients = await q<{ id: string; contact_id: string; status: string }>(`SELECT id, contact_id, status FROM campaign_recipients WHERE execution_id = $1 ORDER BY id`, [ex]);
    return { campaignId: c.body.id as string, executionId: ex, listId, recipients };
  }
  const tokenFor = (recipientId: string, o = orgId, w = W) => issueUnsubscribeToken(sessionSecret, { orgId: o, workspaceId: w, recipientId });

  beforeAll(async () => {
    await resetTestDatabase();
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test' });
    const config = t.app.get(APP_CONFIG, { strict: false }) as AppConfig;
    secret = config.fingerprintSecret;
    sessionSecret = config.sessionSecret;
    owner = await signUp(t, undefined, 'Owner');
    ({ orgId, workspaceId: W } = await createOrg(owner, 'Unsub Co'));
    topicId = (await owner.get(`/v1/workspaces/${W}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id;
  });
  afterAll(async () => t?.close());

  it('tokens: round trip; any tampering, truncation or other key is refused', () => {
    const c = { orgId: randomUUID(), workspaceId: randomUUID(), recipientId: randomUUID() };
    const tok = issueUnsubscribeToken('k'.repeat(40), c);
    expect(verifyUnsubscribeToken('k'.repeat(40), tok)).toEqual(c);
    expect(verifyUnsubscribeToken('x'.repeat(40), tok)).toBeNull();
    expect(tok.length).toBeLessThanOrEqual(100); // fits one URL path segment
    const [v, payload, mac] = tok.split('.');
    const raw = Buffer.from(payload!, 'base64url');
    raw[47] = raw[47]! ^ 1; // another recipient id
    const other = raw.toString('base64url');
    for (const bad of [`${v}.${other}.${mac}`, `${v}.${payload}`, `u2.${payload}.${mac}`, `${tok}.x`, '', 'x'.repeat(500)]) expect(verifyUnsubscribeToken('k'.repeat(40), bad)).toBeNull();
    const links = unsubscribeLinks('https://app.example.com/', tok);
    expect(links).toEqual({ page: `https://app.example.com/unsubscribe/${tok}`, oneClick: `https://app.example.com/api/v1/unsubscribe/${tok}` });
    expect(listUnsubscribeHeaders(links)).toEqual({ 'List-Unsubscribe': `<${links.oneClick}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
  });

  it('GET explains the link and changes nothing; POST unsubscribes from the campaign topic (Audience, actor contact, ids as evidence)', async () => {
    const { campaignId, executionId, recipients } = await sent();
    const r = recipients[0]!;
    const tok = tokenFor(r.id);
    const before = (await q(`SELECT count(*)::int AS n FROM consent_events WHERE contact_id = $1`, [r.contact_id]))[0]!.n;
    const info = await anonymous().get(`/v1/unsubscribe/${tok}`);
    expect(info.status).toBe(200);
    expect(info.body).toEqual({ organization: 'Unsub Co', workspace: 'Main', topicScoped: true });
    expect((await q(`SELECT count(*)::int AS n FROM consent_events WHERE contact_id = $1`, [r.contact_id]))[0]!.n).toBe(before);

    const res = await anonymous().post(`/v1/unsubscribe/${tok}`, { scope: 'topic' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unsubscribed: true, scope: 'topic', changed: true });
    const [ev] = await q(`SELECT action, topic_id, channel, actor_type, actor_id, source, evidence FROM consent_events WHERE contact_id = $1 ORDER BY recorded_at DESC LIMIT 1`, [r.contact_id]);
    expect(ev).toMatchObject({ action: 'unsubscribed', topic_id: topicId, channel: null, actor_type: 'contact', actor_id: r.contact_id, source: 'unsubscribe_link' });
    expect(ev!.evidence).toMatchObject({ campaignId, executionId, recipientId: r.id, recordedVia: 'unsubscribe_link' });
    expect(JSON.stringify(ev!.evidence)).not.toMatch(/@/);
    expect((await q(`SELECT status FROM contact_topic_preferences WHERE contact_id = $1 AND topic_id = $2`, [r.contact_id, topicId]))[0]!.status).toBe('unsubscribed');

    const again = await anonymous().post(`/v1/unsubscribe/${tok}`, { scope: 'topic' });
    expect(again.body).toEqual({ unsubscribed: true, scope: 'topic', changed: false });
  });

  it('RFC 8058 one-click: a form POST from a mail client, no session, no CSRF token', async () => {
    const { recipients } = await sent();
    const r = recipients[1]!;
    const res = await raw('POST', `/v1/unsubscribe/${tokenFor(r.id)}`, { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://mail.example.net' }, 'List-Unsubscribe=One-Click');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ unsubscribed: true, scope: 'topic', changed: true });
    expect((await q(`SELECT source FROM consent_events WHERE contact_id = $1 ORDER BY recorded_at DESC LIMIT 1`, [r.contact_id]))[0]!.source).toBe('list_unsubscribe');
    const junk = await raw('POST', `/v1/unsubscribe/${tokenFor(r.id)}`, { 'content-type': 'application/x-www-form-urlencoded' }, 'evil=1');
    expect(junk.statusCode).toBe(400);
  });

  it('"all marketing" withdraws the email channel; the next campaign skips that contact', async () => {
    const first = await sent(2);
    const r = first.recipients[0]!;
    const res = await anonymous().post(`/v1/unsubscribe/${tokenFor(r.id)}`, { scope: 'all' });
    expect(res.body).toEqual({ unsubscribed: true, scope: 'all', changed: true });
    expect((await q(`SELECT state FROM consent_states WHERE contact_id = $1 AND channel = 'email'`, [r.contact_id]))[0]!.state).toBe('withdrawn');
    const second = await sent(0, first.listId); // same list, no new contacts
    const mine = (await q<{ status: string; reason_codes: string[] }>(`SELECT status, reason_codes FROM campaign_recipients WHERE execution_id = $1 AND contact_id = $2`, [second.executionId, r.contact_id]))[0]!;
    expect(mine.status).toBe('skipped');
    expect(mine.reason_codes.join(',')).toMatch(/UNSUBSCRIBED|CONSENT/);
  });

  it('forged, tampered and cross-tenant tokens are 404; a contact that is gone is not an error', async () => {
    const { recipients } = await sent(2);
    expect((await anonymous().get('/v1/unsubscribe/u1.forged.forged')).status).toBe(404);
    expect((await anonymous().post(`/v1/unsubscribe/${issueUnsubscribeToken('wrong-key-wrong-key-wrong-key-0123', { orgId, workspaceId: W, recipientId: recipients[0]!.id })}`, {})).status).toBe(404);
    // A correctly signed token naming another tenant's ids finds nothing there (RLS), never this tenant's recipient.
    const outsider = await signUp(t, undefined, 'Outsider');
    const other = await createOrg(outsider, 'Other Co');
    expect((await anonymous().get(`/v1/unsubscribe/${tokenFor(recipients[0]!.id, other.orgId, other.workspaceId)}`)).status).toBe(404);
    expect((await anonymous().get(`/v1/unsubscribe/${tokenFor(randomUUID())}`)).status).toBe(404);
    await q(`UPDATE contacts SET deleted_at = now() WHERE id = $1`, [recipients[1]!.contact_id]);
    const gone = await anonymous().post(`/v1/unsubscribe/${tokenFor(recipients[1]!.id)}`, {});
    expect(gone.status).toBe(200);
    expect(gone.body).toMatchObject({ unsubscribed: true, changed: false });
  });
});
