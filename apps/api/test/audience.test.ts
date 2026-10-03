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
  waitForImport,
  withOwnerConnection,
} from './support.js';

let t: TestApp;
let owner: Agent;
let org: { orgId: string; workspaceId: string };
let W: string;
const url = (p: string) => `/v1/workspaces/${W}${p}`;

async function newContact(agent: Agent, body: Record<string, unknown>) {
  const r = await agent.post(url('/contacts'), body);
  if (r.status !== 201) throw new Error(`create contact failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { id: string; version: number; email: string | null };
}

beforeAll(async () => {
  await resetTestDatabase();
  t = await startTestApp();
  owner = await signUp(t, undefined, 'Owner');
  org = await createOrg(owner, 'Audience Co');
  W = org.workspaceId;
});
afterAll(async () => t?.close());

describe('contacts', () => {
  it('normalizes identities and refuses duplicates regardless of case or format', async () => {
    const c = await newContact(owner, { firstName: 'Ann', lastName: 'Lee', email: ' Ann.Lee@Example.COM ', phone: '098765 43210', defaultCountry: 'IN' });
    const detail = (await owner.get(url(`/contacts/${c.id}`))).body;
    expect(detail.identities.map((i: { kind: string; value: string }) => [i.kind, i.value])).toEqual([
      ['email', 'Ann.Lee@Example.COM'],
      ['phone', '098765 43210'],
    ]);
    const dupEmail = await owner.post(url('/contacts'), { email: 'ann.lee@example.com' });
    expect(dupEmail.status).toBe(409);
    const dupPhone = await owner.post(url('/contacts'), { phone: '+91 98765-43210' });
    expect(dupPhone.status).toBe(409);
  });

  it('validates input: needs email or phone, valid formats, a country for national numbers', async () => {
    expect((await owner.post(url('/contacts'), { firstName: 'Nobody' })).status).toBe(400);
    expect((await owner.post(url('/contacts'), { email: 'not-an-email' })).body.error.fields.email).toBeDefined();
    expect((await owner.post(url('/contacts'), { phone: '98765 43210' })).body.error.fields.phone[0]).toMatch(/country/i);
  });

  it('searches by partial name, email or phone, and paginates with a stable keyset', async () => {
    for (let i = 0; i < 5; i++) await newContact(owner, { firstName: `Pager${i}`, email: `pager${i}@paging.test` });
    const found = await owner.get(url('/contacts?q=paging.te'));
    expect(found.body.data).toHaveLength(5);
    expect((await owner.get(url('/contacts?q=PAGER3'))).body.data.map((c: { email: string }) => c.email)).toEqual(['pager3@paging.test']);
    // Wildcards are literal
    expect((await owner.get(url('/contacts?q=%25%25'))).body.data).toEqual([]);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r = await owner.get(url(`/contacts?q=paging.test&limit=2${cursor ? `&cursor=${cursor}` : ''}`));
      seen.push(...r.body.data.map((c: { id: string }) => c.id));
      cursor = r.body.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(5);
    expect((await owner.get(url('/contacts/count?q=paging.test'))).body.count).toBe(5);
  });

  it('updates with optimistic concurrency and validates custom fields', async () => {
    await owner.post(url('/custom-fields'), { key: 'plan', label: 'Plan', type: 'single_select', options: [{ key: 'gold', label: 'Gold' }, { key: 'free', label: 'Free' }] });
    await owner.post(url('/custom-fields'), { key: 'seats', label: 'Seats', type: 'number', validation: { min: 1 } });
    const c = await newContact(owner, { email: 'fields@example.test', customFields: { plan: 'Gold' } });
    expect((await owner.get(url(`/contacts/${c.id}`))).body.customFields).toEqual({ plan: 'gold' });
    const bad = await owner.patch(url(`/contacts/${c.id}`), { customFields: { seats: 0 }, version: c.version });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields['customFields.seats']).toBeDefined();
    const unknown = await owner.patch(url(`/contacts/${c.id}`), { customFields: { nope: 1 }, version: c.version });
    expect(unknown.status).toBe(400);
    const ok = await owner.patch(url(`/contacts/${c.id}`), { firstName: 'Fran', customFields: { seats: 5 }, version: c.version });
    expect(ok.status).toBe(200);
    expect(ok.body.customFields).toEqual({ plan: 'gold', seats: 5 });
    const stale = await owner.patch(url(`/contacts/${c.id}`), { firstName: 'Stale', version: c.version });
    expect(stale.status).toBe(409);
  });

  it('locks a custom field key once used; used fields are archived, not deleted', async () => {
    const fields = (await owner.get(url('/custom-fields'))).body.data as { id: string; key: string; keyLocked: boolean; version: number }[];
    const plan = fields.find((f) => f.key === 'plan')!;
    expect(plan.keyLocked).toBe(true);
    expect((await owner.patch(url(`/custom-fields/${plan.id}`), { key: 'tier', version: plan.version })).status).toBe(400);
    expect((await owner.delete(url(`/custom-fields/${plan.id}`))).status).toBe(422);
    expect((await owner.post(url(`/custom-fields/${plan.id}/archive`))).status).toBe(200);
    const c = await newContact(owner, { email: 'archived-field@example.test' });
    expect((await owner.patch(url(`/contacts/${c.id}`), { customFields: { plan: 'free' }, version: c.version })).status).toBe(400);
    await owner.post(url(`/custom-fields/${plan.id}/restore`));
  });

  it('manages identities: no duplicates across contacts, never removes the last email/phone', async () => {
    const a = await newContact(owner, { email: 'ident-a@example.test' });
    await newContact(owner, { email: 'ident-b@example.test' });
    expect((await owner.post(url(`/contacts/${a.id}/identities`), { kind: 'email', value: 'IDENT-B@example.test' })).status).toBe(409);
    const withPhone = await owner.post(url(`/contacts/${a.id}/identities`), { kind: 'phone', value: '+14155552671' });
    expect(withPhone.status).toBe(201);
    const email = withPhone.body.identities.find((i: { kind: string }) => i.kind === 'email');
    const phone = withPhone.body.identities.find((i: { kind: string }) => i.kind === 'phone');
    expect((await owner.delete(url(`/contacts/${a.id}/identities/${email.id}`))).status).toBe(200);
    const last = await owner.delete(url(`/contacts/${a.id}/identities/${phone.id}`));
    expect(last.status).toBe(422);
  });

  it('soft-deletes, restores and erases; erasure keeps pseudonymous consent evidence', async () => {
    const c = await newContact(owner, { firstName: 'Gone', email: 'erase-me@example.test' });
    await owner.post(url(`/contacts/${c.id}/consent`), { channel: 'email', action: 'subscribed', source: 'paper', lawfulBasis: 'consent', evidenceNote: 'Signed form' });
    expect((await owner.delete(url(`/contacts/${c.id}`))).status).toBe(204);
    expect((await owner.get(url('/contacts?q=erase-me'))).body.data).toEqual([]);
    expect((await owner.get(url('/contacts?deleted=only&q=erase-me'))).body.data).toHaveLength(1);
    expect((await owner.post(url(`/contacts/${c.id}/restore`))).status).toBe(200);
    expect((await owner.post(url(`/contacts/${c.id}/erase`), { confirm: 'nope' })).status).toBe(400);
    expect((await owner.post(url(`/contacts/${c.id}/erase`), { confirm: 'ERASE' })).status).toBe(204);
    expect((await owner.get(url(`/contacts/${c.id}`))).status).toBe(404);
    const db = await withOwnerConnection(async (cl) => ({
      contact: (await cl.query('SELECT first_name, search_text, erased_at FROM contacts WHERE id = $1', [c.id])).rows[0],
      identities: (await cl.query('SELECT count(*)::int AS n FROM contact_identities WHERE contact_id = $1', [c.id])).rows[0].n,
      evidence: (await cl.query('SELECT subject_fingerprint FROM consent_events WHERE contact_id = $1', [c.id])).rows,
    }));
    expect(db.contact.first_name).toBeNull();
    expect(db.contact.search_text).toBe('');
    expect(db.identities).toBe(0);
    expect(db.evidence).toHaveLength(1);
    expect(db.evidence[0].subject_fingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(db.evidence[0].subject_fingerprint).not.toContain('erase-me');
  });

  it('builds a timeline from domain events', async () => {
    const c = await newContact(owner, { email: 'timeline@example.test' });
    await owner.patch(url(`/contacts/${c.id}`), { firstName: 'Tim', version: c.version });
    const tl = await owner.get(url(`/contacts/${c.id}/timeline`));
    expect(tl.body.data.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(['contact.created', 'contact.identity_added', 'contact.updated']));
    expect(JSON.stringify(tl.body.data)).not.toContain('timeline@example.test'); // no personal data in events
  });
});

describe('lists, tags and topics', () => {
  it('lists: membership without duplicates, counts, archive blocks changes, delete removes memberships', async () => {
    const list = (await owner.post(url('/lists'), { name: 'VIP' })).body;
    expect((await owner.post(url('/lists'), { name: 'vip' })).status).toBe(409);
    const a = await newContact(owner, { email: 'list-a@example.test' });
    const b = await newContact(owner, { email: 'list-b@example.test' });
    expect((await owner.post(url(`/lists/${list.id}/members`), { contactIds: [a.id, b.id] })).body).toEqual({ added: 2, alreadyMembers: 0 });
    expect((await owner.post(url(`/lists/${list.id}/members`), { contactIds: [a.id] })).body).toEqual({ added: 0, alreadyMembers: 1 });
    expect((await owner.get(url(`/lists/${list.id}`))).body.memberCount).toBe(2);
    expect((await owner.get(url(`/contacts?listId=${list.id}`))).body.data).toHaveLength(2);
    await owner.post(url(`/lists/${list.id}/archive`));
    expect((await owner.post(url(`/lists/${list.id}/members`), { contactIds: [a.id] })).status).toBe(422);
    await owner.post(url(`/lists/${list.id}/restore`));
    expect((await owner.delete(url(`/lists/${list.id}`))).status).toBe(204);
    expect((await owner.get(url(`/contacts/${a.id}`))).body.lists).toEqual([]);
    expect((await owner.post(url('/lists'), { name: 'VIP' })).status).toBe(201); // name reusable after delete
  });

  it('tags: case-insensitive uniqueness, tag/untag, filter', async () => {
    const tag = (await owner.post(url('/tags'), { name: 'Lead', color: 'blue' })).body;
    expect((await owner.post(url('/tags'), { name: 'LEAD' })).status).toBe(409);
    const c = await newContact(owner, { email: 'tagged@example.test' });
    expect((await owner.put(url(`/contacts/${c.id}/tags/${tag.id}`), {})).status).toBe(204);
    expect((await owner.get(url(`/contacts?tagId=${tag.id}`))).body.data.map((x: { id: string }) => x.id)).toEqual([c.id]);
    expect((await owner.delete(url(`/contacts/${c.id}/tags/${tag.id}`))).status).toBe(204);
    expect((await owner.get(url(`/contacts?tagId=${tag.id}`))).body.data).toEqual([]);
  });

  it('topics: a default Marketing topic exists and cannot be archived', async () => {
    const topics = (await owner.get(url('/topics'))).body.data as { id: string; key: string; isDefault: boolean }[];
    const marketing = topics.find((x) => x.key === 'marketing')!;
    expect(marketing.isDefault).toBe(true);
    expect((await owner.post(url(`/topics/${marketing.id}/archive`))).status).toBe(422);
    const news = (await owner.post(url('/topics'), { name: 'Product News' })).body;
    expect(news.key).toBe('product_news');
    expect((await owner.post(url(`/topics/${news.id}/default`))).body.isDefault).toBe(true);
    expect((await owner.post(url(`/topics/${marketing.id}/archive`))).status).toBe(200);
    await owner.post(url(`/topics/${marketing.id}/restore`));
    await owner.post(url(`/topics/${marketing.id}/default`));
  });
});

describe('consent, suppression and eligibility', () => {
  it('staff must give evidence when recording consent; evidence history is kept', async () => {
    const c = await newContact(owner, { email: 'consent@example.test' });
    expect((await owner.post(url(`/contacts/${c.id}/consent`), { channel: 'email', action: 'subscribed', source: 'admin' })).status).toBe(400);
    const ok = await owner.post(url(`/contacts/${c.id}/consent`), { channel: 'email', action: 'subscribed', source: 'paper', lawfulBasis: 'consent', evidenceNote: 'Signed at expo' });
    expect(ok.status).toBe(201);
    expect(ok.body.newState).toBe('granted');
    const noAddress = await owner.post(url(`/contacts/${c.id}/consent`), { channel: 'sms', action: 'subscribed', source: 'paper', lawfulBasis: 'consent', evidenceNote: 'x' });
    expect(noAddress.status).toBe(422);
    const history = (await owner.get(url(`/contacts/${c.id}/consent`))).body.data;
    expect(history[0]).toMatchObject({ action: 'subscribed', newState: 'granted', source: 'paper', evidence: { note: 'Signed at expo' } });
  });

  it('a self-unsubscribe cannot be reversed by staff (subscription, consent and topic)', async () => {
    const c = await newContact(owner, { email: 'sticky@example.test' });
    const topic = ((await owner.get(url('/topics'))).body.data as { id: string; key: string }[]).find((x) => x.key === 'marketing')!;
    await withOwnerConnection(async (cl) => {
      await cl.query(`UPDATE contacts SET subscription_type = 'unsubscribed', unsubscribed_by = 'contact' WHERE id = $1`, [c.id]);
      const ev = (
        await cl.query(
          `INSERT INTO consent_events (id, org_id, workspace_id, contact_id, channel, action, previous_state, new_state, source, actor_type, correlation_id, occurred_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'email', 'unsubscribed', 'granted', 'withdrawn', 'preference_center', 'contact', gen_random_uuid(), now()) RETURNING id`,
          [org.orgId, W, c.id],
        )
      ).rows[0].id;
      await cl.query(
        `INSERT INTO consent_states (org_id, workspace_id, contact_id, channel, state, changed_by, last_event_id, changed_at) VALUES ($1, $2, $3, 'email', 'withdrawn', 'contact', $4, now())`,
        [org.orgId, W, c.id, ev],
      );
      await cl.query(
        `INSERT INTO contact_topic_preferences (org_id, workspace_id, contact_id, topic_id, status, changed_by, last_event_id, changed_at) VALUES ($1, $2, $3, $4, 'unsubscribed', 'contact', $5, now())`,
        [org.orgId, W, c.id, topic.id, ev],
      );
    });
    const version = (await owner.get(url(`/contacts/${c.id}`))).body.version;
    const sub = await owner.put(url(`/contacts/${c.id}/subscription`), { subscriptionType: 'marketing', version });
    expect(sub.status).toBe(422);
    expect(sub.body.error.fields.subscriptionType).toEqual(['SELF_UNSUBSCRIBED']);
    const consent = await owner.post(url(`/contacts/${c.id}/consent`), { channel: 'email', action: 'subscribed', source: 'paper', lawfulBasis: 'consent', evidenceNote: 'x' });
    expect(consent.status).toBe(422);
    expect((await owner.put(url(`/contacts/${c.id}/topics/${topic.id}`), { status: 'subscribed' })).status).toBe(422);
  });

  it('eligibility explains every blocker and suppression changes the answer', async () => {
    const topic = ((await owner.get(url('/topics'))).body.data as { id: string; key: string }[]).find((x) => x.key === 'marketing')!;
    const c = await newContact(owner, { email: 'eligible@example.test' });
    const check = (body: Record<string, unknown> = {}) => owner.post(url('/eligibility/check'), { contactIds: [c.id], channel: 'email', topicId: topic.id, ...body });
    expect((await check()).body.results[0].reasons.map((r: { code: string }) => r.code)).toEqual(['CONSENT_MISSING', 'TOPIC_NOT_SUBSCRIBED']);
    await owner.post(url(`/contacts/${c.id}/consent`), { channel: 'email', action: 'subscribed', source: 'form', lawfulBasis: 'consent', evidenceNote: 'Website form' });
    await owner.put(url(`/contacts/${c.id}/topics/${topic.id}`), { status: 'subscribed' });
    expect((await check()).body.results[0]).toMatchObject({ eligible: true, reasons: [] });

    const s = await owner.post(url('/suppressions'), { channel: 'all', reason: 'compliance', contactId: c.id, note: 'Legal hold' });
    expect(s.status).toBe(201);
    expect((await owner.post(url('/suppressions'), { channel: 'all', reason: 'manual', contactId: c.id })).status).toBe(409);
    expect((await check()).body.results[0].reasons.map((r: { code: string }) => r.code)).toEqual(['SUPPRESSED']);
    expect((await check({ purpose: 'transactional' })).body.results[0].eligible).toBe(false); // suppression beats transactional
    expect((await owner.get(url(`/contacts?suppressed=true&q=eligible@`))).body.data).toHaveLength(1);
    expect((await owner.post(url(`/suppressions/${s.body.id}/lift`), { reason: 'Hold released' })).status).toBe(200);
    expect((await check()).body.results[0].eligible).toBe(true);

    // Address-level suppression applies to whichever contact owns the address.
    await owner.post(url('/suppressions'), { channel: 'email', reason: 'manual', identityKind: 'email', value: 'ELIGIBLE@example.test' });
    expect((await check()).body.results[0].reasons.map((r: { code: string }) => r.code)).toEqual(['SUPPRESSED']);
    expect((await check({ channel: 'sms' })).body.results[0].reasons.map((r: { code: string }) => r.code)).toContain('NO_ADDRESS');
  });

  it('retention policy: defaults, audited changes, purge', async () => {
    const def = (await owner.get(url('/consent/retention-policy'))).body;
    expect(def).toMatchObject({ isDefault: true, retainAfterWithdrawalDays: 2190 });
    const set = await owner.put(url('/consent/retention-policy'), { retainAfterWithdrawalDays: 365, retainAfterErasureDays: null, pendingExpiryDays: 7 });
    expect(set.body).toMatchObject({ isDefault: false, retainAfterWithdrawalDays: 365, retainAfterErasureDays: null });
    expect((await owner.post(url('/consent/retention-purge'))).body).toEqual({ deleted: 0 });
    const audit = (await owner.get(`/v1/organizations/${org.orgId}/audit-logs?action=consent.`)).body.data.map((a: { action: string }) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['consent.retention_policy_updated', 'consent.retention_purged']));
  });
});

describe('bulk operations', () => {
  it('tag by ids and add to list by filter, in server-side chunks, with one audit record', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await newContact(owner, { email: `bulk${i}@bulk.test` })).id);
    const tag = (await owner.post(url('/tags'), { name: 'Bulk' })).body;
    const r = await owner.post(url('/contacts/bulk'), { action: 'tag', tagId: tag.id, selection: { contactIds: [...ids, ids[0]] } });
    expect(r.body).toMatchObject({ matched: 3, affected: 3, truncated: false });
    const list = (await owner.post(url('/lists'), { name: 'Bulk list' })).body;
    const byFilter = await owner.post(url('/contacts/bulk'), { action: 'add_to_list', listId: list.id, selection: { filter: { q: 'bulk.test' } } });
    expect(byFilter.body).toMatchObject({ matched: 3, affected: 3 });
    const again = await owner.post(url('/contacts/bulk'), { action: 'add_to_list', listId: list.id, selection: { filter: { q: 'bulk.test' } } });
    expect(again.body.affected).toBe(0);
    const audit = (await owner.get(`/v1/organizations/${org.orgId}/audit-logs?action=contacts.bulk_action`)).body.data;
    expect(audit.length).toBeGreaterThanOrEqual(3);
  });

  it('Idempotency-Key replays a bulk action instead of repeating it', async () => {
    const c = await newContact(owner, { email: 'idem-bulk@example.test' });
    const headers = { 'idempotency-key': 'bulk-unsub-0001' };
    const body = { action: 'unsubscribe', selection: { contactIds: [c.id] } };
    const first = await owner.request('POST', url('/contacts/bulk'), body, { headers });
    const second = await owner.request('POST', url('/contacts/bulk'), body, { headers });
    expect(first.body).toEqual(second.body);
    expect(first.body.affected).toBe(1);
    // The same key with a different request is refused, not silently replayed.
    const other = await owner.request('POST', url('/contacts/bulk'), { ...body, action: 'delete' }, { headers });
    expect(other.status).toBe(422);
  });
});

describe('imports', () => {
  it('upload → mapping → dry run → start: deterministic duplicates, validation, list/consent options', async () => {
    const existing = await newContact(owner, { firstName: 'Old', email: 'existing@import.test' });
    const list = (await owner.post(url('/lists'), { name: 'Imported' })).body;
    const csv = [
      '﻿Email,First Name,Mobile,Plan',
      'new1@import.test,Nia,+14155550101,Gold',
      'NEW1@import.test,Dup,,Gold', // same email (different case) as row 1 → duplicate in file
      'existing@import.test,Updated,,Free', // existing → update
      'not-an-email,Bad,,Gold', // invalid
      'new2@import.test,=HYPERLINK("http://x"),,Platinum', // formula text stored as data; invalid select
      'new3@import.test,Zed,+14155550101,', // phone already used by row 1 in this file → duplicate in file
    ].join('\r\n');
    const up = await uploadCsv(owner, W, csv, '../../etc/passwd.csv');
    expect(up.status).toBe(201);
    expect(up.body.fileName).toBe('passwd.csv');
    expect(up.body.totalRows).toBe(6);
    expect(up.body.mapping).toEqual({ 0: 'email', 1: 'first_name', 2: 'phone', 3: 'cf:plan' });

    const start0 = await owner.post(url(`/imports/${up.body.id}/start`));
    expect(start0.status).toBe(422); // dry run first

    const mapped = await owner.put(url(`/imports/${up.body.id}/mapping`), {
      mapping: up.body.mapping,
      options: { mode: 'create_or_update', listIds: [list.id], consent: { channel: 'email', lawfulBasis: 'consent', evidenceNote: 'Signup sheet, event 2026' } },
      version: up.body.version,
    });
    expect(mapped.status).toBe(200);
    const dry = await owner.post(url(`/imports/${up.body.id}/dry-run`));
    // new1 → create; NEW1 → duplicate; existing → update; not-an-email → error; Platinum → invalid option; new3 → duplicate phone
    expect(dry.body.dryRun).toEqual({ total: 6, create: 1, update: 1, skip: 2, error: 2 });
    expect(dry.body.status).toBe('validated');
    // Dry run changed nothing.
    expect((await owner.get(url('/contacts?q=new1@import'))).body.data).toEqual([]);

    const started = await owner.request('POST', url(`/imports/${up.body.id}/start`), {}, { headers: { 'idempotency-key': 'start-import-0001' } });
    expect(started.status).toBe(202);
    const done = await waitForImport(owner, W, up.body.id);
    expect(done.status).toBe('completed');
    // The real run did exactly what the dry run predicted.
    expect(done.counts).toEqual({ created: 1, updated: 1, skipped: 2, errors: 2 });

    const n1 = (await owner.get(url('/contacts?q=new1@import'))).body.data[0];
    const detail = (await owner.get(url(`/contacts/${n1.id}`))).body;
    expect(detail).toMatchObject({ firstName: 'Nia', customFields: { plan: 'gold' } });
    expect(detail.lists.map((l: { id: string }) => l.id)).toEqual([list.id]);
    expect(detail.consent.find((s: { channel: string }) => s.channel === 'email').state).toBe('granted');
    expect((await owner.get(url(`/contacts/${existing.id}`))).body.firstName).toBe('Updated');

    const issues = await owner.get(url(`/imports/${up.body.id}/issues?phase=run`));
    expect(issues.body.data.map((i: { code: string }) => i.code)).toEqual(expect.arrayContaining(['DUPLICATE_IN_FILE', 'INVALID_EMAIL', 'FIELD_INVALID']));
    const csvOut = await owner.get(url(`/imports/${up.body.id}/issues.csv?phase=run`));
    expect(String(csvOut.body)).not.toMatch(/(^|,)=HYPERLINK/m);

    // Re-running the same start is replayed, not re-imported.
    const replay = await owner.request('POST', url(`/imports/${up.body.id}/start`), {}, { headers: { 'idempotency-key': 'start-import-0001' } });
    expect(replay.status).toBe(202);
    expect((await owner.get(url('/contacts/count?q=new1@import'))).body.count).toBe(1);
  });

  it('a failed import resumes after its last committed chunk (no row imported twice)', async () => {
    const rows = Array.from({ length: 300 }, (_, i) => `resume${i}@resume.test`);
    const up = await uploadCsv(owner, W, 'email\n' + rows.join('\n'));
    await owner.put(url(`/imports/${up.body.id}/mapping`), { mapping: { 0: 'email' }, options: { mode: 'create_or_update' }, version: up.body.version });
    await owner.post(url(`/imports/${up.body.id}/dry-run`));
    // Simulate a crash after the first chunk (250 rows) was committed: checkpoint says 250, nothing else ran.
    await withOwnerConnection((c) => c.query(`UPDATE contact_imports SET status = 'failed', processed_rows = 250, failure_reason = 'crash' WHERE id = $1`, [up.body.id]));
    expect((await owner.post(url(`/imports/${up.body.id}/retry`))).status).toBe(202);
    const done = await waitForImport(owner, W, up.body.id);
    expect(done.status).toBe('completed');
    expect(done.processedRows).toBe(300);
    expect(done.counts.created).toBe(50); // only rows 251–300 ran
    expect((await owner.get(url('/contacts/count?q=resume.test'))).body.count).toBe(50);
    expect((await owner.post(url(`/imports/${up.body.id}/retry`))).status).toBe(422); // completed imports cannot be retried
  });

  it('a cancelled import cannot start and its file is removed', async () => {
    const up = await uploadCsv(owner, W, 'email\ncancel@import.test\n');
    expect((await owner.post(url(`/imports/${up.body.id}/cancel`))).body.status).toBe('cancelled');
    expect((await owner.post(url(`/imports/${up.body.id}/start`))).status).toBe(422);
    expect((await owner.get(url(`/imports/${up.body.id}/preview`))).status).toBe(422);
  });

  it('never merges: an email and phone that belong to different contacts is a row error', async () => {
    await newContact(owner, { email: 'merge-a@import.test' });
    await newContact(owner, { phone: '+14155550199' });
    const up = await uploadCsv(owner, W, 'email,phone\nmerge-a@import.test,+14155550199\n');
    await owner.put(url(`/imports/${up.body.id}/mapping`), { mapping: { 0: 'email', 1: 'phone' }, options: { mode: 'create_or_update' }, version: up.body.version });
    const dry = await owner.post(url(`/imports/${up.body.id}/dry-run`));
    expect(dry.body.dryRun).toMatchObject({ error: 1, create: 0, update: 0 });
    const issues = (await owner.get(url(`/imports/${up.body.id}/issues`))).body.data;
    expect(issues[0].code).toBe('IDENTITY_CONFLICT');
  });

  it.each([
    ['invalid UTF-8', Buffer.from([0x65, 0x6d, 0x61, 0x69, 0x6c, 0x0a, 0xff, 0xfe, 0x40, 0x0a]), 'ENCODING_INVALID'],
    ['an unclosed quote', 'email,name\n"broken@x.test,Ann\n', 'CSV_INVALID'],
    ['an empty file', '', 'EMPTY_FILE'],
    ['a header only', 'email\n', 'NO_ROWS'],
  ])('rejects %s', async (_label, body, code) => {
    const r = await uploadCsv(owner, W, body);
    expect(r.status).toBe(400);
    expect(r.body.error.fields.file).toEqual([code]);
  });

  it('rejects non-CSV content types and oversized files', async () => {
    const json = await owner.post(url('/imports'), { email: 'x' });
    expect(json.status).toBe(400);
    const small = await startTestApp({ IMPORT_MAX_BYTES: '2048' });
    try {
      const o = await signUp(small);
      const { workspaceId } = await createOrg(o, 'Small');
      const big = 'email\n' + Array.from({ length: 200 }, (_, i) => `user${i}@big.test`).join('\n');
      const r = await uploadCsv(o, workspaceId, big);
      expect(r.status).toBe(413);
      expect(r.body.error.fields.file).toEqual(['FILE_TOO_LARGE']);
    } finally {
      await small.close();
    }
  });
});

describe('isolation and permissions', () => {
  let outsider: Agent;
  let viewer: Agent;
  let editor: Agent;
  let W2: string;
  let contactId: string;
  let listId: string;
  beforeAll(async () => {
    outsider = await signUp(t);
    await createOrg(outsider, 'Other Org');
    viewer = await signUp(t);
    editor = await signUp(t);
    await inviteAndAccept(t, owner, viewer, org.orgId, 'member', [{ workspaceId: W, roleKey: 'viewer' }]);
    await inviteAndAccept(t, owner, editor, org.orgId, 'member', [{ workspaceId: W, roleKey: 'editor' }]);
    W2 = (await owner.post(`/v1/organizations/${org.orgId}/workspaces`, { name: 'Second brand' })).body.id;
    contactId = (await newContact(owner, { email: 'private@iso.test' })).id;
    listId = (await owner.post(url('/lists'), { name: 'Iso list' })).body.id;
  });

  it('another organization cannot reach the workspace or its contacts (404)', async () => {
    expect((await outsider.get(url('/contacts'))).status).toBe(404);
    expect((await outsider.get(url(`/contacts/${contactId}`))).status).toBe(404);
    expect((await outsider.post(url('/contacts'), { email: 'x@y.z' })).status).toBe(404);
  });

  it('ids from workspace A are invisible through workspace B, even for the same owner (no IDOR)', async () => {
    const B = (p: string) => `/v1/workspaces/${W2}${p}`;
    expect((await owner.get(B(`/contacts/${contactId}`))).status).toBe(404);
    expect((await owner.get(B(`/contacts/${contactId}/consent`))).status).toBe(404);
    expect((await owner.post(B(`/lists/${listId}/members`), { contactIds: [contactId] })).status).toBe(404);
    const bList = (await owner.post(B('/lists'), { name: 'B list' })).body;
    expect((await owner.post(B(`/lists/${bList.id}/members`), { contactIds: [contactId] })).status).toBe(400);
    expect((await owner.post(B('/contacts/bulk'), { action: 'delete', selection: { contactIds: [contactId] } })).body.matched).toBe(0);
    const elig = await owner.post(B('/eligibility/check'), { contactIds: [contactId], channel: 'email' });
    expect(elig.body).toEqual({ results: [], notFound: [contactId] });
    expect((await owner.get(B('/contacts?q=private@iso'))).body.data).toEqual([]);
    expect((await owner.get(url(`/contacts/${contactId}`))).status).toBe(200);
  });

  it('a workspace member without access to workspace B cannot see it', async () => {
    expect((await viewer.get(`/v1/workspaces/${W2}/contacts`)).status).toBe(404);
  });

  it('viewers read but cannot change audience data; denials are audited', async () => {
    expect((await viewer.get(url('/contacts'))).status).toBe(200);
    expect((await viewer.get(url(`/contacts/${contactId}`))).status).toBe(200);
    expect((await viewer.post(url('/contacts'), { email: 'v@x.test' })).status).toBe(403);
    expect((await viewer.post(url(`/contacts/${contactId}/consent`), { channel: 'email', action: 'revoked', source: 'admin' })).status).toBe(403);
    expect((await viewer.post(url('/suppressions'), { channel: 'all', reason: 'manual', contactId })).status).toBe(403);
    expect((await viewer.post(url('/custom-fields'), { key: 'x1', label: 'X', type: 'text' })).status).toBe(403);
    expect((await uploadCsv(viewer, W, 'email\na@b.co\n')).status).toBe(403);
    expect((await viewer.post(url('/contacts/bulk'), { action: 'tag', tagId: listId, selection: { contactIds: [contactId] } })).status).toBe(403);
    const denied = (await owner.get(`/v1/organizations/${org.orgId}/audit-logs?action=access.denied`)).body.data;
    expect(denied.length).toBeGreaterThanOrEqual(6);
  });

  it('editors create and tag but cannot import, delete, suppress or record consent', async () => {
    expect((await editor.post(url('/contacts'), { email: 'by-editor@x.test' })).status).toBe(201);
    expect((await uploadCsv(editor, W, 'email\na@b.co\n')).status).toBe(403);
    expect((await editor.delete(url(`/contacts/${contactId}`))).status).toBe(403);
    expect((await editor.post(url('/contacts/bulk'), { action: 'suppress', channel: 'all', selection: { contactIds: [contactId] } })).status).toBe(403);
    expect((await editor.post(url(`/contacts/${contactId}/consent`), { channel: 'email', action: 'revoked', source: 'admin' })).status).toBe(403);
    const tag = (await owner.post(url('/tags'), { name: 'Editor tag' })).body;
    expect((await editor.put(url(`/contacts/${contactId}/tags/${tag.id}`), {})).status).toBe(204);
  });
});
