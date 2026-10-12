import { randomUUID } from 'node:crypto';
import type { Database, Tx } from '@workeasy/db';
import type { Workspace } from './snapshot-cleanup.js';

/**
 * Maintenance of the Audience count bitmap (Phase 6.3 G2; migration 20261013000000_audience_count_bitmap;
 * docs/audit/phase-6.3-g2-closure.md, phase-6.3-bitmap-online-rebuild-readiness.md).
 *
 * Writers keep the bitmap current through triggers. This module only repairs and checks it:
 *   rebuild   — online, one rebuilder per workspace (lease), one chunk per short transaction, exclusive chunk lock taken
 *               without queueing ahead of writers (try-lock, then bounded waits; busy chunks are skipped and retried),
 *               whole-bitmap verification and a generation compare-and-set before VALID is published.
 *   reconcile — VALID bitmaps only: whole-bitmap verification in one statement; any difference marks it INVALID.
 *   gc        — deletes all-zero chunks (each under its chunk lock, re-checked).
 * Every step runs inside withTenant for ONE workspace, as the runtime role: RLS confines it to that workspace.
 */

export interface CountRebuildOptions {
  /** Lease length; renewed while the rebuild progresses. */
  leaseSeconds?: number;
  /** Contacts given a position per transaction (first rebuild after installation). */
  positionBatch?: number;
  /** Statement timeout for one position batch (the runtime default of 15 s is too short at 5M; MEASURED). */
  positionTimeoutMs?: number;
  /** Repair passes over busy chunks before giving up (the lease then expires and a later run takes over). */
  maxPasses?: number;
  /** Longest wait for one chunk lock in passes after the first (the first pass only tries). */
  lockWaitMs?: number; // keep below the server's deadlock_timeout (1 s default)
  /** Statement timeout for the whole-bitmap statements (repair list, verification). */
  verifyTimeoutMs?: number;
  /** Statement timeout for one chunk repair; unset = the role default (15 s). Tests force timeouts with it. */
  chunkTimeoutMs?: number;
  /**
   * Test hook (failure injection): awaited at each stage; throwing aborts the rebuild there, like a crash.
   * 'begun' after R1, 'first-chunk' after the first repaired chunk, 'halfway', 'repaired' after the last chunk
   * (before verification), 'published' after VALID.
   */
  onStage?: (stage: CountRebuildStage) => Promise<void>;
}

export type CountRebuildOutcome =
  | {
      outcome: 'published';
      generation: string;
      chunks: number;
      skippedRetries: number;
      passes: number;
      ms: number;
      /** Wall time per stage: positions, repair list, chunk repair, verification + compare-and-set. */
      stageMs: { positions: number; list: number; repair: number; finish: number };
    }
  | { outcome: 'busy' } // another rebuilder holds a live lease
  | { outcome: 'superseded'; generation: string; stage: string } // invalidated or taken over meanwhile: NOT published
  | { outcome: 'verify_failed'; generation: string; result: Record<string, unknown> } // marked INVALID again
  | { outcome: 'incomplete'; generation: string; busyChunks: number }; // chunks stayed busy; lease left to expire

export type CountRebuildStage = 'begun' | 'first-chunk' | 'halfway' | 'repaired' | 'published';

/** Transient lock conflicts on a chunk count as "busy": the chunk is retried in a later pass. */
const isLockConflict = (e: unknown) => /\b(40P01|40001|55P03)\b|deadlock|could not obtain lock|lock timeout/i.test(String((e as { message?: string })?.message ?? e));

/**
 * A chunk repair that ran into its statement timeout (57014) on a loaded server. The chunk's transaction rolled back as
 * a whole, so it is retried in a later pass like a busy chunk; if it keeps timing out the rebuild ends 'incomplete' and
 * the next maintenance run continues (counts use the exact query until the bitmap is published). Before 2026-10-10 the
 * timeout aborted the whole rebuild with an error (found in a CI-equivalent Linux run under host memory pressure).
 */
const isStatementTimeout = (e: unknown) => /\b57014\b|canceling statement due to statement timeout/i.test(String((e as { message?: string })?.message ?? e));

const DEFAULTS = { leaseSeconds: 120, positionBatch: 10_000, positionTimeoutMs: 120_000, maxPasses: 12, lockWaitMs: 200, verifyTimeoutMs: 300_000 };

/** Transaction-local statement timeout for one whole-workspace statement (never above the transaction timeout). */
async function longStatement<T>(tx: Tx, ms: number, run: () => Promise<T>): Promise<T> {
  await tx.$executeRawUnsafe(`SELECT set_config('statement_timeout', $1, true)`, `${ms}ms`);
  return run();
}

export async function rebuildCountBitmap(db: Database, workspace: Workspace, options: CountRebuildOptions = {}): Promise<CountRebuildOutcome> {
  const o = { ...DEFAULTS, ...options };
  const ctx = { ...workspace, userId: null };
  const token = randomUUID();
  const started = Date.now();
  const inWs = <T>(fn: (tx: Tx) => Promise<T>, timeout = 10_000) => db.withTenant(ctx, fn, { timeout });

  // R1 — lease + REBUILDING + new generation.
  const [begun] = await inWs((tx) =>
    tx.$queryRawUnsafe<{ g: bigint | null }[]>(`SELECT app.audience_count_begin_rebuild($1::uuid, $2::int) AS g`, token, o.leaseSeconds),
  );
  if (begun!.g === null) return { outcome: 'busy' };
  const generation = begun!.g;
  let renewedAt = Date.now();
  const renew = async (force = false): Promise<boolean> => {
    if (!force && Date.now() - renewedAt < (o.leaseSeconds * 1000) / 4) return true;
    const [r] = await inWs((tx) =>
      tx.$queryRawUnsafe<{ ok: boolean }[]>(`SELECT app.audience_count_renew_lease($1::uuid, $2::bigint, $3::int) AS ok`, token, generation, o.leaseSeconds),
    );
    renewedAt = Date.now();
    return r!.ok;
  };
  const superseded = (stage: string): CountRebuildOutcome => ({ outcome: 'superseded', generation: String(generation), stage });
  await o.onStage?.('begun');
  const stageMs = { positions: 0, list: 0, repair: 0, finish: 0 };
  let mark = Date.now();
  const lap = (k: keyof typeof stageMs) => {
    stageMs[k] = Date.now() - mark;
    mark = Date.now();
  };

  // R2 — positions for contacts that have none (only after installation or a lost position); skipped when none lacks one.
  const [missing] = await inWs(
    (tx) => longStatement(tx, o.verifyTimeoutMs, () => tx.$queryRawUnsafe<{ m: boolean }[]>(`SELECT app.audience_count_positions_missing() AS m`)),
    o.verifyTimeoutMs + 10_000,
  );
  for (let after: string | null = null; missing!.m; ) {
    const [r] = await inWs(
      (tx) =>
        longStatement(tx, o.positionTimeoutMs, () =>
          tx.$queryRawUnsafe<{ last: string | null }[]>(`SELECT app.audience_count_fill_positions($1::uuid, $2::int)::text AS last`, after, o.positionBatch),
        ),
      o.positionTimeoutMs + 10_000,
    );
    if (!(await renew())) return superseded('positions');
    if (r!.last === null) break;
    after = r!.last;
  }
  lap('positions');

  // R3 — what to repair: position chunks of this workspace ∪ chunks with stored non-zero bits.
  let pending = (
    await inWs(
      (tx) => longStatement(tx, o.verifyTimeoutMs, () => tx.$queryRawUnsafe<{ chunk: bigint }[]>(`SELECT chunk FROM app.audience_count_repair_list()`)),
      o.verifyTimeoutMs + 10_000,
    )
  ).map((r) => r.chunk);
  const chunks = pending.length;
  lap('list');

  // R4 — repair, one position chunk (all its sources + dead bits) per short transaction. Busy chunks (a writer holds
  // one of their locks) are skipped and retried in later passes.
  let passes = 0;
  let skippedRetries = 0;
  let repaired = 0;
  while (pending.length && passes < o.maxPasses) {
    const wait = passes === 0 ? 0 : o.lockWaitMs;
    passes++;
    const busy: bigint[] = [];
    for (const chunk of pending) {
      const repairChunk = (tx: Tx) => tx.$queryRawUnsafe<{ ok: boolean }[]>(`SELECT app.audience_count_repair_chunk($1::bigint, $2::int) AS ok`, chunk, wait);
      const ok = await inWs(async (tx) => (await (o.chunkTimeoutMs ? longStatement(tx, o.chunkTimeoutMs, () => repairChunk(tx)) : repairChunk(tx)))[0]!.ok).catch(
        (e: unknown) => (isLockConflict(e) || isStatementTimeout(e) ? false : Promise.reject(e)),
      );
      if (!ok) busy.push(chunk);
      else if (++repaired === 1) await o.onStage?.('first-chunk');
      else if (repaired === Math.ceil(chunks / 2)) await o.onStage?.('halfway');
      if (!(await renew())) return superseded('repair');
    }
    skippedRetries += busy.length;
    pending = busy;
    if (pending.length) await new Promise((res) => setTimeout(res, Math.min(50 * passes, 500)));
  }
  if (pending.length) return { outcome: 'incomplete', generation: String(generation), busyChunks: pending.length };
  if (!(await renew(true))) return superseded('before-verify');

  await o.onStage?.('repaired');
  lap('repair');

  // R5 — whole-bitmap verification + generation/token compare-and-set, in one function call.
  const [fin] = await inWs(
    (tx) =>
      longStatement(tx, o.verifyTimeoutMs, () =>
        tx.$queryRawUnsafe<{ f: Record<string, unknown> & { ok: boolean; published: boolean; superseded: boolean } }[]>(
          `SELECT app.audience_count_finish_rebuild($1::uuid, $2::bigint) AS f`,
          token,
          generation,
        ),
      ),
    o.verifyTimeoutMs + 10_000,
  );
  const f = fin!.f;
  lap('finish');
  if (f.published) await o.onStage?.('published');
  if (f.published) return { outcome: 'published', generation: String(generation), chunks, skippedRetries, passes, ms: Date.now() - started, stageMs };
  if (f.superseded) return superseded('finish');
  return { outcome: 'verify_failed', generation: String(generation), result: f };
}

export interface CountReconcileResult {
  skipped?: string;
  ok?: boolean;
  sourceDiff?: number;
  deadDiff?: number;
  positionsMissing?: number;
  ms?: number;
}

/** Reconciliation of one workspace (VALID only). A difference marks the bitmap INVALID; the result is recorded. */
export async function reconcileCountBitmap(db: Database, workspace: Workspace, opts: { timeoutMs?: number } = {}): Promise<CountReconcileResult> {
  const ms = opts.timeoutMs ?? DEFAULTS.verifyTimeoutMs;
  const [r] = await db.withTenant(
    { ...workspace, userId: null },
    (tx) => longStatement(tx, ms, () => tx.$queryRawUnsafe<{ r: CountReconcileResult }[]>(`SELECT app.audience_count_reconcile() AS r`)),
    { timeout: ms + 10_000 },
  );
  return r!.r;
}

/** Deletes all-zero chunks of one workspace; repeat until `deleted` is 0. Never changes a count. */
export async function gcCountBitmap(db: Database, workspace: Workspace, limit = 1_000): Promise<{ deleted: number; busy: number }> {
  const [r] = await db.withTenant({ ...workspace, userId: null }, (tx) =>
    tx.$queryRawUnsafe<{ r: { deleted: number; busy: number } }[]>(`SELECT app.audience_count_gc($1::int) AS r`, limit),
  );
  return r!.r;
}

export interface CountMaintenanceLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface CountMaintenanceReport {
  workspaces: number;
  rebuilt: number;
  reconciled: number;
  reconcileFailures: number;
  rebuildNotPublished: number;
  /** All-zero chunk rows deleted by garbage collection in this run. */
  gcDeleted: number;
  errors: number;
}

/** Garbage collection until a pass deletes nothing (bounded: a busy chunk is left for the next run). */
async function gcAll(db: Database, ws: Workspace): Promise<{ deleted: number; busy: number; passes: number }> {
  const total = { deleted: 0, busy: 0, passes: 0 };
  for (let i = 0; i < 100; i++) {
    const r = await gcCountBitmap(db, ws);
    total.deleted += r.deleted;
    total.busy = r.busy;
    total.passes++;
    if (r.deleted === 0) break;
  }
  return total;
}

/**
 * One maintenance run (the worker calls it on an interval): rebuilds every bitmap that is not valid, reconciles every
 * valid bitmap not reconciled within `reconcileEveryMs` (24 h), and garbage-collects after each rebuild. A
 * reconciliation difference is an ALERT (logged at error level with ids only) and is followed by a rebuild.
 */
export async function runCountMaintenance(
  db: Database,
  log: CountMaintenanceLogger,
  opts: { reconcileEveryMs?: number; limit?: number; now?: Date; rebuild?: CountRebuildOptions } = {},
): Promise<CountMaintenanceReport> {
  const now = opts.now ?? new Date();
  const due = await db.system.workspacesWithCountMaintenance(new Date(now.getTime() - (opts.reconcileEveryMs ?? 24 * 3_600_000)), opts.limit ?? 100);
  const report: CountMaintenanceReport = { workspaces: due.length, rebuilt: 0, reconciled: 0, reconcileFailures: 0, rebuildNotPublished: 0, gcDeleted: 0, errors: 0 };
  for (const { state, ...ws } of due) {
    try {
      let rebuild = state !== 'valid';
      if (!rebuild) {
        const r = await reconcileCountBitmap(db, ws);
        if (r.skipped) continue;
        report.reconciled++;
        if (r.ok) {
          // empty chunks left by list/tag deletion or removals: collected on every reconciled workspace
          const gc = await gcAll(db, ws);
          report.gcDeleted += gc.deleted;
          log.info({ ...ws, reconcile: r, gc }, 'audience count bitmap reconciled');
        }
        if (!r.ok) {
          report.reconcileFailures++;
          log.error({ alert: 'audience_count_reconcile_mismatch', ...ws, result: r }, 'audience count bitmap reconciliation found differences; marked invalid');
          rebuild = true;
        }
      }
      if (rebuild) {
        const r = await rebuildCountBitmap(db, ws, opts.rebuild);
        if (r.outcome === 'published') {
          report.rebuilt++;
          const gc = await gcAll(db, ws);
          report.gcDeleted += gc.deleted;
          log.info({ ...ws, ...r, gc }, 'audience count bitmap rebuilt and verified');
        } else {
          report.rebuildNotPublished++;
          const level = r.outcome === 'verify_failed' ? 'error' : 'info';
          log[level]({ ...(level === 'error' ? { alert: 'audience_count_rebuild_verify_failed' } : {}), ...ws, ...r }, 'audience count bitmap rebuild not published');
        }
      }
    } catch (err) {
      report.errors++;
      log.error({ alert: 'audience_count_maintenance_error', ...ws, err: err instanceof Error ? err.message : String(err) }, 'audience count bitmap maintenance failed');
    }
  }
  return report;
}
