/**
 * D2 correctness (docs/audit/phase-6.3-g2-closure.md): set-algebra resolution + chunked snapshot storage must produce
 * EXACTLY the pure core reference (captureMembers over the workspace's rows) — count, capture size and the full paged
 * snapshot in ascending order — for randomized workspaces and definitions, at several chunk and page sizes. And T0:
 * the snapshot is frozen at capture, while the live eligibility checks (consent, suppression, topic, address,
 * deletion/erasure) keep evaluating the current state.
 */
import { randomUUID } from 'node:crypto';
import { AudienceResolutionError, captureMembers, compareContactIds, consentFingerprint } from '@workeasy/audience-core';
import { createDatabase, type Database, type TenantContext } from '@workeasy/db';
import { resetTestDatabase, testDatabaseUrls, withOwnerConnection } from '@workeasy/db/testing';
import type { AudienceDefinitionV1, AudienceSelector } from '@workeasy/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CAPTURE_TRANSACTION_TIMEOUT_MS, createAudienceReadSide, PrismaAudienceResolution } from '../src/index.js';

const SECRET = 'd2-correctness-secret';
const CASES = Number(process.env.D2_CASES ?? 400);
let db: Database;
const user = randomUUID();
const orgs = [randomUUID(), randomUUID()];
let seed = 6_300_201;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
const sample = <T,>(xs: T[], k: number) => [...xs].sort(() => rnd() - 0.5).slice(0, k);

type Outcome = { kind: 'ok'; ids: string[] } | { kind: 'error'; code: string };

async function inWs<T>(w: TenantContext, fn: (s: { tx: never; orgId: string; workspaceId: string }) => Promise<T>) {
  return db.withTenant(w, (tx) => fn({ tx: tx as never, orgId: w.orgId, workspaceId: w.workspaceId! }), { timeout: CAPTURE_TRANSACTION_TIMEOUT_MS });
}
const code = (e: unknown) => (e instanceof AudienceResolutionError ? e.code : String((e as { code?: string })?.code ?? e));

/** Reference: the pure core over every row of the workspace (owner read, no SQL set logic involved). */
async function reference(w: TenantContext, def: AudienceDefinitionV1): Promise<Outcome> {
  const rows = await withOwnerConnection(async (c) => ({
    lists: (await c.query(`SELECT id::text FROM lists WHERE workspace_id = $1 AND deleted_at IS NULL`, [w.workspaceId])).rows.map((r) => r.id as string),
    tags: (await c.query(`SELECT id::text FROM tags WHERE workspace_id = $1 AND deleted_at IS NULL`, [w.workspaceId])).rows.map((r) => r.id as string),
    lm: (await c.query(`SELECT list_id::text AS s, contact_id::text AS c FROM list_memberships WHERE workspace_id = $1`, [w.workspaceId])).rows,
    ct: (await c.query(`SELECT tag_id::text AS s, contact_id::text AS c FROM contact_tags WHERE workspace_id = $1`, [w.workspaceId])).rows,
    live: (await c.query(`SELECT id::text FROM contacts WHERE workspace_id = $1 AND deleted_at IS NULL AND erased_at IS NULL`, [w.workspaceId])).rows.map((r) => r.id as string),
  }));
  const members = new Map<string, string[]>();
  for (const l of rows.lists) members.set(`list:${l}`, []);
  for (const t of rows.tags) members.set(`tag:${t}`, []);
  for (const r of rows.lm) members.get(`list:${r.s}`)?.push(r.c);
  for (const r of rows.ct) members.get(`tag:${r.s}`)?.push(r.c);
  try {
    return { kind: 'ok', ids: captureMembers(def, members, new Set(rows.live)) };
  } catch (e) {
    return { kind: 'error', code: code(e) };
  }
}

/** D2: count, then capture and read the whole snapshot back through page(). */
async function d2(w: TenantContext, def: AudienceDefinitionV1, chunkSize: number, pageSize: number) {
  const r = new PrismaAudienceResolution({ chunkSize });
  const count = await inWs(w, (s) => r.count(s, def)).then((c) => ({ kind: 'ok' as const, n: c.count }), (e) => ({ kind: 'error' as const, code: code(e) }));
  const captured = await inWs(w, async (s) => {
    const ref = await r.capture(s, def, randomUUID(), { kind: 'campaign_execution', id: randomUUID() });
    return ref;
  }).then((ref) => ({ kind: 'ok' as const, ref }), (e) => ({ kind: 'error' as const, code: code(e) }));
  if (captured.kind === 'error') return { count, capture: captured };
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const p = await inWs(w, (s) => r.page(s, captured.ref.snapshotId, { cursor, limit: pageSize }));
    ids.push(...p.contactIds);
    cursor = p.cursor;
  } while (cursor);
  return { count, capture: { kind: 'ok' as const, size: captured.ref.size, ids } };
}

async function newWorkspace(org: string, i: number) {
  const w: TenantContext = { orgId: org, workspaceId: randomUUID(), userId: null };
  await withOwnerConnection((c) => c.query(`INSERT INTO workspaces (id, org_id, name, slug) VALUES ($1, $2, $3, $3)`, [w.workspaceId, org, `d2-${i}-${w.workspaceId!.slice(0, 6)}`]));
  return w;
}

/** A random workspace with every fact that must NOT influence membership (consent, suppression, topics, address, subscription). */
async function randomWorkspace(i: number) {
  const org = orgs[i % 2]!;
  const w = await newWorkspace(org, i);
  const ws = w.workspaceId!;
  const n = Math.floor(rnd() * 70);
  const contacts = Array.from({ length: n }, () => ({ id: randomUUID(), deleted: rnd() < 0.1, erased: rnd() < 0.06, sub: pick(['marketing', 'non_marketing', 'unsubscribed'] as const), email: rnd() < 0.85 }));
  const density = pick([0, 0.05, 0.3, 0.7, 1]);
  const lists = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => ({ id: randomUUID(), archived: rnd() < 0.2, deleted: rnd() < 0.05, members: contacts.filter(() => rnd() < density).map((c) => c.id) }));
  const tags = Array.from({ length: Math.floor(rnd() * 4) }, () => ({ id: randomUUID(), deleted: rnd() < 0.05, members: contacts.filter(() => rnd() < density).map((c) => c.id) }));
  const topic = randomUUID();
  await withOwnerConnection(async (c) => {
    await c.query(`INSERT INTO topics (id, org_id, workspace_id, key, name, is_default) VALUES ($1, $2, $3, 'news', 'News', true)`, [topic, org, ws]);
    for (const ct of contacts) {
      await c.query(`INSERT INTO contacts (id, org_id, workspace_id, deleted_at, erased_at, subscription_type) VALUES ($1, $2, $3, $4, $5, $6)`,
        [ct.id, org, ws, ct.deleted || ct.erased ? new Date() : null, ct.erased ? new Date() : null, ct.sub]);
      if (ct.email) {
        const addr = `${ct.id}@d2.test`;
        await c.query(`INSERT INTO contact_identities (id, org_id, workspace_id, contact_id, kind, value, value_normalized, is_primary) VALUES ($1, $2, $3, $4, 'email', $5, $5, true)`, [randomUUID(), org, ws, ct.id, addr]);
        const state = pick(['granted', 'withdrawn', null] as const);
        if (state) {
          const ev = randomUUID();
          await c.query(`INSERT INTO consent_events (id, org_id, workspace_id, contact_id, channel, action, previous_state, new_state, source, actor_type, correlation_id, occurred_at, subject_fingerprint)
                         VALUES ($1, $2, $3, $4, 'email', $5, 'none', $6, 'admin', 'user', $7, now(), $8)`,
            [ev, org, ws, ct.id, state === 'granted' ? 'subscribed' : 'unsubscribed', state, randomUUID(), consentFingerprint(SECRET, 'email', addr)]);
          await c.query(`INSERT INTO consent_states (org_id, workspace_id, contact_id, channel, state, changed_by, last_event_id, changed_at, subject_fingerprint) VALUES ($1, $2, $3, 'email', $4, 'user', $5, now(), $6)`,
            [org, ws, ct.id, state, ev, consentFingerprint(SECRET, 'email', addr)]);
        }
        if (rnd() < 0.1) await c.query(`INSERT INTO suppressions (id, org_id, workspace_id, channel, contact_id, reason, source, active_key) VALUES ($1, $2, $3, 'all', $4, 'manual', 'admin', $5)`, [randomUUID(), org, ws, ct.id, `contact:${ct.id}:all`]);
      }
      if (rnd() < 0.5) {
        const tev = randomUUID();
        const status = pick(['subscribed', 'unsubscribed'] as const);
        await c.query(`INSERT INTO consent_events (id, org_id, workspace_id, contact_id, topic_id, action, previous_state, new_state, source, actor_type, correlation_id, occurred_at)
                       VALUES ($1, $2, $3, $4, $5, $6, 'none', $6, 'admin', 'user', $7, now())`, [tev, org, ws, ct.id, topic, status, randomUUID()]);
        await c.query(`INSERT INTO contact_topic_preferences (org_id, workspace_id, contact_id, topic_id, status, changed_by, last_event_id, changed_at) VALUES ($1, $2, $3, $4, $5, 'user', $6, now())`, [org, ws, ct.id, topic, status, tev]);
      }
    }
    for (const [j, l] of lists.entries()) {
      await c.query(`INSERT INTO lists (id, org_id, workspace_id, name, name_key, status) VALUES ($1, $2, $3, $4, $4, $5)`, [l.id, org, ws, `l${j}`, l.archived ? 'archived' : 'active']);
      if (l.deleted) await c.query(`UPDATE lists SET deleted_at = now(), name_key = NULL WHERE id = $1`, [l.id]);
      else if (l.members.length) await c.query(`INSERT INTO list_memberships (org_id, workspace_id, list_id, contact_id) SELECT $1, $2, $3, unnest($4::uuid[])`, [org, ws, l.id, l.members]);
    }
    for (const [j, t] of tags.entries()) {
      await c.query(`INSERT INTO tags (id, org_id, workspace_id, name, name_key) VALUES ($1, $2, $3, $4, $4)`, [t.id, org, ws, `t${j}`]);
      if (t.deleted) await c.query(`UPDATE tags SET deleted_at = now(), name_key = NULL WHERE id = $1`, [t.id]);
      else if (t.members.length) await c.query(`INSERT INTO contact_tags (org_id, workspace_id, tag_id, contact_id) SELECT $1, $2, $3, unnest($4::uuid[])`, [org, ws, t.id, t.members]);
    }
  });
  const pool: AudienceSelector[] = [...lists.map((l) => ({ type: 'list' as const, listId: l.id })), ...tags.map((t) => ({ type: 'tag' as const, tagId: t.id }))];
  return { w, pool };
}

function randomDefinition(pool: AudienceSelector[]): { def: AudienceDefinitionV1; shape: string } {
  const r = rnd();
  if (r < 0.04) return { def: { include: [], exclude: sample(pool, 1) }, shape: 'empty include' };
  if (r < 0.08 && pool.length) {
    const s = pick(pool);
    return { def: { include: [s], exclude: [s] }, shape: 'conflicting include/exclude' };
  }
  const chosen = sample(pool, Math.min(pool.length, 1 + Math.floor(rnd() * 5)));
  const nInc = Math.max(1, Math.ceil(chosen.length * rnd()));
  return { def: { include: chosen.slice(0, nInc), exclude: chosen.slice(nInc) }, shape: chosen.length - nInc ? 'mixed with exclusions' : 'includes only' };
}

beforeAll(async () => {
  await resetTestDatabase();
  await withOwnerConnection(async (c) => {
    await c.query(`INSERT INTO users (id, email, email_normalized, display_name) VALUES ($1, 'd2@x.test', 'd2@x.test', 'D2')`, [user]);
    for (const [i, org] of orgs.entries()) await c.query(`INSERT INTO organizations (id, name, slug, created_by_user_id) VALUES ($1, $2, $2, $3)`, [org, `d2-org-${i}`, user]);
  });
  db = createDatabase({ url: testDatabaseUrls().app, maxConnections: 4 });
});
afterAll(async () => db?.disconnect());

describe('D2 equals the core reference exactly', () => {
  it(`${CASES} randomized workspaces and definitions (chunk sizes 1, 3, 7, 1000; page sizes 1, 2, 5, 1000)`, { timeout: 3_600_000 }, async () => {
    const totals = { cases: 0, compared: 0, errors: 0, empty: 0, shapes: {} as Record<string, number>, mismatches: [] as unknown[] };
    for (let i = 0; i < CASES; i++) {
      const { w, pool } = await randomWorkspace(i);
      const { def, shape } = randomDefinition(pool);
      const chunkSize = pick([1, 3, 7, 1000]);
      const pageSize = pick([1, 2, 5, 1000]);
      const expected = await reference(w, def);
      const got = await d2(w, def, chunkSize, pageSize);
      totals.cases++;
      totals.shapes[shape] = (totals.shapes[shape] ?? 0) + 1;
      if (expected.kind === 'error') {
        totals.errors++;
        const ok = got.count.kind === 'error' && got.count.code === expected.code && got.capture.kind === 'error' && got.capture.code === expected.code;
        if (!ok) totals.mismatches.push({ i, shape, def, expected, got });
        continue;
      }
      if (expected.ids.length === 0) totals.empty++;
      totals.compared++;
      const ok =
        got.count.kind === 'ok' && got.count.n === expected.ids.length &&
        got.capture.kind === 'ok' && got.capture.size === expected.ids.length &&
        JSON.stringify(got.capture.ids) === JSON.stringify(expected.ids);
      if (!ok) totals.mismatches.push({ i, shape, chunkSize, pageSize, def, expected: expected.ids.length, got: { count: got.count, size: got.capture.kind === 'ok' ? got.capture.size : got.capture } });
    }
    console.log(JSON.stringify({ d2Randomized: { ...totals, mismatchCount: totals.mismatches.length, mismatches: totals.mismatches.slice(0, 3) } }));
    expect(totals.mismatches).toEqual([]);
  });

  it('size sweep 0, 1, 100, 1,000, 10,000, 100,000 members: identical ids, ascending, multi-chunk paging', { timeout: 1_800_000 }, async () => {
    const results: unknown[] = [];
    for (const size of [0, 1, 100, 1_000, 10_000, 100_000]) {
      const w = await newWorkspace(orgs[0]!, 9000 + size);
      const list = randomUUID();
      const excl = randomUUID();
      await withOwnerConnection(async (c) => {
        await c.query(`INSERT INTO lists (id, org_id, workspace_id, name, name_key) VALUES ($1, $2, $3, 'l', 'l'), ($4, $2, $3, 'x', 'x')`, [list, w.orgId, w.workspaceId, excl]);
        // size live members + 10 % excluded + 5 % deleted noise, so every part of the expression is exercised
        await c.query('BEGIN');
        await c.query(`CREATE TEMP TABLE t2 ON COMMIT DROP AS SELECT g, gen_random_uuid() AS id FROM generate_series(1, $1::int) g`, [Math.ceil(size * 1.15)]);
        await c.query(`INSERT INTO contacts (id, org_id, workspace_id, deleted_at) SELECT id, $1, $2, CASE WHEN g % 20 = 0 THEN now() END FROM t2`, [w.orgId, w.workspaceId]);
        await c.query(`INSERT INTO list_memberships (org_id, workspace_id, list_id, contact_id) SELECT $1, $2, $3, id FROM t2`, [w.orgId, w.workspaceId, list]);
        await c.query(`INSERT INTO list_memberships (org_id, workspace_id, list_id, contact_id) SELECT $1, $2, $3, id FROM t2 WHERE g % 10 = 3`, [w.orgId, w.workspaceId, excl]);
        await c.query('COMMIT');
      });
      const def: AudienceDefinitionV1 = { include: [{ type: 'list', listId: list }], exclude: [{ type: 'list', listId: excl }] };
      const expected = await reference(w, def);
      const got = await d2(w, def, 1000, 1000);
      const ids = got.capture.kind === 'ok' ? got.capture.ids : [];
      const ascending = ids.every((x, k) => k === 0 || compareContactIds(ids[k - 1]!, x) < 0);
      results.push({ requested: size, members: expected.kind === 'ok' ? expected.ids.length : expected, equal: expected.kind === 'ok' && JSON.stringify(ids) === JSON.stringify(expected.ids), ascending });
    }
    console.log(JSON.stringify({ d2Sweep: results }));
    for (const r of results as { equal: boolean; ascending: boolean }[]) expect([r.equal, r.ascending]).toEqual([true, true]);
  });
});

describe('T0: the snapshot is frozen; live checks stay live', () => {
  it('after capture, deletion, erasure, membership changes, suppression, consent withdrawal and topic opt-out change the live eligibility but never the snapshot', { timeout: 300_000 }, async () => {
    const w = await newWorkspace(orgs[1]!, 7777);
    const org = w.orgId;
    const ws = w.workspaceId!;
    const list = randomUUID();
    const topic = randomUUID();
    const ids = Array.from({ length: 12 }, () => randomUUID());
    await withOwnerConnection(async (c) => {
      await c.query(`INSERT INTO lists (id, org_id, workspace_id, name, name_key) VALUES ($1, $2, $3, 'l', 'l')`, [list, org, ws]);
      await c.query(`INSERT INTO topics (id, org_id, workspace_id, key, name, is_default) VALUES ($1, $2, $3, 'news', 'News', true)`, [topic, org, ws]);
      for (const id of ids) {
        const addr = `${id}@t0.test`;
        await c.query(`INSERT INTO contacts (id, org_id, workspace_id) VALUES ($1, $2, $3)`, [id, org, ws]);
        await c.query(`INSERT INTO contact_identities (id, org_id, workspace_id, contact_id, kind, value, value_normalized, is_primary) VALUES ($1, $2, $3, $4, 'email', $5, $5, true)`, [randomUUID(), org, ws, id, addr]);
        const ev = randomUUID();
        await c.query(`INSERT INTO consent_events (id, org_id, workspace_id, contact_id, channel, action, previous_state, new_state, source, actor_type, correlation_id, occurred_at, subject_fingerprint)
                       VALUES ($1, $2, $3, $4, 'email', 'subscribed', 'none', 'granted', 'admin', 'user', $5, now(), $6)`, [ev, org, ws, id, randomUUID(), consentFingerprint(SECRET, 'email', addr)]);
        await c.query(`INSERT INTO consent_states (org_id, workspace_id, contact_id, channel, state, changed_by, last_event_id, changed_at, subject_fingerprint) VALUES ($1, $2, $3, 'email', 'granted', 'user', $4, now(), $5)`,
          [org, ws, id, ev, consentFingerprint(SECRET, 'email', addr)]);
        const tev = randomUUID();
        await c.query(`INSERT INTO consent_events (id, org_id, workspace_id, contact_id, topic_id, action, previous_state, new_state, source, actor_type, correlation_id, occurred_at)
                       VALUES ($1, $2, $3, $4, $5, 'subscribed', 'none', 'subscribed', 'admin', 'user', $6, now())`, [tev, org, ws, id, topic, randomUUID()]);
        await c.query(`INSERT INTO contact_topic_preferences (org_id, workspace_id, contact_id, topic_id, status, changed_by, last_event_id, changed_at) VALUES ($1, $2, $3, $4, 'subscribed', 'user', $5, now())`, [org, ws, id, topic, tev]);
      }
      await c.query(`INSERT INTO list_memberships (org_id, workspace_id, list_id, contact_id) SELECT $1, $2, $3, unnest($4::uuid[])`, [org, ws, list, ids]);
    });
    const def: AudienceDefinitionV1 = { include: [{ type: 'list', listId: list }], exclude: [] };
    const r = new PrismaAudienceResolution({ chunkSize: 5 });
    const ref = await inWs(w, (s) => r.capture(s, def, randomUUID(), { kind: 'campaign_execution', id: randomUUID() }));
    const page = async () => (await inWs(w, (s) => r.page(s, ref.snapshotId, { cursor: null, limit: 1000 }))).contactIds;
    const before = await page();
    const { eligibility } = createAudienceReadSide({ fingerprintSecret: SECRET });
    const evaluate = () => inWs(w, (s) => eligibility.evaluate(s as never, { contactIds: ids, channel: 'email', purpose: 'marketing', topicId: topic }));
    const eligibleBefore = (await evaluate()).results.filter((x) => x.eligible).length;

    // changes after T0
    await withOwnerConnection(async (c) => {
      await c.query(`UPDATE contacts SET deleted_at = now() WHERE id = $1`, [ids[0]]);
      await c.query(`UPDATE contacts SET deleted_at = now(), erased_at = now() WHERE id = $1`, [ids[1]]);
      await c.query(`DELETE FROM list_memberships WHERE contact_id = $1`, [ids[2]]);
      await c.query(`INSERT INTO suppressions (id, org_id, workspace_id, channel, contact_id, reason, source, active_key) VALUES ($1, $2, $3, 'all', $4, 'manual', 'admin', $5)`, [randomUUID(), org, ws, ids[3], `contact:${ids[3]}:all`]);
      await c.query(`UPDATE consent_states SET state = 'withdrawn' WHERE contact_id = $1`, [ids[4]]);
      await c.query(`UPDATE contact_topic_preferences SET status = 'unsubscribed' WHERE contact_id = $1`, [ids[5]]);
      await c.query(`DELETE FROM contact_identities WHERE contact_id = $1`, [ids[6]]); // no address any more
      const extra = randomUUID();
      await c.query(`INSERT INTO contacts (id, org_id, workspace_id) VALUES ($1, $2, $3)`, [extra, org, ws]);
      await c.query(`INSERT INTO list_memberships (org_id, workspace_id, list_id, contact_id) VALUES ($1, $2, $3, $4)`, [org, ws, list, extra]);
    });
    const after = await page();
    const results = (await evaluate()).results;
    const liveCount = (await inWs(w, (s) => r.count(s, def))).count;
    const ineligible = ids.slice(0, 7).map((id) => results.find((x) => x.contactId === id)?.eligible ?? 'notFound');
    console.log(JSON.stringify({ d2T0: { snapshotBefore: before.length, snapshotAfter: after.length, frozen: JSON.stringify(before) === JSON.stringify(after), eligibleBefore, ineligibleAfterChange: ineligible, liveCountAfter: liveCount } }));
    expect(after).toEqual(before); // T0: membership frozen
    expect(before).toHaveLength(12);
    expect(eligibleBefore).toBe(12);
    // live: deleted, erased, suppressed, consent-withdrawn, topic-unsubscribed and address-less contacts are no longer
    // eligible. Removing a list membership after T0 changes neither the snapshot nor eligibility (eligibility is not
    // about membership): contact 2 stays in the snapshot and eligible.
    expect(ineligible[2]).toBe(true);
    for (const v of [0, 1, 3, 4, 5, 6].map((k) => ineligible[k])) expect(v === false || v === 'notFound').toBe(true);
    expect(liveCount).toBe(12 - 3 + 1); // count is live: −deleted −erased −removed membership +new member
  });
});
