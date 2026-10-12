import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseUrls } from '../src/testing.js';

/**
 * Sending-rate token buckets (Phase 7.11; campaign amendment §R) at the database level, as the runtime role: access only
 * through the functions; grants never exceed what every bucket holds; refill at the rate up to the burst; the wait hint;
 * refunds capped at the burst; concurrent takers never get more than the bucket held; invalid arguments refused.
 */
let sys: pg.Client;
const scope = (kind: 'provider' | 'workspace' | 'execution') => `${kind}:${randomUUID()}`;
const take = async (scopes: string[], rates: number[], bursts: number[], wanted: number, client = sys) =>
  (await client.query(`SELECT granted, wait_ms FROM app.take_send_tokens($1::text[], $2::float8[], $3::float8[], $4::int)`, [scopes, rates, bursts, wanted])).rows[0] as { granted: number; wait_ms: number };
const refund = (scopes: string[], bursts: number[], n: number) => sys.query(`SELECT app.refund_send_tokens($1::text[], $2::float8[], $3::int)`, [scopes, bursts, n]);

beforeAll(async () => {
  sys = new pg.Client({ connectionString: testDatabaseUrls().app });
  await sys.connect();
});
afterAll(async () => sys?.end());

describe('send-rate buckets', () => {
  it('the runtime role cannot touch the buckets directly', async () => {
    for (const sql of [`SELECT * FROM send_rate_buckets`, `UPDATE send_rate_buckets SET tokens = 1e9`, `DELETE FROM send_rate_buckets`, `INSERT INTO send_rate_buckets (scope, tokens) VALUES ('provider:x', 1e9)`]) {
      await expect(sys.query(sql)).rejects.toThrow(/permission denied/);
    }
  });

  it('a new bucket starts full; the grant is the burst at most, then the wait says when the next token comes', async () => {
    const s = scope('execution');
    expect(await take([s], [1], [10], 25)).toEqual({ granted: 10, wait_ms: expect.any(Number) });
    const empty = await take([s], [1], [10], 5);
    expect(empty.granted).toBe(0);
    expect(empty.wait_ms).toBeGreaterThan(800);
    expect(empty.wait_ms).toBeLessThanOrEqual(1000);
  });

  it('several scopes: the same grant from each, limited by the emptiest', async () => {
    const p = scope('provider');
    const w = scope('workspace');
    expect((await take([p], [100], [100], 95)).granted).toBe(95); // the provider bucket has ~5 left
    const r = await take([p, w], [100, 50], [100, 50], 40);
    expect(r.granted).toBeGreaterThanOrEqual(5);
    expect(r.granted).toBeLessThan(10);
    // The workspace bucket lost exactly what was granted: ~50 - granted remain.
    const left = await take([w], [50], [50], 50);
    expect(left.granted).toBeGreaterThanOrEqual(50 - r.granted - 1);
    expect(left.granted).toBeLessThanOrEqual(50 - r.granted + 1);
  });

  it('refills at the rate, never above the burst; refunds are capped at the burst too', async () => {
    const s = scope('workspace');
    expect((await take([s], [20], [20], 20)).granted).toBe(20);
    await new Promise((r) => setTimeout(r, 300));
    const after = await take([s], [20], [20], 20);
    expect(after.granted).toBeGreaterThanOrEqual(5);
    expect(after.granted).toBeLessThanOrEqual(7);
    await refund([s], [20], 1000);
    expect((await take([s], [20], [20], 100)).granted).toBe(20);
  });

  it('concurrent takers share the bucket: the total granted never exceeds what it held', async () => {
    const s = scope('provider');
    const clients = await Promise.all(Array.from({ length: 8 }, async () => {
      const c = new pg.Client({ connectionString: testDatabaseUrls().app });
      await c.connect();
      return c;
    }));
    try {
      const grants = await Promise.all(clients.map((c) => take([s], [0.001], [50], 20, c)));
      expect(grants.reduce((a, g) => a + g.granted, 0)).toBe(50);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });

  it('refuses invalid arguments', async () => {
    const s = scope('execution');
    for (const [scopes, rates, bursts, wanted] of [
      [[s], [0], [1], 1],
      [[s], [1], [0], 1],
      [[s], [1], [1], 0],
      [[s], [1], [1], 10_001],
      [[s, scope('workspace')], [1], [1, 1], 1],
      [[], [], [], 1],
    ] as const) {
      await expect(take([...scopes], [...rates], [...bursts], wanted)).rejects.toThrow(/take_send_tokens/);
    }
    await expect(take(['tenant:x'], [1], [1], 1)).rejects.toThrow(/send_rate_buckets_scope_chk/);
  });
});
