import { randomBytes } from 'node:crypto';
import {
  AUDIENCE_CAPTURE_LIMIT,
  type AudienceCount,
  type AudienceReleaseResult,
  AUDIENCE_SAMPLE_LIMIT,
  AudienceResolutionError,
  type AudienceResolutionV1_2,
  type AudienceSampleOutcome,
  type AudienceSampleWithinOptions,
  type AudienceSample,
  type AudienceSampleOptions,
  type AudienceSnapshotPage,
  type AudienceSnapshotRef,
  type AudienceSourceStatus,
  type AudienceTopicStatus,
  type AudienceValidation,
  assertCaptureRequest,
  canonicalDefinition,
  captureKeyError,
  captureKeyOutcome,
  decodeSnapshotCursor,
  definitionErrors,
  definitionHash,
  encodeSnapshotCursor,
  isUuid,
  pageLimit,
  type SnapshotOwner,
  type SnapshotReleaseReason,
  type TenantScope,
} from '@workeasy/audience-core';
import type { Tx } from '@workeasy/db';
import type { AudienceDefinitionV1, AudienceSelector } from '@workeasy/shared';
import { assertTenantScope } from './tenant-scope.js';

/**
 * Audience Resolution v1 over the Audience-owned snapshot tables (docs/contracts/phase-5-audience.md §9.3–9.6,
 * decisions A–O in docs/architecture/phase-6-campaign-engine.md §15). Every query runs in the caller's RLS-scoped
 * transaction after assertTenantScope; SQL texts are constants and every value is a bound parameter.
 */

/** Members deleted per releaseByKey call (decision A): 10 chunks of SNAPSHOT_CHUNK_SIZE. */
export const SNAPSHOT_PURGE_CHUNK = 10_000;
/** Captured member ids per stored chunk (D2). The 5,000,000 limit is 5,000 chunks. */
export const SNAPSHOT_CHUNK_SIZE = 1_000;
/** Elevated timeout for the single capture statement only (decision K). */
export const CAPTURE_STATEMENT_TIMEOUT = '300s';
/** Caller's transaction timeout for capture (decision K): the statement timeout plus margin. */
export const CAPTURE_TRANSACTION_TIMEOUT_MS = 330_000;

const RELEASE_REASONS: readonly SnapshotReleaseReason[] = ['materialized', 'cancelled', 'failed', 'orphan_sweep'];

/** Programming error: the capture transaction already wrote or row-locked something (decision K). */
export class CaptureTransactionNotDedicatedError extends Error {
  constructor() {
    super('capture must run in a dedicated transaction that has not written or locked anything');
    this.name = 'CaptureTransactionNotDedicatedError';
  }
}

interface Selectors {
  incLists: string[];
  incTags: string[];
  excLists: string[];
  excTags: string[];
}

function selectors(def: AudienceDefinitionV1): Selectors {
  const ids = (list: AudienceSelector[], type: 'list' | 'tag') =>
    list.flatMap((s) => (s.type === 'list' && type === 'list' ? [s.listId.toLowerCase()] : s.type === 'tag' && type === 'tag' ? [s.tagId.toLowerCase()] : []));
  return { incLists: ids(def.include, 'list'), incTags: ids(def.include, 'tag'), excLists: ids(def.exclude, 'list'), excTags: ids(def.exclude, 'tag') };
}

/**
 * The audience expression (§9.5), shared by count and capture. Parameters: $1 include lists, $2 include tags,
 * $3 exclude lists, $4 exclude tags (uuid[]). `m` = union of includes, minus union of excludes, live contacts only,
 * one row per contact. `missing` = selectors whose list/tag row is not visible or is deleted (decision M) — existence
 * is checked here, never inferred from memberships (deletion removes memberships).
 *
 * Set-algebra form (D2, docs/audit/phase-6.3-performance-remediation.md §3 "B3"): (∪ includes) − (∪ excludes) −
 * (non-live contacts of the workspace). Equivalent to joining the includes to live contacts because every membership row
 * references a contact of the same workspace (composite FK) and RLS confines every table to that workspace, so
 * "member and not non-live" = "live member". The non-live set is read from the partial index contacts_non_live_idx
 * instead of scanning every contact of the workspace.
 */
const MISSING_CTE = `
  missing AS (
    SELECT 'list'::text AS type, x.id FROM unnest($1::uuid[] || $3::uuid[]) AS x(id)
      WHERE NOT EXISTS (SELECT 1 FROM lists l WHERE l.id = x.id AND l.deleted_at IS NULL)
    UNION ALL
    SELECT 'tag'::text, x.id FROM unnest($2::uuid[] || $4::uuid[]) AS x(id)
      WHERE NOT EXISTS (SELECT 1 FROM tags t WHERE t.id = x.id AND t.deleted_at IS NULL)
  )`;

const AUDIENCE_CTES = `
  m AS MATERIALIZED (
    (SELECT contact_id FROM list_memberships WHERE list_id = ANY($1::uuid[])
     UNION
     SELECT contact_id FROM contact_tags WHERE tag_id = ANY($2::uuid[]))
    EXCEPT
    (SELECT contact_id FROM list_memberships WHERE list_id = ANY($3::uuid[])
     UNION
     SELECT contact_id FROM contact_tags WHERE tag_id = ANY($4::uuid[])
     UNION
     SELECT id FROM contacts WHERE workspace_id = (SELECT app.current_workspace_id()) AND (deleted_at IS NOT NULL OR erased_at IS NOT NULL))
  ),${MISSING_CTE}`;

/**
 * THE capture statement (decision L): one statement, one MVCC snapshot. Source existence, include/exclude membership
 * and contact liveness are all read at T0 = statement_timestamp(); the snapshot row and its members are inserted
 * only if every source exists and the size is within the limit. $5 capture_key, $6 owner_kind, $7 owner_id,
 * $8 canonical definition (jsonb), $9 definition_hash, $10 size limit, $11 chunk size.
 *
 * Members are stored as sorted chunks (D2): chunk k holds positions k·$11 … k·$11 + $11 − 1 of the ascending contact-id
 * order — one row, one FK check and one RLS check per chunk instead of per member.
 */
const CAPTURE_SQL = `
WITH ${AUDIENCE_CTES},
  n AS (SELECT count(*)::int AS size FROM m),
  s AS (
    INSERT INTO audience_snapshots (id, org_id, workspace_id, capture_key, owner_kind, owner_id, definition, definition_hash, captured_at, size)
    SELECT gen_random_uuid(), app.current_org_id(), app.current_workspace_id(), $5, $6, $7::uuid, $8::jsonb, $9, statement_timestamp(), n.size
    FROM n
    WHERE n.size <= $10 AND NOT EXISTS (SELECT 1 FROM missing)
    ON CONFLICT (workspace_id, capture_key) DO NOTHING
    RETURNING id, captured_at, size
  ),
  ins AS (
    INSERT INTO audience_snapshot_chunks (org_id, workspace_id, snapshot_id, chunk_no, first_contact, last_contact, contact_ids)
    SELECT app.current_org_id(), app.current_workspace_id(), s.id, g.k, g.ids[1], g.ids[cardinality(g.ids)], g.ids
    FROM s CROSS JOIN (
      SELECT x.k::int AS k, array_agg(x.contact_id ORDER BY x.contact_id) AS ids
      FROM (SELECT contact_id, (row_number() OVER (ORDER BY contact_id) - 1) / $11::int AS k FROM m) x
      GROUP BY x.k
    ) g
  )
SELECT (SELECT id::text FROM s) AS snapshot_id,
       (SELECT captured_at FROM s) AS captured_at,
       (SELECT size FROM n) AS size,
       (SELECT coalesce(json_agg(json_build_object('type', type, 'id', id::text)), '[]'::json) FROM missing) AS missing`;

/** Live count up to a cap: $5 cap + 1 rows at most are counted. */
const COUNT_SQL = `
WITH ${AUDIENCE_CTES}
SELECT (SELECT count(*)::int FROM (SELECT 1 FROM m LIMIT $5) capped) AS n,
       statement_timestamp() AS counted_at,
       (SELECT coalesce(json_agg(json_build_object('type', type, 'id', id::text)), '[]'::json) FROM missing) AS missing`;

/**
 * Exact count from the derived membership bitmap (Phase 6.3 G2; docs/audit/phase-6.3-g2-closure.md). Same parameters
 * as COUNT_SQL. ONE statement, one MVCC snapshot: the bitmap's state, source existence and the count are read together,
 * so a count is only taken from bits that were VALID at that instant (an invalidation or rebuild that commits
 * concurrently is either entirely visible — state not valid → exact query — or not at all).
 *   count = Σ over 4,096-position chunks of bit_count( OR(include chunks) & ~OR(exclude chunks) & ~dead chunk )
 * The bitmap holds membership and liveness only (the same facts as the exact query); eligibility stays live.
 */
const BITMAP_COUNT_SQL = `
WITH ${MISSING_CTE},
  inc AS (SELECT chunk, bit_or(bits) AS v FROM audience_count_source_chunks WHERE source_id = ANY($1::uuid[] || $2::uuid[]) GROUP BY chunk),
  exc AS (SELECT chunk, bit_or(bits) AS v FROM audience_count_source_chunks WHERE source_id = ANY($3::uuid[] || $4::uuid[]) GROUP BY chunk)
SELECT (SELECT state FROM audience_count_state WHERE workspace_id = (SELECT app.current_workspace_id())) AS state,
       (SELECT coalesce(sum(bit_count(i.v & ~coalesce(e.v, z.z) & ~coalesce(d.bits, z.z))), 0)::bigint
          FROM inc i CROSS JOIN (SELECT repeat('0', 4096)::varbit AS z) z
          LEFT JOIN exc e ON e.chunk = i.chunk
          LEFT JOIN audience_count_dead_chunks d ON d.workspace_id = (SELECT app.current_workspace_id()) AND d.chunk = i.chunk) AS n,
       statement_timestamp() AS counted_at,
       (SELECT coalesce(json_agg(json_build_object('type', type, 'id', id::text)), '[]'::json) FROM missing) AS missing`;

/**
 * Uniform sample, bitmap path (Audience Resolution v1.1, §9.9): source existence and the Audience-owned sampling
 * function (app.audience_sample_ids — VALID bitmap only, else it answers {"state": …}) in ONE statement.
 * $1–$4 as COUNT_SQL, $5 size, $6 seed (NULL = fresh randomness).
 */
const BITMAP_SAMPLE_SQL = `
WITH ${MISSING_CTE}
SELECT app.audience_sample_ids($1::uuid[] || $2::uuid[], $3::uuid[] || $4::uuid[], $5::int, $6::float8) AS r,
       statement_timestamp() AS sampled_at,
       (SELECT coalesce(json_agg(json_build_object('type', type, 'id', id::text)), '[]'::json) FROM missing) AS missing`;

/**
 * Uniform sample, exact path (bitmap not valid): the same set expression as count; top-k by a 64-bit hash of the id
 * seeded with a fresh random value — a uniformly random order, so the first k members are a uniform sample.
 * `uuid_hash_extended` hashes the uuid's bytes directly (no text conversion): MEASURED at 940,000 members the
 * statement is ≈ 1.25 s vs ≈ 2.6 s with md5(text) — within ≈ 10 % of the exact count alone. $5 size, $6 seed (bigint).
 */
const EXACT_SAMPLE_SQL = `
WITH ${AUDIENCE_CTES}
SELECT (SELECT count(*) FROM m)::bigint AS n,
       (SELECT coalesce(array_agg(s.contact_id::text ORDER BY s.contact_id), '{}') FROM (
          SELECT contact_id FROM m ORDER BY uuid_hash_extended(contact_id, $6::bigint) LIMIT $5) s) AS ids,
       statement_timestamp() AS sampled_at,
       (SELECT coalesce(json_agg(json_build_object('type', type, 'id', id::text)), '[]'::json) FROM missing) AS missing`;

/** Which path answered a count: the verified bitmap, or the exact query (bitmap invalid, rebuilding or absent). */
export type AudienceCountPath = 'bitmap' | 'exact';

/**
 * One page in one statement: $1 snapshot id, $2 limit (+1 to detect more), $3 = after this contact id (NULL for the
 * first page). The first chunk is the lowest-numbered one whose last id is after the cursor (primary-key range read).
 * Every chunk but the last is full, so the page can reach at most ⌈$2 / size of that chunk⌉ further chunks — derived
 * from the stored data, not from configuration. The page never re-resolves the audience, and the snapshot's status is
 * read in the same statement (one MVCC snapshot).
 */
const PAGE_SQL = `
WITH k AS (
  SELECT chunk_no AS k, cardinality(contact_ids) AS size FROM audience_snapshot_chunks
  WHERE snapshot_id = $1::uuid AND ($3::uuid IS NULL OR last_contact > $3::uuid)
  ORDER BY chunk_no LIMIT 1
)
SELECT (SELECT released_at IS NOT NULL FROM audience_snapshots WHERE id = $1::uuid) AS released,
       coalesce((SELECT array_agg(p.x::text ORDER BY p.x) FROM (
         SELECT x FROM k CROSS JOIN audience_snapshot_chunks c CROSS JOIN LATERAL unnest(c.contact_ids) AS x
         WHERE c.snapshot_id = $1::uuid AND c.chunk_no BETWEEN k.k AND k.k + ceil($2::numeric / k.size)::int
           AND ($3::uuid IS NULL OR x > $3::uuid)
         ORDER BY x LIMIT $2) p), '{}') AS ids`;

interface SnapshotRow {
  id: string;
  capture_key: string;
  owner_kind: string;
  owner_id: string;
  definition_hash: string;
  captured_at: Date;
  size: number;
  released_at: Date | null;
  purged_at: Date | null;
}

const SNAPSHOT_COLUMNS = `id::text AS id, capture_key, owner_kind, owner_id::text AS owner_id, definition_hash, captured_at, size, released_at, purged_at`;

export interface PrismaAudienceResolutionOptions {
  /**
   * Lower capture limit, for tests of the over-limit path only. Clamped to AUDIENCE_CAPTURE_LIMIT (5,000,000): it can
   * never raise the frozen limit.
   */
  captureLimit?: number;
  /** Smaller purge unit (members per releaseByKey call), for tests only. Clamped to 1–SNAPSHOT_PURGE_CHUNK. */
  purgeChunk?: number;
  /** Smaller member chunk, for tests only (multi-chunk paging and purge on small snapshots). Clamped to 1–SNAPSHOT_CHUNK_SIZE. */
  chunkSize?: number;
  /**
   * false: never read the count bitmap (always the exact query). For tests and benchmarks that need the exact path
   * regardless of the bitmap's state. Default true.
   */
  bitmapCount?: boolean;
}

export class PrismaAudienceResolution implements AudienceResolutionV1_2<Tx> {
  private readonly captureLimit: number;
  private readonly purgeChunk: number;
  private readonly chunkSize: number;
  private readonly bitmapCount: boolean;

  constructor(options: PrismaAudienceResolutionOptions = {}) {
    this.captureLimit = Math.max(0, Math.min(options.captureLimit ?? AUDIENCE_CAPTURE_LIMIT, AUDIENCE_CAPTURE_LIMIT));
    this.purgeChunk = Math.max(1, Math.min(options.purgeChunk ?? SNAPSHOT_PURGE_CHUNK, SNAPSHOT_PURGE_CHUNK));
    this.chunkSize = Math.max(1, Math.min(options.chunkSize ?? SNAPSHOT_CHUNK_SIZE, SNAPSHOT_CHUNK_SIZE));
    this.bitmapCount = options.bitmapCount ?? true;
  }

  async validate(scope: TenantScope<Tx>, def: AudienceDefinitionV1): Promise<AudienceValidation> {
    await assertTenantScope(scope);
    const errors = definitionErrors(def);
    if (errors.length) return { valid: false, sources: [], errors: errors.map(toWire) };
    const s = selectors(def);
    const lists = await scope.tx.$queryRawUnsafe<{ id: string; status: string }[]>(
      `SELECT id::text AS id, status FROM lists WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [...s.incLists, ...s.excLists],
    );
    const tags = await scope.tx.$queryRawUnsafe<{ id: string }[]>(`SELECT id::text AS id FROM tags WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`, [...s.incTags, ...s.excTags]);
    const listStatus = new Map(lists.map((l) => [l.id, l.status === 'archived' ? ('archived' as const) : ('ok' as const)]));
    const tagIds = new Set(tags.map((t) => t.id));
    const statusOf = (sel: AudienceSelector): AudienceSourceStatus =>
      sel.type === 'list' ? (listStatus.get(sel.listId.toLowerCase()) ?? 'not_found') : tagIds.has(sel.tagId.toLowerCase()) ? 'ok' : 'not_found';
    const sources = [
      ...def.include.map((selector) => ({ role: 'include' as const, selector, status: statusOf(selector) })),
      ...def.exclude.map((selector) => ({ role: 'exclude' as const, selector, status: statusOf(selector) })),
    ];
    const missing = sources.filter((x) => x.status === 'not_found').map((x) => toWire(notFound(x.selector)));
    return { valid: missing.length === 0, sources, errors: missing };
  }

  async count(scope: TenantScope<Tx>, def: AudienceDefinitionV1, opts: { cap?: number } = {}): Promise<AudienceCount> {
    const { path: _path, ...count } = await this.countWithPath(scope, def, opts);
    return count;
  }

  /**
   * count(), also reporting which path answered. Both paths are exact; the bitmap answers only while its state is
   * 'valid' in the same statement, otherwise the exact set-algebra query (D2) answers. Never an approximation.
   */
  async countWithPath(scope: TenantScope<Tx>, def: AudienceDefinitionV1, opts: { cap?: number } = {}): Promise<AudienceCount & { path: AudienceCountPath }> {
    await assertTenantScope(scope);
    const errors = definitionErrors(def);
    if (errors.length) throw errors[0]!;
    const cap = Math.min(opts.cap ?? AUDIENCE_CAPTURE_LIMIT, AUDIENCE_CAPTURE_LIMIT);
    if (!Number.isInteger(cap) || cap < 1) throw new TypeError('cap must be a positive integer');
    const s = selectors(def);
    if (this.bitmapCount) {
      const [b] = await scope.tx.$queryRawUnsafe<{ state: string | null; n: bigint; counted_at: Date; missing: { type: 'list' | 'tag'; id: string }[] }[]>(
        BITMAP_COUNT_SQL,
        s.incLists,
        s.incTags,
        s.excLists,
        s.excTags,
      );
      if (b!.missing.length) throw notFound(selectorOf(b!.missing[0]!));
      if (b!.state === 'valid') {
        const n = Number(b!.n);
        return { count: Math.min(n, cap), capped: n > cap, countedAt: b!.counted_at.toISOString(), path: 'bitmap' };
      }
    }
    const [row] = await withStatementSettings(scope.tx, BULK_PLAN, () =>
      scope.tx.$queryRawUnsafe<{ n: number; counted_at: Date; missing: { type: 'list' | 'tag'; id: string }[] }[]>(COUNT_SQL, s.incLists, s.incTags, s.excLists, s.excTags, cap + 1),
    );
    if (row!.missing.length) throw notFound(selectorOf(row!.missing[0]!));
    return { count: Math.min(row!.n, cap), capped: row!.n > cap, countedAt: row!.counted_at.toISOString(), path: 'exact' };
  }

  /**
   * Audience Resolution v1.1 — uniform sample of the live audience (no snapshot, no write). Same validation and errors
   * as count. The audience size is exact (capped like count) and read in the same statement as the sample.
   */
  async sample(scope: TenantScope<Tx>, def: AudienceDefinitionV1, opts: AudienceSampleOptions): Promise<AudienceSample> {
    return (await this.sampleWithPath(scope, def, opts)).sample;
  }

  /** sample(), also reporting which path answered (tests and benchmarks). */
  async sampleWithPath(scope: TenantScope<Tx>, def: AudienceDefinitionV1, opts: AudienceSampleOptions): Promise<{ sample: AudienceSample; path: AudienceCountPath }> {
    return (await this.sampleImpl(scope, def, opts, null))!;
  }

  /**
   * Audience Resolution v1.2 — bounded sample (§9.10). Bitmap path as `sample`; the exact path runs inside a SAVEPOINT
   * with `statement_timeout = exactBudgetMs`: if it is cancelled by the budget the savepoint is rolled back (settings
   * included) and the caller's transaction stays usable; the answer is "unavailable", never partial.
   */
  async sampleWithin(scope: TenantScope<Tx>, def: AudienceDefinitionV1, opts: AudienceSampleWithinOptions): Promise<AudienceSampleOutcome> {
    if (!Number.isInteger(opts.exactBudgetMs) || opts.exactBudgetMs < 100 || opts.exactBudgetMs > 10_000) throw new TypeError('exactBudgetMs must be an integer 100–10,000');
    const r = await this.sampleImpl(scope, def, opts, opts.exactBudgetMs);
    return r ? { available: true, sample: r.sample } : { available: false, reason: 'exact_budget_exceeded' };
  }

  /** sampleWithin(), also reporting the path ('unavailable' when the budget was exceeded) — tests and benchmarks. */
  async sampleWithinWithPath(scope: TenantScope<Tx>, def: AudienceDefinitionV1, opts: AudienceSampleWithinOptions): Promise<{ outcome: AudienceSampleOutcome; path: AudienceCountPath | 'unavailable' }> {
    const r = await this.sampleImpl(scope, def, opts, opts.exactBudgetMs);
    return r ? { outcome: { available: true, sample: r.sample }, path: r.path } : { outcome: { available: false, reason: 'exact_budget_exceeded' }, path: 'unavailable' };
  }

  /** `null` only when `budgetMs` is set and the exact path exceeded it. */
  private async sampleImpl(
    scope: TenantScope<Tx>,
    def: AudienceDefinitionV1,
    opts: AudienceSampleOptions,
    budgetMs: number | null,
  ): Promise<{ sample: AudienceSample; path: AudienceCountPath } | null> {
    await assertTenantScope(scope);
    const errors = definitionErrors(def);
    if (errors.length) throw errors[0]!;
    if (!Number.isInteger(opts.size) || opts.size < 0 || opts.size > AUDIENCE_SAMPLE_LIMIT) throw new TypeError(`size must be an integer 0–${AUDIENCE_SAMPLE_LIMIT}`);
    if (opts.seed !== undefined && !(opts.seed >= -1 && opts.seed <= 1)) throw new TypeError('seed must be between -1 and 1');
    const s = selectors(def);
    const result = (n: number, contactIds: string[], at: Date, path: AudienceCountPath) => ({
      sample: { contactIds, audienceSize: Math.min(n, AUDIENCE_CAPTURE_LIMIT), capped: n > AUDIENCE_CAPTURE_LIMIT, sampledAt: at.toISOString() },
      path,
    });
    if (this.bitmapCount) {
      const [b] = await scope.tx.$queryRawUnsafe<{ r: { state: string; total?: number; contactIds?: string[] }; sampled_at: Date; missing: { type: 'list' | 'tag'; id: string }[] }[]>(
        BITMAP_SAMPLE_SQL,
        s.incLists,
        s.incTags,
        s.excLists,
        s.excTags,
        opts.size,
        opts.seed ?? null,
      );
      if (b!.missing.length) throw notFound(selectorOf(b!.missing[0]!));
      if (b!.r.state === 'valid') return result(Number(b!.r.total), b!.r.contactIds ?? [], b!.sampled_at, 'bitmap');
    }
    // A seed (tests) maps to a fixed 53-bit hash seed; otherwise 64 fresh random bits.
    const salt = opts.seed !== undefined ? String(Math.round(opts.seed * Number.MAX_SAFE_INTEGER)) : randomBytes(8).readBigInt64BE().toString();
    const exact = () =>
      scope.tx.$queryRawUnsafe<{ n: bigint; ids: string[]; sampled_at: Date; missing: { type: 'list' | 'tag'; id: string }[] }[]>(
        EXACT_SAMPLE_SQL,
        s.incLists,
        s.incTags,
        s.excLists,
        s.excTags,
        opts.size,
        salt,
      );
    let row: Awaited<ReturnType<typeof exact>>[number] | undefined;
    if (budgetMs === null) {
      [row] = await withStatementSettings(scope.tx, BULK_PLAN, exact);
    } else {
      await scope.tx.$executeRawUnsafe('SAVEPOINT audience_sample_within');
      try {
        [row] = await withStatementSettings(scope.tx, { ...BULK_PLAN, statement_timeout: `${budgetMs}ms` }, exact);
        await scope.tx.$executeRawUnsafe('RELEASE SAVEPOINT audience_sample_within');
      } catch (err) {
        await scope.tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT audience_sample_within'); // also restores the settings
        if (isStatementTimeout(err)) return null;
        throw err;
      }
    }
    if (row!.missing.length) throw notFound(selectorOf(row!.missing[0]!));
    return result(Number(row!.n), row!.ids, row!.sampled_at, 'exact');
  }

  /** Audience Resolution v1.1 — status of one topic of this workspace (RLS: another workspace's topic is not found). */
  async topicStatus(scope: TenantScope<Tx>, topicId: string): Promise<AudienceTopicStatus> {
    await assertTenantScope(scope);
    if (!isUuid(topicId)) return { available: false, reason: 'not_found' };
    const [t] = await scope.tx.$queryRawUnsafe<{ kind: string; status: string }[]>(`SELECT kind, status FROM topics WHERE id = $1::uuid`, topicId);
    if (!t) return { available: false, reason: 'not_found' };
    if (t.kind !== 'topic') return { available: false, reason: 'category' };
    if (t.status !== 'active') return { available: false, reason: 'archived' };
    return { available: true };
  }

  async capture(scope: TenantScope<Tx>, def: AudienceDefinitionV1, captureKey: string, owner: SnapshotOwner): Promise<AudienceSnapshotRef> {
    await assertTenantScope(scope);
    assertCaptureRequest(captureKey, owner);
    const errors = definitionErrors(def);
    if (errors.length) throw errors[0]!;
    const { tx } = scope;
    const [clean] = await tx.$queryRawUnsafe<{ clean: boolean }[]>(`SELECT pg_current_xact_id_if_assigned() IS NULL AS clean`);
    if (!clean!.clean) throw new CaptureTransactionNotDedicatedError();

    const hash = definitionHash(def);
    const identity = { definitionHash: hash, ownerKind: owner.kind, ownerId: owner.id };
    const existing = await this.byKey(tx, captureKey);
    if (existing) return this.reuse(existing, identity);

    const s = selectors(def);
    const [row] = await withStatementSettings(tx, { ...BULK_PLAN, statement_timeout: CAPTURE_STATEMENT_TIMEOUT }, () =>
      tx.$queryRawUnsafe<{ snapshot_id: string | null; captured_at: Date | null; size: number; missing: { type: 'list' | 'tag'; id: string }[] }[]>(
        CAPTURE_SQL,
        s.incLists,
        s.incTags,
        s.excLists,
        s.excTags,
        captureKey,
        owner.kind,
        owner.id,
        canonicalDefinition(def),
        hash,
        this.captureLimit,
        this.chunkSize,
      ),
    );

    if (row!.missing.length) throw notFound(selectorOf(row!.missing[0]!));
    if (row!.size > this.captureLimit) {
      throw new AudienceResolutionError('AUDIENCE_TOO_LARGE', `An audience can have at most ${this.captureLimit.toLocaleString('en')} contacts`);
    }
    if (row!.snapshot_id && row!.captured_at) {
      return { snapshotId: row!.snapshot_id, captureKey, capturedAt: row!.captured_at.toISOString(), size: row!.size, definitionHash: hash };
    }
    // A concurrent capture with the same key committed first (ON CONFLICT DO NOTHING waited for it).
    const winner = await this.byKey(tx, captureKey);
    if (!winner) throw new Error('capture: key conflict without a visible snapshot');
    return this.reuse(winner, identity);
  }

  async page(scope: TenantScope<Tx>, snapshotId: string, opts: { cursor: string | null; limit?: number }): Promise<AudienceSnapshotPage> {
    await assertTenantScope(scope);
    const limit = pageLimit(opts.limit);
    if (!isUuid(snapshotId)) throw snapshotNotFound();
    const after = opts.cursor === null ? null : decodeSnapshotCursor(snapshotId, opts.cursor);
    // ONE statement, one MVCC snapshot: the snapshot's status and its members are read together, so a release that
    // commits concurrently can never yield a partial page. Reads only the captured members (never re-resolves the
    // audience): a primary-key range of chunks.
    const [row] =
      after === null
        ? await scope.tx.$queryRawUnsafe<{ released: boolean | null; ids: string[] }[]>(PAGE_SQL, snapshotId, limit + 1, null)
        : await scope.tx.$queryRawUnsafe<{ released: boolean | null; ids: string[] }[]>(PAGE_SQL, snapshotId, limit + 1, after);
    if (row!.released !== false) throw snapshotNotFound(); // null: no such snapshot in this workspace
    const rows = row!.ids.map((contact_id) => ({ contact_id }));
    const contactIds = rows.slice(0, limit).map((r) => r.contact_id);
    return { contactIds, cursor: rows.length > limit ? encodeSnapshotCursor(snapshotId, contactIds.at(-1)!) : null };
  }

  async releaseByKey(scope: TenantScope<Tx>, captureKey: string, reason: SnapshotReleaseReason): Promise<AudienceReleaseResult> {
    await assertTenantScope(scope);
    if (!RELEASE_REASONS.includes(reason)) throw new TypeError('Unknown release reason');
    const { tx } = scope;
    // 1–2. Locate under tenant scope and lock the row BEFORE any lifecycle change: concurrent releases serialize here.
    const [snap] = await tx.$queryRawUnsafe<{ id: string; released: boolean; purged: boolean }[]>(
      `SELECT id::text AS id, released_at IS NOT NULL AS released, purged_at IS NOT NULL AS purged
       FROM audience_snapshots WHERE capture_key = $1 FOR UPDATE`,
      captureKey,
    );
    if (!snap) return { released: false, membersRemaining: false };
    // 3–4. Mark released once; the first reason is kept (the trigger also forbids overwriting).
    if (!snap.released) {
      await tx.$executeRawUnsafe(`UPDATE audience_snapshots SET released_at = now(), release_reason = $2 WHERE id = $1::uuid`, snap.id, reason);
    }
    if (snap.purged) return { released: true, membersRemaining: false };
    // 5. One bounded unit, in contact order: the lowest-numbered chunks (≤ purgeChunk members, default 10 chunks =
    //    10,000 ids), deleted by primary-key range. No join, so the plan stays linear without statistics.
    //    Chunks per call come from the stored chunk size (every chunk but the last is full): ⌊purgeChunk / size⌋, ≥ 1.
    await tx.$executeRawUnsafe(
      `DELETE FROM audience_snapshot_chunks
       WHERE snapshot_id = $1::uuid
         AND chunk_no < (SELECT chunk_no + greatest(1, $2::int / cardinality(contact_ids)) FROM audience_snapshot_chunks
                         WHERE snapshot_id = $1::uuid ORDER BY chunk_no LIMIT 1)`,
      snap.id,
      this.purgeChunk,
    );
    // 6–7. Nothing can add members to a released snapshot, so this answer is stable under the row lock.
    const [rest] = await tx.$queryRawUnsafe<{ remaining: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM audience_snapshot_chunks WHERE snapshot_id = $1::uuid) AS remaining`,
      snap.id,
    );
    if (!rest!.remaining) await tx.$executeRawUnsafe(`UPDATE audience_snapshots SET purged_at = now() WHERE id = $1::uuid`, snap.id);
    return { released: true, membersRemaining: rest!.remaining };
  }

  async listUnreleased(scope: TenantScope<Tx>, ownerKind: SnapshotOwner['kind'], olderThan: Date, limit: number) {
    await assertTenantScope(scope);
    assertListLimit(limit);
    const rows = await scope.tx.$queryRawUnsafe<SnapshotRow[]>(
      `SELECT ${SNAPSHOT_COLUMNS} FROM audience_snapshots
       WHERE owner_kind = $1 AND purged_at IS NULL AND released_at IS NULL AND captured_at < $2::timestamptz
       ORDER BY captured_at, id LIMIT $3`,
      ownerKind,
      olderThan,
      limit,
    );
    return rows.map((r) => ({ snapshotId: r.id, captureKey: r.capture_key, ownerId: r.owner_id, capturedAt: r.captured_at.toISOString(), size: r.size }));
  }

  async listReleasedUnpurged(scope: TenantScope<Tx>, ownerKind: SnapshotOwner['kind'], limit: number) {
    await assertTenantScope(scope);
    assertListLimit(limit);
    const rows = await scope.tx.$queryRawUnsafe<SnapshotRow[]>(
      `SELECT ${SNAPSHOT_COLUMNS} FROM audience_snapshots
       WHERE owner_kind = $1 AND purged_at IS NULL AND released_at IS NOT NULL
       ORDER BY released_at, id LIMIT $2`,
      ownerKind,
      limit,
    );
    return rows.map((r) => ({ snapshotId: r.id, captureKey: r.capture_key, ownerId: r.owner_id, releasedAt: r.released_at!.toISOString() }));
  }

  private async byKey(tx: Tx, captureKey: string): Promise<SnapshotRow | null> {
    const [row] = await tx.$queryRawUnsafe<SnapshotRow[]>(`SELECT ${SNAPSHOT_COLUMNS} FROM audience_snapshots WHERE capture_key = $1`, captureKey);
    return row ?? null;
  }

  /** Decisions B and C for an existing key. */
  private reuse(existing: SnapshotRow, requested: { definitionHash: string; ownerKind: string; ownerId: string }): AudienceSnapshotRef {
    const outcome = captureKeyOutcome(
      { definitionHash: existing.definition_hash, ownerKind: existing.owner_kind, ownerId: existing.owner_id, released: existing.released_at !== null },
      requested,
    );
    if (outcome !== 'reuse') throw captureKeyError(outcome);
    return {
      snapshotId: existing.id,
      captureKey: existing.capture_key,
      capturedAt: existing.captured_at.toISOString(),
      size: existing.size,
      definitionHash: existing.definition_hash,
    };
  }
}

/**
 * Plan settings for the two bulk set statements (count, capture), transaction-local and restored after the one
 * statement. Their size is unknown to the planner whenever the tables' statistics lag behind (a fresh import, a new
 * workspace): with nested loops allowed it can then pick an inner scan per outer row — quadratic. Hash and merge joins
 * are linear whatever the estimates. `work_mem` 64 MB keeps the set operations of a 1M–5M audience in memory (no
 * sort/hash spills; D2).
 */
const BULK_PLAN = { enable_nestloop: 'off', work_mem: '64MB' } as const;

/**
 * Applies transaction-local settings for exactly one statement and restores the previous values afterwards
 * (decision K: only the capture statement gets the elevated timeout; the role default is never changed).
 */
async function withStatementSettings<T>(tx: Tx, settings: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const names = Object.keys(settings);
  const previous: string[] = [];
  for (const n of names) previous.push((await tx.$queryRawUnsafe<{ v: string }[]>(`SELECT current_setting($1) AS v`, n))[0]!.v);
  for (const n of names) await tx.$queryRawUnsafe(`SELECT set_config($1, $2, true)`, n, settings[n]);
  const result = await run();
  for (const [i, n] of names.entries()) await tx.$queryRawUnsafe(`SELECT set_config($1, $2, true)`, n, previous[i]);
  return result;
}

/** SQLSTATE 57014 (query_canceled by statement_timeout), as surfaced by the Prisma driver adapter. */
const isStatementTimeout = (err: unknown) => {
  const e = err as { code?: string; meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string } } }; message?: string };
  return e?.meta?.code === '57014' || e?.meta?.driverAdapterError?.cause?.originalCode === '57014' || /\b57014\b|statement timeout/.test(String(e?.message ?? ''));
};

const notFound = (selector: AudienceSelector) => new AudienceResolutionError('AUDIENCE_SOURCE_NOT_FOUND', 'A selected list or tag does not exist', selector);
const snapshotNotFound = () => new AudienceResolutionError('AUDIENCE_SNAPSHOT_NOT_FOUND', 'The audience snapshot does not exist or was released');
const selectorOf = (m: { type: 'list' | 'tag'; id: string }): AudienceSelector => (m.type === 'list' ? { type: 'list', listId: m.id } : { type: 'tag', tagId: m.id });
const toWire = (e: AudienceResolutionError) => ({ code: e.code, ...(e.selector ? { selector: e.selector } : {}), message: e.message });

function assertListLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new TypeError('limit must be 1–1,000');
}
