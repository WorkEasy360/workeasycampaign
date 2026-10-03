/**
 * Phase 5 audience isolation at the database layer. Runs as the real runtime role (workeasy_app).
 * Workspace A1 and A2 belong to organization A; B1 belongs to organization B.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database, isNotFound, sqlStateOf } from '../src/index.js';
import { resetTestDatabase, testDatabaseUrls, withOwnerConnection } from '../src/testing.js';

const id = () => randomUUID();
const ids = {
  user: id(),
  orgA: id(),
  orgB: id(),
  a1: id(),
  a2: id(),
  b1: id(),
  contactA1: id(),
  contactA2: id(),
  contactB1: id(),
  listA1: id(),
  tagA1: id(),
  topicA1: id(),
  topicA2: id(),
  suppressionA1: id(),
  importA1: id(),
  fieldA1: id(),
  consentEventA1: id(),
};
let db: Database;
const ctx = (orgId: string, workspaceId: string | null) => ({ orgId, workspaceId, userId: ids.user });
const A1 = () => ctx(ids.orgA, ids.a1);
const A2 = () => ctx(ids.orgA, ids.a2);

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return sqlStateOf(e) ?? (isNotFound(e) ? 'P2025' : `unknown: ${(e as Error).message}`);
  }
  throw new Error('expected failure');
}

beforeAll(async () => {
  await resetTestDatabase();
  await withOwnerConnection(async (c) => {
    await c.query(`INSERT INTO users (id, email, email_normalized, display_name) VALUES ($1, 'u@x.test', 'u@x.test', 'U')`, [ids.user]);
    for (const [org, slug] of [[ids.orgA, 'a'], [ids.orgB, 'b']] as const) {
      await c.query(`INSERT INTO organizations (id, name, slug, created_by_user_id) VALUES ($1, $2, $2, $3)`, [org, `org-${slug}`, ids.user]);
    }
    const ws = [
      [ids.a1, ids.orgA, 'a1', ids.contactA1, ids.topicA1],
      [ids.a2, ids.orgA, 'a2', ids.contactA2, ids.topicA2],
      [ids.b1, ids.orgB, 'b1', ids.contactB1, id()],
    ] as const;
    for (const [w, org, slug, contact, topic] of ws) {
      await c.query(`INSERT INTO workspaces (id, org_id, name, slug) VALUES ($1, $2, $3, $3)`, [w, org, slug]);
      await c.query(`INSERT INTO contacts (id, org_id, workspace_id, first_name, search_text) VALUES ($1, $2, $3, $4, $4)`, [contact, org, w, slug]);
      await c.query(
        `INSERT INTO contact_identities (id, org_id, workspace_id, contact_id, kind, value, value_normalized, is_primary)
         VALUES ($1, $2, $3, $4, 'email', $5, $5, true)`,
        [id(), org, w, contact, 'same@example.test'],
      );
      await c.query(`INSERT INTO topics (id, org_id, workspace_id, key, name, is_default) VALUES ($1, $2, $3, 'marketing', 'Marketing', true)`, [topic, org, w]);
    }
    await c.query(`INSERT INTO lists (id, org_id, workspace_id, name, name_key) VALUES ($1, $2, $3, 'VIP', 'vip')`, [ids.listA1, ids.orgA, ids.a1]);
    await c.query(`INSERT INTO list_memberships (org_id, workspace_id, list_id, contact_id) VALUES ($1, $2, $3, $4)`, [ids.orgA, ids.a1, ids.listA1, ids.contactA1]);
    await c.query(`INSERT INTO tags (id, org_id, workspace_id, name, name_key) VALUES ($1, $2, $3, 'Lead', 'lead')`, [ids.tagA1, ids.orgA, ids.a1]);
    await c.query(`INSERT INTO contact_tags (org_id, workspace_id, tag_id, contact_id) VALUES ($1, $2, $3, $4)`, [ids.orgA, ids.a1, ids.tagA1, ids.contactA1]);
    await c.query(`INSERT INTO custom_field_definitions (id, org_id, workspace_id, key, label, type) VALUES ($1, $2, $3, 'plan', 'Plan', 'text')`, [ids.fieldA1, ids.orgA, ids.a1]);
    await c.query(
      `INSERT INTO consent_events (id, org_id, workspace_id, contact_id, channel, action, previous_state, new_state, source, actor_type, correlation_id, occurred_at)
       VALUES ($1, $2, $3, $4, 'email', 'subscribed', 'none', 'granted', 'admin', 'user', $5, now())`,
      [ids.consentEventA1, ids.orgA, ids.a1, ids.contactA1, id()],
    );
    await c.query(
      `INSERT INTO consent_states (org_id, workspace_id, contact_id, channel, state, changed_by, last_event_id, changed_at)
       VALUES ($1, $2, $3, 'email', 'granted', 'user', $4, now())`,
      [ids.orgA, ids.a1, ids.contactA1, ids.consentEventA1],
    );
    await c.query(
      `INSERT INTO suppressions (id, org_id, workspace_id, channel, contact_id, reason, source, active_key)
       VALUES ($1, $2, $3, 'all', $4, 'manual', 'admin', $5)`,
      [ids.suppressionA1, ids.orgA, ids.a1, ids.contactA1, `contact:${ids.contactA1}:all`],
    );
    await c.query(
      `INSERT INTO contact_imports (id, org_id, workspace_id, file_name, file_size, file_sha256) VALUES ($1, $2, $3, 'a.csv', 10, 'x')`,
      [ids.importA1, ids.orgA, ids.a1],
    );
    await c.query(
      `INSERT INTO domain_events (id, org_id, workspace_id, type, version, aggregate_type, aggregate_id, actor_type, source, correlation_id, payload, occurred_at)
       VALUES ($1, $2, $3, 'contact.created', 1, 'contact', $4, 'system', 'test', $5, '{}', now()),
              ($6, $2, NULL, 'organization.updated', 1, 'organization', $2, 'system', 'test', $5, '{}', now())`,
      [id(), ids.orgA, ids.a1, ids.contactA1, id(), id()],
    );
  });
  db = createDatabase({ url: testDatabaseUrls().app, maxConnections: 2 });
});
afterAll(async () => db?.disconnect());

describe('workspace isolation of audience data', () => {
  it('workspace A1 sees only its own rows in every audience table', async () => {
    const seen = await db.withTenant(A1(), async (tx) => ({
      contacts: await tx.contact.count(),
      identities: await tx.contactIdentity.count(),
      lists: await tx.contactList.count(),
      memberships: await tx.listMembership.count(),
      tags: await tx.tag.count(),
      contactTags: await tx.contactTag.count(),
      topics: await tx.topic.count(),
      fields: await tx.customFieldDefinition.count(),
      consentEvents: await tx.consentEvent.count(),
      consentStates: await tx.consentState.count(),
      suppressions: await tx.suppression.count(),
      imports: await tx.contactImport.count(),
    }));
    expect(seen).toEqual({
      contacts: 1, identities: 1, lists: 1, memberships: 1, tags: 1, contactTags: 1, topics: 1, fields: 1,
      consentEvents: 1, consentStates: 1, suppressions: 1, imports: 1,
    });
  });

  it('workspace A2 (same organization) sees none of A1’s list, tag, consent, suppression, import or field rows', async () => {
    const seen = await db.withTenant(A2(), async (tx) => ({
      a1Contact: await tx.contact.findUnique({ where: { id: ids.contactA1 } }),
      lists: await tx.contactList.count(),
      memberships: await tx.listMembership.count(),
      tags: await tx.tag.count(),
      consent: await tx.consentEvent.count(),
      suppressions: await tx.suppression.count(),
      imports: await tx.contactImport.count(),
      fields: await tx.customFieldDefinition.count(),
    }));
    expect(seen).toEqual({ a1Contact: null, lists: 0, memberships: 0, tags: 0, consent: 0, suppressions: 0, imports: 0, fields: 0 });
  });

  it('an organization-level context (no workspace) sees no audience data at all', async () => {
    expect(await db.withTenant(ctx(ids.orgA, null), (tx) => tx.contact.count())).toBe(0);
  });

  it('cannot insert into another workspace, even in the same organization', async () => {
    expect(
      await code(db.withTenant(A2(), (tx) => tx.contact.create({ data: { orgId: ids.orgA, workspaceId: ids.a1, firstName: 'x' } }))),
    ).toBe('42501');
  });

  it('cannot update or delete another workspace’s rows', async () => {
    const r = await db.withTenant(A2(), async (tx) => ({
      upd: (await tx.contact.updateMany({ where: { id: ids.contactA1 }, data: { firstName: 'pwned' } })).count,
      del: (await tx.listMembership.deleteMany({ where: { listId: ids.listA1 } })).count,
      untag: (await tx.contactTag.deleteMany({ where: { tagId: ids.tagA1 } })).count,
    }));
    expect(r).toEqual({ upd: 0, del: 0, untag: 0 });
  });

  it('a membership cannot link a list in A1 to a contact in A2 (composite foreign keys)', async () => {
    const r = await code(
      db.withTenant(A1(), (tx) =>
        tx.listMembership.create({ data: { orgId: ids.orgA, workspaceId: ids.a1, listId: ids.listA1, contactId: ids.contactA2 } }),
      ),
    );
    expect(r).toBe('23503');
  });

  it('the same address may exist once per workspace, but not twice in one workspace', async () => {
    const dup = await code(
      db.withTenant(A1(), (tx) =>
        tx.contactIdentity.create({
          data: { orgId: ids.orgA, workspaceId: ids.a1, contactId: ids.contactA1, kind: 'email', value: 'SAME@example.test', valueNormalized: 'same@example.test' },
        }),
      ),
    );
    expect(dup).toBe('23505');
  });

  it('tenant keys and identity values cannot be changed by the runtime role', async () => {
    expect(await code(db.withTenant(A1(), (tx) => tx.contact.update({ where: { id: ids.contactA1 }, data: { workspaceId: ids.a2 } })))).toBe('42501');
    expect(
      await code(db.withTenant(A1(), (tx) => tx.contactIdentity.updateMany({ where: { contactId: ids.contactA1 }, data: { valueNormalized: 'x@y.z' } }))),
    ).toBe('42501');
    expect(await code(db.withTenant(A1(), (tx) => tx.topic.update({ where: { id: ids.topicA1 }, data: { key: 'other' } })))).toBe('42501');
  });
});

describe('consent evidence is immutable', () => {
  it('the runtime role cannot update or delete consent events', async () => {
    expect(await code(db.withTenant(A1(), (tx) => tx.consentEvent.updateMany({ data: { action: 'revoked' } })))).toBe('42501');
    expect(await code(db.withTenant(A1(), (tx) => tx.consentEvent.deleteMany({})))).toBe('42501');
  });

  it('even the schema owner cannot update evidence (trigger)', async () => {
    await expect(withOwnerConnection((c) => c.query(`UPDATE consent_events SET action = 'revoked'`))).rejects.toThrow(/append-only/);
  });

  it('every event has exactly one scope: a channel or a topic', async () => {
    const both = await code(
      db.withTenant(A1(), (tx) =>
        tx.consentEvent.create({
          data: {
            orgId: ids.orgA, workspaceId: ids.a1, contactId: ids.contactA1, channel: 'email', topicId: ids.topicA1,
            action: 'subscribed', previousState: 'none', newState: 'granted', source: 'admin', actorType: 'user',
            correlationId: id(), occurredAt: new Date(),
          },
        }),
      ),
    );
    expect(both).toBe('23514');
  });
});

describe('suppressions', () => {
  it('cannot be deleted, only lifted', async () => {
    expect(await code(db.withTenant(A1(), (tx) => tx.suppression.deleteMany({})))).toBe('42501');
  });

  it('allow at most one active suppression per target and channel', async () => {
    const dup = await code(
      db.withTenant(A1(), (tx) =>
        tx.suppression.create({
          data: { orgId: ids.orgA, workspaceId: ids.a1, channel: 'all', contactId: ids.contactA1, reason: 'manual', source: 'admin', activeKey: `contact:${ids.contactA1}:all` },
        }),
      ),
    );
    expect(dup).toBe('23505');
  });

  it('must target a contact or an address, not both', async () => {
    const both = await code(
      db.withTenant(A1(), (tx) =>
        tx.suppression.create({
          data: {
            orgId: ids.orgA, workspaceId: ids.a1, channel: 'email', contactId: ids.contactA1, identityKind: 'email',
            valueNormalized: 'x@y.z', reason: 'manual', source: 'admin', activeKey: 'k',
          },
        }),
      ),
    );
    expect(both).toBe('23514');
  });
});

describe('domain events are workspace-scoped', () => {
  it('a workspace context sees its own and organization-level events, not other workspaces’', async () => {
    const a1 = await db.withTenant(A1(), (tx) => tx.domainEvent.findMany({ select: { type: true } }));
    const a2 = await db.withTenant(A2(), (tx) => tx.domainEvent.findMany({ select: { type: true } }));
    const org = await db.withTenant(ctx(ids.orgA, null), (tx) => tx.domainEvent.count());
    expect(a1.map((e) => e.type).sort()).toEqual(['contact.created', 'organization.updated']);
    expect(a2.map((e) => e.type)).toEqual(['organization.updated']);
    expect(org).toBe(2);
  });
});

describe('consent retention purge', () => {
  it('refuses to purge a workspace other than the current context', async () => {
    const r = await code(db.withTenant(A2(), (tx) => tx.$queryRaw`SELECT app.purge_consent_evidence(${ids.a1}::uuid)`));
    expect(r).toBe('42501');
  });

  it('deletes only evidence past the configured retention; granted consent is kept', async () => {
    const withdrawnContact = id();
    await withOwnerConnection(async (c) => {
      await c.query(`INSERT INTO contacts (id, org_id, workspace_id) VALUES ($1, $2, $3)`, [withdrawnContact, ids.orgA, ids.a1]);
      const e1 = id();
      const e2 = id();
      await c.query(
        `INSERT INTO consent_events (id, org_id, workspace_id, contact_id, channel, action, previous_state, new_state, source, actor_type, correlation_id, occurred_at)
         VALUES ($1, $3, $4, $5, 'email', 'subscribed', 'none', 'granted', 'admin', 'user', $6, now() - interval '3 days'),
                ($2, $3, $4, $5, 'email', 'unsubscribed', 'granted', 'withdrawn', 'admin', 'contact', $6, now() - interval '2 days')`,
        [e1, e2, ids.orgA, ids.a1, withdrawnContact, id()],
      );
      await c.query(
        `INSERT INTO consent_states (org_id, workspace_id, contact_id, channel, state, changed_by, last_event_id, changed_at)
         VALUES ($1, $2, $3, 'email', 'withdrawn', 'contact', $4, now() - interval '2 days')`,
        [ids.orgA, ids.a1, withdrawnContact, e2],
      );
      await c.query(
        `INSERT INTO consent_retention_policies (org_id, workspace_id, retain_after_withdrawal_days, retain_after_erasure_days) VALUES ($1, $2, 1, NULL)`,
        [ids.orgA, ids.a1],
      );
    });
    const purged = await db.withTenant(A1(), (tx) => tx.$queryRaw<{ n: number }[]>`SELECT app.purge_consent_evidence(${ids.a1}::uuid) AS n`);
    expect(purged[0]!.n).toBe(2);
    const left = await db.withTenant(A1(), (tx) => tx.consentEvent.findMany({ select: { id: true } }));
    expect(left.map((e) => e.id)).toEqual([ids.consentEventA1]);
  });

  it('a NULL retention keeps evidence indefinitely', async () => {
    await withOwnerConnection((c) => c.query(`UPDATE consent_retention_policies SET retain_after_withdrawal_days = NULL WHERE workspace_id = $1`, [ids.a1]));
    const purged = await db.withTenant(A1(), (tx) => tx.$queryRaw<{ n: number }[]>`SELECT app.purge_consent_evidence(${ids.a1}::uuid) AS n`);
    expect(purged[0]!.n).toBe(0);
  });
});
