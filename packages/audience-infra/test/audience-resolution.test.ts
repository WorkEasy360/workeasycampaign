/**
 * Audience Resolution v1 against the real database (docs/contracts/phase-5-audience.md §9.1–9.6; decisions A–O).
 * Seeding and "later" membership changes go through the owner connection; everything under test runs as
 * workeasy_app inside withTenant, exactly as production code will.
 */
import { randomUUID } from 'node:crypto';
import type { AudienceSelector } from '@workeasy/shared';
import { createDatabase, type Database, type TenantContext, type Tx } from '@workeasy/db';
import { resetTestDatabase, testDatabaseUrls, withOwnerConnection } from '@workeasy/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CAPTURE_TRANSACTION_TIMEOUT_MS,
  CaptureTransactionNotDedicatedError,
  createAudienceReadSide,
  discoverSnapshotCleanup,
  PrismaAudienceResolution,
  purgeUntilDone,
  resumeSnapshotPurges,
} from '../src/index.js';

const id = () => randomUUID();
const ORG_A = id();
const ORG_B = id();
const A: TenantContext = { orgId: ORG_A, workspaceId: id(), userId: null };
const A2: TenantContext = { orgId: ORG_A, workspaceId: id(), userId: null };
const B: TenantContext = { orgId: ORG_B, workspaceId: id(), userId: null };
const USER = id();
const owner = (kind = 'campaign_execution' as const) => ({ kind, id: id() });
const list = (listId: string): AudienceSelector => ({ type: 'list', listId });
const tag = (tagId: string): AudienceSelector => ({ type: 'tag', tagId });
const sorted = (xs: string[]) => [...xs].sort();

let db: Database;
const resolution = new PrismaAudienceResolution();

// ─── seeding (owner connection) ─────────────────────────────────────────────────────────────────────────────────
const sql = <T extends object = Record<string, unknown>>(q: string, v: unknown[] = []): Promise<{ rows: T[] }> =>
  withOwnerConnection(async (c) => ({ rows: (await c.query(q, v)).rows as T[] }));
async function contact(ws: TenantContext) {
  const c = id();
  await sql(`INSERT INTO contacts (id, org_id, workspace_id) VALUES ($1, $2, $3)`, [c, ws.orgId, ws.workspaceId]);
  return c;
}
async function newList(ws: TenantContext, opts: { archived?: boolean } = {}) {
  const l = id();
  await sql(`INSERT INTO lists (id, org_id, workspace_id, name, name_key, status) VALUES ($1, $2, $3, $4, $4, $5)`, [l, ws.orgId, ws.workspaceId, `l-${l}`, opts.archived ? 'archived' : 'active']);
  return l;
}
async function newTag(ws: TenantContext) {
  const t = id();
  await sql(`INSERT INTO tags (id, org_id, workspace_id, name, name_key) VALUES ($1, $2, $3, $4, $4)`, [t, ws.orgId, ws.workspaceId, `t-${t}`]);
  return t;
}
const addToList = (ws: TenantContext, l: string, ...cs: string[]) =>
  Promise.all(cs.map((c) => sql(`INSERT INTO list_memberships (org_id, workspace_id, list_id, contact_id) VALUES ($1, $2, $3, $4)`, [ws.orgId, ws.workspaceId, l, c])));
const removeFromList = (l: string, c: string) => sql(`DELETE FROM list_memberships WHERE list_id = $1 AND contact_id = $2`, [l, c]);
const addTag = (ws: TenantContext, t: string, ...cs: string[]) =>
  Promise.all(cs.map((c) => sql(`INSERT INTO contact_tags (org_id, workspace_id, tag_id, contact_id) VALUES ($1, $2, $3, $4)`, [ws.orgId, ws.workspaceId, t, c])));
/** Exactly what the Lists service does: soft delete + remove memberships in one transaction. */
const deleteList = (l: string) =>
  withOwnerConnection(async (c) => {
    await c.query('BEGIN');
    await c.query(`DELETE FROM list_memberships WHERE list_id = $1`, [l]);
    await c.query(`UPDATE lists SET deleted_at = now(), name_key = NULL WHERE id = $1`, [l]);
    await c.query('COMMIT');
  });
const deleteContact = (c: string) => sql(`UPDATE contacts SET deleted_at = now() WHERE id = $1`, [c]);

// ─── calling the adapter as workeasy_app ────────────────────────────────────────────────────────────────────────
const inTenant = <T>(ws: TenantContext, fn: (scope: { tx: Tx; orgId: string; workspaceId: string }) => Promise<T>) =>
  db.withTenant(ws, (tx) => fn({ tx, orgId: ws.orgId, workspaceId: ws.workspaceId! }), { timeout: CAPTURE_TRANSACTION_TIMEOUT_MS });
const capture = (ws: TenantContext, include: AudienceSelector[], exclude: AudienceSelector[] = [], key = id(), o = owner()) =>
  inTenant(ws, (s) => resolution.capture(s, { include, exclude }, key, o));
async function members(ws: TenantContext, snapshotId: string, limit?: number) {
  const out: string[] = [];
  let cursor: string | null = null;
  do {
    const p = await inTenant(ws, (s) => resolution.page(s, snapshotId, { cursor, limit }));
    out.push(...p.contactIds);
    cursor = p.cursor;
  } while (cursor);
  return out;
}
const errorCode = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string; name?: string }) => e.code ?? e.name ?? 'error');
const snapshotRows = (key: string) => sql<{ id: string; released_at: Date | null; release_reason: string | null; purged_at: Date | null; n: number }>(
  `SELECT s.id, s.released_at, s.release_reason, s.purged_at, (SELECT coalesce(sum(cardinality(c.contact_ids)), 0)::int FROM audience_snapshot_chunks c WHERE c.snapshot_id = s.id) AS n
   FROM audience_snapshots s WHERE s.capture_key = $1`,
  [key],
).then((r) => r.rows);

beforeAll(async () => {
  await resetTestDatabase();
  await sql(`INSERT INTO users (id, email, email_normalized, display_name) VALUES ($1, 'r@x.test', 'r@x.test', 'R')`, [USER]);
  for (const org of [ORG_A, ORG_B]) await sql(`INSERT INTO organizations (id, name, slug, created_by_user_id) VALUES ($1, $2, $2, $3)`, [org, `res-${org.slice(0, 8)}`, USER]);
  for (const ws of [A, A2, B]) await sql(`INSERT INTO workspaces (id, org_id, name, slug) VALUES ($1, $2, $3, $3)`, [ws.workspaceId, ws.orgId, `ws-${ws.workspaceId!.slice(0, 8)}`]);
  db = createDatabase({ url: testDatabaseUrls().app, maxConnections: 6 });
});
afterAll(async () => db?.disconnect());

// ─── validate + count (6.3.4) ───────────────────────────────────────────────────────────────────────────────────

describe('validate', () => {
  it('reports each source: ok, archived (lists), not_found (deleted, foreign or unknown)', async () => {
    const ok = await newList(A);
    const archived = await newList(A, { archived: true });
    const deleted = await newList(A);
    await deleteList(deleted);
    const foreign = await newList(B);
    const t = await newTag(A);
    const v = await inTenant(A, (s) => resolution.validate(s, { include: [list(ok), list(archived), tag(t), list(foreign)], exclude: [list(deleted), tag(id())] }));
    expect(v.sources.map((x) => x.status)).toEqual(['ok', 'archived', 'ok', 'not_found', 'not_found', 'not_found']);
    expect(v.valid).toBe(false);
    expect(v.errors.map((e) => e.code)).toEqual(['AUDIENCE_SOURCE_NOT_FOUND', 'AUDIENCE_SOURCE_NOT_FOUND', 'AUDIENCE_SOURCE_NOT_FOUND']);
    const archivedOnly = await inTenant(A, (s) => resolution.validate(s, { include: [list(archived)], exclude: [] }));
    expect(archivedOnly.valid).toBe(true);
  });

  it('an invalid definition is reported, never sent to SQL', async () => {
    const v = await inTenant(A, (s) => resolution.validate(s, { include: [{ type: 'list', listId: "x' OR 1=1 --" }], exclude: [] }));
    expect(v).toMatchObject({ valid: false, sources: [] });
    expect(v.errors.map((e) => e.code)).toEqual(['AUDIENCE_DEFINITION_INVALID']);
  });
});

describe('count', () => {
  it('union of includes minus excludes, live contacts only, each once; capped', async () => {
    const [c1, c2, c3, c4, c5] = await Promise.all([contact(A), contact(A), contact(A), contact(A), contact(A)]);
    const l = await newList(A);
    const t = await newTag(A);
    const x = await newList(A);
    await addToList(A, l, c1!, c2!, c3!);
    await addTag(A, t, c3!, c4!);
    await addToList(A, x, c2!);
    await deleteContact(c4!);
    await addToList(A, l, c5!);
    await sql(`UPDATE contacts SET erased_at = now() WHERE id = $1`, [c5]);
    const n = await inTenant(A, (s) => resolution.count(s, { include: [list(l), tag(t)], exclude: [list(x)] }));
    expect(n).toMatchObject({ count: 2, capped: false }); // c1, c3
    expect(await inTenant(A, (s) => resolution.count(s, { include: [list(l), tag(t)], exclude: [] }, { cap: 2 }))).toMatchObject({ count: 2, capped: true });
    expect(await inTenant(A, (s) => resolution.count(s, { include: [list(l), tag(t)], exclude: [] }, { cap: 3 }))).toMatchObject({ count: 3, capped: false });
  });

  it('an existing empty source counts 0; a missing source is AUDIENCE_SOURCE_NOT_FOUND (decision M)', async () => {
    const empty = await newList(A);
    expect((await inTenant(A, (s) => resolution.count(s, { include: [list(empty)], exclude: [] }))).count).toBe(0);
    expect(await errorCode(inTenant(A, (s) => resolution.count(s, { include: [list(id())], exclude: [] })))).toBe('AUDIENCE_SOURCE_NOT_FOUND');
  });
});

// ─── capture (6.3.5) ────────────────────────────────────────────────────────────────────────────────────────────

describe('capture', () => {
  it('captures union minus exclusion of live contacts, each once, with T0 = statement time', async () => {
    const [c1, c2, c3] = await Promise.all([contact(A), contact(A), contact(A)]);
    const l1 = await newList(A);
    const l2 = await newList(A, { archived: true });
    const t = await newTag(A);
    const x = await newList(A);
    await addToList(A, l1, c1!, c2!);
    await addToList(A, l2, c2!, c3!); // c2 in two sources
    await addTag(A, t, c3!);
    await addToList(A, x, c1!);
    const before = new Date();
    const ref = await capture(A, [list(l1), list(l2), tag(t)], [list(x)]);
    const after = new Date();
    expect(ref.size).toBe(2);
    expect(new Date(ref.capturedAt).getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(new Date(ref.capturedAt).getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
    expect(await members(A, ref.snapshotId)).toEqual(sorted([c2!, c3!]));
  });

  it('an existing source with zero members gives an empty snapshot, not an error', async () => {
    const empty = await newList(A);
    const ref = await capture(A, [list(empty)]);
    expect(ref.size).toBe(0);
    expect(await inTenant(A, (s) => resolution.page(s, ref.snapshotId, { cursor: null }))).toEqual({ contactIds: [], cursor: null });
  });

  it('a source deleted before T0 fails with AUDIENCE_SOURCE_NOT_FOUND and writes nothing', async () => {
    const l = await newList(A);
    await addToList(A, l, await contact(A));
    await deleteList(l);
    const key = id();
    const err = await capture(A, [list(l)], [], key).catch((e) => e);
    expect(err).toMatchObject({ code: 'AUDIENCE_SOURCE_NOT_FOUND', selector: { type: 'list', listId: l } });
    expect(await snapshotRows(key)).toEqual([]);
    // also when only an exclusion source is missing
    const ok = await newList(A);
    expect(await errorCode(capture(A, [list(ok)], [list(l)]))).toBe('AUDIENCE_SOURCE_NOT_FOUND');
  });

  it('above the capture limit: AUDIENCE_TOO_LARGE, and no snapshot row or member is committed', async () => {
    const small = new PrismaAudienceResolution({ captureLimit: 2 });
    const l = await newList(A);
    await addToList(A, l, ...(await Promise.all([contact(A), contact(A), contact(A)])));
    const key = id();
    const err = await inTenant(A, (s) => small.capture(s, { include: [list(l)], exclude: [] }, key, owner())).catch((e) => e);
    expect(err).toMatchObject({ code: 'AUDIENCE_TOO_LARGE' });
    expect(await snapshotRows(key)).toEqual([]);
    expect((await sql(`SELECT count(*)::int AS n FROM audience_snapshot_chunks m JOIN audience_snapshots s ON s.id = m.snapshot_id WHERE s.capture_key = $1`, [key])).rows[0]!.n).toBe(0);
    // exactly at the limit succeeds; the limit can never be raised above 5,000,000
    const at = new PrismaAudienceResolution({ captureLimit: 3 });
    expect((await inTenant(A, (s) => at.capture(s, { include: [list(l)], exclude: [] }, id(), owner()))).size).toBe(3);
    expect(new PrismaAudienceResolution({ captureLimit: 10_000_000 })).toMatchObject({ captureLimit: 5_000_000 });
  });

  it('refuses a transaction that has already written or locked something (decision K)', async () => {
    const l = await newList(A);
    const c = await contact(A);
    const err = await db
      .withTenant(A, async (tx) => {
        await tx.$queryRawUnsafe(`SELECT id FROM contacts WHERE id = $1::uuid FOR UPDATE`, c);
        return resolution.capture({ tx, orgId: A.orgId, workspaceId: A.workspaceId! }, { include: [list(l)], exclude: [] }, id(), owner());
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(CaptureTransactionNotDedicatedError);
  });

  it('the elevated timeout is local to the capture statement: the previous value is restored', async () => {
    const l = await newList(A);
    const [before, afterwards] = await db.withTenant(
      A,
      async (tx) => {
        const read = async () => (await tx.$queryRawUnsafe<{ t: string }[]>(`SELECT current_setting('statement_timeout') AS t`))[0]!.t;
        const b = await read();
        await resolution.capture({ tx, orgId: A.orgId, workspaceId: A.workspaceId! }, { include: [list(l)], exclude: [] }, id(), owner());
        return [b, await read()];
      },
      { timeout: CAPTURE_TRANSACTION_TIMEOUT_MS },
    );
    expect(afterwards).toBe(before);
    expect(before).not.toBe('5min');
  });
});

describe('capture keys (decisions B and C)', () => {
  it('same key + same definition + same owner returns the existing snapshot (order-insensitive)', async () => {
    const [l1, l2] = [await newList(A), await newList(A)];
    await addToList(A, l1, await contact(A));
    const key = id();
    const o = owner();
    const first = await capture(A, [list(l1), list(l2)], [], key, o);
    await addToList(A, l2, await contact(A)); // membership changed since: still the original capture
    const again = await capture(A, [list(l2), list(l1)], [], key, o);
    expect(again).toEqual(first);
    expect((await snapshotRows(key)).length).toBe(1);
  });

  it('a different definition or a different owner is AUDIENCE_SNAPSHOT_KEY_CONFLICT; ownership never transfers', async () => {
    const [l1, l2] = [await newList(A), await newList(A)];
    const key = id();
    const o = owner();
    await capture(A, [list(l1)], [], key, o);
    expect(await errorCode(capture(A, [list(l2)], [], key, o))).toBe('AUDIENCE_SNAPSHOT_KEY_CONFLICT');
    expect(await errorCode(capture(A, [list(l1)], [list(l2)], key, o))).toBe('AUDIENCE_SNAPSHOT_KEY_CONFLICT');
    expect(await errorCode(capture(A, [list(l1)], [], key, owner()))).toBe('AUDIENCE_SNAPSHOT_KEY_CONFLICT');
    const rows = await sql(`SELECT owner_id FROM audience_snapshots WHERE capture_key = $1`, [key]);
    expect(rows.rows).toEqual([{ owner_id: o.id }]);
  });

  it('a released key is never recaptured: AUDIENCE_SNAPSHOT_NOT_FOUND whatever is asked', async () => {
    const l = await newList(A);
    const key = id();
    const o = owner();
    await capture(A, [list(l)], [], key, o);
    await inTenant(A, (s) => resolution.releaseByKey(s, key, 'cancelled'));
    expect(await errorCode(capture(A, [list(l)], [], key, o))).toBe('AUDIENCE_SNAPSHOT_NOT_FOUND');
    expect(await errorCode(capture(A, [list(await newList(A))], [], key, owner()))).toBe('AUDIENCE_SNAPSHOT_NOT_FOUND');
    expect((await snapshotRows(key)).length).toBe(1);
  });

  it('keys are per workspace: B uses the same key independently and never observes A', async () => {
    const la = await newList(A);
    const lb = await newList(B);
    await addToList(A, la, await contact(A));
    const key = id();
    const a = await capture(A, [list(la)], [], key);
    const b = await capture(B, [list(lb)], [], key);
    expect(b.snapshotId).not.toBe(a.snapshotId);
    expect([a.size, b.size]).toEqual([1, 0]);
    expect(await inTenant(B, (s) => resolution.listUnreleased(s, 'campaign_execution', new Date(Date.now() + 60_000), 1000))).not.toContainEqual(
      expect.objectContaining({ snapshotId: a.snapshotId }),
    );
  });

  it('concurrent captures with one key create one snapshot and return it to both', async () => {
    const l = await newList(A);
    await addToList(A, l, ...(await Promise.all(Array.from({ length: 50 }, () => contact(A)))));
    const key = id();
    const o = owner();
    const [r1, r2] = await Promise.all([capture(A, [list(l)], [], key, o), capture(A, [list(l)], [], key, o)]);
    expect(r1).toEqual(r2);
    expect(await snapshotRows(key)).toEqual([expect.objectContaining({ n: 50 })]);
  });
});

// ─── T0 semantics: every case of Audience §9.2 against the real database ────────────────────────────────────────

describe('T0 — Audience §9.2', () => {
  it('membership, exclusion, source and contact changes around T0', async () => {
    const [inBoth, rmBefore, addBefore, rmAfter, exAfter, unexAfter, delAfter, addAfter, addRm, consentAfter, suppAfter] = await Promise.all(
      Array.from({ length: 11 }, () => contact(A)),
    );
    const inc = await newList(A);
    const t = await newTag(A);
    const exc = await newList(A);
    const doomed = await newList(A);
    await addToList(A, inc, inBoth!, rmBefore!, rmAfter!, exAfter!, unexAfter!, delAfter!, consentAfter!, suppAfter!);
    await addTag(A, t, inBoth!);
    await addToList(A, exc, unexAfter!);
    await addToList(A, doomed, ...[rmAfter!]);
    // 1 / 2: committed just before T0
    await addToList(A, inc, addBefore!);
    await removeFromList(inc, rmBefore!);

    const ref = await capture(A, [list(inc), tag(t), list(doomed)], [list(exc)]);
    const atT0 = await members(A, ref.snapshotId);

    // after T0
    await addToList(A, inc, addAfter!); // 3 / case 1
    await removeFromList(inc, rmAfter!); // 4 / case 2
    await addToList(A, exc, exAfter!); // 5 / case 3
    await removeFromList(exc, unexAfter!); // 6 / case 4
    await addToList(A, inc, addRm!); // case 5
    await removeFromList(inc, addRm!);
    await deleteList(doomed); // case 8b
    await deleteContact(delAfter!); // 8 / case 9b
    await sql(`INSERT INTO suppressions (id, org_id, workspace_id, channel, contact_id, reason, source, active_key) VALUES ($1, $2, $3, 'all', $4, 'manual', 'admin', $5)`, [
      id(),
      A.orgId,
      A.workspaceId,
      suppAfter,
      `contact:${suppAfter}:all`,
    ]); // 10 / case 10
    const ev = id();
    await sql(
      `INSERT INTO consent_events (id, org_id, workspace_id, contact_id, channel, action, previous_state, new_state, source, actor_type, correlation_id, occurred_at)
       VALUES ($1, $2, $3, $4, 'email', 'unsubscribed', 'none', 'withdrawn', 'admin', 'contact', $5, now())`,
      [ev, A.orgId, A.workspaceId, consentAfter, id()],
    );
    await sql(`INSERT INTO consent_states (org_id, workspace_id, contact_id, channel, state, changed_by, last_event_id, changed_at) VALUES ($1, $2, $3, 'email', 'withdrawn', 'contact', $4, now())`, [
      A.orgId,
      A.workspaceId,
      consentAfter,
      ev,
    ]); // 9 / case 10

    const expected = sorted([inBoth!, addBefore!, rmAfter!, exAfter!, delAfter!, consentAfter!, suppAfter!]);
    expect(atT0).toEqual(expected);
    expect(await members(A, ref.snapshotId)).toEqual(expected); // nothing after T0 changed the snapshot
    expect(atT0).not.toContain(rmBefore);
    expect(atT0).not.toContain(unexAfter);
    expect(atT0).not.toContain(addAfter);
    expect(atT0).not.toContain(addRm);

    // Eligibility stays live (Checkpoint A would see these changes): the snapshot carries membership only.
    const { eligibility } = createAudienceReadSide({ fingerprintSecret: 'res-test' });
    const r = await inTenant(A, (s) => eligibility.evaluate(s, { contactIds: [delAfter!, suppAfter!, consentAfter!], channel: 'email', purpose: 'marketing' }));
    const reasons = Object.fromEntries(r.results.map((x) => [x.contactId, x.reasons.map((y) => y.code)]));
    expect(reasons[delAfter!]).toContain('CONTACT_DELETED');
    expect(reasons[suppAfter!]).toContain('SUPPRESSED');
    expect(reasons[consentAfter!]).toContain('CONSENT_WITHDRAWN');
  });

  it('a membership change uncommitted during the capture statement is invisible and does not block it', async () => {
    const l = await newList(A);
    const c1 = await contact(A);
    const c2 = await contact(A);
    await addToList(A, l, c1);
    const writer = await withOwnerConnection(async (w) => {
      await w.query('BEGIN');
      await w.query(`INSERT INTO list_memberships (org_id, workspace_id, list_id, contact_id) VALUES ($1, $2, $3, $4)`, [A.orgId, A.workspaceId, l, c2]);
      const ref = await capture(A, [list(l)]); // runs while the writer's transaction is open
      await w.query('COMMIT');
      return ref;
    });
    expect(await members(A, writer.snapshotId)).toEqual([c1]);
    expect((await sql(`SELECT count(*)::int AS n FROM list_memberships WHERE list_id = $1`, [l])).rows[0]!.n).toBe(2);
  });
});

// ─── page (6.3.6) ───────────────────────────────────────────────────────────────────────────────────────────────

describe('page', () => {
  let snap: string;
  let all: string[];
  beforeAll(async () => {
    const l = await newList(A);
    const t = await newTag(A);
    const cs = await Promise.all(Array.from({ length: 5 }, () => contact(A)));
    await addToList(A, l, ...cs);
    await addTag(A, t, cs[0]!, cs[1]!); // duplicates across sources
    const ref = await capture(A, [list(l), tag(t)]);
    snap = ref.snapshotId;
    all = sorted(cs);
  });

  it('first, middle and final pages in ascending contact order; each contact once', async () => {
    const p1 = await inTenant(A, (s) => resolution.page(s, snap, { cursor: null, limit: 2 }));
    const p2 = await inTenant(A, (s) => resolution.page(s, snap, { cursor: p1.cursor, limit: 2 }));
    const p3 = await inTenant(A, (s) => resolution.page(s, snap, { cursor: p2.cursor, limit: 2 }));
    expect([p1.contactIds, p2.contactIds, p3.contactIds]).toEqual([all.slice(0, 2), all.slice(2, 4), all.slice(4)]);
    expect([p1.cursor === null, p2.cursor === null, p3.cursor]).toEqual([false, false, null]);
    expect(await members(A, snap, 1000)).toEqual(all);
  });

  it('is deterministic on repeat; an exact multiple of the page size ends with cursor null', async () => {
    const p1 = await inTenant(A, (s) => resolution.page(s, snap, { cursor: null, limit: 2 }));
    expect(await inTenant(A, (s) => resolution.page(s, snap, { cursor: p1.cursor, limit: 2 }))).toEqual(await inTenant(A, (s) => resolution.page(s, snap, { cursor: p1.cursor, limit: 2 })));
    expect(await inTenant(A, (s) => resolution.page(s, snap, { cursor: null, limit: 5 }))).toEqual({ contactIds: all, cursor: null });
  });

  it('rejects bad limits, tampered cursors and cursors of another snapshot', async () => {
    for (const limit of [0, 1001]) expect(await errorCode(inTenant(A, (s) => resolution.page(s, snap, { cursor: null, limit })))).toBe('AUDIENCE_LIMIT_INVALID');
    const other = (await capture(A, [list(await newList(A))])).snapshotId;
    const p1 = await inTenant(A, (s) => resolution.page(s, snap, { cursor: null, limit: 2 }));
    expect(await errorCode(inTenant(A, (s) => resolution.page(s, other, { cursor: p1.cursor, limit: 2 })))).toBe('AUDIENCE_CURSOR_INVALID');
    const forged = Buffer.from(JSON.stringify({ v: 1, s: snap, a: "x' OR 1=1 --" })).toString('base64url');
    expect(await errorCode(inTenant(A, (s) => resolution.page(s, snap, { cursor: forged })))).toBe('AUDIENCE_CURSOR_INVALID');
    expect(await errorCode(inTenant(A, (s) => resolution.page(s, snap, { cursor: 'garbage' })))).toBe('AUDIENCE_CURSOR_INVALID');
  });

  it("another workspace's snapshot, an unknown id and a non-UUID id are all AUDIENCE_SNAPSHOT_NOT_FOUND", async () => {
    for (const ws of [B, A2]) expect(await errorCode(inTenant(ws, (s) => resolution.page(s, snap, { cursor: null })))).toBe('AUDIENCE_SNAPSHOT_NOT_FOUND');
    expect(await errorCode(inTenant(A, (s) => resolution.page(s, id(), { cursor: null })))).toBe('AUDIENCE_SNAPSHOT_NOT_FOUND');
    expect(await errorCode(inTenant(A, (s) => resolution.page(s, 'not-a-uuid', { cursor: null })))).toBe('AUDIENCE_SNAPSHOT_NOT_FOUND');
  });
});

// ─── release + purge (6.3.7) ────────────────────────────────────────────────────────────────────────────────────

const perIdChunks = new PrismaAudienceResolution({ chunkSize: 1 });
async function capturedWith(n: number, ws: TenantContext = A) {
  const l = await newList(ws);
  await addToList(ws, l, ...(await Promise.all(Array.from({ length: n }, () => contact(ws)))));
  const key = id();
  // one id per chunk, so purge units of 2 members behave exactly as in the row-per-member design
  const ref = await inTenant(ws, (s) => perIdChunks.capture(s, { include: [list(l)], exclude: [] }, key, owner()));
  return { key, ref };
}

describe('releaseByKey', () => {
  const chunked = new PrismaAudienceResolution({ purgeChunk: 2 });
  const release = (ws: TenantContext, key: string, reason: 'cancelled' | 'failed' | 'materialized' | 'orphan_sweep', r = chunked) =>
    inTenant(ws, (s) => r.releaseByKey(s, key, reason));

  it('marks released (first reason kept), purges ≤ chunk per call, sets purged_at when none remain', async () => {
    const { key, ref } = await capturedWith(5);
    expect(await release(A, key, 'cancelled')).toEqual({ released: true, membersRemaining: true });
    let [row] = await snapshotRows(key);
    expect(row).toMatchObject({ release_reason: 'cancelled', purged_at: null, n: 3 });
    expect(row!.released_at).toBeInstanceOf(Date);
    expect(await errorCode(inTenant(A, (s) => resolution.page(s, ref.snapshotId, { cursor: null })))).toBe('AUDIENCE_SNAPSHOT_NOT_FOUND');
    expect(await release(A, key, 'failed')).toEqual({ released: true, membersRemaining: true });
    expect(await release(A, key, 'failed')).toEqual({ released: true, membersRemaining: false });
    [row] = await snapshotRows(key);
    expect(row).toMatchObject({ release_reason: 'cancelled', n: 0 });
    expect(row!.purged_at).toBeInstanceOf(Date);
    const purgedAt = row!.purged_at;
    expect(await release(A, key, 'orphan_sweep')).toEqual({ released: true, membersRemaining: false });
    expect((await snapshotRows(key))[0]!.purged_at).toEqual(purgedAt);
  });

  it('an unknown key, or another workspace\'s key, is { released: false, membersRemaining: false } and writes nothing', async () => {
    expect(await release(A, id(), 'cancelled')).toEqual({ released: false, membersRemaining: false });
    const { key } = await capturedWith(3);
    expect(await release(B, key, 'cancelled')).toEqual({ released: false, membersRemaining: false });
    expect(await release(A2, key, 'cancelled')).toEqual({ released: false, membersRemaining: false });
    expect(await snapshotRows(key)).toEqual([expect.objectContaining({ released_at: null, n: 3 })]);
  });

  it('a snapshot with no members is released and purged in one call', async () => {
    const { key } = await capturedWith(0);
    expect(await release(A, key, 'materialized', resolution)).toEqual({ released: true, membersRemaining: false });
    expect((await snapshotRows(key))[0]!.purged_at).toBeInstanceOf(Date);
  });

  it('concurrent releases of one key serialize on the row lock and converge', async () => {
    const { key } = await capturedWith(9);
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => release(A, key, i % 2 ? 'failed' : 'cancelled')));
    expect(results.every((r) => r.released)).toBe(true);
    await purgeUntilDone(db, chunked, { orgId: A.orgId, workspaceId: A.workspaceId! }, key, 'orphan_sweep');
    const [row] = await snapshotRows(key);
    expect(row!.n).toBe(0);
    expect(row!.purged_at).toBeInstanceOf(Date);
    expect(['cancelled', 'failed']).toContain(row!.release_reason);
  });
});

// ─── crash recovery (decision A) and discovery/sweep (6.3.8) ────────────────────────────────────────────────────

describe('crash recovery', () => {
  const chunked = new PrismaAudienceResolution({ purgeChunk: 2 });
  const W = { orgId: A.orgId, workspaceId: A.workspaceId! };

  it('crash before the release commits: the snapshot stays unreleased and intact', async () => {
    const { key } = await capturedWith(4);
    await db
      .withTenant(A, async (tx) => {
        await chunked.releaseByKey({ tx, ...W }, key, 'cancelled');
        throw new Error('simulated crash');
      })
      .catch(() => undefined);
    expect(await snapshotRows(key)).toEqual([expect.objectContaining({ released_at: null, purged_at: null, n: 4 })]);
  });

  it('crash after release / halfway / after the last chunk: listReleasedUnpurged finds it and recovery finishes it', async () => {
    const afterRelease = await capturedWith(5);
    const halfway = await capturedWith(7);
    const lastChunkGone = await capturedWith(3);
    await inTenant(A, (s) => chunked.releaseByKey(s, afterRelease.key, 'cancelled')); // committed, then "crash"
    for (let i = 0; i < 2; i++) await inTenant(A, (s) => chunked.releaseByKey(s, halfway.key, 'failed'));
    await inTenant(A, (s) => chunked.releaseByKey(s, lastChunkGone.key, 'materialized'));
    await sql(`DELETE FROM audience_snapshot_chunks WHERE snapshot_id = $1`, [lastChunkGone.ref.snapshotId]); // last chunk deleted, purged_at never written

    const pending = await inTenant(A, (s) => resolution.listReleasedUnpurged(s, 'campaign_execution', 1000));
    expect(pending.map((p) => p.captureKey)).toEqual(expect.arrayContaining([afterRelease.key, halfway.key, lastChunkGone.key]));
    for (const p of pending) expect(Object.keys(p).sort()).toEqual(['captureKey', 'ownerId', 'releasedAt', 'snapshotId']);

    const done = await resumeSnapshotPurges(db, chunked, W, { limit: 1000 });
    expect(done.snapshots).toBeGreaterThanOrEqual(3);
    for (const k of [afterRelease.key, halfway.key, lastChunkGone.key]) {
      const [row] = await snapshotRows(k);
      expect(row!.n).toBe(0);
      expect(row!.purged_at).toBeInstanceOf(Date);
    }
    expect(await inTenant(A, (s) => resolution.listReleasedUnpurged(s, 'campaign_execution', 1000))).toEqual([]);
  });

  it('discovery finds every workspace with cleanup; per-workspace recovery never crosses tenants', async () => {
    const a = await capturedWith(3, A);
    const b = await capturedWith(3, B); // > one chunk, so the release leaves members to purge
    await inTenant(A, (s) => chunked.releaseByKey(s, a.key, 'cancelled'));
    await inTenant(B, (s) => chunked.releaseByKey(s, b.key, 'cancelled'));
    const unreleased = await capturedWith(1, A2); // live snapshot: discovered only past the threshold, never purged by recovery
    const found = await discoverSnapshotCleanup(db, 'campaign_execution', new Date(Date.now() - 3_600_000));
    expect(found).toEqual(expect.arrayContaining([{ orgId: A.orgId, workspaceId: A.workspaceId }, { orgId: B.orgId, workspaceId: B.workspaceId }]));
    expect(found).not.toContainEqual({ orgId: A2.orgId, workspaceId: A2.workspaceId });
    expect(await discoverSnapshotCleanup(db, 'campaign_execution', new Date(Date.now() + 3_600_000))).toContainEqual({ orgId: A2.orgId, workspaceId: A2.workspaceId });

    await resumeSnapshotPurges(db, chunked, { orgId: B.orgId, workspaceId: B.workspaceId! });
    expect((await snapshotRows(b.key))[0]!.purged_at).toBeInstanceOf(Date);
    expect((await snapshotRows(a.key))[0]).toMatchObject({ purged_at: null, n: 1 }); // B's recovery never touched A
    await resumeSnapshotPurges(db, chunked, { orgId: A.orgId, workspaceId: A.workspaceId! });
    expect((await snapshotRows(a.key))[0]!.purged_at).toBeInstanceOf(Date);
    await resumeSnapshotPurges(db, chunked, { orgId: A2.orgId, workspaceId: A2.workspaceId! });
    expect(await snapshotRows(unreleased.key)).toEqual([expect.objectContaining({ released_at: null, n: 1 })]); // live snapshots are left alone
  });

  it('listUnreleased returns only unreleased snapshots older than the threshold, in this workspace, ids only', async () => {
    const { key, ref } = await capturedWith(1, A2);
    const later = await inTenant(A2, (s) => resolution.listUnreleased(s, 'campaign_execution', new Date(Date.now() + 60_000), 1000));
    expect(later.map((x) => x.captureKey)).toContain(key);
    expect(Object.keys(later[0]!).sort()).toEqual(['captureKey', 'capturedAt', 'ownerId', 'size', 'snapshotId']);
    expect(await inTenant(A2, (s) => resolution.listUnreleased(s, 'campaign_execution', new Date(Date.now() - 60_000), 1000))).not.toContainEqual(
      expect.objectContaining({ snapshotId: ref.snapshotId }),
    );
    expect(await inTenant(A, (s) => resolution.listUnreleased(s, 'campaign_execution', new Date(Date.now() + 60_000), 1000))).not.toContainEqual(
      expect.objectContaining({ snapshotId: ref.snapshotId }),
    );
  });
});
