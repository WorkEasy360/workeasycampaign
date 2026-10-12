/**
 * Opt-in scale benchmark for milestone 6.9 (execution, TEST MODE): NOT part of the default suite.
 *   EXECUTION_BENCH=1 [EXECUTION_BENCH_SIZES=10000,100000] [EXECUTION_BENCH_OUT=file.jsonl] pnpm --filter @workeasy/api exec vitest run test/campaigns-execution-bench.test.ts
 *
 * Per size N: N contacts (80 % with valid granted consent, 20 % without), one list; send-now through HTTP; the real
 * engine with PRODUCTION page / batch sizes (1,000) runs start → capture → materialization (Checkpoint A) → delivery
 * (Checkpoint B + NullDeliveryPort) → completion. Measured from the persisted timestamps (started_at, captured_at,
 * materialized_at, completed_at); peak RSS sampled every 200 ms; PostgreSQL load as pg_stat_database deltas. A second
 * run of the same size injects one crash mid-materialization (job retry after 1 s) to measure retry overhead / resume.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { setFlagsFromString } from 'node:v8';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InlineJobDispatcher, JOB_DISPATCHER } from '../src/common/jobs.js';
import type { AppConfig } from '../src/config/env.js';
import type { AudienceResolutionRecovery } from '@workeasy/audience-core';
import { APP_CONFIG, AUDIENCE_RECOVERY } from '../src/infrastructure/providers.js';
import { CAMPAIGN_DELIVERY_PORT } from '../src/modules/campaigns/application/delivery.js';
import { ExecutionService } from '../src/modules/campaigns/application/execution.service.js';
import type { NullDeliveryPort } from '../src/modules/campaigns/infrastructure/null-delivery-port.js';
import { seedAudience } from './execution-support.js';
import { type Agent, createOrg, resetTestDatabase, signUp, startTestApp, type TestApp, withOwnerConnection } from './support.js';

const ENABLED = !!process.env.EXECUTION_BENCH;
// Opt-in (EXECUTION_BENCH_TRACE_GC=1): V8 prints every GC (kind, heap before → after) to stdout — NODE_OPTIONS refuses
// --trace-gc, so it is set here. Diagnostic only.
if (ENABLED && process.env.EXECUTION_BENCH_TRACE_GC) setFlagsFromString('--trace-gc');
const SIZES = (process.env.EXECUTION_BENCH_SIZES ?? '10000,100000').split(',').filter(Boolean).map(Number);
const report = (name: string, data: Record<string, unknown>) => {
  const line = `BENCH ${JSON.stringify({ name, at: new Date().toISOString(), ...data })}`;
  console.log(line);
  if (process.env.EXECUTION_BENCH_OUT) appendFileSync(process.env.EXECUTION_BENCH_OUT, `${line}\n`);
};
const mb = (b: number) => Math.round(b / 1_048_576);

describe.skipIf(!ENABLED)('execution scale benchmark (6.9)', () => {
  let t: TestApp;
  let owner: Agent;
  let svc: ExecutionService;
  let port: NullDeliveryPort;
  let dispatcher: InlineJobDispatcher;
  let secret: string;

  beforeAll(async () => {
    await resetTestDatabase();
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test' });
    svc = t.app.get(ExecutionService, { strict: false });
    port = t.app.get(CAMPAIGN_DELIVERY_PORT, { strict: false });
    dispatcher = t.app.get(JOB_DISPATCHER, { strict: false });
    secret = (t.app.get(APP_CONFIG, { strict: false }) as AppConfig).fingerprintSecret;
    owner = await signUp(t, undefined, 'Bench owner');
    // production sizes; only the retry backoff is shortened (1 s instead of 1 min) so a retried run fits the benchmark
    svc.configure({ pageSize: 1_000, deliveryBatch: 1_000, jobRetryDelaysMs: [1_000, 2_000, 4_000] });
  });
  afterAll(async () => t?.close());

  const pgStats = () =>
    withOwnerConnection(async (c) =>
      (await c.query(`SELECT xact_commit::bigint AS commits, blks_read::bigint AS blks_read, blks_hit::bigint AS blks_hit, tup_inserted::bigint AS inserted, tup_updated::bigint AS updated, temp_bytes::bigint AS temp_bytes FROM pg_stat_database WHERE datname = current_database()`)).rows[0] as Record<string, string>,
    );
  const delta = (a: Record<string, string>, b: Record<string, string>) => Object.fromEntries(Object.keys(a).map((k) => [k, Number(b[k]) - Number(a[k])]));

  async function runOnce(n: number, label: 'clean' | 'crash_mid_materialization') {
    const { orgId, workspaceId: W } = await createOrg(owner, `Exec bench ${n} ${label}`);
    const topicId = (await owner.get(`/v1/workspaces/${W}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id;
    const listId = (await owner.post(`/v1/workspaces/${W}/lists`, { name: `bench-${n}-${randomUUID().slice(0, 6)}` })).body.id as string;
    const eligible = Math.round(n * 0.8);
    const seedStart = performance.now();
    await seedAudience({ orgId, workspaceId: W, listId, n, eligible, secret, tag: `${label}-${n}` });
    const seedMs = Math.round(performance.now() - seedStart);
    const c = await owner.post(`/v1/workspaces/${W}/campaigns`, { name: 'Bench', channel: 'email', topicId });
    const p = await owner.patch(`/v1/workspaces/${W}/campaigns/${c.body.id}`, {
      expectedVersion: 1,
      audience: { include: [{ type: 'list', listId }], exclude: [] },
      sender: { senderIdentityId: null, fromName: 'Bench', replyTo: null },
      messages: [{ variantKey: 'default', content: { schema: 'email.content.v1', subject: 'Bench', preheader: '', body: { format: 'text', text: 'Bench' } } }],
    });
    expect(p.status).toBe(200);
    // Like a real client: if audience resolution is degraded (bulk-seeded data leaves the count bitmap invalid; at 1M the
    // exact query exceeds its 1 s budget), honour Retry-After until the automatic rebuild makes the estimate available.
    // Done BEFORE the measured section; the time to recovery is reported on its own.
    // Bulk-seeded data leaves the count bitmap INVALID (writes outside a tenant context, by design). In a deployment the
    // worker's count maintenance repairs it; this API-only harness does the same through the Audience-owned recovery port
    // (no production semantics changed), waits until the bitmap is VALID, then confirms with one pre-flight. Done BEFORE
    // the measured section; the time to recovery is reported on its own.
    const recoveryStart = performance.now();
    let preflightAttempts = 0;
    await (t.app.get(AUDIENCE_RECOVERY, { strict: false }) as AudienceResolutionRecovery).requestRecovery({ orgId, workspaceId: W });
    for (;;) {
      const state = (await withOwnerConnection((cl) => cl.query(`SELECT state FROM audience_count_state WHERE workspace_id = $1`, [W]))).rows[0]?.state;
      if (state === 'valid') break;
      if (performance.now() - recoveryStart > 3_600_000) throw new Error('audience resolution did not recover within 1 h (state ' + state + ')');
      await new Promise((r) => setTimeout(r, 2_000));
    }
    preflightAttempts++;
    const pf = await owner.post(`/v1/workspaces/${W}/campaigns/${c.body.id}/preflight`, {});
    expect(pf.status).toBe(200);
    expect(pf.body.readinessFindings.map((x: { code: string }) => x.code)).not.toContain('ELIGIBILITY_ESTIMATE_UNAVAILABLE');
    const audienceRecoveryMs = Math.round(performance.now() - recoveryStart);
    port.reset();
    port.trackCalls = false; // harness memory must not be counted as engine memory
    svc.testHooks = {};
    const timings: Record<string, number[]> = { capture: [], page: [], checkpointB: [], deliveryBatch: [] };
    // Heap attribution (6.13 investigation of the 500k peak): the phase of the most recent engine timing event, and the
    // peak heap seen while in it. Harness-only bookkeeping (constant size).
    let phase = 'start';
    const PHASE: Record<string, string> = { capture: 'capture', page: 'materialize', checkpointB: 'deliver', deliveryBatch: 'deliver' };
    const phasePeak: Record<string, number> = {};
    svc.onTiming = (kind, ms) => {
      timings[kind]!.push(ms);
      phase = PHASE[kind] ?? kind;
    };
    if (label === 'crash_mid_materialization') {
      let pages = 0;
      const crashAt = Math.max(1, Math.floor(n / 1_000 / 2));
      svc.testHooks.afterPage = () => {
        if (++pages === crashAt) throw new Error('simulated crash mid-materialization');
      };
    }
    global.gc?.();
    const rssBase = process.memoryUsage().rss;
    const heapBase = process.memoryUsage().heapUsed;
    let rssPeak = rssBase;
    let heapPeak = heapBase;
    const sampler = setInterval(() => {
      const m = process.memoryUsage();
      rssPeak = Math.max(rssPeak, m.rss);
      heapPeak = Math.max(heapPeak, m.heapUsed);
      phasePeak[phase] = Math.max(phasePeak[phase] ?? 0, m.heapUsed);
    }, 200);
    // Opt-in (EXECUTION_BENCH_LIVE_GC_MS): force a GC periodically DURING the run and record the largest LIVE heap —
    // separates retained memory (a leak would grow with N) from uncollected garbage (GC scheduling). Perturbs timings,
    // so durations of such runs are not reported as performance results.
    const liveEvery = Number(process.env.EXECUTION_BENCH_LIVE_GC_MS ?? 0);
    let liveMax = 0;
    const liveSampler = liveEvery && global.gc ? setInterval(() => {
      global.gc!();
      liveMax = Math.max(liveMax, process.memoryUsage().heapUsed);
    }, liveEvery) : null;
    // Opt-in (EXECUTION_BENCH_ALLOC_PROFILE=<file prefix>): V8 sampling heap profiler INCLUDING objects already collected,
    // i.e. where the run allocates (not only what it retains), attributed to the nearest engine frame. Perturbs timings,
    // so durations and peaks of such runs are not reported as results.
    const allocProfile = process.env.EXECUTION_BENCH_ALLOC_PROFILE;
    const inspector = allocProfile ? new Session() : null;
    // EXECUTION_BENCH_ALLOC_PHASE=materialize limits the profile to materialization (from the first page timing to the
    // first delivery timing); otherwise the whole run is profiled.
    const onlyPhase = process.env.EXECUTION_BENCH_ALLOC_PHASE;
    let profiling: Promise<unknown> | null = null;
    let stopped: Promise<{ profile: { head: AllocNode } }> | null = null;
    const startProfile = () => (profiling ??= inspector!.post('HeapProfiler.startSampling', { samplingInterval: 16_384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true }));
    const stopProfile = () => (stopped ??= (async () => { await profiling; return (await inspector!.post('HeapProfiler.stopSampling')) as { profile: { head: AllocNode } }; })());
    if (inspector) {
      inspector.connect();
      await inspector.post('HeapProfiler.enable');
      if (!onlyPhase) await startProfile();
      else {
        const timing = svc.onTiming!;
        svc.onTiming = (kind, ms) => {
          timing(kind, ms);
          if (PHASE[kind] === onlyPhase) void startProfile();
          else if (profiling && PHASE[kind] !== onlyPhase) void stopProfile();
        };
      }
    }
    const pg0 = await pgStats();
    const t0 = performance.now();
    const s = await owner.post(`/v1/workspaces/${W}/campaigns/${c.body.id}/schedule`, { mode: 'now', expectedVersion: p.body.version });
    const scheduleMs = Math.round(performance.now() - t0);
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    const ex = s.body.currentExecution.id as string;
    for (;;) {
      await dispatcher.idle();
      const st = (await withOwnerConnection((cl) => cl.query(`SELECT status FROM campaign_executions WHERE id = $1`, [ex]))).rows[0].status;
      if (st === 'completed' || st === 'failed') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const wallMs = Math.round(performance.now() - t0);
    if (inspector) {
      const { profile } = await stopProfile();
      inspector.disconnect();
      writeFileSync(`${allocProfile}.${n}.${label}.txt`, summarizeAllocations(profile.head));
    }
    clearInterval(sampler);
    if (liveSampler) clearInterval(liveSampler);
    svc.onTiming = null;
    port.reset(); // the TEST port keeps one acknowledgement per key by design; drop it before measuring retention
    global.gc?.();
    const heapAfterGc = process.memoryUsage().heapUsed;
    const pg1 = await pgStats();
    const e = (await withOwnerConnection((cl) => cl.query(`SELECT * FROM campaign_executions WHERE id = $1`, [ex]))).rows[0];
    const dups = Number((await withOwnerConnection((cl) => cl.query(`SELECT count(*) - count(DISTINCT contact_id) AS n FROM campaign_recipients WHERE execution_id = $1`, [ex]))).rows[0].n);
    expect(e.status).toBe('completed');
    expect([e.planned, e.sent, e.skipped, dups]).toEqual([eligible, eligible, n - eligible, 0]);
    const ms = (a: Date, b: Date) => new Date(b).getTime() - new Date(a).getTime();
    const capture = ms(e.started_at, e.captured_at);
    const materialize = ms(e.captured_at, e.materialized_at);
    const deliver = ms(e.materialized_at, e.completed_at);
    report('execution.run', {
      size: n,
      label,
      eligible,
      seedMs,
      scheduleHttpMs: scheduleMs,
      audienceRecoveryMs,
      preflightAttempts,
      startToT0Ms: capture, // started_at → captured_at (T0 = start of the capture statement); capture DURATION is timingsMs.capture
      materializeMs: materialize,
      materializeRecipientsPerSec: Math.round(n / (materialize / 1000)),
      deliverMs: deliver,
      deliverRecipientsPerSec: Math.round(eligible / (deliver / 1000)),
      startToCompleteMs: ms(e.started_at, e.completed_at),
      wallMs,
      rssBaseMB: mb(rssBase),
      rssPeakMB: mb(rssPeak),
      rssGrowthMB: mb(rssPeak - rssBase),
      heapGrowthMB: mb(heapPeak - heapBase),
      timingsMs: Object.fromEntries(Object.entries(timings).map(([k, v]) => {
        const xs = Float64Array.from(v).sort();
        const at = (p: number) => (xs.length ? Math.round(xs[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)]!) : null);
        return [k, { n: xs.length, p50: at(50), p95: at(95), max: xs.length ? Math.round(xs[xs.length - 1]!) : null }];
      })),
      heapBaseMB: mb(heapBase),
      heapPeakMB: mb(heapPeak),
      heapAfterGcMB: global.gc ? mb(heapAfterGc) : null,
      liveHeapMaxAboveBaseMB: liveSampler ? mb(liveMax - heapBase) : null,
      heapPeakByPhaseMB: Object.fromEntries(Object.entries(phasePeak).map(([k, v]) => [k, mb(v - heapBase)])),
      pg: delta(pg0, pg1),
      duplicates: dups,
      counts: { planned: e.planned, skipped: e.skipped, sent: e.sent },
    });
    return { startToComplete: ms(e.started_at, e.completed_at), materialize };
  }

  for (const n of SIZES) {
    it(`${n.toLocaleString('en')} recipients: clean run, then a run with one crash mid-materialization`, async () => {
      const clean = await runOnce(n, 'clean');
      const crashed = await runOnce(n, 'crash_mid_materialization');
      report('execution.retry_overhead', {
        size: n,
        cleanStartToCompleteMs: clean.startToComplete,
        crashedStartToCompleteMs: crashed.startToComplete,
        overheadMs: crashed.startToComplete - clean.startToComplete,
        note: 'includes the 1 s job-retry backoff; resume continues from the committed cursor',
      });
    }, 4 * 3_600_000);
  }
});

type AllocNode = { callFrame: { functionName: string; url: string; lineNumber: number }; selfSize: number; children: AllocNode[] };
/** Bytes allocated per leaf frame and per nearest repository frame (apps/ or packages/ source, not node_modules). */
function summarizeAllocations(head: AllocNode): string {
  const leaf = new Map<string, number>();
  const app = new Map<string, number>();
  let total = 0;
  const name = (n: AllocNode) => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.replace(/^.*Workeasy-Campaign[\/]/, '')}:${n.callFrame.lineNumber + 1}`;
  const isApp = (n: AllocNode) => /Workeasy-Campaign[\/](apps|packages)[\/][^\/]+[\/](src|dist)[\/]/.test(n.callFrame.url) && !n.callFrame.url.includes('node_modules');
  const walk = (n: AllocNode, nearestApp: string) => {
    const here = isApp(n) ? name(n) : nearestApp;
    if (n.selfSize) {
      total += n.selfSize;
      leaf.set(name(n), (leaf.get(name(n)) ?? 0) + n.selfSize);
      app.set(here, (app.get(here) ?? 0) + n.selfSize);
    }
    for (const c of n.children) walk(c, here);
  };
  walk(head, '(outside the repository)');
  const top = (m: Map<string, number>) =>
    [...m]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([k, v]) => `${(v / 1_048_576).toFixed(1).padStart(9)} MB  ${((100 * v) / total).toFixed(1).padStart(5)} %  ${k}`)
      .join('\n');
  return [`total sampled allocation ${(total / 1_048_576).toFixed(0)} MB`, '', '== by nearest repository frame', top(app), '', '== by allocating frame', top(leaf), ''].join('\n');
}
