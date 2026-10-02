/**
 * Tenant isolation at the database layer (audit §5.3). Every query here runs as workeasy_app — the real runtime
 * role — so these tests prove what PostgreSQL enforces even if application code is wrong.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database, isNotFound, isUniqueViolation, sqlStateOf } from '../src/index.js';
import { resetTestDatabase, testDatabaseUrls } from '../src/testing.js';
import { ids, seedTwoTenants } from './seed.js';

let db: Database;
const ctxA = () => ({ orgId: ids.orgA, workspaceId: null, userId: ids.userA });
const ctxB = () => ({ orgId: ids.orgB, workspaceId: null, userId: ids.userB });

beforeAll(async () => {
  await resetTestDatabase();
  await seedTwoTenants();
  db = createDatabase({ url: testDatabaseUrls().app, maxConnections: 2 });
});
afterAll(async () => db?.disconnect());

/** PostgreSQL SQLSTATE from a failed call (or P2025 when Prisma found no row to change). */
async function pgCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return sqlStateOf(e) ?? (isNotFound(e) ? 'P2025' : `unknown: ${(e as Error).message}`);
  }
  throw new Error('expected the operation to fail');
}

describe('organization isolation', () => {
  it('Tenant A cannot SELECT Tenant B rows', async () => {
    const r = await db.withTenant(ctxA(), async (tx) => ({
      orgs: await tx.organization.findMany({ where: { id: { in: [ids.orgA, ids.orgB] } } }),
      workspaces: await tx.workspace.findMany(),
      audit: await tx.auditLog.findMany(),
      events: await tx.domainEvent.findMany(),
      bById: await tx.workspace.findUnique({ where: { id: ids.wsB1 } }),
    }));
    expect(r.orgs.map((o) => o.id)).toEqual([ids.orgA]);
    expect(r.workspaces.map((w) => w.id).sort()).toEqual([ids.wsA1, ids.wsA2].sort());
    expect(r.audit.map((a) => a.id)).toEqual([ids.auditA]);
    expect(r.events.map((e) => e.id)).toEqual([ids.eventA]);
    expect(r.bById).toBeNull();
  });

  it('Tenant A cannot INSERT rows belonging to Tenant B', async () => {
    const code = await pgCode(
      db.withTenant(ctxA(), (tx) =>
        tx.workspace.create({ data: { id: randomUUID(), orgId: ids.orgB, name: 'evil', slug: 'evil' } }),
      ),
    );
    expect(code).toBe('42501'); // new row violates row-level security policy
  });

  it('Tenant A cannot UPDATE Tenant B rows', async () => {
    const n = await db.withTenant(ctxA(), (tx) =>
      tx.workspace.updateMany({ where: { id: ids.wsB1 }, data: { name: 'pwned' } }),
    );
    expect(n.count).toBe(0);
    const b = await db.withTenant(ctxB(), (tx) => tx.workspace.findUnique({ where: { id: ids.wsB1 } }));
    expect(b?.name).toBe('b1');
  });

  it('Tenant A cannot DELETE Tenant B rows', async () => {
    const n = await db.withTenant(ctxA(), (tx) => tx.workspaceMembership.deleteMany({ where: { orgId: ids.orgB } }));
    expect(n.count).toBe(0);
    const left = await db.withTenant(ctxB(), (tx) => tx.workspaceMembership.count());
    expect(left).toBe(1);
  });

  it('a row in A cannot reference a parent in B (composite tenant foreign keys)', async () => {
    const code = await pgCode(
      db.withTenant(ctxA(), (tx) =>
        tx.workspaceMembership.create({
          data: { orgId: ids.orgA, workspaceId: ids.wsB1, userId: ids.userA, roleId: ids.roleWsA },
        }),
      ),
    );
    expect(code).toBe('23503'); // foreign_key_violation: (org A, workspace B1) does not exist
  });

  it('tenant keys and ids cannot be changed by the runtime role', async () => {
    const code = await pgCode(
      db.withTenant(ctxA(), (tx) => tx.workspace.update({ where: { id: ids.wsA1 }, data: { orgId: ids.orgB } })),
    );
    expect(code).toBe('42501'); // permission denied (no column UPDATE privilege on org_id)
  });

  it('missing tenant context sees nothing (fails closed, not open)', async () => {
    const r = await db.asUser(ids.userA, async (tx) => ({
      workspaces: await tx.workspace.count(),
      audit: await tx.auditLog.count(),
      settings: await tx.workspaceSettings.count(),
    }));
    expect(r).toEqual({ workspaces: 0, audit: 0, settings: 0 });
  });

  it('context does not leak to the next transaction on a pooled connection', async () => {
    const single = createDatabase({ url: testDatabaseUrls().app, maxConnections: 1 });
    try {
      await single.withTenant(ctxA(), (tx) => tx.auditLog.count());
      const after = await single.asUser(ids.userB, (tx) => tx.auditLog.count());
      expect(after).toBe(0);
    } finally {
      await single.disconnect();
    }
  });

  it('rejects malformed context values before reaching SQL', async () => {
    await expect(db.withTenant({ orgId: "x' OR 1=1 --", workspaceId: null, userId: null }, async () => 1)).rejects.toThrow(
      'orgId must be a UUID',
    );
  });
});

describe('workspace isolation', () => {
  it('a workspace context sees only its own workspace-owned rows', async () => {
    const rows = await db.withTenant({ ...ctxA(), workspaceId: ids.wsA1 }, (tx) => tx.workspaceSettings.findMany());
    expect(rows.map((r) => r.locale)).toEqual(['a1']);
  });

  it('workspace A2 cannot read workspace A1 data in the same organization', async () => {
    const r = await db.withTenant({ ...ctxA(), workspaceId: ids.wsA2 }, (tx) =>
      tx.workspaceSettings.findUnique({ where: { workspaceId: ids.wsA1 } }),
    );
    expect(r).toBeNull();
  });

  it("a workspace cannot access another organization's workspace even with its id", async () => {
    const r = await db.withTenant({ ...ctxA(), workspaceId: ids.wsB1 }, (tx) => tx.workspaceSettings.findMany());
    expect(r).toEqual([]);
    const code = await pgCode(
      db.withTenant({ ...ctxA(), workspaceId: ids.wsB1 }, (tx) =>
        tx.workspaceSettings.update({ where: { workspaceId: ids.wsB1 }, data: { locale: 'x' } }),
      ),
    );
    expect(code).toBe('P2025'); // the row is invisible, so there is nothing to update
  });

  it('organization context without a workspace sees no workspace-owned rows', async () => {
    expect(await db.withTenant(ctxA(), (tx) => tx.workspaceSettings.count())).toBe(0);
  });
});

describe('user-scoped visibility', () => {
  it('a user lists only their own memberships across organizations', async () => {
    const rows = await db.asUser(ids.userBoth, (tx) => tx.organizationMembership.findMany());
    expect(rows.map((m) => m.orgId).sort()).toEqual([ids.orgA, ids.orgB].sort());
    const a = await db.asUser(ids.userA, (tx) => tx.organizationMembership.findMany());
    expect(a.map((m) => m.orgId)).toEqual([ids.orgA]);
  });

  it('within an organization, only that organization’s members are visible as users', async () => {
    const users = await db.withTenant(ctxA(), (tx) => tx.user.findMany());
    expect(users.map((u) => u.id).sort()).toEqual([ids.userA, ids.userBoth].sort());
  });

  it('a user can list organizations they belong to, but not others', async () => {
    const orgs = await db.asUser(ids.userA, (tx) => tx.organization.findMany());
    expect(orgs.map((o) => o.id)).toEqual([ids.orgA]);
  });
});

describe('append-only history', () => {
  it.each(['auditLog', 'domainEvent'] as const)('%s cannot be updated or deleted by the runtime role', async (model) => {
    const update = await pgCode(
      db.withTenant(ctxA(), (tx) =>
        // @ts-expect-error – both delegates accept updateMany with a where on orgId
        tx[model].updateMany({ where: { orgId: ids.orgA }, data: { orgId: ids.orgA } }),
      ),
    );
    expect(update).toBe('42501');
    const del = await pgCode(
      // @ts-expect-error – both delegates accept deleteMany
      db.withTenant(ctxA(), (tx) => tx[model].deleteMany({ where: { orgId: ids.orgA } })),
    );
    expect(del).toBe('42501');
  });

  it('security events can only be written through the definer function', async () => {
    const direct = await pgCode(
      db.asUser(ids.userA, (tx) =>
        tx.securityEvent.create({ data: { userId: ids.userA, type: 'forged', correlationId: randomUUID() } }),
      ),
    );
    expect(direct).toBe('42501');
    await db.system.recordSecurityEvent({
      userId: ids.userA,
      type: 'auth.login_failed',
      ipAddress: '203.0.113.9',
      userAgent: 'test',
      correlationId: randomUUID(),
    });
    const own = await db.asUser(ids.userA, (tx) => tx.securityEvent.findMany());
    expect(own.map((e) => e.type)).toContain('auth.login_failed');
    expect(await db.asUser(ids.userB, (tx) => tx.securityEvent.count())).toBe(0);
  });
});

describe('webhook tenant resolution', () => {
  it('resolves the tenant from the routing table, and the resolved context sees only that tenant', async () => {
    const route = await db.system.resolveProviderMessage('smtp', 'msg-b-1');
    expect(route).toMatchObject({ orgId: ids.orgB, workspaceId: ids.wsB1 });
    const visible = await db.withTenant({ orgId: route!.orgId, workspaceId: route!.workspaceId, userId: null }, (tx) =>
      tx.workspaceSettings.findMany(),
    );
    expect(visible.map((s) => s.workspaceId)).toEqual([ids.wsB1]);
  });

  it('an unknown provider message resolves to nothing', async () => {
    expect(await db.system.resolveProviderMessage('smtp', 'forged-id')).toBeNull();
  });

  it('the runtime role cannot enumerate other tenants’ routes directly', async () => {
    expect(await db.withTenant(ctxA(), (tx) => tx.providerMessageRoute.count())).toBe(0);
  });
});

describe('analytics and reporting cannot aggregate across tenants', () => {
  it('aggregates under a tenant context include only that tenant', async () => {
    const n = await db.withTenant(ctxA(), (tx) => tx.auditLog.count());
    expect(n).toBe(1);
  });

  it('the reporting role is also tenant-scoped', async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrls().reporting });
    await client.connect();
    try {
      const none = await client.query('SELECT count(*)::int AS n FROM audit_logs');
      expect(none.rows[0].n).toBe(0);
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.org_id', $1, true)`, [ids.orgB]);
      const b = await client.query('SELECT count(*)::int AS n, array_agg(DISTINCT org_id) AS orgs FROM audit_logs');
      await client.query('COMMIT');
      expect(b.rows[0].n).toBe(1);
      expect(b.rows[0].orgs).toEqual([ids.orgB]);
      await expect(client.query('SELECT count(*) FROM sessions')).rejects.toThrow(/permission denied/);
    } finally {
      await client.end();
    }
  });
});

describe('identity linking', () => {
  it('creates a platform user once per external identity and never links by email alone', async () => {
    const input = { provider: 'local', subject: randomUUID(), email: 'link@example.test', displayName: 'L', emailVerified: false };
    const first = await db.system.linkIdentity(input);
    expect(await db.system.linkIdentity(input)).toBe(first);
    try {
      await db.system.linkIdentity({ ...input, provider: 'workeasy-sso', subject: 'other' });
      throw new Error('expected failure');
    } catch (e) {
      expect(isUniqueViolation(e)).toBe(true);
    }
  });
});
