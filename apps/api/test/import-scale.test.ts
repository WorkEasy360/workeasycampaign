import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Agent, createOrg, resetTestDatabase, signUp, startTestApp, type TestApp, uploadCsv, waitForImport } from './support.js';

/**
 * Opt-in scale measurement for imports at the configured maximum (100,000 rows). Not part of the default suite:
 *   IMPORT_SCALE=1 pnpm --filter @workeasy/api exec vitest run test/import-scale.test.ts
 * Prints timings and memory so docs/audit/phase-5-hardening-audit.md can quote measured numbers.
 */
const ROWS = Number(process.env.IMPORT_SCALE_ROWS ?? 100_000);

describe.skipIf(!process.env.IMPORT_SCALE)('import at maximum scale', () => {
  let t: TestApp;
  let owner: Agent;
  let W: string;
  beforeAll(async () => {
    await resetTestDatabase();
    t = await startTestApp();
    owner = await signUp(t, undefined, 'Scale');
    W = (await createOrg(owner, 'Scale Co')).workspaceId;
  });
  afterAll(async () => t?.close());

  it(`uploads, dry-runs and imports ${ROWS} rows within bounded time and memory`, { timeout: 1_800_000 }, async () => {
    const lines = ['Email,First name,Last name,Company'];
    for (let i = 0; i < ROWS; i++) lines.push(`person${i}@scale.test,First${i},Last${i},Company ${i % 500}`);
    const csv = Buffer.from(lines.join('\n'));
    const mb = (n: number) => Math.round(n / 1024 / 1024);
    const rss0 = process.memoryUsage().rss;
    let peak = rss0;
    const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 200);

    let t0 = Date.now();
    const up = await uploadCsv(owner, W, csv, 'scale.csv');
    expect(up.status).toBe(201);
    const uploadMs = Date.now() - t0;
    const id = up.body.id as string;

    const imp = (await owner.get(`/v1/workspaces/${W}/imports/${id}`)).body;
    const put = await owner.put(`/v1/workspaces/${W}/imports/${id}/mapping`, { mapping: imp.mapping, options: { mode: 'create_or_update' }, version: imp.version });
    expect(put.status).toBe(200);

    t0 = Date.now();
    const dry = await owner.post(`/v1/workspaces/${W}/imports/${id}/dry-run`, {});
    const dryMs = Date.now() - t0;
    expect(dry.status).toBe(200);
    expect(dry.body.dryRun.create).toBe(ROWS);

    t0 = Date.now();
    const start = await owner.post(`/v1/workspaces/${W}/imports/${id}/start`, {});
    expect(start.status).toBe(202);
    const done = await waitForImport(owner, W, id, 1_700_000);
    const runMs = Date.now() - t0;
    clearInterval(sampler);
    expect(done.status).toBe('completed');
    expect(done.counts.created).toBe(ROWS);

    console.log(
      JSON.stringify({ rows: ROWS, fileMB: Math.round((csv.length / 1024 / 1024) * 10) / 10, uploadMs, dryRunMs: dryMs, runMs, rssStartMB: mb(rss0), rssPeakMB: mb(peak) }),
    );
  });
});
