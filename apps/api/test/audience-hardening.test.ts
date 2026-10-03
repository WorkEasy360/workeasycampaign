import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withAppConnection } from '@workeasy/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Agent,
  createOrg,
  inviteAndAccept,
  resetTestDatabase,
  signUp,
  startTestApp,
  type TestApp,
  uploadCsv,
  withOwnerConnection,
} from './support.js';

/**
 * Phase 5 hardening (docs/audit/phase-5-hardening-audit.md). Each block proves one finding's fix or one row of the
 * security test matrix, through the real HTTP API and database.
 */
let t: TestApp;
let owner: Agent;
let org: { orgId: string; workspaceId: string };
let W: string;
const url = (p: string, ws = W) => `/v1/workspaces/${ws}${p}`;
const FILES = join(tmpdir(), 'workeasy-test-files');

async function contact(agent: Agent, body: Record<string, unknown>, ws = W) {
  const r = await agent.post(url('/contacts', ws), body);
  if (r.status !== 201) throw new Error(`create contact failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { id: string; version: number };
}

async function eligibility(agent: Agent, contactId: string, extra: Record<string, unknown> = {}) {
  const r = await agent.post(url('/eligibility/check'), { contactIds: [contactId], channel: 'email', ...extra });
  return r;
}

/** Runs SQL as the API runtime role (workeasy_app) inside a tenant context, as the API does. */
const asAppRole = withAppConnection;

async function mapAndDryRun(agent: Agent, ws: string, importId: string, mapping: Record<string, string>, options: Record<string, unknown> = {}) {
  const imp = (await agent.get(url(`/imports/${importId}`, ws))).body;
  const put = await agent.put(url(`/imports/${importId}/mapping`, ws), { mapping, options: { mode: 'create_or_update', ...options }, version: imp.version });
  if (put.status !== 200) return put;
  return agent.post(url(`/imports/${importId}/dry-run`, ws));
}

beforeAll(async () => {
  await resetTestDatabase();
  t = await startTestApp();
  owner = await signUp(t, undefined, 'Owner');
  org = await createOrg(owner, 'Hardening Co');
  W = org.workspaceId;
});
afterAll(async () => t?.close());

describe('consent: retention cannot be shortened by backdating (H-1)', () => {
  it('a withdrawal dated years ago is measured from when it was RECORDED, so a purge keeps its evidence', async () => {
    const c = await contact(owner, { email: 'backdate@h.test' });
    const grant = await owner.post(url(`/contacts/${c.id}/consent`), { channel: 'email', action: 'subscribed', lawfulBasis: 'consent', source: 'paper', evidenceNote: 'Signed form' });
    expect(grant.status).toBe(201);
    const backdated = await owner.post(url(`/contacts/${c.id}/consent`), { channel: 'email', action: 'revoked', source: 'admin', occurredAt: '2010-01-01T00:00:00Z' });
    expect(backdated.status).toBe(201);
    await owner.put(url('/consent/retention-policy'), { retainAfterWithdrawalDays: 30, retainAfterErasureDays: 30, pendingExpiryDays: 7 });

    const purge = await owner.post(url('/consent/retention-purge'));
    expect(purge.body).toEqual({ deleted: 0 });
    expect((await owner.get(url(`/contacts/${c.id}/consent`))).body.data).toHaveLength(2);

    // Only once the withdrawal has really been on record for longer than the policy does the purge remove it.
    // Simulate 31 days passing. Evidence is append-only even for the owner role, so the test lifts the trigger inside
    // its own transaction just to move the clock — something no runtime role can do.
    await withOwnerConnection(async (db) => {
      await db.query('BEGIN');
      await db.query('ALTER TABLE consent_events DISABLE TRIGGER consent_events_append_only');
      await db.query(
        `UPDATE consent_events SET recorded_at = recorded_at - interval '31 days', occurred_at = least(occurred_at, recorded_at - interval '31 days') WHERE contact_id = $1`,
        [c.id],
      );
      await db.query('ALTER TABLE consent_events ENABLE TRIGGER consent_events_append_only');
      await db.query(`UPDATE consent_states SET recorded_at = recorded_at - interval '31 days' WHERE contact_id = $1`, [c.id]);
      await db.query('COMMIT');
    });
    expect((await owner.post(url('/consent/retention-purge'))).body).toEqual({ deleted: 2 });
    // The projection stays authoritative: the contact is still withdrawn, so still not eligible.
    expect((await eligibility(owner, c.id)).body.results[0].reasons.map((x: { code: string }) => x.code)).toEqual(['CONSENT_WITHDRAWN']);
  });

  it('refuses consent dated in the future (API validation and a database CHECK)', async () => {
    const c = await contact(owner, { email: 'future@h.test' });
    const r = await owner.post(url(`/contacts/${c.id}/consent`), {
      channel: 'email',
      action: 'subscribed',
      lawfulBasis: 'consent',
      source: 'paper',
      evidenceNote: 'x',
      occurredAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(r.status).toBe(400);
    const err = await withOwnerConnection((db) =>
      db
        .query(
          `INSERT INTO consent_events (id, org_id, workspace_id, contact_id, channel, action, previous_state, new_state, source, actor_type, correlation_id, occurred_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'email', 'subscribed', 'none', 'granted', 'admin', 'user', gen_random_uuid(), now() + interval '1 day')`,
          [org.orgId, W, c.id],
        )
        .then(() => null, (e: { code?: string }) => e.code),
    );
    expect(err).toBe('23514');
  });
});

describe('consent: bound to the address it was given for (H-2)', () => {
  it('changing the primary email stops old consent from counting; switching back restores it', async () => {
    const c = await contact(owner, { email: 'first@h.test' });
    await owner.post(url(`/contacts/${c.id}/consent`), { channel: 'email', action: 'subscribed', lawfulBasis: 'consent', source: 'form', evidenceNote: 'Signup form' });
    expect((await eligibility(owner, c.id)).body.results[0].eligible).toBe(true);

    const added = await owner.post(url(`/contacts/${c.id}/identities`), { kind: 'email', value: 'second@h.test' });
    const second = added.body.identities.find((i: { value: string }) => i.value === 'second@h.test');
    const first = added.body.identities.find((i: { value: string }) => i.value === 'first@h.test');
    // Adding a secondary address changes nothing: messages go to the primary.
    expect((await eligibility(owner, c.id)).body.results[0]).toMatchObject({ eligible: true, addressIdentityId: first.id });

    const switched = await owner.post(url(`/contacts/${c.id}/identities/${second.id}/primary`));
    expect(switched.body.consent.find((s: { channel: string }) => s.channel === 'email')).toMatchObject({ state: 'granted', appliesToPrimaryAddress: false });
    const r = (await eligibility(owner, c.id)).body.results[0];
    expect(r).toMatchObject({ eligible: false, addressIdentityId: second.id });
    expect(r.reasons.map((x: { code: string }) => x.code)).toEqual(['CONSENT_ADDRESS_CHANGED']);
    // The address itself is never returned, only its identity id.
    expect(JSON.stringify(r)).not.toContain('@h.test');

    await owner.post(url(`/contacts/${c.id}/identities/${first.id}/primary`));
    expect((await eligibility(owner, c.id)).body.results[0].eligible).toBe(true);
    const timeline = (await owner.get(url(`/contacts/${c.id}/timeline`))).body.data.map((e: { type: string }) => e.type);
    expect(timeline.filter((x: string) => x === 'contact.primary_identity_changed')).toHaveLength(2);
  });
});

describe('consent: pending requests expire (M-1)', () => {
  it('an unconfirmed request past the policy period is expired, never qualifies and cannot be confirmed', async () => {
    const c = await contact(owner, { email: 'pending@h.test' });
    await owner.post(url(`/contacts/${c.id}/consent`), { channel: 'email', action: 'pending', source: 'form' });
    expect((await eligibility(owner, c.id)).body.results[0].reasons.map((x: { code: string }) => x.code)).toEqual(['CONSENT_PENDING']);

    await withOwnerConnection((db) => db.query(`UPDATE consent_states SET recorded_at = now() - interval '8 days' WHERE contact_id = $1`, [c.id]));
    expect((await eligibility(owner, c.id)).body.results[0].reasons.map((x: { code: string }) => x.code)).toEqual(['CONSENT_EXPIRED']);
    expect((await owner.get(url(`/contacts/${c.id}`))).body.consent.find((s: { channel: string }) => s.channel === 'email').state).toBe('expired');

    const confirm = await owner.post(url(`/contacts/${c.id}/consent`), { channel: 'email', action: 'confirmed', lawfulBasis: 'consent', source: 'form', evidenceNote: 'late click' });
    expect(confirm.status).toBe(422);
    expect(confirm.body.error.fields.action).toEqual(['INVALID_TRANSITION']);
    // A fresh request starts over.
    expect((await owner.post(url(`/contacts/${c.id}/consent`), { channel: 'email', action: 'pending', source: 'form' })).body.changed).toBe(true);
    expect((await eligibility(owner, c.id)).body.results[0].reasons.map((x: { code: string }) => x.code)).toEqual(['CONSENT_PENDING']);
  });
});

describe('eligibility contract', () => {
  it('rejects a topic that is not in this workspace and reports foreign contacts as not found', async () => {
    const other = await createOrg(owner, 'Elsewhere');
    const foreignTopic = (await owner.get(url('/topics', other.workspaceId))).body.data[0].id;
    const foreignContact = await contact(owner, { email: 'foreign@h.test' }, other.workspaceId);
    const mine = await contact(owner, { email: 'mine@h.test' });
    const bad = await eligibility(owner, mine.id, { topicId: foreignTopic });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields.topicId).toBeDefined();
    const r = await owner.post(url('/eligibility/check'), { contactIds: [mine.id, foreignContact.id], channel: 'email' });
    expect(r.body.results.map((x: { contactId: string }) => x.contactId)).toEqual([mine.id]);
    expect(r.body.notFound).toEqual([foreignContact.id]);
  });
});

describe('authorization: import and create options need their own permissions (M-3)', () => {
  let importer: Agent;
  beforeAll(async () => {
    const role = await owner.post(`/v1/organizations/${org.orgId}/roles`, {
      name: 'Importer only',
      scope: 'workspace',
      permissions: ['workspace.read', 'contacts.read', 'contacts.create', 'contacts.import'],
    });
    expect(role.status).toBe(201);
    importer = await signUp(t, undefined, 'Importer');
    const memberRole = (await owner.get(`/v1/organizations/${org.orgId}/roles`)).body.data.find((r: { key: string }) => r.key === 'member').id;
    const inv = await owner.post(`/v1/organizations/${org.orgId}/invitations`, {
      email: (importer as Agent & { email: string }).email,
      organizationRoleId: memberRole,
      workspaces: [{ workspaceId: W, roleId: role.body.id }],
    });
    expect(inv.status).toBe(201);
    const ok = await importer.post('/v1/invitations/accept', { token: t.mailer.tokenFrom((importer as Agent & { email: string }).email, 'invitation') });
    expect(ok.status).toBe(200);
    await importer.put('/v1/me/context', { organizationId: org.orgId, workspaceId: W });
  });

  it('an importer without consent.manage cannot record consent, and without lists.manage cannot add to lists', async () => {
    const list = (await owner.post(url('/lists'), { name: 'Perm list' })).body;
    const up = await uploadCsv(importer, W, 'email\nperm@h.test\n');
    expect(up.status).toBe(201);
    const consent = await mapAndDryRun(importer, W, up.body.id, { 0: 'email' }, { consent: { channel: 'email', lawfulBasis: 'consent', evidenceNote: 'trust me' } });
    expect(consent.status).toBe(403);
    expect(consent.body.error.fields['options.consent']).toBeDefined();
    const lists = await mapAndDryRun(importer, W, up.body.id, { 0: 'email' }, { listIds: [list.id] });
    expect(lists.status).toBe(403);
    expect((await mapAndDryRun(importer, W, up.body.id, { 0: 'email' })).status).toBe(200);
    // Same rule when creating a contact directly.
    expect((await importer.post(url('/contacts'), { email: 'perm2@h.test', listIds: [list.id] })).status).toBe(403);
    expect((await importer.post(url('/contacts'), { email: 'perm2@h.test' })).status).toBe(201);
  });

  it('the permission is re-checked at start: options saved by someone else do not lend their permissions', async () => {
    const list = (await owner.post(url('/lists'), { name: 'Saved by owner' })).body;
    const up = await uploadCsv(owner, W, 'email\nlender@h.test\n');
    expect((await mapAndDryRun(owner, W, up.body.id, { 0: 'email' }, { listIds: [list.id] })).status).toBe(200);
    expect((await importer.post(url(`/imports/${up.body.id}/start`))).status).toBe(403);
    await owner.post(url(`/imports/${up.body.id}/cancel`));
  });
});

describe('imports: lifecycle and resource limits (M-4, M-5)', () => {
  it('only one import runs at a time in a workspace', async () => {
    const a = await uploadCsv(owner, W, 'email\nrun-a@h.test\n');
    const b = await uploadCsv(owner, W, 'email\nrun-b@h.test\n');
    await mapAndDryRun(owner, W, a.body.id, { 0: 'email' });
    await mapAndDryRun(owner, W, b.body.id, { 0: 'email' });
    await withOwnerConnection((db) => db.query(`UPDATE contact_imports SET status = 'processing' WHERE id = $1`, [a.body.id]));
    const blocked = await owner.post(url(`/imports/${b.body.id}/start`));
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.fields.import).toEqual(['IMPORT_IN_PROGRESS']);
    await owner.post(url(`/imports/${a.body.id}/cancel`));
    expect((await owner.post(url(`/imports/${b.body.id}/start`))).status).toBe(202);
  });

  it('caps unfinished imports per workspace and expires abandoned ones, deleting their files', async () => {
    const uploader = await signUp(t, undefined, 'Uploader');
    const ws = (await createOrg(uploader, 'Caps Co')).workspaceId;
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await uploadCsv(uploader, ws, `email\ncap${i}@h.test\n`);
      expect(r.status).toBe(201);
      ids.push(r.body.id);
    }
    const full = await uploadCsv(uploader, ws, 'email\ncap-over@h.test\n');
    expect(full.status).toBe(409);
    expect(full.body.error.fields.file).toEqual(['TOO_MANY_OPEN_IMPORTS']);

    const stale = ids.slice(0, 3);
    for (const id of stale) expect(existsSync(join(FILES, 'imports', ws, `${id}.csv`))).toBe(true);
    await withOwnerConnection((db) => db.query(`UPDATE contact_imports SET updated_at = now() - interval '25 hours' WHERE id = ANY($1::uuid[])`, [stale]));
    const list = (await uploader.get(url('/imports', ws))).body.data;
    for (const id of stale) {
      expect(list.find((x: { id: string }) => x.id === id).status).toBe('cancelled');
      expect(existsSync(join(FILES, 'imports', ws, `${id}.csv`))).toBe(false);
    }
    expect((await uploadCsv(uploader, ws, 'email\ncap-after@h.test\n')).status).toBe(201);
  });
});

describe('imports: file and content edge cases', () => {
  it.each([
    ['semicolons', 'Email;First name\nsemi@h.test;Ann\n', ['Email', 'First name']],
    ['tabs', 'Email\tFirst name\ntab@h.test\tAnn\n', ['Email', 'First name']],
    ['pipes', 'Email|First name\npipe@h.test|Ann\n', ['Email', 'First name']],
  ])('detects %s as the delimiter', async (_l, csv, headers) => {
    const r = await uploadCsv(owner, W, csv);
    expect(r.status).toBe(201);
    expect(r.body.headers).toEqual(headers);
    await owner.post(url(`/imports/${r.body.id}/cancel`));
  });

  it('keeps newlines inside quoted fields as data, and counts rows correctly', async () => {
    const r = await uploadCsv(owner, W, 'email,company\n"nl@h.test","Line one\nLine two"\nnl2@h.test,Plain\n');
    expect(r.status).toBe(201);
    expect(r.body.totalRows).toBe(2);
    const preview = (await owner.get(url(`/imports/${r.body.id}/preview`))).body;
    expect(preview.rows[0][1]).toBe('Line one\nLine two');
    await owner.post(url(`/imports/${r.body.id}/cancel`));
  });

  it('reports over-long cells per row instead of storing them', async () => {
    const r = await uploadCsv(owner, W, `email,company\nlong@h.test,${'x'.repeat(2500)}\n`);
    const dry = await mapAndDryRun(owner, W, r.body.id, { 0: 'email', 1: 'company' });
    expect(dry.body.dryRun).toMatchObject({ error: 1, create: 0 });
    const issues = (await owner.get(url(`/imports/${r.body.id}/issues`))).body.data;
    expect(issues.map((i: { code: string }) => i.code)).toContain('CELL_TOO_LONG');
    // Issue messages never echo the cell contents.
    expect(JSON.stringify(issues)).not.toContain('xxxxxxxxxx');
    await owner.post(url(`/imports/${r.body.id}/cancel`));
  });

  it('rejects extremely wide rows and stores hostile file names safely', async () => {
    const wide = await uploadCsv(owner, W, `${Array.from({ length: 101 }, (_, i) => `c${i}`).join(',')}\n${'1,'.repeat(100)}1\n`);
    expect(wide.status).toBe(400);
    expect(wide.body.error.fields.file).toEqual(['TOO_MANY_COLUMNS']);
    for (const name of ['<script>alert(1)</script>.csv', '..\\..\\windows\\win.ini', '/etc/passwd', 'a\u0000b.csv']) {
      const r = await uploadCsv(owner, W, 'email\nname@h.test\n', name);
      expect(r.status).toBe(201);
      expect(r.body.fileName).toMatch(/^[\w.\- ()]+$/);
      await owner.post(url(`/imports/${r.body.id}/cancel`));
    }
  });

  it('never merges: a phone and WhatsApp number owned by different contacts is a row error', async () => {
    await contact(owner, { phone: '+14155550111' });
    const wa = await contact(owner, { email: 'wa-owner@h.test' });
    await owner.post(url(`/contacts/${wa.id}/identities`), { kind: 'whatsapp', value: '+14155550122' });
    const r = await uploadCsv(owner, W, 'phone,whatsapp\n+1 (415) 555-0111,+14155550122\n');
    const dry = await mapAndDryRun(owner, W, r.body.id, { 0: 'phone', 1: 'whatsapp' });
    expect(dry.body.dryRun).toMatchObject({ error: 1 });
    expect((await owner.get(url(`/imports/${r.body.id}/issues`))).body.data[0].code).toBe('IDENTITY_CONFLICT');
    await owner.post(url(`/imports/${r.body.id}/cancel`));
  });
});

describe('identity: deterministic, never merged', () => {
  it('treats formatting variants of one phone number as the same identity', async () => {
    await contact(owner, { phone: '+44 20 7946 0958' });
    const dup = await owner.post(url('/contacts'), { phone: '0044 (20) 7946-0958' });
    expect(dup.status).toBe(409);
    const national = await owner.post(url('/contacts'), { phone: '020 7946 0958', defaultCountry: 'GB' });
    expect(national.status).toBe(409);
  });

  it('external ids are unique per provider; the same id from another provider is a different identity', async () => {
    const a = await contact(owner, { email: 'ext-a@h.test' });
    const b = await contact(owner, { email: 'ext-b@h.test' });
    expect((await owner.post(url(`/contacts/${a.id}/identities`), { kind: 'external', provider: 'crm:hubspot', value: 'H-1' })).status).toBe(201);
    expect((await owner.post(url(`/contacts/${b.id}/identities`), { kind: 'external', provider: 'crm:hubspot', value: 'H-1' })).status).toBe(409);
    expect((await owner.post(url(`/contacts/${b.id}/identities`), { kind: 'external', provider: 'crm:zoho', value: 'H-1' })).status).toBe(201);
  });
});

describe('idempotency and concurrency', () => {
  it('concurrent requests with one key execute once', async () => {
    const headers = { 'idempotency-key': 'concurrent-create-0001' };
    const body = { email: 'concurrent@h.test' };
    const [a, b] = await Promise.all([owner.request('POST', url('/contacts'), body, { headers }), owner.request('POST', url('/contacts'), body, { headers })]);
    expect([a.status, b.status].sort()).toEqual(a.status === b.status ? [201, 201] : [201, 409]);
    if (a.status === b.status) expect(a.body.id).toBe(b.body.id);
    const found = (await owner.get(url('/contacts?q=concurrent@h.test'))).body.data;
    expect(found).toHaveLength(1);
    // A later retry replays the stored result.
    const replay = await owner.request('POST', url('/contacts'), body, { headers });
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(found[0].id);
  });

  it('a failed attempt is not cached: retrying runs again', async () => {
    await contact(owner, { email: 'taken@h.test' });
    const headers = { 'idempotency-key': 'failed-attempt-0001' };
    const first = await owner.request('POST', url('/contacts'), { email: 'taken@h.test' }, { headers });
    expect(first.status).toBe(409);
    const again = await owner.request('POST', url('/contacts'), { email: 'taken@h.test' }, { headers });
    expect(again.status).toBe(409);
    expect(again.headers['idempotency-replayed']).toBeUndefined();
  });

  it('a stale version is a conflict, never a silent overwrite', async () => {
    const c = await contact(owner, { email: 'version@h.test', firstName: 'One' });
    expect((await owner.patch(url(`/contacts/${c.id}`), { firstName: 'Two', version: c.version })).status).toBe(200);
    const stale = await owner.patch(url(`/contacts/${c.id}`), { firstName: 'Three', version: c.version });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'version_conflict' });
    expect(typeof stale.body.error.requestId).toBe('string');
    expect((await owner.get(url(`/contacts/${c.id}`))).body.firstName).toBe('Two');
  });
});

describe('search and bulk limits on a large workspace', () => {
  it('caps search at 1,000 matches and "all matching" bulk actions at 10,000, and cannot be bypassed', { timeout: 180_000 }, async () => {
    const big = await createOrg(owner, 'Big Co');
    await withOwnerConnection((db) =>
      db.query(
        `INSERT INTO contacts (id, org_id, workspace_id, first_name, search_text, created_at)
         SELECT gen_random_uuid(), $1, $2, 'Bulk' || g, 'bulk' || g || ' bulkcap', now() - (g || ' seconds')::interval
         FROM generate_series(1, 10050) g`,
        [big.orgId, big.workspaceId],
      ),
    );
    const B = big.workspaceId;
    const searched = await owner.get(url('/contacts/count?q=bulkcap', B));
    expect(searched.body).toEqual({ count: 1000, searchTruncated: true });
    expect((await owner.get(url('/contacts?q=bulkcap&limit=100', B))).body.searchTruncated).toBe(true);
    expect((await owner.get(url('/contacts?limit=101', B))).status).toBe(400);

    const tag = (await owner.post(url('/tags', B), { name: 'All' })).body;
    const bulk = await owner.post(url('/contacts/bulk', B), { action: 'tag', tagId: tag.id, selection: { filter: {} } });
    expect(bulk.body).toMatchObject({ matched: 10_000, affected: 10_000, truncated: true });
    const tooMany = Array.from({ length: 1001 }, () => crypto.randomUUID());
    expect((await owner.post(url('/contacts/bulk', B), { action: 'tag', tagId: tag.id, selection: { contactIds: tooMany } })).status).toBe(400);
  });
});

describe('immutability, as the API database role', () => {
  it('consent evidence, audit records and domain events cannot be changed or deleted by workeasy_app', async () => {
    const c = await contact(owner, { email: 'immutable@h.test' });
    await owner.post(url(`/contacts/${c.id}/consent`), { channel: 'email', action: 'subscribed', lawfulBasis: 'consent', source: 'paper', evidenceNote: 'x' });
    for (const sql of [
      `UPDATE consent_events SET source = 'api'`,
      `DELETE FROM consent_events`,
      `UPDATE audit_logs SET action = 'x'`,
      `DELETE FROM audit_logs`,
      `UPDATE domain_events SET type = 'x'`,
      `DELETE FROM domain_events`,
    ]) {
      const code = await asAppRole(org, (db) => db.query(sql).then(() => null, (e: { code?: string }) => e.code));
      expect(code, sql).toBe('42501'); // insufficient_privilege
    }
    // There is no HTTP route that edits or deletes evidence, for any role.
    const ev = (await owner.get(url(`/contacts/${c.id}/consent`))).body.data[0].id;
    expect((await owner.patch(url(`/contacts/${c.id}/consent/${ev}`), { source: 'api' })).status).toBe(404);
    expect((await owner.delete(url(`/contacts/${c.id}/consent/${ev}`))).status).toBe(404);
  });
});

describe('tenant isolation sweep', () => {
  it('every Phase 5 resource of workspace A is invisible through workspace B of the same owner', async () => {
    const b = await createOrg(owner, 'Sibling');
    const B = b.workspaceId;
    const c = await contact(owner, { email: 'sweep@h.test' });
    const list = (await owner.post(url('/lists'), { name: 'Sweep list' })).body;
    const tag = (await owner.post(url('/tags'), { name: 'Sweep tag' })).body;
    const topic = (await owner.post(url('/topics'), { name: 'Sweep topic' })).body;
    const field = (await owner.post(url('/custom-fields'), { key: 'sweep_field', label: 'Sweep', type: 'text' })).body;
    const sup = (await owner.post(url('/suppressions'), { channel: 'all', reason: 'manual', contactId: c.id })).body;
    const imp = (await uploadCsv(owner, W, 'email\nsweep-import@h.test\n')).body;

    const probes: [string, string, unknown?][] = [
      ['GET', `/contacts/${c.id}`],
      ['GET', `/contacts/${c.id}/timeline`],
      ['GET', `/contacts/${c.id}/consent`],
      ['PATCH', `/contacts/${c.id}`, { firstName: 'x', version: 1 }],
      ['POST', `/contacts/${c.id}/consent`, { channel: 'email', action: 'revoked', source: 'admin' }],
      ['GET', `/lists/${list.id}`],
      ['POST', `/lists/${list.id}/members`, { contactIds: [c.id] }],
      ['PATCH', `/tags/${tag.id}`, { name: 'x', version: 1 }],
      ['POST', `/topics/${topic.id}/archive`],
      ['PATCH', `/custom-fields/${field.id}`, { label: 'x', version: 1 }],
      ['POST', `/suppressions/${sup.id}/lift`, { reason: 'cross workspace' }],
      ['GET', `/imports/${imp.id}`],
      ['GET', `/imports/${imp.id}/preview`],
      ['POST', `/imports/${imp.id}/cancel`],
    ];
    for (const [method, path, body] of probes) {
      const r = await owner.request(method, url(path, B), body);
      expect(r.status, `${method} ${path}`).toBe(404);
    }
    // Collections in B do not contain A's rows; bulk by id silently ignores foreign ids.
    expect((await owner.get(url('/contacts?q=sweep@h.test', B))).body.data).toHaveLength(0);
    const tagB = (await owner.post(url('/tags', B), { name: 'B tag' })).body;
    expect((await owner.post(url('/contacts/bulk', B), { action: 'tag', tagId: tagB.id, selection: { contactIds: [c.id] } })).body).toMatchObject({ affected: 0 });
    // The database agrees: in B's context, A's rows do not exist.
    const counts = await asAppRole(b, async (db) => {
      const r = await db.query(
        `SELECT (SELECT count(*) FROM contacts WHERE id = $1) c, (SELECT count(*) FROM consent_events WHERE contact_id = $1) e,
                (SELECT count(*) FROM domain_events WHERE aggregate_id = $1) d, (SELECT count(*) FROM suppressions WHERE id = $2) s`,
        [c.id, sup.id],
      );
      return r.rows[0];
    });
    expect(counts).toEqual({ c: '0', e: '0', d: '0', s: '0' });
  });
});

describe('event and audit privacy', () => {
  it('domain event payloads and audit metadata never contain contact personal data', async () => {
    const email = 'private.person@h.test';
    const c = await contact(owner, { email, firstName: 'Privatina', lastName: 'Personson', company: 'Secret Ltd', phone: '+14155550177' });
    await owner.patch(url(`/contacts/${c.id}`), { company: 'Even More Secret', version: c.version });
    await owner.post(url(`/contacts/${c.id}/consent`), { channel: 'email', action: 'subscribed', lawfulBasis: 'consent', source: 'paper', evidenceNote: 'ok' });
    await owner.post(url('/suppressions'), { channel: 'email', reason: 'manual', identityKind: 'email', value: 'suppressed.address@h.test' });
    const imp = await uploadCsv(owner, W, 'email,first name\nimported.person@h.test,Importina\n');
    await mapAndDryRun(owner, W, imp.body.id, { 0: 'email', 1: 'first_name' });
    await owner.post(url(`/imports/${imp.body.id}/start`));
    await new Promise((r) => setTimeout(r, 1500));
    await owner.post(url(`/contacts/${c.id}/erase`), { confirm: 'ERASE' });

    const needles = [email, 'Privatina', 'Personson', 'Secret Ltd', 'Even More Secret', '4155550177', 'suppressed.address', 'imported.person', 'Importina'];
    const leaks = await withOwnerConnection(async (db) => {
      const ev = await db.query(`SELECT type, payload::text p FROM domain_events WHERE org_id = $1`, [org.orgId]);
      const au = await db.query(`SELECT action, metadata::text m FROM audit_logs WHERE org_id = $1`, [org.orgId]);
      return [
        ...ev.rows.flatMap((r: { type: string; p: string }) => needles.filter((n) => r.p.toLowerCase().includes(n.toLowerCase())).map((n) => `${r.type}: ${n}`)),
        ...au.rows.flatMap((r: { action: string; m: string }) => needles.filter((n) => r.m.toLowerCase().includes(n.toLowerCase())).map((n) => `${r.action}: ${n}`)),
      ];
    });
    expect(leaks).toEqual([]);
  });
});
