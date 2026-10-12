/**
 * Opt-in benchmark for milestone 6.7 (target: pre-flight p95 < 2 s). Not part of the default suite:
 *   PREFLIGHT_BENCH=1 [PREFLIGHT_BENCH_SIZES=100000,500000,1000000] [PREFLIGHT_BENCH_OUT=bench.jsonl] pnpm --filter @workeasy/api exec vitest run test/campaigns-preflight-bench.test.ts
 * Prints one JSON line per measurement (prefix BENCH) for docs/audit.
 *
 * Measured END TO END through HTTP (auth, guard, rate limit, PreflightService → Audience Resolution v1.1 → Eligibility
 * v1.1), on both Audience paths: exact (bitmap not built) and verified bitmap (after a rebuild, the steady state the
 * maintenance job keeps). Plus a per-component breakdown through the same ports as workeasy_app.
 *
 * Dataset per size N (seeded through the owner connection): N contacts with a primary email identity; 2 include lists
 * (all contacts in one, 20 % also in the second — overlap), 1 exclusion list (5 %), 1 % deleted; for EVERY contact a
 * consent event + state (1/7 withdrawn), topic preference on the default topic for half (10 % of those unsubscribed),
 * 5 % suppressed. The sample is uniform over the whole audience, so facts must exist across it, not in a corner.
 * Consent fingerprints are synthetic (they never match the address): the evaluator reads the same rows and runs the
 * same queries, only the reason differs (INFERRED: equal cost).
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createDatabase, type Database } from '@workeasy/db';
import { createAudienceReadSide, rebuildCountBitmap } from '@workeasy/audience-infra';
import { testDatabaseUrls } from '@workeasy/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Agent, createOrg, inviteAndAccept, resetTestDatabase, signUp, startTestApp, type TestApp, withOwnerConnection } from './support.js';

const ENABLED = !!process.env.PREFLIGHT_BENCH;
const SIZES = (process.env.PREFLIGHT_BENCH_SIZES ?? '100000,500000,1000000').split(',').filter(Boolean).map(Number);
const RUNS = Number(process.env.PREFLIGHT_BENCH_RUNS ?? 25);
const WARMUP = 3;
const pct = (xs: number[], p: number) => Float64Array.from(xs).sort()[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)]!;
const stats = (xs: number[]) => ({ n: xs.length, p50: +pct(xs, 50).toFixed(1), p95: +pct(xs, 95).toFixed(1), p99: +pct(xs, 99).toFixed(1), max: +xs.reduce((m, x) => Math.max(m, x), -Infinity).toFixed(1) });
/** One JSON line per measurement; also appended to PREFLIGHT_BENCH_OUT when set (vitest hides passing tests' logs). */
const report = (name: string, data: Record<string, unknown>) => {
  const line = `BENCH ${JSON.stringify({ name, at: new Date().toISOString(), ...data })}`;
  console.log(line);
  if (process.env.PREFLIGHT_BENCH_OUT) appendFileSync(process.env.PREFLIGHT_BENCH_OUT, `${line}\n`);
};

describe.skipIf(!ENABLED)('pre-flight benchmark (6.7)', () => {
  let t: TestApp;
  let owner: Agent;
  let db: Database;
  const readSide = createAudienceReadSide({ fingerprintSecret: 'bench-fingerprint-secret-0123456789abcdef' });

  beforeAll(async () => {
    await resetTestDatabase();
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test' });
    owner = await signUp(t, undefined, 'Bench owner');
    db = createDatabase({ url: testDatabaseUrls().app, maxConnections: 4 });
  });
  afterAll(async () => {
    await db?.disconnect();
    await t?.close();
  });

  for (const n of SIZES) {
    it(`${n.toLocaleString('en')} contacts`, async () => {
      const { orgId, workspaceId: W } = await createOrg(owner, `Bench ${n}`);
      const topicId = (await owner.get(`/v1/workspaces/${W}/topics`)).body.data.find((x: { key: string }) => x.key === 'marketing').id as string;
      const [all, overlap, exclusion] = [randomUUID(), randomUUID(), randomUUID()];
      const seedStart = performance.now();
      await withOwnerConnection(async (c) => {
        const q = (sql: string, v: unknown[] = []) => c.query(sql, v);
        await q(`SET statement_timeout = 0`);
        await q('BEGIN');
        await q(`CREATE TEMP TABLE b_c ON COMMIT DROP AS SELECT g, gen_random_uuid() AS id, gen_random_uuid() AS ev FROM generate_series(1, $1::int) g`, [n]);
        await q(`INSERT INTO contacts (id, org_id, workspace_id, deleted_at) SELECT id, $1::uuid, $2::uuid, CASE WHEN g % 100 = 0 THEN now() END FROM b_c`, [orgId, W]);
        await q(`ANALYZE contacts`);
        await q(
          `INSERT INTO contact_identities (id, org_id, workspace_id, contact_id, kind, value, value_normalized, is_primary)
           SELECT gen_random_uuid(), $1::uuid, $2::uuid, id, 'email', 'b' || g || '@bench.test', 'b' || g || '@bench.test', true FROM b_c`,
          [orgId, W],
        );
        for (const [id, name] of [[all, 'all'], [overlap, 'overlap'], [exclusion, 'exclusion']]) {
          await q(`INSERT INTO lists (id, org_id, workspace_id, name, name_key) VALUES ($1, $2, $3, $4, $4)`, [id, orgId, W, `${name}-${n}`]);
        }
        await q(
          `INSERT INTO list_memberships (org_id, workspace_id, list_id, contact_id)
           SELECT $1::uuid, $2::uuid, $3::uuid, id FROM b_c
           UNION ALL SELECT $1::uuid, $2::uuid, $4::uuid, id FROM b_c WHERE g % 5 = 0
           UNION ALL SELECT $1::uuid, $2::uuid, $5::uuid, id FROM b_c WHERE g % 20 = 7`,
          [orgId, W, all, overlap, exclusion],
        );
        await q(
          `INSERT INTO consent_events (id, org_id, workspace_id, contact_id, channel, action, previous_state, new_state, source, actor_type, correlation_id, occurred_at, subject_fingerprint)
           SELECT ev, $1::uuid, $2::uuid, id, 'email', 'subscribed', 'none', 'granted', 'admin', 'user', gen_random_uuid(), now(), md5(id::text) FROM b_c`,
          [orgId, W],
        );
        await q(
          `INSERT INTO consent_states (org_id, workspace_id, contact_id, channel, state, changed_by, last_event_id, changed_at, subject_fingerprint)
           SELECT $1::uuid, $2::uuid, id, 'email', CASE WHEN g % 7 = 0 THEN 'withdrawn' ELSE 'granted' END, 'user', ev, now(), md5(id::text) FROM b_c`,
          [orgId, W],
        );
        await q(
          `INSERT INTO contact_topic_preferences (org_id, workspace_id, contact_id, topic_id, status, changed_by, last_event_id, changed_at)
           SELECT $1::uuid, $2::uuid, id, $3::uuid, CASE WHEN g % 10 = 1 THEN 'unsubscribed' ELSE 'subscribed' END, 'user', ev, now() FROM b_c WHERE g % 2 = 0`,
          [orgId, W, topicId],
        );
        await q(
          `INSERT INTO suppressions (id, org_id, workspace_id, channel, contact_id, reason, source, active_key)
           SELECT gen_random_uuid(), $1::uuid, $2::uuid, 'all', id, 'manual', 'admin', 'contact:' || id || ':all' FROM b_c WHERE g % 20 = 0`,
          [orgId, W],
        );
        await q('COMMIT');
        await q(`VACUUM (ANALYZE) contacts, list_memberships, contact_identities, consent_states, consent_events, contact_topic_preferences, suppressions`);
      });
      report('preflight.seed', { size: n, ms: Math.round(performance.now() - seedStart) });

      const c = await owner.post(`/v1/workspaces/${W}/campaigns`, { name: `Bench ${n}`, channel: 'email', topicId });
      const p = await owner.patch(`/v1/workspaces/${W}/campaigns/${c.body.id}`, {
        expectedVersion: 1,
        audience: { include: [{ type: 'list', listId: all }, { type: 'list', listId: overlap }], exclude: [{ type: 'list', listId: exclusion }] },
        sender: { senderIdentityId: null, fromName: 'Bench', replyTo: null },
        messages: [{ variantKey: 'default', content: { schema: 'email.content.v1', subject: 'Bench', preheader: '', body: { format: 'text', text: 'Bench' } } }],
      });
      expect(p.status).toBe(200);
      // Independent oracle for the exact audience size (the owner, plain set algebra; never the bitmap).
      const oracle = await withOwnerConnection(async (cl) =>
        Number(
          (
            await cl.query(
              `SELECT count(DISTINCT m.contact_id) AS n FROM list_memberships m JOIN contacts k ON k.id = m.contact_id
               WHERE m.list_id = ANY($1::uuid[]) AND k.deleted_at IS NULL
                 AND NOT EXISTS (SELECT 1 FROM list_memberships e WHERE e.list_id = $2 AND e.contact_id = m.contact_id)`,
              [[all, overlap], exclusion],
            )
          ).rows[0].n,
        ),
      );

      /**
       * 'degraded': before EVERY request the bitmap is invalidated the way a real invalidation does it (state invalid,
       * generation + 1 — any running recovery is superseded), so each request faces a not-valid bitmap while recovery
       * runs concurrently: the worst case. Answers are either a normal exact answer (fit the 1 s budget) or
       * ELIGIBILITY_ESTIMATE_UNAVAILABLE. Since 2026-10-07 no request may fail on either path (no 500).
       */
      const invalidate = () =>
        withOwnerConnection((cl) => cl.query(`UPDATE audience_count_state SET state = 'invalid', generation = generation + 1, reason = 'bench', rebuild_token = NULL, rebuild_lease_until = NULL WHERE workspace_id = $1`, [W]));
      const measure = async (path: 'degraded' | 'bitmap') => {
        // Fresh read-only user per path: the 60/h/user rate limit is part of the measured stack and must not trip.
        const viewer = await signUp(t, undefined, `Bench viewer ${path}`);
        await inviteAndAccept(t, owner, viewer, orgId, 'member', [{ workspaceId: W, roleKey: 'viewer' }]);
        const times: number[] = [];
        const answers = { normal: 0, unavailable: 0 };
        let last: { estimate: { audienceSize: number; sampleSize: number; eligibleEstimate: number; topReasons: unknown[] } } | null = null;
        for (let i = 0; i < WARMUP + RUNS; i++) {
          if (path === 'degraded') await invalidate();
          const t0 = performance.now();
          const r = await viewer.post(`/v1/workspaces/${W}/campaigns/${c.body.id}/preflight`);
          const ms = performance.now() - t0;
          expect(r.status, JSON.stringify(r.body)).toBe(200);
          if (r.body.estimate) {
            answers.normal++;
            last = r.body;
          } else {
            expect(r.body.readinessFindings.map((x: { code: string }) => x.code)).toContain('ELIGIBILITY_ESTIMATE_UNAVAILABLE');
            answers.unavailable++;
          }
          if (path === 'bitmap') expect(r.body.estimate).not.toBeNull();
          if (i >= WARMUP) times.push(ms);
        }
        if (last) {
          expect(last.estimate.audienceSize).toBe(oracle);
          expect(last.estimate.sampleSize).toBe(Math.min(2_000, oracle));
        }
        const s = stats(times);
        report('preflight.http', { size: n, path, audienceSize: oracle, answers, sampleSize: last?.estimate.sampleSize ?? null, eligibleEstimate: last?.estimate.eligibleEstimate ?? null, ...s, failures: 0, target: 'p95 < 2000 ms, no failures', pass: s.p95 < 2_000 });
        return s;
      };
      /** After the degraded phase a recovery may hold the rebuild lease: wait for it (or rebuild if none is running). */
      const ensureValid = async () => {
        const t0 = performance.now();
        for (;;) {
          const st = await withOwnerConnection(async (cl) => (await cl.query(`SELECT state, coalesce(rebuild_lease_until > now(), false) AS leased FROM audience_count_state WHERE workspace_id = $1`, [W])).rows[0]);
          if (st.state === 'valid') break;
          if (!st.leased) await rebuildCountBitmap(db, { orgId, workspaceId: W });
          else await new Promise((r) => setTimeout(r, 1_000));
        }
        report('preflight.bitmap_ready', { size: n, ms: Math.round(performance.now() - t0) });
      };

      const components = async (path: 'bitmap') => {
        const def = { include: [{ type: 'list' as const, listId: all }, { type: 'list' as const, listId: overlap }], exclude: [{ type: 'list' as const, listId: exclusion }] };
        const parts: Record<string, number[]> = { topic: [], validate: [], sample: [], eligibility: [], total: [] };
        let componentFailures = 0;
        for (let i = 0; i < WARMUP + 10; i++) {
          await db.withTenant({ orgId, workspaceId: W, userId: null }, async (tx) => {
            const scope = { tx, orgId, workspaceId: W };
            const t0 = performance.now();
            await readSide.resolution.topicStatus(scope, topicId);
            const t1 = performance.now();
            await readSide.resolution.validate(scope, def);
            const t2 = performance.now();
            const sample = await readSide.resolution.sample(scope, def, { size: 2_000 });
            const t3 = performance.now();
            for (let j = 0; j < sample.contactIds.length; j += 1_000) {
              await readSide.eligibility.evaluateInBatches(scope, { contactIds: sample.contactIds.slice(j, j + 1_000), channel: 'email', purpose: 'marketing', topicId, topicPolicy: 'block_unsubscribed' });
            }
            const t4 = performance.now();
            if (i >= WARMUP) {
              parts.topic!.push(t1 - t0);
              parts.validate!.push(t2 - t1);
              parts.sample!.push(t3 - t2);
              parts.eligibility!.push(t4 - t3);
              parts.total!.push(t4 - t0);
            }
          }, { timeout: 60_000 }).catch((err: unknown) => {
            if (path === 'bitmap') throw err;
            componentFailures++;
          });
        }
        report('preflight.components', { size: n, path, mode: 'ports called serially (1,000 ids per eligibility call) — raw IO cost; HTTP uses the service', failures: componentFailures, ...Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.length ? stats(v) : null])) });
      };

      const degraded = await measure('degraded');
      // Informational: 4 degraded pre-flights at once (one recovery for all of them).
      const busyD = await signUp(t, undefined, 'Bench concurrent degraded');
      await inviteAndAccept(t, owner, busyD, orgId, 'member', [{ workspaceId: W, roleKey: 'viewer' }]);
      const concurrentD: number[] = [];
      for (let round = 0; round < 3; round++) {
        await invalidate();
        await Promise.all(Array.from({ length: 4 }, async () => {
          const t0 = performance.now();
          const r = await busyD.post(`/v1/workspaces/${W}/campaigns/${c.body.id}/preflight`);
          expect(r.status).toBe(200);
          concurrentD.push(performance.now() - t0);
        }));
      }
      report('preflight.http_concurrent4', { size: n, path: 'degraded', ...stats(concurrentD) });
      await ensureValid();
      const bitmap = await measure('bitmap');
      await components('bitmap');
      // Informational: 4 pre-flights at once (shared eligibility slots, 10-connection pool), 3 rounds.
      const busy = await signUp(t, undefined, 'Bench concurrent');
      await inviteAndAccept(t, owner, busy, orgId, 'member', [{ workspaceId: W, roleKey: 'viewer' }]);
      const concurrent: number[] = [];
      for (let round = 0; round < 3; round++) {
        await Promise.all(Array.from({ length: 4 }, async () => {
          const t0 = performance.now();
          const r = await busy.post(`/v1/workspaces/${W}/campaigns/${c.body.id}/preflight`);
          expect(r.status).toBe(200);
          concurrent.push(performance.now() - t0);
        }));
      }
      report('preflight.http_concurrent4', { size: n, path: 'bitmap', ...stats(concurrent) });
      report('preflight.summary', { size: n, degradedP95: degraded.p95, bitmapP95: bitmap.p95 });
    }, 4 * 3_600_000);
  }
});
