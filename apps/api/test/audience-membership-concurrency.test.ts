import { withAppConnection } from '@workeasy/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTenantRetrying, isRetryableConflict } from '../src/modules/tenancy/application/tenant-tx.js';
import { type Agent, createOrg, resetTestDatabase, signUp, startTestApp, type TestApp, withOwnerConnection } from './support.js';

/**
 * C1 — membership concurrency hardening (docs/audit/phase-6.3-g2-closure.md): concurrent multi-row membership inserts
 * with overlapping contacts deadlocked on the list_memberships unique index when each statement listed the contacts in
 * a different order. Membership writes now insert in ascending contact-id order, and the membership units of work
 * re-run after a deadlock or serialization failure.
 */
const shuffle = <T,>(xs: T[], seed: number) => {
  const a = [...xs];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
};

describe('membership write concurrency (C1)', () => {
  let t: TestApp;
  let owner: Agent;
  let orgId: string;
  let W: string;
  let ids: string[] = [];
  const url = (p: string) => `/v1/workspaces/${W}${p}`;
  const deadlocks = () =>
    withOwnerConnection(async (c) => Number((await c.query(`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`)).rows[0].deadlocks));
  const members = (listId: string) =>
    withOwnerConnection(async (c) => (await c.query(`SELECT count(*)::int n FROM list_memberships WHERE list_id = $1`, [listId])).rows[0].n as number);

  beforeAll(async () => {
    await resetTestDatabase();
    t = await startTestApp();
    owner = await signUp(t, undefined, 'Concurrency');
    ({ orgId, workspaceId: W } = await createOrg(owner, 'Concurrency Co'));
    ids = await withOwnerConnection(async (c) =>
      (await c.query(`INSERT INTO contacts (id, org_id, workspace_id, subscription_type, source) SELECT gen_random_uuid(), $1, $2, 'marketing', 'manual'
                      FROM generate_series(1, 3000) RETURNING id::text`, [orgId, W])).rows.map((r: { id: string }) => r.id),
    );
  });
  afterAll(async () => t?.close());

  it('control: unordered overlapping multi-row inserts deadlock; ascending order does not (runtime role, SQL level)', { timeout: 120_000 }, async () => {
    const run = async (sorted: boolean) => {
      const listId = (await owner.post(url('/lists'), { name: `ctl-${sorted}`, description: '' })).body.id as string;
      const before = await deadlocks();
      let errors = 0;
      await Promise.all(
        Array.from({ length: 8 }, async (_, k) => {
          for (let round = 0; round < 5; round++) {
            const batch = shuffle(ids.slice(0, 1500), k * 31 + round);
            // one transaction per insert as the runtime role (rolled back afterwards: deadlocks happen at insert time)
            await withAppConnection({ orgId, workspaceId: W }, (c) =>
              c.query(
                `INSERT INTO list_memberships (org_id, workspace_id, list_id, contact_id) SELECT $1, $2, $3, unnest($4::uuid[]) ON CONFLICT DO NOTHING`,
                [orgId, W, listId, sorted ? [...batch].sort() : batch],
              ),
            ).catch(() => errors++);
          }
        }),
      );
      return { deadlocks: (await deadlocks()) - before, errors };
    };
    const unsorted = await run(false);
    const sorted = await run(true);
    console.log(JSON.stringify({ c1Control: { unsorted, sorted } }));
    expect(sorted).toEqual({ deadlocks: 0, errors: 0 });
  });

  it('concurrent API membership writes with overlapping, differently ordered contacts: no failures, no deadlocks', { timeout: 300_000 }, async () => {
    const listId = (await owner.post(url('/lists'), { name: 'concurrent', description: '' })).body.id as string;
    expect((await owner.post(url(`/lists/${listId}/members`), { contactIds: ids.slice(2700, 3000) })).status).toBe(200);
    const before = await deadlocks();
    const statuses: number[] = [];
    // 12 × add 1,000 (overlapping windows, each shuffled) + 4 bulk adds + 4 removes, all at once
    await Promise.all([
      ...Array.from({ length: 12 }, async (_, k) => {
        const r = await owner.post(url(`/lists/${listId}/members`), { contactIds: shuffle(ids.slice(k * 150, k * 150 + 1000), k + 1) });
        statuses.push(r.status);
      }),
      ...Array.from({ length: 4 }, async (_, k) => {
        const r = await owner.post(url('/contacts/bulk'), { action: 'add_to_list', listId, selection: { contactIds: shuffle(ids.slice(500 + k * 200, 1500 + k * 200), 100 + k) } });
        statuses.push(r.status);
      }),
      ...Array.from({ length: 4 }, async (_, k) => {
        const r = await owner.delete(url(`/lists/${listId}/members`), { contactIds: shuffle(ids.slice(2700 + k * 75, 2775 + k * 75), 200 + k) });
        statuses.push(r.status);
      }),
    ]);
    const occurred = (await deadlocks()) - before;
    console.log(JSON.stringify({ c1Api: { requests: statuses.length, statuses: [...new Set(statuses)], deadlocks: occurred } }));
    expect(statuses.every((s) => s === 200)).toBe(true);
    expect(occurred).toBe(0);
    // adds cover ids[0, 2650) (12 windows) ∪ [500, 2100) (bulk); the pre-added ids[2700, 3000) were all removed
    expect(await members(listId)).toBe(2650);
  });

  it('retry helper: recognises deadlocks/serialization failures and re-runs the unit of work', async () => {
    expect(isRetryableConflict({ code: '40P01' })).toBe(true);
    expect(isRetryableConflict({ code: 'P2034' })).toBe(true);
    expect(isRetryableConflict({ message: 'wrapped', cause: { code: '40001' } })).toBe(true);
    expect(isRetryableConflict({ code: 'P2002' })).toBe(false);
    expect(isRetryableConflict(new Error('deadlock detected'))).toBe(true);
    let calls = 0;
    const fakeDb = { withTenant: async (_c: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({}) } as never;
    const ctx = { access: { orgId, workspaceId: W }, principal: { userId: null }, meta: { requestId: 'r' } } as never;
    const r = await inTenantRetrying(fakeDb, ctx, async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
      return 'ok';
    });
    expect([r, calls]).toEqual(['ok', 3]);
    calls = 0;
    await expect(inTenantRetrying(fakeDb, ctx, async () => {
      calls++;
      throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
    })).rejects.toThrow('deadlock');
    expect(calls).toBe(3);
  });
});
