import { createHash } from 'node:crypto';
import type { AudienceDefinitionV1, AudienceSelector } from '@workeasy/shared';

/**
 * Audience Resolution v1 — pure rules (docs/contracts/phase-5-audience.md §9.3–9.5). Definition validation, the
 * canonical hash, page limits, the opaque cursor, and the reference semantics of capture and paging. The adapter
 * (milestone 6.3) implements capture in one SQL statement; these functions are the rules it must agree with.
 */

export const AUDIENCE_DEFINITION_LIMITS = { include: 25, exclude: 25 } as const;
/** Maximum members per snapshot in v1 (`AUDIENCE_TOO_LARGE` above), pending the capture benchmark. */
export const AUDIENCE_CAPTURE_LIMIT = 5_000_000;
export const AUDIENCE_PAGE_SIZE = { default: 1_000, max: 1_000 } as const;

export type AudienceResolutionErrorCode =
  | 'AUDIENCE_DEFINITION_INVALID'
  | 'AUDIENCE_SOURCE_NOT_FOUND'
  | 'AUDIENCE_SNAPSHOT_NOT_FOUND'
  | 'AUDIENCE_SNAPSHOT_KEY_CONFLICT'
  | 'AUDIENCE_TOO_LARGE'
  | 'AUDIENCE_CURSOR_INVALID'
  | 'AUDIENCE_LIMIT_INVALID';

export class AudienceResolutionError extends Error {
  constructor(
    readonly code: AudienceResolutionErrorCode,
    message: string,
    readonly selector?: AudienceSelector,
  ) {
    super(message);
    this.name = 'AudienceResolutionError';
  }
}

/** Canonical UUID text (any case). Selector ids, cursor positions and owner ids must be UUIDs before any SQL. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** Identity of a selector; ids compared case-insensitively (as PostgreSQL compares uuid). */
export const selectorKey = (s: AudienceSelector) => (s.type === 'list' ? `list:${s.listId.toLowerCase()}` : `tag:${s.tagId.toLowerCase()}`);

const isSelector = (s: unknown): s is AudienceSelector => {
  if (!s || typeof s !== 'object') return false;
  const keys = Object.keys(s).sort().join(',');
  const o = s as Record<string, unknown>;
  if (o.type === 'list') return keys === 'listId,type' && isUuid(o.listId);
  if (o.type === 'tag') return keys === 'tagId,type' && isUuid(o.tagId);
  return false;
};

/**
 * Structural rules of a definition (no database): shape, 1–25 include and 0–25 exclude selectors, no duplicates, no
 * selector both included and excluded, ids are UUIDs. Source existence is `AudienceResolution.validate`'s job (adapter).
 */
export function definitionErrors(raw: unknown): AudienceResolutionError[] {
  const invalid = (message: string, selector?: AudienceSelector) => new AudienceResolutionError('AUDIENCE_DEFINITION_INVALID', message, selector);
  const d = raw as Partial<AudienceDefinitionV1> | null;
  if (!d || typeof d !== 'object' || !Array.isArray(d.include) || !Array.isArray(d.exclude)) return [invalid('The audience must have include and exclude lists')];
  if (Object.keys(d).sort().join(',') !== 'exclude,include') return [invalid('The audience has unexpected fields')];
  const errors: AudienceResolutionError[] = [];
  if (d.include.length === 0) errors.push(invalid('Choose at least one list or tag to send to'));
  if (d.include.length > AUDIENCE_DEFINITION_LIMITS.include) errors.push(invalid(`At most ${AUDIENCE_DEFINITION_LIMITS.include} lists and tags can be included`));
  if (d.exclude.length > AUDIENCE_DEFINITION_LIMITS.exclude) errors.push(invalid(`At most ${AUDIENCE_DEFINITION_LIMITS.exclude} lists and tags can be excluded`));
  const seen = new Map<string, 'include' | 'exclude'>();
  for (const [role, list] of [['include', d.include], ['exclude', d.exclude]] as const) {
    for (const s of list as unknown[]) {
      if (!isSelector(s)) {
        errors.push(invalid('Each audience source must be a list or a tag with a valid id'));
        continue;
      }
      const key = selectorKey(s);
      const prior = seen.get(key);
      if (prior === role) errors.push(invalid('The same list or tag is chosen twice', s));
      else if (prior) errors.push(invalid('A list or tag cannot be both included and excluded', s));
      else seen.set(key, role);
    }
  }
  return errors;
}

/** Canonical form: selectors sorted by key inside include and exclude (the definition is a pair of sets). */
export function canonicalDefinition(def: AudienceDefinitionV1): string {
  const sorted = (list: AudienceSelector[]) => list.map(selectorKey).sort();
  return JSON.stringify({ exclude: sorted(def.exclude), include: sorted(def.include) });
}

/** sha-256 (hex) of the canonical definition — `AudienceSnapshotRef.definitionHash`, used to detect key conflicts. */
export const definitionHash = (def: AudienceDefinitionV1) => createHash('sha256').update(canonicalDefinition(def)).digest('hex');

/** Page size: default 1,000; 1–1,000 enforced (`AUDIENCE_LIMIT_INVALID`). */
export function pageLimit(limit: number | undefined): number {
  if (limit === undefined) return AUDIENCE_PAGE_SIZE.default;
  if (!Number.isInteger(limit) || limit < 1 || limit > AUDIENCE_PAGE_SIZE.max) {
    throw new AudienceResolutionError('AUDIENCE_LIMIT_INVALID', `Page size must be 1–${AUDIENCE_PAGE_SIZE.max}`);
  }
  return limit;
}

/**
 * Opaque page cursor, bound to its snapshot: the last contact id returned. A cursor from another snapshot, or one
 * that was tampered with, is `AUDIENCE_CURSOR_INVALID` (never silently restarted).
 */
export function encodeSnapshotCursor(snapshotId: string, afterContactId: string): string {
  return Buffer.from(JSON.stringify({ v: 1, s: snapshotId, a: afterContactId }), 'utf8').toString('base64url');
}

export function decodeSnapshotCursor(snapshotId: string, cursor: string): string {
  const fail = () => new AudienceResolutionError('AUDIENCE_CURSOR_INVALID', 'The page cursor is not valid for this audience snapshot');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw fail();
  }
  const c = parsed as { v?: unknown; s?: unknown; a?: unknown } | null;
  if (!c || c.v !== 1 || c.s !== snapshotId || !isUuid(c.a)) throw fail();
  return c.a.toLowerCase();
}

/**
 * Ascending contact-id order, as PostgreSQL orders `uuid`: byte order, which for canonical lowercase UUID text is
 * plain code-unit order. Never locale-aware.
 */
export const compareContactIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Reference semantics of capture (§9.5): union of include sources minus union of exclude sources, live contacts only,
 * each contact once, ascending. `members` maps selectorKey → member contact ids at T0; `live` holds contacts that were
 * not deleted/erased at T0. A source missing from `members` is `AUDIENCE_SOURCE_NOT_FOUND`. Consent, subscription,
 * suppression and topics are NOT applied here — that is Eligibility's job.
 */
export function captureMembers(def: AudienceDefinitionV1, members: ReadonlyMap<string, readonly string[]>, live: ReadonlySet<string>): string[] {
  const errors = definitionErrors(def);
  if (errors.length) throw errors[0]!;
  const sourceOf = (s: AudienceSelector) => {
    const m = members.get(selectorKey(s));
    if (!m) throw new AudienceResolutionError('AUDIENCE_SOURCE_NOT_FOUND', 'An audience source no longer exists', s);
    return m;
  };
  const excluded = new Set(def.exclude.flatMap(sourceOf));
  const included = new Set(def.include.flatMap(sourceOf));
  const out = [...included].filter((id) => !excluded.has(id) && live.has(id)).sort(compareContactIds);
  if (out.length > AUDIENCE_CAPTURE_LIMIT) throw new AudienceResolutionError('AUDIENCE_TOO_LARGE', `An audience can have at most ${AUDIENCE_CAPTURE_LIMIT} contacts`);
  return out;
}

/** Reference semantics of `page` over an immutable, ascending snapshot. Deterministic for a given cursor. */
export function pageMembers(snapshotId: string, sorted: readonly string[], opts: { cursor: string | null; limit?: number }): { contactIds: string[]; cursor: string | null } {
  const limit = pageLimit(opts.limit);
  const after = opts.cursor === null ? null : decodeSnapshotCursor(snapshotId, opts.cursor);
  const start = after === null ? 0 : sorted.findIndex((id) => compareContactIds(id, after) > 0);
  const from = start === -1 ? sorted.length : start;
  const contactIds = sorted.slice(from, from + limit);
  const more = from + limit < sorted.length;
  return { contactIds, cursor: more ? encodeSnapshotCursor(snapshotId, contactIds.at(-1)!) : null };
}

// ─── capture identity (decisions B and C, docs/contracts/phase-5-audience.md §9.4 step 2) ──────────────────────────

export interface CaptureIdentity {
  definitionHash: string;
  ownerKind: string;
  ownerId: string;
}

/**
 * What a capture with an already used key must do. A key identifies one capture lifecycle (per workspace):
 *   released               → 'released'  (AUDIENCE_SNAPSHOT_NOT_FOUND — never recreated, whatever was asked)
 *   same definition + owner → 'reuse'     (return the existing snapshot)
 *   anything else           → 'conflict'  (AUDIENCE_SNAPSHOT_KEY_CONFLICT — ownership never transfers)
 */
export function captureKeyOutcome(existing: CaptureIdentity & { released: boolean }, requested: CaptureIdentity): 'reuse' | 'conflict' | 'released' {
  if (existing.released) return 'released';
  const same =
    existing.definitionHash === requested.definitionHash &&
    existing.ownerKind === requested.ownerKind &&
    existing.ownerId.toLowerCase() === requested.ownerId.toLowerCase();
  return same ? 'reuse' : 'conflict';
}

export const captureKeyError = (outcome: 'conflict' | 'released') =>
  outcome === 'released'
    ? new AudienceResolutionError('AUDIENCE_SNAPSHOT_NOT_FOUND', 'This audience snapshot was released')
    : new AudienceResolutionError('AUDIENCE_SNAPSHOT_KEY_CONFLICT', 'This capture key is already used for a different audience or owner');

/** Capture keys are 1–200 characters (DB CHECK); owner ids are UUIDs. Violations are programming errors. */
export function assertCaptureRequest(captureKey: string, owner: { kind: string; id: string }): void {
  if (typeof captureKey !== 'string' || captureKey.length < 1 || captureKey.length > 200) throw new TypeError('captureKey must be 1–200 characters');
  if (owner.kind !== 'campaign_execution') throw new TypeError('Unknown snapshot owner kind');
  if (!isUuid(owner.id)) throw new TypeError('owner.id must be a UUID');
}
