import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type InlineJobDispatcher, JOB_DISPATCHER } from '../src/common/jobs.js';
import type { AppConfig } from '../src/config/env.js';
import { APP_CONFIG } from '../src/infrastructure/providers.js';
import { CAMPAIGN_DELIVERY_PORT } from '../src/modules/campaigns/application/delivery.js';
import { ExecutionService } from '../src/modules/campaigns/application/execution.service.js';
import type { NullDeliveryPort } from '../src/modules/campaigns/infrastructure/null-delivery-port.js';
import { seedAudience } from './execution-support.js';
import { type Agent, createOrg, resetTestDatabase, signUp, startTestApp, type TestApp, withOwnerConnection } from './support.js';

/**
 * The execution engine acting on the provider outcome taxonomy (Phase 7.7; docs/architecture/delivery-providers.md):
 * unknown → final 'unknown', never resent; rejected → failed; transient → retried; throttled → the batch stops, the
 * rest is requeued without consuming attempts and the run waits as asked; configuration → retried with back-off and
 * stalls if it persists — never a duplicate, never a lost recipient.
 */
describe('delivery outcomes in the execution', () => {
  let t: TestApp;
  let owner: Agent;
  let orgId: string;
  let W: string;
  let topicId: string;
  let secret: string;
  let port: NullDeliveryPort;
  let svc: ExecutionService;
  let dispatcher: InlineJobDispatcher;
  const url = (p = '') => `/v1/workspaces/${W}/campaigns${p}`;
  const q = <T = Record<string, any>>(sql: string, args: unknown[] = []) => withOwnerConnection(async (c) => (await c.query(sql, args)).rows as T[]);
  const idle = async () => {
    for (let i = 0; i < 400; i++) {
      await dispatcher.idle();
      await new Promise((r) => setTimeout(r, 25));
      if (!(dispatcher as unknown as { running: Set<unknown> }).running.size) return;
    }
  };
  const until = async (pred: () => Promise<boolean>, ms = 20_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await idle();
      if (await pred()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('condition not reached');
  };
  const byStatus = async (executionId: string) =>
    Object.fromEntries((await q<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM campaign_recipients WHERE execution_id = $1 GROUP BY status`, [executionId])).map((r) => [r.status, r.n]));
  const exec = async (id: string) => (await q(`SELECT status, health, sent, failed, unknown FROM campaign_executions WHERE id = $1`, [id]))[0]!;

  async function send(n = 10): Promise<string> {
    const listId = (await owner.post(`/v1/workspaces/${W}/lists`, { name: `o-${randomUUID().slice(0, 6)}` })).body.id;
    await seedAudience({ orgId, workspaceId: W, listId, n, eligible: n, secret });
    const c = await owner.post(url(), { name: 'Outcomes', channel: 'email', topicId });
    const p = await owner.patch(url(`/${c.body.id}`), {
      expectedVersion: 1,
      audience: { include: [{ type: 'list', listId }], exclude: [] },
      messages: [{ variantKey: 'default', content: { schema: 'email.content.v1', subject: 'S', preheader: '', body: { format: 'text', text: 'B' } } }],
    });
    const s = await owner.post(url(`/${c.body.id}/schedule`), { mode: 'now', expectedVersion: p.body.version });
    expect(s.status).toBe(200);
    return s.body.currentExecution.id as string;
  }

  beforeAll(async () => {
    await resetTestDatabase();
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test' });
    secret = (t.app.get(APP_CONFIG, { strict: false }) as AppConfig).fingerprintSecret;
    port = t.app.get(CAMPAIGN_DELIVERY_PORT, { strict: false });
    svc = t.app.get(ExecutionService, { strict: false });
    dispatcher = t.app.get(JOB_DISPATCHER, { strict: false });
    svc.configure({ deliveryBatch: 4, jobRetryDelaysMs: [50, 50, 50] });
    owner = await signUp(t, undefined, 'Owner');
    ({ orgId, workspaceId: W } = await createOrg(owner, 'Outcome Co'));
    topicId = (await owner.get(`/v1/workspaces/${W}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id;
  });
  beforeEach(() => port.reset());
  afterAll(async () => {
    await idle();
    await t?.close();
  });

  it('unknown outcome: final "unknown", counted, never handed off again; the rest is sent', async () => {
    let first: string | null = null;
    port.script = (item) => {
      first ??= item.idempotencyKey;
      return item.idempotencyKey === first ? { ok: false, retryable: false, kind: 'unknown', code: 'MAILGUN_TIMEOUT', message: 'x' } : undefined;
    };
    const ex = await send(10);
    await until(async () => (await exec(ex)).status === 'completed');
    expect(await byStatus(ex)).toEqual({ sent: 9, unknown: 1 });
    expect(await exec(ex)).toMatchObject({ sent: 9, unknown: 1 });
    expect(port.callsFor(first!)).toBe(1);
  });

  it('rejected → failed (final); transient → retried and sent', async () => {
    const tries = new Map<string, number>();
    const keys: string[] = [];
    port.script = (item) => {
      if (!keys.includes(item.idempotencyKey)) keys.push(item.idempotencyKey);
      const n = (tries.get(item.idempotencyKey) ?? 0) + 1;
      tries.set(item.idempotencyKey, n);
      if (item.idempotencyKey === keys[0]) return { ok: false, retryable: false, kind: 'rejected', code: 'MAILGUN_400', message: 'x' };
      if (item.idempotencyKey === keys[1] && n === 1) return { ok: false, retryable: true, kind: 'transient', code: 'MAILGUN_503', message: 'x' };
      return undefined;
    };
    const ex = await send(6);
    await until(async () => (await exec(ex)).status === 'completed');
    expect(await byStatus(ex)).toEqual({ sent: 5, failed: 1 });
    expect(tries.get(keys[1]!)).toBe(2);
  });

  it('throttled: the batch stops, the rest is requeued without using an attempt, the run waits, then every recipient is sent once', async () => {
    let throttles = 0;
    port.script = () => (throttles++ < 1 ? { ok: false, retryable: true, kind: 'throttled', retryAfterSeconds: 1, code: 'MAILGUN_429', message: 'x' } : undefined);
    const started = Date.now();
    const ex = await send(8);
    await until(async () => (await exec(ex)).status === 'completed');
    expect(Date.now() - started).toBeGreaterThanOrEqual(900); // waited as asked
    expect(await byStatus(ex)).toEqual({ sent: 8 });
    const attempts = await q<{ attempts: number }>(`SELECT attempts FROM campaign_recipients WHERE execution_id = $1`, [ex]);
    expect(Math.max(...attempts.map((a) => a.attempts))).toBe(1); // the throttle consumed no attempt
  });

  it('configuration failure: nothing is lost or failed; retried with back-off; once fixed it completes, without duplicates', async () => {
    let broken = true;
    port.script = () => (broken ? { ok: false, retryable: false, kind: 'configuration', code: 'MAILGUN_401', message: 'x' } : undefined);
    const ex = await send(6);
    await until(async () => (await exec(ex)).health !== 'ok' || (await exec(ex)).status === 'completed');
    expect((await byStatus(ex)).failed ?? 0).toBe(0);
    broken = false;
    await until(async () => (await exec(ex)).status === 'completed');
    expect(await byStatus(ex)).toEqual({ sent: 6 });
    const dups = (await q(`SELECT count(*) - count(DISTINCT contact_id) AS n FROM campaign_recipients WHERE execution_id = $1`, [ex]))[0]!.n;
    expect(Number(dups)).toBe(0);
  });

  it('a configuration failure that persists stalls the execution (alert) with every recipient still queued, not failed', async () => {
    port.script = () => ({ ok: false, retryable: false, kind: 'configuration', code: 'MAILGUN_401', message: 'x' });
    const ex = await send(4);
    await until(async () => (await exec(ex)).health === 'stalled');
    const s = await byStatus(ex);
    expect(s.failed ?? 0).toBe(0);
    expect(s.queued).toBe(4);
    expect((await exec(ex)).status).toBe('delivering');
  });
});
