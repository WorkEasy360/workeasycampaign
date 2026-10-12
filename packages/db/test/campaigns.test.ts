/**
 * Phase 6.5 — the campaign tables as the database enforces them (migration 20261014000000_campaigns;
 * docs/contracts/phase-6-campaign.md §12). Exercised as the real roles: the schema owner for setup, workeasy_app
 * (RLS, grants) for everything the runtime can do. Behaviour of the API is tested in apps/api.
 */
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetTestDatabase, testDatabaseUrls, withAppConnection, withOwnerConnection } from '../src/testing.js';

const id = () => randomUUID();
const ids = { user: id(), orgA: id(), orgB: id(), wsA: id(), wsB: id(), topicA: id(), topicB: id(), contactA: id(), contactB: id() };
const A = { orgId: ids.orgA, workspaceId: ids.wsA };
const B = { orgId: ids.orgB, workspaceId: ids.wsB };
const TABLES = ['campaigns', 'campaign_versions', 'campaign_executions', 'campaign_recipients'];
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string; message?: string }) => e.code ?? e.message ?? 'error');
const owner = <T>(fn: (c: pg.Client) => Promise<T>) => withOwnerConnection(fn);

const snapshot = (topicId: string) => ({ schema: 'campaign.version.v1', channel: 'email', topic: { topicIds: [topicId] } });
const hash = (s: unknown) => createHash('sha256').update(JSON.stringify(s)).digest('hex');

/** Committed work as the runtime role in a tenant context (withAppConnection always rolls back). */
async function appCommit<T>(ctx: { orgId: string; workspaceId: string | null }, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: testDatabaseUrls().app });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.org_id', $1, true), set_config('app.workspace_id', $2, true)`, [ctx.orgId, ctx.workspaceId ?? '']);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}

const newCampaign = (c: pg.Client, ctx: typeof A, over: Record<string, unknown> = {}) =>
  c
    .query(
      `INSERT INTO campaigns (id, org_id, workspace_id, name, channel, topic_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::text`,
      [over.id ?? id(), ctx.orgId, ctx.workspaceId, over.name ?? 'Launch', over.channel ?? 'email', over.topicId ?? null],
    )
    .then((r) => r.rows[0].id as string);
const newVersion = (c: pg.Client, ctx: typeof A, campaignId: string, number: number, topicId = ids.topicA) =>
  c
    .query(
      `INSERT INTO campaign_versions (id, org_id, workspace_id, campaign_id, number, schema, snapshot, content_hash, reason)
       VALUES ($1, $2, $3, $4, $5, 'campaign.version.v1', $6::jsonb, $7, 'scheduled') RETURNING id::text`,
      [id(), ctx.orgId, ctx.workspaceId, campaignId, number, JSON.stringify(snapshot(topicId)), hash(snapshot(topicId))],
    )
    .then((r) => r.rows[0].id as string);
const newExecution = (c: pg.Client, ctx: typeof A, campaignId: string, versionId: string, runNumber: number, status = 'pending') =>
  c
    .query(
      `INSERT INTO campaign_executions (id, org_id, workspace_id, campaign_id, version_id, run_number, status, send_at, paused_phase)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8) RETURNING id::text`,
      [id(), ctx.orgId, ctx.workspaceId, campaignId, versionId, runNumber, status, status === 'paused' ? 'materializing' : null],
    )
    .then((r) => r.rows[0].id as string);

let campaignA = '';
let versionA = '';
let executionA = '';
let campaignB = '';
let versionB = '';
let executionB = '';
let recipientB = '';

beforeAll(async () => {
  await resetTestDatabase();
  await owner(async (c) => {
    await c.query(`INSERT INTO users (id, email, email_normalized, display_name) VALUES ($1, 'cmp@x.test', 'cmp@x.test', 'C')`, [ids.user]);
    for (const [org, ws, topic, contact, slug] of [[ids.orgA, ids.wsA, ids.topicA, ids.contactA, 'a'], [ids.orgB, ids.wsB, ids.topicB, ids.contactB, 'b']] as const) {
      await c.query(`INSERT INTO organizations (id, name, slug, created_by_user_id) VALUES ($1, $2, $2, $3)`, [org, `cmp-org-${slug}`, ids.user]);
      await c.query(`INSERT INTO workspaces (id, org_id, name, slug) VALUES ($1, $2, $3, $3)`, [ws, org, `cmp-${slug}`]);
      await c.query(`INSERT INTO topics (id, org_id, workspace_id, key, name) VALUES ($1, $2, $3, 'news', 'News')`, [topic, org, ws]);
      await c.query(`INSERT INTO contacts (id, org_id, workspace_id) VALUES ($1, $2, $3)`, [contact, org, ws]);
    }
  });
  ({ campaignA, versionA, executionA } = await appCommit(A, async (c) => {
    const campaignA = await newCampaign(c, A, { topicId: ids.topicA });
    const versionA = await newVersion(c, A, campaignA, 1);
    const executionA = await newExecution(c, A, campaignA, versionA, 1);
    await c.query(`UPDATE campaigns SET current_version_id = $2, current_execution_id = $3, status = 'scheduled', version = version + 1 WHERE id = $1`, [campaignA, versionA, executionA]);
    return { campaignA, versionA, executionA };
  }));
  ({ campaignB, versionB, executionB, recipientB } = await appCommit(B, async (c) => {
    const campaignB = await newCampaign(c, B, { topicId: ids.topicB, name: 'Secret B' });
    const versionB = await newVersion(c, B, campaignB, 1, ids.topicB);
    const executionB = await newExecution(c, B, campaignB, versionB, 1);
    const recipientB = (
      await c.query(`INSERT INTO campaign_recipients (id, org_id, workspace_id, execution_id, contact_id, status) VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING id::text`, [
        id(),
        ids.orgB,
        ids.wsB,
        executionB,
        ids.contactB,
      ])
    ).rows[0].id as string;
    return { campaignB, versionB, executionB, recipientB };
  }));
});

afterAll(async () => {
  await resetTestDatabase();
});

describe('row-level security and grants', () => {
  it('all four tables: RLS enabled and forced, one FOR ALL workspace policy with USING and WITH CHECK', async () => {
    const r = await owner(async (c) =>
      (
        await c.query(
          `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, count(p.*)::int AS policies, bool_and(p.polcmd = '*') AS for_all,
                  bool_and(pg_get_expr(p.polqual, p.polrelid) LIKE '%current_org_id()%current_workspace_id()%') AS using_ok,
                  bool_and(pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%current_org_id()%current_workspace_id()%') AS check_ok
           FROM pg_class c JOIN pg_policy p ON p.polrelid = c.oid WHERE c.relname = ANY($1::text[]) GROUP BY 1, 2, 3 ORDER BY 1`,
          [TABLES],
        )
      ).rows,
    );
    expect(r).toHaveLength(4);
    for (const t of r) expect([t.relrowsecurity, t.relforcerowsecurity, t.policies, t.for_all, t.using_ok, t.check_ok], t.relname).toEqual([true, true, 1, true, true, true]);
  });

  it('table privileges: app SELECT/INSERT only (+ column UPDATE), no DELETE/TRUNCATE; reporting, identity, maintenance and PUBLIC get nothing', async () => {
    const rows = await owner(async (c) =>
      (
        await c.query(
          `SELECT r.role, t.tbl, p.priv FROM unnest(ARRAY['workeasy_app', 'workeasy_reporting', 'workeasy_identity', 'workeasy_audience_count']) r(role),
                  unnest($1::text[]) t(tbl), unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p(priv)
           WHERE has_table_privilege(r.role, format('public.%I', t.tbl)::regclass, p.priv) ORDER BY r.role COLLATE "C", t.tbl COLLATE "C", p.priv COLLATE "C"`,
          [TABLES],
        )
      ).rows.map((x: { role: string; tbl: string; priv: string }) => `${x.role} ${x.tbl} ${x.priv}`),
    );
    expect(rows).toEqual([
      'workeasy_app campaign_executions INSERT',
      'workeasy_app campaign_executions SELECT',
      'workeasy_app campaign_recipients INSERT',
      'workeasy_app campaign_recipients SELECT',
      'workeasy_app campaign_versions INSERT',
      'workeasy_app campaign_versions SELECT',
      'workeasy_app campaigns INSERT',
      'workeasy_app campaigns SELECT',
    ]);
    const pub = await owner(async (c) =>
      (await c.query(`SELECT count(*)::int AS n FROM information_schema.role_table_grants WHERE grantee = 'PUBLIC' AND table_name = ANY($1::text[])`, [TABLES])).rows[0].n,
    );
    expect(pub).toBe(0);
  });

  it('column UPDATE grants: draft/status/pointers yes; ids, tenant keys, channel, provenance and the execution version reference no', async () => {
    const updatable = await owner(async (c) =>
      (
        await c.query(
          `SELECT table_name || '.' || column_name AS col FROM information_schema.column_privileges
           WHERE grantee = 'workeasy_app' AND privilege_type = 'UPDATE' AND table_name = ANY($1::text[]) ORDER BY 1`,
          [TABLES],
        )
      ).rows.map((r: { col: string }) => r.col),
    );
    for (const col of ['campaigns.name', 'campaigns.audience', 'campaigns.status', 'campaigns.current_version_id', 'campaigns.version', 'campaign_executions.status', 'campaign_executions.send_at']) {
      expect(updatable).toContain(col);
    }
    for (const col of [
      'campaigns.id', 'campaigns.org_id', 'campaigns.workspace_id', 'campaigns.channel', 'campaigns.purpose', 'campaigns.cloned_from_id', 'campaigns.created_by_user_id',
      'campaign_versions.snapshot', 'campaign_versions.number', 'campaign_versions.content_hash',
      'campaign_executions.campaign_id', 'campaign_executions.version_id', 'campaign_executions.run_number', 'campaign_executions.initiated_by_user_id',
      'campaign_recipients.execution_id', 'campaign_recipients.contact_id',
    ]) {
      expect(updatable, col).not.toContain(col);
    }
    expect(await code(withAppConnection(A, (c) => c.query(`UPDATE campaigns SET channel = 'sms' WHERE id = $1`, [campaignA])))).toBe('42501');
    expect(await code(withAppConnection(A, (c) => c.query(`UPDATE campaign_executions SET version_id = version_id WHERE id = $1`, [executionA])))).toBe('42501');
    expect(await code(withAppConnection(A, (c) => c.query(`DELETE FROM campaigns WHERE id = $1`, [campaignA])))).toBe('42501');
    expect(await code(withAppConnection(A, (c) => c.query(`TRUNCATE campaign_recipients`)))).toBe('42501');
  });
});

describe('tenant isolation (raw SQL as the runtime role)', () => {
  it('workspace A sees, updates and links nothing of workspace B — campaigns, versions, executions, recipients', async () => {
    await withAppConnection(A, async (c) => {
      for (const [t, rid] of [['campaigns', campaignB], ['campaign_versions', versionB], ['campaign_executions', executionB], ['campaign_recipients', recipientB]] as const) {
        expect((await c.query(`SELECT 1 FROM ${t} WHERE id = $1`, [rid])).rowCount, t).toBe(0);
      }
      expect((await c.query(`SELECT count(*)::int AS n FROM campaigns`)).rows[0].n).toBe(1);
      expect((await c.query(`SELECT 1 FROM campaigns WHERE name = 'Secret B'`)).rowCount).toBe(0);
      expect((await c.query(`UPDATE campaigns SET name = 'hijack' WHERE id = $1`, [campaignB])).rowCount).toBe(0);
      expect((await c.query(`UPDATE campaign_executions SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [executionB])).rowCount).toBe(0);
    });
    // rows labelled with B's tenant are refused by WITH CHECK
    expect(await code(withAppConnection(A, (c) => newCampaign(c, B)))).toBe('42501');
    // a mismatched org/workspace pair (client ids are never trusted) sees nothing
    await withAppConnection({ orgId: ids.orgB, workspaceId: ids.wsA }, async (c) => expect((await c.query(`SELECT 1 FROM campaigns`)).rowCount).toBe(0));
    await withAppConnection({ orgId: ids.orgA, workspaceId: null }, async (c) => expect((await c.query(`SELECT 1 FROM campaign_executions`)).rowCount).toBe(0));
    // B still has its campaign untouched
    expect(await owner(async (c) => (await c.query(`SELECT name FROM campaigns WHERE id = $1`, [campaignB])).rows[0].name)).toBe('Secret B');
  });

  it('composite tenant keys: no campaign of A can reference B’s topic, version, execution or contact', async () => {
    expect(await code(withAppConnection(A, (c) => newCampaign(c, A, { topicId: ids.topicB })))).toBe('23503');
    expect(await code(withAppConnection(A, (c) => newVersion(c, A, campaignB, 9)))).toBe('23503');
    // (a fresh campaign without an active execution, so the foreign key — not the active-execution index — decides)
    const unusedVersionB = await appCommit(B, (c) => newVersion(c, B, campaignB, 2, ids.topicB)); // has no execution yet
    expect(await code(withAppConnection(A, async (c) => newExecution(c, A, await newCampaign(c, A), unusedVersionB, 9)))).toBe('23503');
    expect(
      await code(withAppConnection(A, (c) => c.query(`INSERT INTO campaign_recipients (id, org_id, workspace_id, execution_id, contact_id, status) VALUES ($5, $1, $2, $3, $4, 'pending')`, [ids.orgA, ids.wsA, executionA, ids.contactB, id()]))),
    ).toBe('23503');
    // the current-version pointer can only name a version of the SAME campaign
    await withAppConnection(A, async (c) => {
      const other = await newCampaign(c, A);
      expect(await code(c.query(`UPDATE campaigns SET current_version_id = $2 WHERE id = $1`, [other, versionA]))).toBe('23503');
    });
  });
});

describe('integrity: constraints, uniqueness, immutability', () => {
  it('CHECK constraints reject values outside the contract', async () => {
    const bad: [string, string, unknown[]][] = [
      ['empty name', `UPDATE campaigns SET name = '' WHERE id = $1`, [campaignA]],
      ['unknown status', `UPDATE campaigns SET status = 'stopped' WHERE id = $1`, [campaignA]],
      ['audience not an object', `UPDATE campaigns SET audience = '[]' WHERE id = $1`, [campaignA]],
      ['execution paused without phase', `UPDATE campaign_executions SET status = 'paused' WHERE id = $1`, [executionA]],
      ['negative count', `UPDATE campaign_executions SET planned = -1 WHERE id = $1`, [executionA]],
      ['failure code without class', `UPDATE campaign_executions SET failure_code = 'X' WHERE id = $1`, [executionA]],
      ['unknown health', `UPDATE campaign_executions SET health = 'sick' WHERE id = $1`, [executionA]],
    ];
    for (const [what, sql, params] of bad) expect(await code(withAppConnection(A, (c) => c.query(sql, params))), what).toBe('23514');
    expect(await code(withAppConnection(A, (c) => newCampaign(c, A, { channel: 'fax' })))).toBe('23514');
    expect(
      await code(withAppConnection(A, (c) =>
        c.query(`INSERT INTO campaign_versions (id, org_id, workspace_id, campaign_id, number, schema, snapshot, content_hash, reason) VALUES ($5, $1, $2, $3, 5, 'campaign.version.v1', '{"schema":"campaign.version.v2"}', $4, 'scheduled')`, [ids.orgA, ids.wsA, campaignA, 'a'.repeat(64), id()]),
      )),
    ).toBe('23514');
  });

  it('versions are insert-only: UPDATE refused for the runtime role (no grant) and for the owner (trigger)', async () => {
    expect(await code(withAppConnection(A, (c) => c.query(`UPDATE campaign_versions SET reason = 'sent_now' WHERE id = $1`, [versionA])))).toBe('42501');
    expect(await code(owner((c) => c.query(`UPDATE campaign_versions SET snapshot = '{"schema":"campaign.version.v1"}' WHERE id = $1`, [versionA])))).toBe('42501');
    // identity columns of campaigns and executions are frozen even for the owner
    expect(await code(owner((c) => c.query(`UPDATE campaigns SET channel = 'sms' WHERE id = $1`, [campaignA])))).toBe('42501');
    expect(await code(owner((c) => c.query(`UPDATE campaign_executions SET run_number = 7 WHERE id = $1`, [executionA])))).toBe('42501');
    expect(await code(owner((c) => c.query(`UPDATE campaign_recipients SET contact_id = contact_id WHERE id = $1`, [recipientB])))).toBe('ok'); // unchanged value is allowed
  });

  it('one version number per campaign, enforced under concurrency (no read-then-insert race)', async () => {
    const campaign = await appCommit(A, (c) => newCampaign(c, A));
    const results = await Promise.all(Array.from({ length: 6 }, () => code(appCommit(A, (c) => newVersion(c, A, campaign, 1)))));
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === '23505')).toHaveLength(5);
  });

  it('a one-time version runs once; one active execution per campaign; run numbers unique; recipients unique per execution', async () => {
    const campaign = await appCommit(A, (c) => newCampaign(c, A));
    const [v1, v2] = await appCommit(A, async (c) => [await newVersion(c, A, campaign, 1), await newVersion(c, A, campaign, 2)]);
    await appCommit(A, (c) => newExecution(c, A, campaign, v1, 1));
    expect(await code(withAppConnection(A, (c) => newExecution(c, A, campaign, v1, 2)))).toBe('23505'); // same one-time version
    expect(await code(withAppConnection(A, (c) => newExecution(c, A, campaign, v2, 2)))).toBe('23505'); // second ACTIVE execution
    expect(await code(withAppConnection(A, (c) => newExecution(c, A, campaign, v2, 1)))).toBe('23505'); // run number reused
    // concurrent creation of the active execution: exactly one wins
    const c2 = await appCommit(A, (c) => newCampaign(c, A));
    const vs = await appCommit(A, async (c) => [await newVersion(c, A, c2, 1), await newVersion(c, A, c2, 2), await newVersion(c, A, c2, 3)]);
    const raced = await Promise.all(vs.map((v, i) => code(appCommit(A, (c) => newExecution(c, A, c2, v, i + 1)))));
    expect(raced.filter((r) => r === 'ok')).toHaveLength(1);
    // once terminal, a new execution may follow
    await appCommit(A, (c) => c.query(`UPDATE campaign_executions SET status = 'cancelled', cancelled_at = now() WHERE campaign_id = $1`, [c2]));
    const free = vs.find((_, i) => raced[i] !== 'ok')!;
    expect(await code(appCommit(A, (c) => newExecution(c, A, c2, free, 9)))).toBe('ok');
    const exec = await owner(async (c) => (await c.query(`SELECT id FROM campaign_executions WHERE campaign_id = $1 AND status = 'pending'`, [c2])).rows[0].id as string);
    const recipient = (status: string) => (c: pg.Client) =>
      c.query(`INSERT INTO campaign_recipients (id, org_id, workspace_id, execution_id, contact_id, status) VALUES ($6, $1, $2, $3, $4, $5)`, [ids.orgA, ids.wsA, exec, ids.contactA, status, id()]);
    await appCommit(A, recipient('pending'));
    expect(await code(withAppConnection(A, recipient('skipped')))).toBe('23505');
  });

  it('optimistic concurrency: two conditional updates on the same version — exactly one applies', async () => {
    const campaign = await appCommit(A, (c) => newCampaign(c, A));
    const results = await Promise.all(
      ['first', 'second'].map((name) => appCommit(A, async (c) => (await c.query(`UPDATE campaigns SET name = $2, version = version + 1 WHERE id = $1 AND version = 1`, [campaign, name])).rowCount)),
    );
    expect(results.sort()).toEqual([0, 1]);
    expect(await owner(async (c) => (await c.query(`SELECT version FROM campaigns WHERE id = $1`, [campaign])).rows[0].version)).toBe(2);
  });
});

describe('campaign name search (definer function)', () => {
  it('is confined to the caller workspace, escapes wildcards, and is not executable by PUBLIC/reporting', async () => {
    await appCommit(A, (c) => newCampaign(c, A, { name: '100% Summer_Sale' }));
    await withAppConnection(A, async (c) => {
      const hits = (await c.query(`SELECT campaign_id FROM app.search_campaign_ids($1, 50)`, ['summer_s'])).rows;
      expect(hits).toHaveLength(1);
      // "%" and "_" match literally: "0%" is in the name; "%S" is not (unescaped, it would match every name)
      expect((await c.query(`SELECT campaign_id FROM app.search_campaign_ids($1, 50)`, ['0%'])).rowCount).toBe(1);
      expect((await c.query(`SELECT campaign_id FROM app.search_campaign_ids($1, 50)`, ['%S'])).rowCount).toBe(0);
      const la = (await c.query(`SELECT campaign_id::text AS id FROM app.search_campaign_ids($1, 50)`, ['la'])).rows.map((x: { id: string }) => x.id);
      expect(la).toContain(campaignA); // "Launch" (and "Summer_Sale")
      expect(la).not.toContain(campaignB);
      expect((await c.query(`SELECT campaign_id FROM app.search_campaign_ids($1, 50)`, ['secret'])).rowCount).toBe(0); // B's campaign
    });
    const r = await owner(async (c) => (await c.query(`SELECT has_function_privilege('public', 'app.search_campaign_ids(text, integer)', 'EXECUTE') AS p,
      has_function_privilege('workeasy_reporting', 'app.search_campaign_ids(text, integer)', 'EXECUTE') AS rep`)).rows[0]);
    expect(r).toEqual({ p: false, rep: false });
  });
});

describe('execution recovery discovery (definer function, migration 20261016000000)', () => {
  it('returns workspace pairs only; executable by the runtime role only; definer with pinned search_path', async () => {
    const r = await owner(async (c) =>
      (
        await c.query(`SELECT pg_get_function_result('app.workspaces_with_campaign_recovery(timestamptz)'::regprocedure) AS result,
                              p.prosecdef AS definer, p.proconfig AS config,
                              has_function_privilege('workeasy_app', p.oid, 'EXECUTE') AS app,
                              has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
                              has_function_privilege('workeasy_reporting', p.oid, 'EXECUTE') AS rep,
                              has_function_privilege('workeasy_identity', p.oid, 'EXECUTE') AS idt
                         FROM pg_proc p WHERE p.oid = 'app.workspaces_with_campaign_recovery(timestamptz)'::regprocedure`)
      ).rows[0],
    );
    expect(r.result).toBe('TABLE(org_id uuid, workspace_id uuid)');
    expect([r.definer, r.app, r.pub, r.rep, r.idt]).toEqual([true, true, false, false, false]);
    expect(r.config.some((s: string) => s.startsWith('search_path='))).toBe(true);
    // as the runtime role (no tenant context) it answers without exposing anything but pairs
    const rows = await withAppConnection({ orgId: randomUUID(), workspaceId: null }, (c) => c.query(`SELECT * FROM app.workspaces_with_campaign_recovery(now())`));
    for (const row of rows.rows) expect(Object.keys(row).sort()).toEqual(['org_id', 'workspace_id']);
  });
});
