import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetTestDatabase, testDatabaseUrls, withAppConnection, withOwnerConnection } from '../src/testing.js';

/**
 * Durable job queue (Phase 7.6; docs/architecture/durable-job-queue.md §4) at the database level, as the runtime role:
 * tenancy and access, the job lifecycle (claim, complete, retry with run_after, dead letters), disjoint concurrent
 * claims, lease expiry and heartbeats, deduplication, retention and stats.
 */
const org = randomUUID();
const ws = randomUUID();
const otherOrg = randomUUID();
let sys: pg.Client;
const N = 'test.job';

const payload = (o = org, w: string | null = ws, extra: Record<string, unknown> = {}) => ({ tenant: { orgId: o, workspaceId: w }, actor: { type: 'system', id: null }, correlationId: randomUUID(), payload: { n: 1, ...extra } });
const enqueue = (opts: { payload?: unknown; name?: string; runAfter?: string | null; maxAttempts?: number | null; dedupe?: string | null } = {}) =>
  withAppConnection({ orgId: org, workspaceId: ws }, async (c) => {
    const r = await c.query(`SELECT app.enqueue_job($1, $2::jsonb, $3::timestamptz, $4::int, $5) AS id`, [opts.name ?? N, JSON.stringify(opts.payload ?? payload()), opts.runAfter ?? null, opts.maxAttempts ?? null, opts.dedupe ?? null]);
    await c.query('COMMIT');
    return r.rows[0].id as string | null;
  });
const claim = async (worker: string, limit = 10, lease = 30, client = sys) => (await client.query(`SELECT * FROM app.claim_jobs($1, $2::text[], $3, $4)`, [worker, [N], limit, lease])).rows as { id: string; attempts: number; payload: any }[];
const row = async (id: string) => (await withOwnerConnection((c) => c.query(`SELECT * FROM job_queue WHERE id = $1`, [id]))).rows[0];

beforeAll(async () => {
  await resetTestDatabase();
  await withOwnerConnection(async (c) => {
    const user = randomUUID();
    await c.query(`INSERT INTO users (id, email, email_normalized, display_name) VALUES ($1, 'j@x.test', 'j@x.test', 'J')`, [user]);
    for (const [o, slug] of [[org, 'jq'], [otherOrg, 'jq2']] as const) await c.query(`INSERT INTO organizations (id, name, slug, created_by_user_id) VALUES ($1, 'q', $2, $3)`, [o, slug, user]);
    await c.query(`INSERT INTO workspaces (id, org_id, name, slug) VALUES ($1::uuid, $2, 'w', 'w')`, [ws, org]);
  });
  // A runtime-role connection WITHOUT tenant context: what a job runner uses.
  sys = new pg.Client({ connectionString: testDatabaseUrls().app });
  await sys.connect();
});
afterAll(async () => sys?.end());

describe('job queue: tenancy and access', () => {
  it('the runtime role cannot touch job_queue directly; only the functions work', async () => {
    await enqueue();
    for (const sql of [`SELECT * FROM job_queue`, `UPDATE job_queue SET status = 'done'`, `DELETE FROM job_queue`, `INSERT INTO job_queue (name, org_id, payload) VALUES ('x', gen_random_uuid(), '{}')`]) {
      await expect(sys.query(sql)).rejects.toThrow(/permission denied/);
    }
  });

  it('enqueue takes the tenant from the session; a payload for another tenant, or no tenant context, is refused', async () => {
    const id = await enqueue();
    expect(await row(id!)).toMatchObject({ org_id: org, workspace_id: ws, status: 'queued', attempts: 0 });
    await expect(enqueue({ payload: payload(otherOrg) })).rejects.toThrow(/does not match the session tenant/);
    await expect(enqueue({ payload: payload(org, randomUUID()) })).rejects.toThrow(/does not match the session tenant/);
    await expect(sys.query(`SELECT app.enqueue_job($1, $2::jsonb, null, null, null)`, [N, JSON.stringify(payload())])).rejects.toThrow(/no tenant context/);
  });
});

describe('job queue: lifecycle', () => {
  beforeAll(async () => withOwnerConnection((c) => c.query(`DELETE FROM job_queue`)));

  it('claim → running (attempt counted) → complete; only the lease holder can complete', async () => {
    const id = (await enqueue())!;
    const [j] = await claim('w1', 1);
    expect(j).toMatchObject({ id, attempts: 1 });
    expect(j!.payload.tenant).toEqual({ orgId: org, workspaceId: ws });
    expect((await sys.query(`SELECT app.complete_job($1, 'intruder') AS ok`, [id])).rows[0].ok).toBe(false);
    expect((await sys.query(`SELECT app.complete_job($1, 'w1') AS ok`, [id])).rows[0].ok).toBe(true);
    expect(await row(id)).toMatchObject({ status: 'done', lease_owner: null });
    expect(await claim('w1')).toEqual([]);
  });

  it('a delayed job is not claimable before run_after', async () => {
    const id = (await enqueue({ runAfter: new Date(Date.now() + 60_000).toISOString() }))!;
    expect((await claim('w1')).map((x) => x.id)).not.toContain(id);
    await withOwnerConnection((c) => c.query(`UPDATE job_queue SET run_after = now() - interval '1 second' WHERE id = $1`, [id]));
    expect((await claim('w1')).map((x) => x.id)).toContain(id);
    await sys.query(`SELECT app.complete_job($1, 'w1')`, [id]);
  });

  it('fail → retried after the back-off; out of attempts → dead letter; permanent → dead at once', async () => {
    const id = (await enqueue({ maxAttempts: 2 }))!;
    await claim('w1');
    expect((await sys.query(`SELECT app.fail_job($1, 'w1', 'BOOM', 30, false) AS s`, [id])).rows[0].s).toBe('queued');
    const r = await row(id);
    expect(r.status).toBe('queued');
    expect(r.last_error).toBe('BOOM');
    expect(new Date(r.run_after).getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(await claim('w1')).toEqual([]); // back-off honoured
    await withOwnerConnection((c) => c.query(`UPDATE job_queue SET run_after = now() WHERE id = $1`, [id]));
    expect((await claim('w1'))[0]).toMatchObject({ id, attempts: 2 });
    expect((await sys.query(`SELECT app.fail_job($1, 'w1', 'BOOM', 30, false) AS s`, [id])).rows[0].s).toBe('dead');
    expect(await row(id)).toMatchObject({ status: 'dead', attempts: 2 });

    const p = (await enqueue())!;
    await claim('w1');
    expect((await sys.query(`SELECT app.fail_job($1, 'w1', 'INVALID_ENVELOPE', 30, true) AS s`, [p])).rows[0].s).toBe('dead');
  });

  it('two runners claiming at once never get the same job', async () => {
    await withOwnerConnection((c) => c.query(`DELETE FROM job_queue`));
    for (let i = 0; i < 40; i++) await enqueue();
    const other = new pg.Client({ connectionString: testDatabaseUrls().app });
    await other.connect();
    try {
      const rounds = await Promise.all([claim('a', 10, 30, sys), claim('b', 10, 30, other), claim('a', 10, 30, sys), claim('b', 10, 30, other)]);
      const ids = rounds.flat().map((x) => x.id);
      expect(ids.length).toBe(40);
      expect(new Set(ids).size).toBe(40);
    } finally {
      await other.end();
    }
  });

  it('a crashed runner’s job is reclaimed after its lease expires; a heartbeat keeps a live lease; the old holder loses it', async () => {
    await withOwnerConnection((c) => c.query(`DELETE FROM job_queue`));
    const id = (await enqueue())!;
    await claim('crashed', 1, 5);
    expect(await claim('rescuer')).toEqual([]); // lease still live
    expect((await sys.query(`SELECT app.extend_job_lease($1, 'crashed', 30) AS ok`, [id])).rows[0].ok).toBe(true);
    await withOwnerConnection((c) => c.query(`UPDATE job_queue SET lease_until = now() - interval '1 second' WHERE id = $1`, [id])); // it stopped beating
    const [j] = await claim('rescuer');
    expect(j).toMatchObject({ id, attempts: 2 });
    expect((await sys.query(`SELECT app.extend_job_lease($1, 'crashed', 30) AS ok`, [id])).rows[0].ok).toBe(false);
    expect((await sys.query(`SELECT app.complete_job($1, 'crashed') AS ok`, [id])).rows[0].ok).toBe(false);
    expect((await sys.query(`SELECT app.complete_job($1, 'rescuer') AS ok`, [id])).rows[0].ok).toBe(true);
  });

  it('dedupe: one queued/running job per key; the key is free again once it finished', async () => {
    const first = await enqueue({ dedupe: 'exec-1:start' });
    expect(first).toBeTruthy();
    expect(await enqueue({ dedupe: 'exec-1:start' })).toBeNull();
    await claim('w1');
    expect(await enqueue({ dedupe: 'exec-1:start' })).toBeNull(); // still running
    await sys.query(`SELECT app.complete_job($1, 'w1')`, [first]);
    expect(await enqueue({ dedupe: 'exec-1:start' })).toBeTruthy();
  });

  it('stats report depth and the oldest due age; purge removes finished jobs only', async () => {
    await withOwnerConnection((c) => c.query(`DELETE FROM job_queue`));
    const a = (await enqueue())!;
    await enqueue();
    await withOwnerConnection((c) => c.query(`UPDATE job_queue SET run_after = now() - interval '90 seconds' WHERE id = $1`, [a]));
    const stats = (await sys.query(`SELECT * FROM app.job_queue_stats()`)).rows;
    const queued = stats.find((s) => s.status === 'queued')!;
    expect(Number(queued.jobs)).toBe(2);
    expect(queued.oldest_due_seconds).toBeGreaterThanOrEqual(89);
    const [j] = await claim('w1', 1);
    await sys.query(`SELECT app.complete_job($1, 'w1')`, [j!.id]);
    await withOwnerConnection((c) => c.query(`UPDATE job_queue SET finished_at = now() - interval '10 days' WHERE id = $1`, [j!.id]));
    expect((await sys.query(`SELECT app.purge_jobs(now() - interval '7 days', 100) AS n`)).rows[0].n).toBe(1);
    expect((await withOwnerConnection((c) => c.query(`SELECT count(*)::int AS n FROM job_queue`))).rows[0].n).toBe(1); // the queued one stays
  });
});
