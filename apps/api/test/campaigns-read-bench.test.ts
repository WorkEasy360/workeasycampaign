/**
 * Read-path benchmark (6.13): the recipient list (row 23) and analytics over a REAL completed execution of N
 * recipients. Opt-in:
 *   READ_BENCH=1 [READ_BENCH_SIZES=100000,500000] [READ_BENCH_OUT=file.jsonl] pnpm --filter @workeasy/api exec vitest run test/campaigns-read-bench.test.ts
 * Latencies are measured through HTTP (guards, RLS transaction, port call, serialization included).
 */
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InlineJobDispatcher, JOB_DISPATCHER } from '../src/common/jobs.js';
import { cursorScope, encodeCursor } from '../src/common/pagination.js';
import { seedAudience } from './execution-support.js';
import { type Agent, createOrg, resetTestDatabase, signUp, startTestApp, type TestApp, withOwnerConnection } from './support.js';

const ENABLED = !!process.env.READ_BENCH;
const SIZES = (process.env.READ_BENCH_SIZES ?? '100000').split(',').filter(Boolean).map(Number);
const report = (data: Record<string, unknown>) => {
  const line = `BENCH ${JSON.stringify({ name: 'read.paths', at: new Date().toISOString(), ...data })}`;
  console.log(line);
  if (process.env.READ_BENCH_OUT) appendFileSync(process.env.READ_BENCH_OUT, `${line}\n`);
};
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!);
  return { n: s.length, p50: at(50), p95: at(95), p99: at(99), max: Math.round(s[s.length - 1]!) };
};

describe.skipIf(!ENABLED)('read-path benchmark (recipients, analytics)', () => {
  let t: TestApp;
  let owner: Agent;
  let dispatcher: InlineJobDispatcher;
  const secret = 'bench-fingerprint-secret-bench-fingerprint';

  beforeAll(async () => {
    await resetTestDatabase();
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test', DATA_FINGERPRINT_SECRET: secret });
    dispatcher = t.app.get(JOB_DISPATCHER);
    owner = await signUp(t, undefined, 'Bench');
  });
  afterAll(async () => t?.close());

  for (const n of SIZES) {
    it(`${n.toLocaleString('en')} recipients`, async () => {
      const { orgId, workspaceId: W } = await createOrg(owner, `Read bench ${n}`);
      const topicId = (await owner.get(`/v1/workspaces/${W}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id;
      const listId = (await owner.post(`/v1/workspaces/${W}/lists`, { name: `rb-${randomUUID().slice(0, 6)}` })).body.id as string;
      await seedAudience({ orgId, workspaceId: W, listId, n, eligible: Math.round(n * 0.8), secret, tag: `rb${n}` });
      const c = await owner.post(`/v1/workspaces/${W}/campaigns`, { name: 'Read bench', channel: 'email', topicId });
      const p = await owner.patch(`/v1/workspaces/${W}/campaigns/${c.body.id}`, {
        expectedVersion: 1,
        audience: { include: [{ type: 'list', listId }], exclude: [] },
        sender: { senderIdentityId: null, fromName: 'Bench', replyTo: null },
        messages: [{ variantKey: 'default', content: { schema: 'email.content.v1', subject: 'Bench', preheader: '', body: { format: 'text', text: 'Bench' } } }],
      });
      const s = await owner.post(`/v1/workspaces/${W}/campaigns/${c.body.id}/schedule`, { mode: 'now', expectedVersion: p.body.version });
      expect(s.status).toBe(200);
      const ex = s.body.currentExecution.id as string;
      for (;;) {
        await dispatcher.idle();
        const st = (await withOwnerConnection((cl) => cl.query(`SELECT status FROM campaign_executions WHERE id = $1`, [ex]))).rows[0].status;
        if (st === 'completed' || st === 'failed') break;
        await new Promise((r) => setTimeout(r, 500));
      }
      await withOwnerConnection((cl) => cl.query('ANALYZE campaign_recipients'));
      const R = (q: string) => `/v1/workspaces/${W}/campaigns/${c.body.id}/executions/${ex}/recipients${q}`;
      const time = async (path: string) => {
        const t0 = performance.now();
        const r = await owner.get(path);
        const ms = performance.now() - t0;
        expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
        return { ms, body: r.body };
      };

      // Sequential pages from the start (100 per page), then pages deep into the list via the cursor.
      const seq: number[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 30; i++) {
        const { ms, body } = await time(R(`?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
        seq.push(ms);
        cursor = body.nextCursor;
      }
      const midId = (await withOwnerConnection((cl) => cl.query(`SELECT id FROM campaign_recipients WHERE execution_id = $1 ORDER BY id OFFSET $2 LIMIT 1`, [ex, Math.floor(n / 2)]))).rows[0].id;
      // Cursors are signed and scoped: the in-process harness signs one with the app's key and the endpoint's scope.
      const deepCursor = encodeCursor({ t: new Date().toISOString(), id: midId }, cursorScope({ orgId, workspaceId: W }, 'campaign.recipients', { campaignId: c.body.id, executionId: ex }));
      const deep: number[] = [];
      for (let i = 0; i < 20; i++) deep.push((await time(R(`?limit=100&cursor=${encodeURIComponent(deepCursor)}`))).ms);
      const status: number[] = [];
      for (let i = 0; i < 20; i++) status.push((await time(R('?limit=100&status=skipped'))).ms);
      const reasonCode = (await time(R('?limit=1&status=skipped'))).body.data[0]?.reasonCodes[0] ?? 'CONSENT_MISSING';
      const reason: number[] = [];
      for (let i = 0; i < 10; i++) reason.push((await time(R(`?limit=100&reason=${reasonCode}`))).ms);
      // Worst case: a reason that matches nothing walks every recipient of the execution.
      const reasonNone: number[] = [];
      for (let i = 0; i < 5; i++) reasonNone.push((await time(R('?limit=100&reason=NO_SUCH_REASON'))).ms);
      const analytics: number[] = [];
      for (let i = 0; i < 20; i++) analytics.push((await time(`/v1/workspaces/${W}/campaigns/analytics`)).ms);

      report({
        size: n,
        recipientsSequentialPagesMs: stats(seq),
        recipientsDeepPageMs: stats(deep),
        recipientsStatusFilterMs: stats(status),
        recipientsReasonFilterMs: stats(reason),
        recipientsReasonNoMatchMs: stats(reasonNone),
        analyticsMs: stats(analytics),
      });
    }, 4 * 3_600_000);
  }
});
