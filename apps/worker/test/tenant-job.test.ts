import { randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '@workeasy/db';
import { resetTestDatabase, testDatabaseUrls, withOwnerConnection } from '@workeasy/db/testing';
import { UnrecoverableError } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTenantJob } from '../src/jobs/tenant-job.js';

const ids = { user: randomUUID(), orgA: randomUUID(), orgB: randomUUID(), wsA: randomUUID(), wsB: randomUUID() };
let db: Database;

beforeAll(async () => {
  await resetTestDatabase();
  await withOwnerConnection(async (c) => {
    await c.query(`INSERT INTO users (id, email, email_normalized, display_name) VALUES ($1, 'w@x.test', 'w@x.test', 'W')`, [ids.user]);
    for (const [org, ws, name] of [[ids.orgA, ids.wsA, 'a'], [ids.orgB, ids.wsB, 'b']] as const) {
      await c.query(`INSERT INTO organizations (id, name, slug, created_by_user_id) VALUES ($1, $2, $2, $3)`, [org, `org-${name}`, ids.user]);
      await c.query(`INSERT INTO workspaces (id, org_id, name, slug) VALUES ($1, $2, $3, $3)`, [ws, org, `ws-${name}`]);
      await c.query(`INSERT INTO workspace_settings (org_id, workspace_id, locale) VALUES ($1, $2, $3)`, [org, ws, name]);
    }
  });
  db = createDatabase({ url: testDatabaseUrls().app, maxConnections: 2 });
});
afterAll(async () => db?.disconnect());

const system = { type: 'system' as const, id: null };

describe('tenant jobs preserve tenant context', () => {
  it('runs the handler scoped to the job tenant only', async () => {
    let seen: string[] = [];
    const job = defineTenantJob('test.read', z.object({}), db, async ({ tx }) => {
      seen = (await tx.workspaceSettings.findMany()).map((s) => s.locale);
    });
    await job.process({ name: job.name, data: job.data({ orgId: ids.orgA, workspaceId: ids.wsA, actor: system, correlationId: randomUUID() }, {}) });
    expect(seen).toEqual(['a']);
  });

  it('cannot reach another tenant even when the payload names it', async () => {
    let found: unknown = 'not-run';
    const job = defineTenantJob('test.cross', z.object({ workspaceId: z.uuid() }), db, async ({ tx, payload }) => {
      found = await tx.workspaceSettings.findUnique({ where: { workspaceId: payload.workspaceId } });
    });
    await job.process({
      name: job.name,
      data: job.data({ orgId: ids.orgA, workspaceId: ids.wsA, actor: system, correlationId: randomUUID() }, { workspaceId: ids.wsB }),
    });
    expect(found).toBeNull();
  });

  it.each([
    ['no tenant at all', { payload: {} }],
    ['malformed org id', { tenant: { orgId: "x' or 1=1", workspaceId: null }, actor: system, correlationId: randomUUID(), payload: {} }],
    ['missing correlation id', { tenant: { orgId: ids.orgA, workspaceId: null }, actor: system, payload: {} }],
  ])('rejects a job with %s before touching the database, without retry', async (_label, data) => {
    let ran = false;
    const job = defineTenantJob('test.reject', z.object({}), db, async () => {
      ran = true;
    });
    await expect(job.process({ name: job.name, data })).rejects.toBeInstanceOf(UnrecoverableError);
    expect(ran).toBe(false);
  });

  it('organization-level jobs see no workspace-owned rows', async () => {
    let count = -1;
    const job = defineTenantJob('test.org', z.object({}), db, async ({ tx }) => {
      count = await tx.workspaceSettings.count();
    });
    await job.process({ name: job.name, data: job.data({ orgId: ids.orgB, workspaceId: null, actor: system, correlationId: randomUUID() }, {}) });
    expect(count).toBe(0);
  });
});
