import { randomUUID } from 'node:crypto';
import { consentFingerprint, EligibilityEvaluator } from '@workeasy/audience-core';
import { createDatabase, type Database, type TenantContext, type Tx } from '@workeasy/db';
import { resetTestDatabase, testDatabaseUrls, withOwnerConnection } from '@workeasy/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAudienceReadSide, PrismaEligibilityFactsReader, TenantScopeMismatchError, tenantScopeFor } from '../src/index.js';

const SECRET = 'infra-test-secret';
const SAME_EMAIL = 'same@example.test';
const id = () => randomUUID();
const ids = {
  user: id(),
  orgA: id(),
  orgB: id(),
  wsA: id(),
  wsA2: id(),
  wsB: id(),
  contactA: id(),
  contactA2: id(),
  contactB: id(),
  topicA: id(),
  topicB: id(),
};
let db: Database;

const A: TenantContext = { orgId: ids.orgA, workspaceId: ids.wsA, userId: null };
const scopeA = (tx: Tx) => ({ tx, orgId: ids.orgA, workspaceId: ids.wsA });

beforeAll(async () => {
  await resetTestDatabase();
  await withOwnerConnection(async (c) => {
    await c.query(`INSERT INTO users (id, email, email_normalized, display_name) VALUES ($1, 'i@x.test', 'i@x.test', 'I')`, [ids.user]);
    const workspaces = [
      [ids.orgA, ids.wsA, 'a', ids.contactA, ids.topicA],
      [ids.orgA, ids.wsA2, 'a2', ids.contactA2, null],
      [ids.orgB, ids.wsB, 'b', ids.contactB, ids.topicB],
    ] as const;
    for (const org of [ids.orgA, ids.orgB]) {
      await c.query(`INSERT INTO organizations (id, name, slug, created_by_user_id) VALUES ($1, $2, $2, $3)`, [org, `org-${org.slice(0, 8)}`, ids.user]);
    }
    for (const [org, ws, slug, contact, topic] of workspaces) {
      await c.query(`INSERT INTO workspaces (id, org_id, name, slug) VALUES ($1, $2, $3, $3)`, [ws, org, `ws-${slug}`]);
      // The same address in every workspace: nothing may be matched across workspaces by value.
      await c.query(`INSERT INTO contacts (id, org_id, workspace_id, first_name, search_text) VALUES ($1, $2, $3, $4, $4)`, [contact, org, ws, slug]);
      await c.query(
        `INSERT INTO contact_identities (id, org_id, workspace_id, contact_id, kind, value, value_normalized, is_primary) VALUES ($1, $2, $3, $4, 'email', $5, $5, true)`,
        [id(), org, ws, contact, SAME_EMAIL],
      );
      const ev = id();
      await c.query(
        `INSERT INTO consent_events (id, org_id, workspace_id, contact_id, channel, action, previous_state, new_state, source, actor_type, correlation_id, occurred_at, subject_fingerprint)
         VALUES ($1, $2, $3, $4, 'email', 'subscribed', 'none', 'granted', 'admin', 'user', $5, now(), $6)`,
        [ev, org, ws, contact, id(), consentFingerprint(SECRET, 'email', SAME_EMAIL)],
      );
      await c.query(
        `INSERT INTO consent_states (org_id, workspace_id, contact_id, channel, state, changed_by, last_event_id, changed_at, subject_fingerprint)
         VALUES ($1, $2, $3, 'email', 'granted', 'user', $4, now(), $5)`,
        [org, ws, contact, ev, consentFingerprint(SECRET, 'email', SAME_EMAIL)],
      );
      if (topic) {
        await c.query(`INSERT INTO topics (id, org_id, workspace_id, key, name, is_default) VALUES ($1, $2, $3, 'news', 'News', true)`, [topic, org, ws]);
        const tev = id();
        await c.query(
          `INSERT INTO consent_events (id, org_id, workspace_id, contact_id, topic_id, action, previous_state, new_state, source, actor_type, correlation_id, occurred_at)
           VALUES ($1, $2, $3, $4, $5, 'subscribed', 'none', 'subscribed', 'admin', 'user', $6, now())`,
          [tev, org, ws, contact, topic, id()],
        );
        await c.query(
          `INSERT INTO contact_topic_preferences (org_id, workspace_id, contact_id, topic_id, status, changed_by, last_event_id, changed_at) VALUES ($1, $2, $3, $4, 'subscribed', 'user', $5, now())`,
          [org, ws, contact, topic, tev],
        );
      }
    }
    // Workspace B suppresses the shared address; workspace A must not see it.
    await c.query(
      `INSERT INTO suppressions (id, org_id, workspace_id, channel, identity_kind, value_normalized, reason, source, active_key) VALUES ($1, $2, $3, 'all', 'email', $4, 'manual', 'admin', $5)`,
      [id(), ids.orgB, ids.wsB, SAME_EMAIL, `value:email:${SAME_EMAIL}:all`],
    );
  });
  db = createDatabase({ url: testDatabaseUrls().app, maxConnections: 2 });
});
afterAll(async () => db?.disconnect());

describe('eligibility facts adapter — tenant isolation', () => {
  it('reads only the scope workspace, even when other workspaces share ids-by-value and are named in the request', async () => {
    const facts = await db.withTenant(A, (tx) =>
      new PrismaEligibilityFactsReader().load(scopeA(tx), { contactIds: [ids.contactA, ids.contactA2, ids.contactB], channel: 'email', topicId: ids.topicA }),
    );
    expect(facts.contacts.map((c) => c.id)).toEqual([ids.contactA]);
    expect(new Set(facts.identities.map((i) => i.contactId))).toEqual(new Set([ids.contactA]));
    expect(facts.suppressions).toEqual([]); // workspace B's suppression of the same address is invisible
    expect(facts.consentStates.map((s) => s.contactId)).toEqual([ids.contactA]);
    expect(facts.topicPreferences).toEqual([{ contactId: ids.contactA, status: 'subscribed' }]);
  });

  it("another workspace's topic is not found", async () => {
    const facts = await db.withTenant(A, (tx) => new PrismaEligibilityFactsReader().load(scopeA(tx), { contactIds: [ids.contactA], channel: 'email', topicId: ids.topicB }));
    expect(facts.topic).toEqual({ found: false });
    expect(facts.contacts).toEqual([]);
  });

  it('end to end through the port: eligible in A; B and A2 contacts are notFound, never evaluated', async () => {
    const { eligibility } = createAudienceReadSide({ fingerprintSecret: SECRET });
    const r = await db.withTenant(A, (tx) =>
      eligibility.evaluate(scopeA(tx), { contactIds: [ids.contactA, ids.contactB, ids.contactA2], channel: 'email', purpose: 'marketing', topicId: ids.topicA }),
    );
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ contactId: ids.contactA, eligible: true, reasons: [] });
    expect(r.notFound.sort()).toEqual([ids.contactB, ids.contactA2].sort());
  });

  it('the stored fingerprint binds consent to the address with the same secret; another secret reads as an address change', async () => {
    const wrong = new EligibilityEvaluator<Tx>(new PrismaEligibilityFactsReader(), 'another-secret');
    const r = await db.withTenant(A, (tx) => wrong.evaluate(scopeA(tx), { contactIds: [ids.contactA], channel: 'email', purpose: 'marketing' }));
    expect(r.results[0]!.reasons.map((x) => x.code)).toEqual(['CONSENT_ADDRESS_CHANGED']);
  });
});

describe('tenant scope is mandatory and must match the transaction', () => {
  const reader = new PrismaEligibilityFactsReader();
  const q = { contactIds: [ids.contactA], channel: 'email' as const, topicId: null };

  it.each([
    ['another workspace of the same org', { orgId: ids.orgA, workspaceId: ids.wsA2 }],
    ['another org', { orgId: ids.orgB, workspaceId: ids.wsB }],
    ['the right workspace with the wrong org', { orgId: ids.orgB, workspaceId: ids.wsA }],
    ['an empty scope', { orgId: '', workspaceId: '' }],
  ])('a scope labelled with %s is refused before reading', async (_label, labels) => {
    await expect(db.withTenant(A, (tx) => reader.load({ tx, ...labels }, q))).rejects.toBeInstanceOf(TenantScopeMismatchError);
  });

  it('an org-only transaction (no workspace) is refused', async () => {
    await expect(db.withTenant({ orgId: ids.orgA, workspaceId: null, userId: null }, (tx) => reader.load(scopeA(tx), q))).rejects.toBeInstanceOf(TenantScopeMismatchError);
    await expect(db.withTenant({ orgId: ids.orgA, workspaceId: null, userId: null }, (tx) => tenantScopeFor(tx, ids.wsA))).rejects.toBeInstanceOf(TenantScopeMismatchError);
  });

  it('tenantScopeFor takes the org from the transaction and refuses a foreign workspace id', async () => {
    await expect(db.withTenant(A, (tx) => tenantScopeFor(tx, ids.wsA).then((s) => ({ orgId: s.orgId, workspaceId: s.workspaceId })))).resolves.toEqual({
      orgId: ids.orgA,
      workspaceId: ids.wsA,
    });
    await expect(db.withTenant(A, (tx) => tenantScopeFor(tx, ids.wsB))).rejects.toBeInstanceOf(TenantScopeMismatchError);
  });
});

describe('batching', () => {
  /** Counts SQL queries made through a transaction: Prisma delegate calls and raw queries (`$queryRaw`, `$executeRaw`). */
  function counting(tx: Tx) {
    const calls: string[] = [];
    const proxy = new Proxy(tx, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof prop === 'string' && !prop.startsWith('$') && value && typeof value === 'object') {
          return new Proxy(value, {
            get(delegate, method) {
              const fn: unknown = Reflect.get(delegate, method);
              return typeof fn === 'function' ? (...args: unknown[]) => (calls.push(`${prop}.${String(method)}`), fn.apply(delegate, args)) : fn;
            },
          });
        }
        if (typeof prop === 'string' && /^\$(query|execute)Raw/.test(prop) && typeof value === 'function') {
          return (...args: unknown[]) => (calls.push(prop), (value as (...a: unknown[]) => unknown).apply(target, args));
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return { proxy, calls };
  }

  it('a fixed number of queries per batch, independent of its size (no per-contact queries)', async () => {
    const extra = Array.from({ length: 250 }, () => randomUUID());
    const run = (contactIds: string[]) =>
      db.withTenant(A, async (tx) => {
        const { proxy, calls } = counting(tx);
        await new PrismaEligibilityFactsReader().load(scopeA(proxy), { contactIds, channel: 'email', topicId: ids.topicA });
        return calls;
      });
    const one = await run([ids.contactA]);
    const many = await run([ids.contactA, ...extra]);
    expect(one).toEqual(many);
    // the tenant-scope check, then topic, contacts, identities, suppressions, consent states, retention policy, topic preferences (raw SQL with one
    // uuid[] parameter each since Gate E, 2026-10-10) — seven, whatever the batch size.
    expect(one).toEqual(['$queryRaw', 'topic.findUnique', '$queryRaw', '$queryRaw', '$queryRaw', '$queryRaw', 'consentRetentionPolicy.findUnique', '$queryRaw']);
  });
});
