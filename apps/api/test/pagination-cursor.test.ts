import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Agent, createOrg, resetTestDatabase, signUp, startTestApp, type TestApp } from './support.js';

/**
 * Keyset cursors are client input. 2026-10-08 regression: a forged cursor reached a uuid column filter (500).
 * 6.13 hardening: cursors are SIGNED and SCOPED (tenant + list + filters) — a forged, edited, unsigned (legacy),
 * cross-workspace or cross-filter cursor is a 400 on every list endpoint; the server's own cursors keep working.
 */
describe('pagination cursors are signed and scoped', () => {
  let t: TestApp;
  let owner: Agent;
  let W: string;
  let W2: string;
  let orgId: string;
  const unsigned = (id: string, ts = '2026-10-08T00:00:00.000Z') => encodeURIComponent(Buffer.from(JSON.stringify({ t: ts, id })).toString('base64url'));

  beforeAll(async () => {
    await resetTestDatabase();
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test' });
    owner = await signUp(t, undefined, 'Owner');
    ({ orgId, workspaceId: W } = await createOrg(owner, 'Cursor Co'));
    ({ workspaceId: W2 } = await createOrg(owner, 'Second Co'));
    for (const n of ['A', 'B', 'C']) {
      expect((await owner.post(`/v1/workspaces/${W}/lists`, { name: `List ${n}` })).status).toBe(201);
      expect((await owner.post(`/v1/workspaces/${W2}/lists`, { name: `List ${n}` })).status).toBe(201);
    }
  });
  afterAll(async () => t?.close());

  const endpoints = () => [
    `/v1/workspaces/${W}/contacts`,
    `/v1/workspaces/${W}/lists`,
    `/v1/workspaces/${W}/suppressions`,
    `/v1/workspaces/${W}/imports`,
    `/v1/workspaces/${W}/campaigns`,
    `/v1/workspaces/${W}/templates`,
    `/v1/organizations/${orgId}/audit-logs`,
  ];

  it.each(["x' OR 1=1 --", 'not-a-uuid', '', '01a11850-b308-7102-9271-54fa8ea2c893'])('an unsigned cursor (id %j) is refused everywhere — even a well-formed one', async (id) => {
    for (const path of endpoints()) {
      const r = await owner.get(`${path}?cursor=${unsigned(id)}`);
      expect(r.status, path).toBe(400);
    }
  });

  it("the server's own cursors work; an edited payload or signature is refused", async () => {
    const first = await owner.get(`/v1/workspaces/${W}/lists?limit=1`);
    const cursor: string = first.body.nextCursor;
    expect(cursor).toMatch(/^[\w-]+\.[\w-]+$/);
    const next = await owner.get(`/v1/workspaces/${W}/lists?limit=1&cursor=${encodeURIComponent(cursor)}`);
    expect(next.status).toBe(200);
    expect(next.body.data[0].id).not.toBe(first.body.data[0].id);
    const [payload, mac] = cursor.split('.');
    // Point the cursor at another (well-formed) id: the signature no longer matches the payload.
    const original = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    const edited = Buffer.from(JSON.stringify({ ...original, id: '01a11850-b308-7102-9271-54fa8ea2c893' })).toString('base64url');
    expect(edited).not.toBe(payload);
    expect((await owner.get(`/v1/workspaces/${W}/lists?limit=1&cursor=${edited}.${mac}`)).status).toBe(400);
    expect((await owner.get(`/v1/workspaces/${W}/lists?limit=1&cursor=${payload}.${mac!.slice(0, -2)}AA`)).status).toBe(400);
    expect((await owner.get(`/v1/workspaces/${W}/lists?limit=1&cursor=${payload}`)).status).toBe(400);
  });

  it('a cursor is bound to its workspace and its filters (no replay elsewhere)', async () => {
    const cursor: string = (await owner.get(`/v1/workspaces/${W}/lists?limit=1`)).body.nextCursor;
    // Same user, same list endpoint, another workspace: refused.
    expect((await owner.get(`/v1/workspaces/${W2}/lists?limit=1&cursor=${encodeURIComponent(cursor)}`)).status).toBe(400);
    // Same workspace, different filter: refused.
    expect((await owner.get(`/v1/workspaces/${W}/lists?limit=1&status=archived&cursor=${encodeURIComponent(cursor)}`)).status).toBe(400);
    // Same workspace, another list endpoint: refused.
    expect((await owner.get(`/v1/workspaces/${W}/templates?limit=1&cursor=${encodeURIComponent(cursor)}`)).status).toBe(400);
    // A different page size is not a different query: accepted.
    expect((await owner.get(`/v1/workspaces/${W}/lists?limit=2&cursor=${encodeURIComponent(cursor)}`)).status).toBe(200);
  });
});
