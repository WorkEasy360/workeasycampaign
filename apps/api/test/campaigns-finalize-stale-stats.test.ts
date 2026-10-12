/**
 * Regression (6.13 lifecycle-at-scale benchmark): finalize after cancel must not depend on planner statistics.
 *
 * The finalize claim was `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`. Right after a bulk load — before
 * autoanalyze, `reltuples = -1` — the planner chose a nested-loop semi join that re-ran the locking subquery once per
 * row of the workspace (MEASURED at 100k: the first chunk hit the 15 s statement timeout, finalize never completed and
 * 64,000 recipients stayed open). Finalize now claims with one SELECT … FOR UPDATE SKIP LOCKED and updates by id.
 *
 * Deterministic setup: this file truncates the tables (`reltuples = -1`) and keeps autovacuum off for
 * campaign_recipients while it runs (files run one at a time; restored in afterAll), so the statistics are stale when
 * finalize runs — asserted as a precondition. Measured without wall-clock thresholds: index tuples read through the
 * claim index (execution_id, status, id) over the whole execution are O(recipients) — the re-running plan reads
 * O(recipients × chunk size).
 */
import { randomUUID } from 'node:crypto';
import type { AudienceResolutionRecovery } from '@workeasy/audience-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InlineJobDispatcher, JOB_DISPATCHER } from '../src/common/jobs.js';
import { AUDIENCE_RECOVERY } from '../src/infrastructure/providers.js';
import { ExecutionService } from '../src/modules/campaigns/application/execution.service.js';
import { seedAudience } from './execution-support.js';
import { type Agent, createOrg, resetTestDatabase, signUp, startTestApp, type TestApp, withOwnerConnection } from './support.js';

const N = 5_000;
const CLAIM_INDEX = 'campaign_recipients_execution_id_status_id_idx';

describe('finalize after cancel with stale planner statistics', () => {
  let t: TestApp;
  let owner: Agent;
  let dispatcher: InlineJobDispatcher;
  let svc: ExecutionService;
  const secret = 'finalize-fingerprint-secret-finalize-fp';
  const q = <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => withOwnerConnection(async (c) => (await c.query(sql, args)).rows as T[]);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const idle = async () => {
    for (let i = 0; i < 400; i++) {
      await dispatcher.idle();
      await sleep(25);
      if (!(dispatcher as unknown as { running: Set<unknown> }).running.size) return;
    }
  };
  /**
   * Cumulative statistics are flushed by each backend asynchronously (at most ~10 s after it goes idle): read until the
   * counter has not moved for 11 s.
   */
  const claimIndexReads = async () => {
    const read = async () => Number((await q<{ n: string }>(`SELECT idx_tup_read AS n FROM pg_stat_user_indexes WHERE indexrelname = $1`, [CLAIM_INDEX]))[0]!.n);
    let last = await read();
    let stableSince = Date.now();
    while (Date.now() - stableSince < 11_000) {
      await sleep(1_000);
      const now = await read();
      if (now !== last) {
        last = now;
        stableSince = Date.now();
      }
    }
    return last;
  };

  beforeAll(async () => {
    await resetTestDatabase(); // TRUNCATE: campaign_recipients has reltuples = -1 until analyzed
    await q(`ALTER TABLE campaign_recipients SET (autovacuum_enabled = false)`);
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test', DATA_FINGERPRINT_SECRET: secret });
    dispatcher = t.app.get(JOB_DISPATCHER);
    svc = t.app.get(ExecutionService);
    owner = await signUp(t, undefined, 'Finalize');
  });
  afterAll(async () => {
    svc.testHooks.beforeCheckpointB = undefined;
    await q(`ALTER TABLE campaign_recipients RESET (autovacuum_enabled)`);
    await t?.close();
  });

  it(`cancel at the first delivery batch of ${N.toLocaleString('en')} recipients: finalize completes with O(recipients) claim reads`, async () => {
    const { orgId, workspaceId: W } = await createOrg(owner, 'Finalize stale stats');
    const C = (p = '') => `/v1/workspaces/${W}/campaigns${p}`;
    const topicId = (await owner.get(`/v1/workspaces/${W}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id;
    const listId = (await owner.post(`/v1/workspaces/${W}/lists`, { name: `fs-${randomUUID().slice(0, 6)}` })).body.id as string;
    await seedAudience({ orgId, workspaceId: W, listId, n: N, eligible: N, secret });
    const c = await owner.post(C(), { name: 'Finalize', channel: 'email', topicId });
    const p = await owner.patch(C(`/${c.body.id}`), {
      expectedVersion: 1,
      audience: { include: [{ type: 'list', listId }], exclude: [] },
      sender: { senderIdentityId: null, fromName: 'Finalize', replyTo: null },
      messages: [{ variantKey: 'default', content: { schema: 'email.content.v1', subject: 'S', preheader: '', body: { format: 'text', text: 'B' } } }],
    });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    // Bulk seeding leaves the audience bitmap invalid; repair it through the Audience port, as the worker would.
    await (t.app.get(AUDIENCE_RECOVERY, { strict: false }) as AudienceResolutionRecovery).requestRecovery({ orgId, workspaceId: W });
    for (let i = 0; (await q<{ state: string }>(`SELECT state FROM audience_count_state WHERE workspace_id = $1`, [W]))[0]?.state !== 'valid'; i++) {
      if (i > 300) throw new Error('audience bitmap not valid');
      await sleep(200);
    }

    // Cancel while the first claimed batch is between claim and hand-off: every other recipient is still pending.
    let cancelStatus = 0;
    let statsAtCancel: { reltuples: number } | undefined;
    svc.testHooks.beforeCheckpointB = async () => {
      if (cancelStatus) return;
      statsAtCancel = (await q<{ reltuples: number }>(`SELECT reltuples::float8 AS reltuples FROM pg_class WHERE relname = 'campaign_recipients'`))[0];
      const version = (await owner.get(C(`/${c.body.id}`))).body.version as number;
      cancelStatus = (await owner.post(C(`/${c.body.id}/cancel`), { expectedVersion: version })).status;
    };
    const baseline = await claimIndexReads();
    const s = await owner.post(C(`/${c.body.id}/schedule`), { mode: 'now', expectedVersion: p.body.version });
    expect(s.status, JSON.stringify(s.body).slice(0, 300)).toBe(200);
    const ex = s.body.currentExecution.id as string;
    await idle();

    expect(cancelStatus).toBe(200);
    expect(statsAtCancel?.reltuples, 'precondition: planner statistics are stale when finalize runs').toBe(-1);
    const e = (await q<{ status: string; sent: number; cancelled: number; planned: number }>(`SELECT status, sent, cancelled, planned FROM campaign_executions WHERE id = $1`, [ex]))[0]!;
    const by = Object.fromEntries(
      (await q<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM campaign_recipients WHERE execution_id = $1 GROUP BY status`, [ex])).map((r) => [r.status, r.n]),
    ) as Record<string, number>;
    expect(e.status).toBe('cancelled');
    expect((by.pending ?? 0) + (by.queued ?? 0) + (by.sending ?? 0), JSON.stringify(by)).toBe(0);
    expect(by.cancelled).toBe(N); // nothing was handed off: cancelled before the first Checkpoint B
    expect(e.cancelled).toBe(N);
    expect(e.sent).toBe(0);

    // Re-running the locking subquery per row reads ~N × 1,000 index tuples per chunk (tens of millions here);
    // claim-then-update reads each recipient a handful of times over materialization, delivery and finalize.
    const reads = (await claimIndexReads()) - baseline;
    expect(reads, `index tuples read through ${CLAIM_INDEX}`).toBeLessThan(20 * N);
  }, 180_000);
});
