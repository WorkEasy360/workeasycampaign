import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agent, createOrg, inviteAndAccept, resetTestDatabase, roleId, signUp, startTestApp, type TestApp, withOwnerConnection } from './support.js';

/**
 * Milestone 6.7 — pre-flight (contract §3, §15 row 10) through the real HTTP stack. Audience facts come only from
 * Audience Resolution v1.1 (uniform live sample, topic status) and Eligibility v1.1. Read-only: no snapshot, no write,
 * no contact data in the response, findings, audit, domain events or logs.
 */
describe('campaign pre-flight API (6.7)', () => {
  let t: TestApp;
  let owner: Agent;
  let viewer: Agent;
  let noRead: Agent; // custom role without campaigns.read
  let outsider: Agent;
  let orgId: string;
  let W: string;
  let WB: string;
  let topicId: string;
  const url = (p = '', ws = W) => `/v1/workspaces/${ws}/campaigns${p}`;
  const content = { schema: 'email.content.v1', subject: 'Autumn news', preheader: '', body: { format: 'text', text: 'Hello' } };
  const count = (sql: string, args: unknown[] = []) => withOwnerConnection(async (c) => Number((await c.query(sql, args)).rows[0].n));

  /** A complete draft whose audience is `listId` (readiness errors come only from audience facts). */
  async function campaignFor(listId: string, topic = topicId): Promise<string> {
    const c = await owner.post(url(), { name: 'Preflight', channel: 'email', topicId: topic });
    expect(c.status).toBe(201);
    const p = await owner.patch(url(`/${c.body.id}`), {
      expectedVersion: 1,
      audience: { include: [{ type: 'list', listId }], exclude: [] },
      sender: { senderIdentityId: null, fromName: 'Acme', replyTo: null },
      messages: [{ variantKey: 'default', content }],
    });
    expect(p.status).toBe(200);
    return c.body.id;
  }
  const list = async (name: string) => (await owner.post(`/v1/workspaces/${W}/lists`, { name })).body.id as string;

  /** `n` bare contacts (no address) in a new list, seeded by the owner — sizes only, never eligible. */
  async function bulkList(n: number): Promise<string> {
    const listId = await list(`bulk-${n}-${randomUUID().slice(0, 6)}`);
    if (n) {
      await withOwnerConnection(async (c) => {
        await c.query(`SET statement_timeout = 0`);
        await c.query('BEGIN');
        await c.query(`CREATE TEMP TABLE s_c ON COMMIT DROP AS SELECT gen_random_uuid() AS id FROM generate_series(1, $1::int)`, [n]);
        await c.query(`INSERT INTO contacts (id, org_id, workspace_id) SELECT id, $1, $2 FROM s_c`, [orgId, W]);
        await c.query(`INSERT INTO list_memberships (org_id, workspace_id, list_id, contact_id) SELECT $1, $2, $3, id FROM s_c`, [orgId, W, listId]);
        await c.query('COMMIT');
        await c.query('ANALYZE contacts');
      });
    }
    return listId;
  }

  /** A list of `total` contacts with email addresses, `consented` of them with email marketing consent (over HTTP). */
  async function consentList(total: number, consented: number): Promise<{ listId: string; ids: string[]; emails: string[] }> {
    const listId = await list(`elig-${total}-${consented}-${randomUUID().slice(0, 6)}`);
    const ids: string[] = [];
    const emails: string[] = [];
    for (let i = 0; i < total; i++) {
      const email = `pf-${randomUUID().slice(0, 8)}@example.test`;
      const c = await owner.post(`/v1/workspaces/${W}/contacts`, { email });
      expect(c.status).toBe(201);
      if (i < consented) {
        const r = await owner.post(`/v1/workspaces/${W}/contacts/${c.body.id}/consent`, { channel: 'email', action: 'subscribed', source: 'form', lawfulBasis: 'consent', evidenceNote: 'Website form' });
        expect(r.status).toBeLessThan(300);
      }
      ids.push(c.body.id);
      emails.push(email);
    }
    expect((await owner.post(`/v1/workspaces/${W}/lists/${listId}/members`, { contactIds: ids })).status).toBe(200);
    return { listId, ids, emails };
  }
  const codes = (body: { readinessFindings: { code: string }[] }) => body.readinessFindings.map((f) => f.code);

  beforeAll(async () => {
    await resetTestDatabase();
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test' });
    owner = await signUp(t, undefined, 'Owner');
    ({ orgId, workspaceId: W } = await createOrg(owner, 'Preflight Co'));
    viewer = await signUp(t, undefined, 'Viewer');
    await inviteAndAccept(t, owner, viewer, orgId, 'member', [{ workspaceId: W, roleKey: 'viewer' }]);
    noRead = await signUp(t, undefined, 'NoRead');
    const custom = await owner.post(`/v1/organizations/${orgId}/roles`, { name: 'Contacts only', scope: 'workspace', permissions: ['contacts.read'] });
    expect(custom.status).toBe(201);
    const inv = await owner.post(`/v1/organizations/${orgId}/invitations`, {
      email: (noRead as Agent & { email: string }).email,
      organizationRoleId: await roleId(owner, orgId, 'member'),
      workspaces: [{ workspaceId: W, roleId: custom.body.id }],
    });
    expect(inv.status).toBe(201);
    expect((await noRead.post('/v1/invitations/accept', { token: t.mailer.tokenFrom((noRead as Agent & { email: string }).email, 'invitation') })).status).toBe(200);
    outsider = await signUp(t, undefined, 'Outsider');
    ({ workspaceId: WB } = await createOrg(outsider, 'Other Co'));
    topicId = (await owner.get(`/v1/workspaces/${W}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id;
  });
  afterAll(async () => t?.close());

  describe('sample sizes (uniform sample ≤ 2,000; exact audience size)', () => {
    for (const n of [0, 1, 1_999, 2_000, 2_001]) {
      it(`${n} members → audienceSize ${n}, sampleSize ${Math.min(n, 2_000)}`, async () => {
        const id = await campaignFor(await bulkList(n));
        const r = await owner.post(url(`/${id}/preflight`));
        expect(r.status).toBe(200);
        expect(r.body.estimate).toMatchObject({ audienceSize: n, audienceSizeCapped: false, sampleSize: Math.min(n, 2_000) });
        // Bare contacts have no address: nobody is eligible.
        expect(r.body.estimate.eligibleEstimate).toBe(0);
        expect(codes(r.body)).toContain(n === 0 ? 'AUDIENCE_EMPTY' : 'NO_ELIGIBLE_RECIPIENTS');
        expect(r.body.readiness).toBe('not_ready');
      }, 120_000);
    }

    it('a large audience (25,000): sample of exactly 2,000, exact size', async () => {
      const id = await campaignFor(await bulkList(25_000));
      const started = performance.now();
      const r = await owner.post(url(`/${id}/preflight`));
      const ms = performance.now() - started;
      expect(r.status).toBe(200);
      expect(r.body.estimate).toMatchObject({ audienceSize: 25_000, sampleSize: 2_000, eligibleEstimate: 0 });
      expect(r.body.estimate.topReasons[0].share).toBe(1);
      expect(ms).toBeLessThan(10_000); // functional bound only; the p95 target is measured by the benchmark
    }, 180_000);
  });

  it('concurrent pre-flights (6 × 4 eligibility slices on a 10-connection pool) all complete with the same exact size — no pool starvation', async () => {
    const id = await campaignFor(await bulkList(2_001));
    const rs = await Promise.all(Array.from({ length: 6 }, () => owner.post(url(`/${id}/preflight`))));
    for (const r of rs) {
      expect(r.status).toBe(200);
      expect(r.body.estimate).toMatchObject({ audienceSize: 2_001, sampleSize: 2_000 });
    }
    // and the API keeps serving other requests meanwhile
    expect((await owner.get(url(`/${id}`))).status).toBe(200);
  }, 120_000);

  describe('topic status', () => {
    it('valid topic: no topic finding', async () => {
      const r = await owner.post(url(`/${await campaignFor((await consentList(2, 2)).listId)}/preflight`));
      expect(r.status).toBe(200);
      expect(r.body.sections.topic).toBe('pass');
      expect(r.body.readiness).toBe('ready');
    });

    it('archived topic: TOPIC_UNAVAILABLE (error); the estimate falls back to channel rules', async () => {
      const topic = (await owner.post(`/v1/workspaces/${W}/topics`, { name: 'Archived news', key: 'archived_news' })).body.id as string;
      const id = await campaignFor((await consentList(2, 2)).listId, topic);
      expect((await owner.post(`/v1/workspaces/${W}/topics/${topic}/archive`)).status).toBe(200);
      const r = await owner.post(url(`/${id}/preflight`));
      expect(codes(r.body)).toContain('TOPIC_UNAVAILABLE');
      expect(r.body.sections.topic).toBe('error');
      expect(r.body.estimate.eligibleEstimate).toBe(2);
      // Restoring the topic clears the finding (live status, not cached).
      expect((await owner.post(`/v1/workspaces/${W}/topics/${topic}/restore`)).status).toBe(200);
      expect(codes((await owner.post(url(`/${id}/preflight`))).body)).not.toContain('TOPIC_UNAVAILABLE');
    });

    it('category: TOPIC_UNAVAILABLE', async () => {
      const category = (await owner.post(`/v1/workspaces/${W}/topics`, { name: 'News category', key: 'news_category', kind: 'category' })).body.id as string;
      const id = await campaignFor((await consentList(1, 1)).listId);
      const v = (await owner.get(url(`/${id}`))).body.version;
      expect((await owner.patch(url(`/${id}`), { expectedVersion: v, topicId: category })).status).toBe(200);
      const r = await owner.post(url(`/${id}/preflight`));
      expect(codes(r.body)).toContain('TOPIC_UNAVAILABLE');
    });

    it('foreign or missing topic: refused at write (composite FK) — never reaches pre-flight', async () => {
      const id = await campaignFor((await consentList(1, 1)).listId);
      const foreignTopic = (await outsider.get(`/v1/workspaces/${WB}/topics`)).body.data[0].id as string;
      for (const topic of [foreignTopic, randomUUID()]) {
        const r = await owner.patch(url(`/${id}`), { expectedVersion: 2, topicId: topic });
        expect(r.status).toBe(400);
        expect(JSON.stringify(r.body)).not.toMatch(/foreign key|constraint|violat|sql|prisma/i);
      }
      expect(codes((await owner.post(url(`/${id}/preflight`))).body)).not.toContain('TOPIC_UNAVAILABLE');
    });
  });

  describe('eligibility estimate', () => {
    for (const [label, total, consented, expected] of [
      ['all eligible', 6, 6, 'ready'],
      ['none eligible', 6, 0, 'NO_ELIGIBLE_RECIPIENTS'],
      ['low share (1 of 6)', 6, 1, 'LOW_ELIGIBLE_SHARE'],
      ['high share (5 of 6)', 6, 5, 'ready'],
    ] as const) {
      it(`${label}: estimate ${consented} of ${total}`, async () => {
        const id = await campaignFor((await consentList(total, consented)).listId);
        const r = await owner.post(url(`/${id}/preflight`));
        expect(r.status).toBe(200);
        expect(r.body.estimate).toMatchObject({ audienceSize: total, sampleSize: total, eligibleEstimate: consented });
        if (consented < total) expect(r.body.estimate.topReasons).toEqual([{ code: 'CONSENT_MISSING', share: Math.round(((total - consented) / total) * 10_000) / 10_000 }]);
        else expect(r.body.estimate.topReasons).toEqual([]);
        if (expected === 'ready') expect(r.body.readiness).toBe('ready');
        else expect(codes(r.body)).toContain(expected);
        if (expected === 'LOW_ELIGIBLE_SHARE') expect(r.body.readiness).toBe('ready'); // a warning
      });
    }
  });

  describe('degraded mode: fast resolution unavailable (contract §3.3, approved 2026-10-07)', () => {
    const bitmap = () =>
      withOwnerConnection(async (c) => (await c.query(`SELECT state, generation::int AS generation FROM audience_count_state WHERE workspace_id = $1`, [W])).rows[0] as { state: string; generation: number });
    const invalidate = () => withOwnerConnection((c) => c.query(`UPDATE audience_count_state SET state = 'invalid', reason = 'test' WHERE workspace_id = $1`, [W]));
    /** ACCESS EXCLUSIVE on list_memberships: the exact audience query cannot finish within its budget ("too slow"). */
    async function blockExact(): Promise<() => Promise<void>> {
      let unlock!: () => void;
      let locked!: () => void;
      const held = new Promise<void>((r) => (locked = r));
      const done = withOwnerConnection(async (c) => {
        await c.query('BEGIN');
        await c.query('LOCK TABLE list_memberships IN ACCESS EXCLUSIVE MODE');
        locked();
        await new Promise<void>((r) => (unlock = r));
        await c.query('ROLLBACK');
      });
      await held;
      return async () => { unlock(); await done; };
    }
    const waitValid = async () => {
      for (let i = 0; i < 120; i++) {
        if ((await bitmap()).state === 'valid') return;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error('bitmap did not recover');
    };
    const codesOf = (fs: { code: string }[]) => fs.map((x) => x.code);

    it('pre-flight answers 200 within its budget with ELIGIBILITY_ESTIMATE_UNAVAILABLE (never a 500, never an invented estimate); 8 concurrent calls start ONE recovery; then the normal path returns', async () => {
      const id = await campaignFor((await consentList(3, 3)).listId);
      await waitValid().catch(() => undefined);
      await invalidate();
      const g0 = (await bitmap()).generation;
      const release = await blockExact();
      let rs: { status: number; body: any; ms: number }[];
      try {
        rs = await Promise.all(Array.from({ length: 8 }, async () => {
          const t0 = performance.now();
          const r = await owner.post(url(`/${id}/preflight`));
          return { status: r.status, body: r.body, ms: performance.now() - t0 };
        }));
      } finally {
        await release();
      }
      for (const r of rs) {
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body.estimate).toBeNull();
        expect(r.body.readiness).toBe('not_ready');
        expect(r.body.sections.audience).toBe('error');
        const f = r.body.readinessFindings.find((x: { code: string }) => x.code === 'ELIGIBILITY_ESTIMATE_UNAVAILABLE');
        expect(f).toMatchObject({ severity: 'error', section: 'audience', details: { retryAfterSeconds: 30 } });
        expect(r.ms).toBeLessThan(5_000); // 1 s exact budget + overhead (8 at once, lock held), never the lock's duration
      }
      await waitValid();
      expect((await bitmap()).generation - g0).toBe(1); // exactly one rebuild for all 8 requests
      const after = await owner.post(url(`/${id}/preflight`));
      expect(after.status).toBe(200);
      expect(after.body.estimate).toMatchObject({ audienceSize: 3, eligibleEstimate: 3 });
      expect(codesOf(after.body.readinessFindings)).not.toContain('ELIGIBILITY_ESTIMATE_UNAVAILABLE');
    }, 180_000);

    it('bitmap not valid but the exact query fits the budget: normal answer (degraded only when it does not fit)', async () => {
      const id = await campaignFor((await consentList(2, 1)).listId);
      await invalidate();
      const r = await owner.post(url(`/${id}/preflight`));
      expect(r.status).toBe(200);
      expect(r.body.estimate).toMatchObject({ audienceSize: 2, eligibleEstimate: 1 });
      await waitValid().catch(() => undefined);
    }, 120_000);

    it('schedule / send-now while unavailable: 409 PREFLIGHT_UNAVAILABLE + Retry-After, nothing written; with another error it stays 422 PREFLIGHT_FAILED; after recovery it schedules', async () => {
      const id = await campaignFor((await consentList(2, 2)).listId);
      const versionOf = async () => (await owner.get(url(`/${id}`))).body.version as number;
      const rows = () =>
        withOwnerConnection(async (c) => ({
          versions: Number((await c.query(`SELECT count(*) AS n FROM campaign_versions WHERE campaign_id = $1`, [id])).rows[0].n),
          executions: Number((await c.query(`SELECT count(*) AS n FROM campaign_executions WHERE campaign_id = $1`, [id])).rows[0].n),
        }));
      await waitValid().catch(() => undefined);
      await invalidate();
      const v = await versionOf();
      const release = await blockExact();
      try {
        for (const body of [{ mode: 'now', expectedVersion: v }, { mode: 'at', sendAt: new Date(Date.now() + 86_400_000).toISOString(), expectedVersion: v }]) {
          const r = await owner.post(url(`/${id}/schedule`), body);
          expect(r.status, JSON.stringify(r.body)).toBe(409);
          expect(r.body.error.code).toBe('PREFLIGHT_UNAVAILABLE');
          expect(r.headers['retry-after']).toBe('30');
          expect(codesOf(r.body.error.findings)).toEqual(['ELIGIBILITY_ESTIMATE_UNAVAILABLE']);
          expect(JSON.stringify(r.body)).not.toMatch(/prisma|postgres|sql|timeout|57014/i);
        }
        expect(await rows()).toEqual({ versions: 0, executions: 0 });
        expect(await versionOf()).toBe(v);
        expect((await owner.get(url(`/${id}`))).body.status).toBe('draft');
        // another blocking problem too → the ordinary 422 with all errors (the user must fix that one first)
        const p = await owner.patch(url(`/${id}`), { expectedVersion: v, messages: [{ variantKey: 'default', content: { ...content, subject: '' } }] });
        expect(p.status).toBe(200);
        const mixed = await owner.post(url(`/${id}/schedule`), { mode: 'now', expectedVersion: p.body.version });
        expect(mixed.status).toBe(422);
        expect(mixed.body.error.code).toBe('PREFLIGHT_FAILED');
        expect(codesOf(mixed.body.error.findings)).toEqual(expect.arrayContaining(['SUBJECT_MISSING', 'ELIGIBILITY_ESTIMATE_UNAVAILABLE']));
        const fixed = await owner.patch(url(`/${id}`), { expectedVersion: p.body.version, messages: [{ variantKey: 'default', content }] });
        expect(fixed.status).toBe(200);
      } finally {
        await release();
      }
      expect(await rows()).toEqual({ versions: 0, executions: 0 });
      await waitValid();
      const ok = await owner.post(url(`/${id}/schedule`), { mode: 'at', sendAt: new Date(Date.now() + 86_400_000).toISOString(), expectedVersion: await versionOf() });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(await rows()).toEqual({ versions: 1, executions: 1 });
    }, 180_000);
  });

  describe('security and privacy', () => {
    let id: string;
    let seeded: { listId: string; ids: string[]; emails: string[] };
    beforeAll(async () => {
      seeded = await consentList(4, 3);
      id = await campaignFor(seeded.listId);
    });

    it('viewer (campaigns.read) may run it; a role without campaigns.read is 403; unauthenticated 401', async () => {
      expect((await viewer.post(url(`/${id}/preflight`))).status).toBe(200);
      const denied = await noRead.post(url(`/${id}/preflight`));
      expect(denied.status).toBe(403);
      const anon = new Agent(t);
      expect((await anon.post(url(`/${id}/preflight`))).status).toBe(401);
    });

    it('cross-workspace / cross-org / IDOR: 404, and nothing about the campaign leaks', async () => {
      const own = await outsider.post(url(`/${id}/preflight`, WB)); // their workspace, our campaign id
      expect(own.status).toBe(404);
      const ours = await outsider.post(url(`/${id}/preflight`)); // our workspace path
      expect(ours.status).toBe(404);
      expect((await owner.post(url(`/${randomUUID()}/preflight`))).status).toBe(404);
      expect((await owner.post(url('/not-a-uuid/preflight'))).status).toBe(404);
      for (const r of [own, ours]) expect(JSON.stringify(r.body)).not.toContain(seeded.listId);
    });

    it('strict body: unknown fields (e.g. workspaceId) are 400', async () => {
      const r = await owner.post(url(`/${id}/preflight`), { workspaceId: WB });
      expect(r.status).toBe(400);
    });

    it('no contact data in the response or findings; no write, no snapshot, no audit, no event; nothing in logs', async () => {
      const before = await withOwnerConnection(async (c) => (await c.query(`SELECT version, updated_at FROM campaigns WHERE id = $1`, [id])).rows[0]);
      const counts = async () => ({
        snapshots: await count(`SELECT count(*) AS n FROM audience_snapshots`),
        events: await count(`SELECT count(*) AS n FROM domain_events WHERE aggregate_id = $1`, [id]),
        audits: await count(`SELECT count(*) AS n FROM audit_logs WHERE target_id = $1`, [id]),
      });
      const c0 = await counts();
      const logged: string[] = [];
      const out = process.stdout.write.bind(process.stdout);
      const errw = process.stderr.write.bind(process.stderr);
      process.stdout.write = ((chunk: string | Uint8Array, ...rest: never[]) => (logged.push(String(chunk)), out(chunk, ...rest))) as typeof process.stdout.write;
      process.stderr.write = ((chunk: string | Uint8Array, ...rest: never[]) => (logged.push(String(chunk)), errw(chunk, ...rest))) as typeof process.stderr.write;
      let r;
      try {
        r = await owner.post(url(`/${id}/preflight`));
      } finally {
        process.stdout.write = out;
        process.stderr.write = errw;
      }
      expect(r.status).toBe(200);
      expect(r.body.estimate).toMatchObject({ audienceSize: 4, eligibleEstimate: 3, sampleSize: 4 });
      const text = JSON.stringify(r.body);
      expect(Object.keys(r.body).sort()).toEqual(['checkedAt', 'estimate', 'readiness', 'readinessFindings', 'sections']);
      expect(Object.keys(r.body.estimate).sort()).toEqual(['audienceSize', 'audienceSizeCapped', 'eligibleEstimate', 'sampleSize', 'topReasons']);
      for (const secret of [...seeded.ids, ...seeded.emails]) {
        expect(text).not.toContain(secret);
        expect(logged.join('')).not.toContain(secret);
      }
      expect(text).not.toMatch(/contactId|email"|phone/i);
      expect(await counts()).toEqual(c0);
      const after = await withOwnerConnection(async (c) => (await c.query(`SELECT version, updated_at FROM campaigns WHERE id = $1`, [id])).rows[0]);
      expect(after).toEqual(before);
      // Domain events and audit rows of the whole workspace carry no contact id of the sample either.
      const all = await withOwnerConnection(async (c) => JSON.stringify((await c.query(`SELECT payload FROM domain_events WHERE type LIKE 'campaign.%'`)).rows) + JSON.stringify((await c.query(`SELECT metadata FROM audit_logs WHERE action LIKE 'campaign.%'`)).rows));
      for (const secret of seeded.ids) expect(all).not.toContain(secret);
    });
  });
});
