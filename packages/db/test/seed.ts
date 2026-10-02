import { randomUUID } from 'node:crypto';
import { withOwnerConnection } from '../src/testing.js';

/** Two organizations, three workspaces, one user per org plus a user in both. Seeded as owner (bypasses RLS). */
export const ids = {
  userA: randomUUID(),
  userB: randomUUID(),
  userBoth: randomUUID(),
  orgA: randomUUID(),
  orgB: randomUUID(),
  wsA1: randomUUID(),
  wsA2: randomUUID(),
  wsB1: randomUUID(),
  roleOwnerA: randomUUID(),
  roleOwnerB: randomUUID(),
  roleWsA: randomUUID(),
  roleWsB: randomUUID(),
  auditA: randomUUID(),
  auditB: randomUUID(),
  eventA: randomUUID(),
  eventB: randomUUID(),
};

export async function seedTwoTenants(): Promise<void> {
  await withOwnerConnection(async (c) => {
    const user = (id: string, email: string) =>
      c.query(`INSERT INTO users (id, email, email_normalized, display_name) VALUES ($1, $2, $2, $2)`, [id, email]);
    await user(ids.userA, 'a@example.test');
    await user(ids.userB, 'b@example.test');
    await user(ids.userBoth, 'both@example.test');

    const org = (id: string, slug: string, by: string) =>
      c.query(`INSERT INTO organizations (id, name, slug, created_by_user_id) VALUES ($1, $2, $2, $3)`, [id, slug, by]);
    await org(ids.orgA, 'org-a', ids.userA);
    await org(ids.orgB, 'org-b', ids.userB);

    const ws = (id: string, orgId: string, slug: string) =>
      c.query(`INSERT INTO workspaces (id, org_id, name, slug) VALUES ($1, $2, $3, $3)`, [id, orgId, slug]);
    await ws(ids.wsA1, ids.orgA, 'a1');
    await ws(ids.wsA2, ids.orgA, 'a2');
    await ws(ids.wsB1, ids.orgB, 'b1');

    const role = (id: string, orgId: string, key: string, scope: string) =>
      c.query(
        `INSERT INTO roles (id, org_id, key, name, scope, is_system, permissions) VALUES ($1, $2, $3, $3, $4, true, '{}')`,
        [id, orgId, key, scope],
      );
    await role(ids.roleOwnerA, ids.orgA, 'owner', 'organization');
    await role(ids.roleOwnerB, ids.orgB, 'owner', 'organization');
    await role(ids.roleWsA, ids.orgA, 'workspace_admin', 'workspace');
    await role(ids.roleWsB, ids.orgB, 'workspace_admin', 'workspace');

    const om = (orgId: string, userId: string, roleId: string) =>
      c.query(`INSERT INTO organization_memberships (id, org_id, user_id, role_id) VALUES ($1, $2, $3, $4)`, [
        randomUUID(),
        orgId,
        userId,
        roleId,
      ]);
    await om(ids.orgA, ids.userA, ids.roleOwnerA);
    await om(ids.orgB, ids.userB, ids.roleOwnerB);
    await om(ids.orgA, ids.userBoth, ids.roleOwnerA);
    await om(ids.orgB, ids.userBoth, ids.roleOwnerB);

    await c.query(
      `INSERT INTO workspace_memberships (id, org_id, workspace_id, user_id, role_id) VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), ids.orgB, ids.wsB1, ids.userB, ids.roleWsB],
    );

    for (const [orgId, wsId, locale] of [
      [ids.orgA, ids.wsA1, 'a1'],
      [ids.orgA, ids.wsA2, 'a2'],
      [ids.orgB, ids.wsB1, 'b1'],
    ] as const) {
      await c.query(`INSERT INTO workspace_settings (org_id, workspace_id, locale) VALUES ($1, $2, $3)`, [orgId, wsId, locale]);
    }

    const audit = (id: string, orgId: string) =>
      c.query(
        `INSERT INTO audit_logs (id, org_id, actor_type, action, correlation_id) VALUES ($1, $2, 'system', 'test.seed', $3)`,
        [id, orgId, randomUUID()],
      );
    await audit(ids.auditA, ids.orgA);
    await audit(ids.auditB, ids.orgB);

    const event = (id: string, orgId: string) =>
      c.query(
        `INSERT INTO domain_events (id, org_id, type, version, aggregate_type, aggregate_id, actor_type, source,
           correlation_id, payload, occurred_at)
         VALUES ($1, $2, 'organization.created', 1, 'organization', $2, 'system', 'test', $3, '{}', now())`,
        [id, orgId, randomUUID()],
      );
    await event(ids.eventA, ids.orgA);
    await event(ids.eventB, ids.orgB);

    await c.query(
      `INSERT INTO provider_message_routes (provider, provider_message_id, org_id, workspace_id, delivery_id)
       VALUES ('smtp', 'msg-b-1', $1, $2, $3)`,
      [ids.orgB, ids.wsB1, randomUUID()],
    );
  });
}
