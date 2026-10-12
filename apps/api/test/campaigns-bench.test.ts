import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Agent, createOrg, resetTestDatabase, signUp, startTestApp, type TestApp, withOwnerConnection } from './support.js';

/**
 * Opt-in latency measurement of the campaign draft API (milestone 6.6), through the real HTTP stack with RLS:
 *   CAMPAIGN_BENCH=1 pnpm --filter @workeasy/api exec vitest run test/campaigns-bench.test.ts
 * A workspace with CAMPAIGN_BENCH_SIZE campaigns (default 5,000) plus a noise workspace of the same size.
 */
const SIZE = Number(process.env.CAMPAIGN_BENCH_SIZE ?? 5_000);
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)]!;
const stats = (xs: number[]) => ({ n: xs.length, p50: +pct(xs, 50).toFixed(1), p95: +pct(xs, 95).toFixed(1), max: +Math.max(...xs).toFixed(1) });

describe.skipIf(!process.env.CAMPAIGN_BENCH)('campaign draft API latency', () => {
  let t: TestApp;
  let owner: Agent;
  let W: string;
  const ids: string[] = [];

  beforeAll(async () => {
    await resetTestDatabase();
    t = await startTestApp();
    owner = await signUp(t, undefined, 'Bench');
    ({ workspaceId: W } = await createOrg(owner, 'Bench Co'));
    const noise = await signUp(t, undefined, 'Noise');
    const { workspaceId: N } = await createOrg(noise, 'Noise Co');
    await withOwnerConnection(async (c) => {
      for (const ws of [W, N]) {
        const r = await c.query(
          `INSERT INTO campaigns (id, org_id, workspace_id, name, channel, status, updated_at)
           SELECT gen_random_uuid(), w.org_id, w.id, 'Campaign ' || g, 'email',
                  (ARRAY['draft','draft','draft','completed','cancelled'])[1 + g % 5], now() - (g || ' minutes')::interval
           FROM workspaces w, generate_series(1, $2::int) g WHERE w.id = $1 RETURNING id::text, status`,
          [ws, SIZE],
        );
        if (ws === W) ids.push(...r.rows.filter((x: { status: string }) => x.status === 'draft').map((x: { id: string }) => x.id)); // editable ones
      }
      await c.query(`ANALYZE campaigns`);
    });
  }, 600_000);
  afterAll(async () => t?.close());

  it('list, get, counts, search, patch', { timeout: 600_000 }, async () => {
    const measure = async (n: number, fn: (i: number) => Promise<{ status: number }>) => {
      const times: number[] = [];
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        const r = await fn(i);
        times.push(performance.now() - t0);
        expect(r.status).toBeLessThan(300);
      }
      return stats(times.slice(3));
    };
    const url = (p = '') => `/v1/workspaces/${W}/campaigns${p}`;
    const results = {
      size: SIZE,
      listFirstPage25: await measure(53, () => owner.get(url('?limit=25'))),
      listFirstPage100: await measure(53, () => owner.get(url('?limit=100'))),
      listStatusFilter: await measure(53, () => owner.get(url('?status=completed&limit=25'))),
      listDeepCursor: await measure(23, async () => {
        let r = await owner.get(url('?limit=100'));
        for (let k = 0; k < 5; k++) r = await owner.get(url(`?limit=100&cursor=${r.body.nextCursor}`));
        return r;
      }),
      search: await measure(53, () => owner.get(url('?q=Campaign 42&limit=25'))),
      counts: await measure(53, () => owner.get(url('/counts'))),
      get: await measure(103, (i) => owner.get(url(`/${ids[i % ids.length]}`))),
      patch: await measure(103, async (i) => {
        const id = ids[i]!;
        return owner.patch(url(`/${id}`), { expectedVersion: 1, name: `Renamed ${randomUUID().slice(0, 8)}` });
      }),
    };
    console.log(`BENCH ${JSON.stringify(results)}`);
  });
});
