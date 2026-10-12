/**
 * Engagement benchmark (Phase 7.10, master prompt §18). Opt-in:
 *   ENGAGEMENT_BENCH=1 [ENGAGEMENT_BENCH_SIZES=10000,100000] [ENGAGEMENT_BENCH_SAMPLE=5000] [ENGAGEMENT_BENCH_OUT=file.jsonl]
 *   pnpm --filter @workeasy/api exec vitest run test/engagement-bench.test.ts
 *
 * Per size N: a REAL completed execution of N recipients (test delivery). Then, as background at scale, one provider
 * route and one `delivered` event per recipient are written in bulk (setup, not measured: they stand for the feedback
 * of a real send). Measured through HTTP (signature, replay claim, route lookup, RLS transactions, rollups):
 *  - webhook ingestion: SAMPLE signed `opened` events, 16 concurrent, against tables already holding N events;
 *  - reads: workspace analytics and the campaign results, 20 times each.
 * Correctness is checked: the rollup's unique opens equal the distinct recipients sampled.
 */
import { appendFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import type { AudienceResolutionRecovery } from '@workeasy/audience-core';
import { MailgunEmailAdapter } from '@workeasy/channels';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type InlineJobDispatcher, JOB_DISPATCHER } from '../src/common/jobs.js';
import { AUDIENCE_RECOVERY } from '../src/infrastructure/providers.js';
import { seedAudience } from './execution-support.js';
import { type Agent, createOrg, resetTestDatabase, signUp, startTestApp, type TestApp, withOwnerConnection } from './support.js';

const ENABLED = !!process.env.ENGAGEMENT_BENCH;
const SIZES = (process.env.ENGAGEMENT_BENCH_SIZES ?? '10000').split(',').filter(Boolean).map(Number);
const SAMPLE = Number(process.env.ENGAGEMENT_BENCH_SAMPLE ?? 5000);
const KEY = 'bench-webhook-key-0123456789';
const report = (data: Record<string, unknown>) => {
  const line = `BENCH ${JSON.stringify({ name: 'engagement', at: new Date().toISOString(), ...data })}`;
  console.log(line);
  if (process.env.ENGAGEMENT_BENCH_OUT) appendFileSync(process.env.ENGAGEMENT_BENCH_OUT, `${line}\n`);
};
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]! * 10) / 10;
  return { n: s.length, p50: at(50), p95: at(95), p99: at(99), max: at(100) };
};

describe.skipIf(!ENABLED)('engagement benchmark (webhook ingestion, analytics reads)', () => {
  let exec: TestApp;
  let owner: Agent;
  const secret = 'bench-fingerprint-secret-bench-fingerprint';

  beforeAll(async () => {
    await resetTestDatabase();
    exec = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test', DATA_FINGERPRINT_SECRET: secret });
    owner = await signUp(exec, undefined, 'Bench');
  });
  afterAll(async () => exec?.close());

  for (const n of SIZES) {
    it(`${n.toLocaleString('en')} recipients`, async () => {
      const { orgId, workspaceId: W } = await createOrg(owner, `Engagement bench ${n}`);
      const topicId = (await owner.get(`/v1/workspaces/${W}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id;
      const listId = (await owner.post(`/v1/workspaces/${W}/lists`, { name: `eb-${randomUUID().slice(0, 6)}` })).body.id as string;
      await seedAudience({ orgId, workspaceId: W, listId, n, eligible: n, secret, tag: `eb${n}` });
      const c = await owner.post(`/v1/workspaces/${W}/campaigns`, { name: 'Engagement bench', channel: 'email', topicId });
      const p = await owner.patch(`/v1/workspaces/${W}/campaigns/${c.body.id}`, {
        expectedVersion: 1,
        audience: { include: [{ type: 'list', listId }], exclude: [] },
        sender: { senderIdentityId: null, fromName: 'Bench', replyTo: null },
        messages: [{ variantKey: 'default', content: { schema: 'email.content.v1', subject: 'Bench', preheader: '', body: { format: 'text', text: 'Bench' } } }],
      });
      // Bulk-seeded data leaves the Audience count bitmap invalid (as in the execution benchmark): repair it through the
      // Audience recovery port and wait until it is valid, so scheduling is not refused for an unavailable estimate.
      await (exec.app.get(AUDIENCE_RECOVERY, { strict: false }) as AudienceResolutionRecovery).requestRecovery({ orgId, workspaceId: W });
      for (const t0 = performance.now(); ; ) {
        const st = (await withOwnerConnection((cl) => cl.query(`SELECT state FROM audience_count_state WHERE workspace_id = $1`, [W]))).rows[0]?.state;
        if (st === 'valid') break;
        if (performance.now() - t0 > 3_600_000) throw new Error(`count bitmap not valid after 1 h (${st})`);
        await new Promise((r) => setTimeout(r, 2_000));
      }
      const s = await owner.post(`/v1/workspaces/${W}/campaigns/${c.body.id}/schedule`, { mode: 'now', expectedVersion: p.body.version });
      expect(s.status, JSON.stringify(s.body).slice(0, 300)).toBe(200);
      const ex = s.body.currentExecution.id as string;
      const dispatcher = exec.app.get(JOB_DISPATCHER) as InlineJobDispatcher;
      for (;;) {
        await dispatcher.idle();
        const st = (await withOwnerConnection((cl) => cl.query(`SELECT status FROM campaign_executions WHERE id = $1`, [ex]))).rows[0].status;
        if (st === 'completed' || st === 'failed') break;
        await new Promise((r) => setTimeout(r, 500));
      }

      // Background at scale (setup): a route and a delivered event per recipient, and the matching rollups.
      const t0 = performance.now();
      await withOwnerConnection(async (cl) => {
        await cl.query(
          `INSERT INTO provider_message_routes (provider, provider_message_id, org_id, workspace_id, delivery_id)
           SELECT 'mailgun', 'eb-' || id || '@mail.bench.test', org_id, workspace_id, id FROM campaign_recipients WHERE execution_id = $1 AND status = 'sent'`,
          [ex],
        );
        await cl.query(
          `INSERT INTO message_events (org_id, workspace_id, execution_id, recipient_id, type, provider, provider_event_id, occurred_at)
           SELECT org_id, workspace_id, execution_id, id, 'delivered', 'bench', id::text, now() FROM campaign_recipients WHERE execution_id = $1 AND status = 'sent'`,
          [ex],
        );
        await cl.query(
          `INSERT INTO recipient_engagement (recipient_id, org_id, workspace_id, execution_id, delivered_at)
           SELECT id, org_id, workspace_id, execution_id, now() FROM campaign_recipients WHERE execution_id = $1 AND status = 'sent'`,
          [ex],
        );
        await cl.query(
          `INSERT INTO execution_engagement (execution_id, org_id, workspace_id, delivered, last_event_at)
           SELECT $1, org_id, workspace_id, count(*), now() FROM campaign_recipients WHERE execution_id = $1 AND status = 'sent' GROUP BY org_id, workspace_id`,
          [ex],
        );
        await cl.query('ANALYZE provider_message_routes, message_events, recipient_engagement, execution_engagement');
      });
      const setupMs = performance.now() - t0;
      const ids = (await withOwnerConnection((cl) => cl.query(`SELECT id FROM campaign_recipients WHERE execution_id = $1 AND status = 'sent' ORDER BY random() LIMIT $2`, [ex, Math.min(SAMPLE, n)]))).rows.map((r) => r.id as string);

      // Webhook app: the provider adapter (never called here) and the signing key; a fresh rate-limit store per size.
      const hooks = await startTestApp(
        { CAMPAIGN_DELIVERY_MODE: 'test', DATA_FINGERPRINT_SECRET: secret, DELIVERY_WEBHOOK_SIGNING_KEY: KEY, DELIVERY_TRACKING: 'opens,clicks' },
        { deliveryAdapter: new MailgunEmailAdapter({ apiKey: 'key-0123456789', domain: 'mail.bench.test', baseUrl: 'http://127.0.0.1:9' }) },
      );
      try {
        const fastify = hooks.app.getHttpAdapter().getInstance() as { inject: (o: object) => Promise<{ statusCode: number; body: string }> };
        const post = async (recipientId: string) => {
          const ts = String(Math.floor(Date.now() / 1000));
          const token = randomUUID().replace(/-/g, '');
          const body = JSON.stringify({
            signature: { timestamp: ts, token, signature: createHmac('sha256', KEY).update(ts + token).digest('hex') },
            'event-data': { id: `o-${recipientId}`, event: 'opened', timestamp: Date.now() / 1000, message: { headers: { 'message-id': `eb-${recipientId}@mail.bench.test` } } },
          });
          const a = performance.now();
          const r = await fastify.inject({ method: 'POST', url: '/v1/webhooks/mailgun', headers: { 'content-type': 'application/json' }, payload: body });
          if (r.statusCode !== 200) throw new Error(`webhook ${r.statusCode}: ${r.body.slice(0, 200)}`);
          return performance.now() - a;
        };
        const lat: number[] = [];
        let next = 0;
        const w0 = performance.now();
        await Promise.all(Array.from({ length: 16 }, async () => {
          while (next < ids.length) lat.push(await post(ids[next++]!));
        }));
        const wallMs = performance.now() - w0;
        const rollup = (await withOwnerConnection((cl) => cl.query(`SELECT delivered, opened_unique FROM execution_engagement WHERE execution_id = $1`, [ex]))).rows[0];
        expect(rollup.opened_unique).toBe(ids.length);

        // Reads as the workspace owner through the execution app's HTTP stack (same database and queries; that app has no
        // provider configured, so its metrics say "not tracked" — the rollup queries run all the same).
        const reader = owner;
        const time = async (path: string) => {
          const a = performance.now();
          const r = await reader.get(path);
          expect(r.status).toBe(200);
          return { ms: performance.now() - a, body: r.body };
        };
        const analytics: number[] = [];
        const results: number[] = [];
        for (let i = 0; i < 20; i++) analytics.push((await time(`/v1/workspaces/${W}/campaigns/analytics`)).ms);
        for (let i = 0; i < 20; i++) results.push((await time(`/v1/workspaces/${W}/campaigns/${c.body.id}/results`)).ms);
        const totalEvents = Number((await withOwnerConnection((cl) => cl.query(`SELECT count(*)::int AS n FROM message_events`))).rows[0].n);
        report({
          size: n,
          sent: Number(rollup.delivered),
          backgroundSetupMs: Math.round(setupMs),
          messageEventsInDatabase: totalEvents,
          webhookSample: ids.length,
          webhookConcurrency: 16,
          webhookThroughputPerSecond: Math.round((ids.length / wallMs) * 1000),
          webhookRequestMs: stats(lat),
          workspaceAnalyticsMs: stats(analytics),
          campaignResultsMs: stats(results),
        });
      } finally {
        await hooks.close();
      }
    }, 4 * 3_600_000);
  }
});
