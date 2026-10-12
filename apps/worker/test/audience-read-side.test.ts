import { randomUUID } from 'node:crypto';
import { EligibilityEvaluator } from '@workeasy/audience-core';
import { createDatabase, type Database } from '@workeasy/db';
import { resetTestDatabase, testDatabaseUrls, withOwnerConnection } from '@workeasy/db/testing';
import type { EligibilityResponse } from '@workeasy/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AudienceCountMaintenance, audienceEligibility } from '../src/audience-read-side.js';
import { defineTenantJob } from '../src/jobs/tenant-job.js';

/** Milestone 6.2: a worker job can evaluate eligibility through the core port, wired by the worker composition root. */
const ids = { user: randomUUID(), orgA: randomUUID(), orgB: randomUUID(), wsA: randomUUID(), wsB: randomUUID(), contactA: randomUUID(), contactB: randomUUID() };
let db: Database;

beforeAll(async () => {
  await resetTestDatabase();
  await withOwnerConnection(async (c) => {
    await c.query(`INSERT INTO users (id, email, email_normalized, display_name) VALUES ($1, 'w@x.test', 'w@x.test', 'W')`, [ids.user]);
    for (const [org, ws, contact, name] of [[ids.orgA, ids.wsA, ids.contactA, 'a'], [ids.orgB, ids.wsB, ids.contactB, 'b']] as const) {
      await c.query(`INSERT INTO organizations (id, name, slug, created_by_user_id) VALUES ($1, $2, $2, $3)`, [org, `org-${name}`, ids.user]);
      await c.query(`INSERT INTO workspaces (id, org_id, name, slug) VALUES ($1, $2, $3, $3)`, [ws, org, `ws-${name}`]);
      await c.query(`INSERT INTO contacts (id, org_id, workspace_id, first_name, search_text) VALUES ($1, $2, $3, $4, $4)`, [contact, org, ws, name]);
      await c.query(
        `INSERT INTO contact_identities (id, org_id, workspace_id, contact_id, kind, value, value_normalized, is_primary) VALUES ($1, $2, $3, $4, 'email', 'x@example.test', 'x@example.test', true)`,
        [randomUUID(), org, ws, contact],
      );
    }
  });
  db = createDatabase({ url: testDatabaseUrls().app, maxConnections: 2 });
});
afterAll(async () => db?.disconnect());

describe('worker composition root → audience-core port', () => {
  it('requires DATA_FINGERPRINT_SECRET and yields the core EligibilityEvaluator', () => {
    expect(() => audienceEligibility({})).toThrow(/DATA_FINGERPRINT_SECRET/);
    expect(audienceEligibility({ DATA_FINGERPRINT_SECRET: 's' })).toBeInstanceOf(EligibilityEvaluator);
  });

  it("a tenant job evaluates only its own workspace's contacts, even when the payload names another tenant's", async () => {
    const eligibility = audienceEligibility({ DATA_FINGERPRINT_SECRET: 'worker-test-secret' });
    let out: EligibilityResponse | null = null;
    const job = defineTenantJob('test.eligibility', z.object({ contactIds: z.array(z.uuid()) }), db, async ({ tx, tenant, payload }) => {
      out = await eligibility.evaluate({ tx, orgId: tenant.orgId, workspaceId: tenant.workspaceId! }, { contactIds: payload.contactIds, channel: 'email', purpose: 'marketing' });
    });
    await job.process({
      name: job.name,
      data: job.data({ orgId: ids.orgA, workspaceId: ids.wsA, actor: { type: 'system', id: null }, correlationId: randomUUID() }, { contactIds: [ids.contactA, ids.contactB] }),
    });
    expect(out!.results.map((r) => [r.contactId, r.reasons.map((x) => x.code)])).toEqual([[ids.contactA, ['CONSENT_MISSING']]]);
    expect(out!.notFound).toEqual([ids.contactB]);
  });
});

describe('audience count bitmap maintenance job (Phase 6.3 G2)', () => {
  it('rebuilds the INVALID bitmaps of every workspace, never overlaps runs, and stops cleanly', async () => {
    const state = () => withOwnerConnection(async (c) => (await c.query(`SELECT state FROM audience_count_state WHERE workspace_id = ANY($1::uuid[]) ORDER BY state`, [[ids.wsA, ids.wsB]])).rows.map((r) => r.state));
    expect(await state()).toEqual(['invalid', 'invalid']); // seeded outside tenant context
    const job = new AudienceCountMaintenance({ databaseUrl: testDatabaseUrls().app, tickMs: 3_600_000 });
    try {
      const [first, overlapping] = await Promise.all([job.runOnce(), job.runOnce()]);
      expect(overlapping).toBeNull();
      expect(first).toMatchObject({ rebuilt: 2, errors: 0, reconcileFailures: 0 });
      expect(await state()).toEqual(['valid', 'valid']);
      // nothing due within 24 h
      expect(await job.runOnce()).toMatchObject({ workspaces: 0 });
    } finally {
      await job.stop();
    }
    expect(() => new AudienceCountMaintenance({ databaseUrl: '' })).toThrow(/DATABASE_URL/);
  });
});

describe('worker service lifecycle (regression: the process exited after its first maintenance run)', () => {
  it('the service timer holds the process; an embedded one does not; stop releases it', async () => {
    const service = new AudienceCountMaintenance({ databaseUrl: testDatabaseUrls().app });
    service.start({ keepProcessAlive: true });
    expect([service.scheduled, service.holdsProcess]).toEqual([true, true]);
    await service.stop();
    expect([service.scheduled, service.holdsProcess]).toEqual([false, false]);
    const embedded = new AudienceCountMaintenance({ databaseUrl: testDatabaseUrls().app });
    embedded.start();
    expect([embedded.scheduled, embedded.holdsProcess]).toEqual([true, false]);
    await embedded.stop();
  });

  it('the worker entry point stays up after its first run and exits only when stopped', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: testDatabaseUrls().app },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    try {
      const deadline = Date.now() + 60_000;
      while (!out.includes('audience count maintenance run') && Date.now() < deadline && child.exitCode === null) await new Promise((r) => setTimeout(r, 200));
      expect(out, out.slice(-2000)).toContain('audience count maintenance run');
      // The first run is over. Before the fix the process exited once the pool closed its idle connections (pg default
      // idleTimeoutMillis 10 s): wait past that.
      await new Promise((r) => setTimeout(r, 15_000));
      expect(child.exitCode, out.slice(-2000)).toBeNull();
    } finally {
      child.kill();
    }
    await exited;
  }, 90_000);
});
