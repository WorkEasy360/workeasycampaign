import type { AudienceResolution, SnapshotOwner, SnapshotReleaseReason } from '@workeasy/audience-core';
import type { Database, Tx } from '@workeasy/db';

/**
 * Audience-side snapshot cleanup (docs/contracts/phase-5-audience.md §9.4/§9.6, campaign contract §6.4; decisions A, J).
 * These need no owner state: a released snapshot is never read again, so finishing its purge is always safe.
 * Deciding WHEN an unreleased snapshot may be released stays with the owner (Campaigns, milestone 6.8).
 */

/** Upper bound on purge calls for one snapshot: 5,000,000 members / 10,000 per call, plus margin. */
const MAX_PURGE_CALLS = 600;

export interface Workspace {
  orgId: string;
  workspaceId: string;
}

/** Workspaces with cleanup to do (cross-tenant discovery returns workspace pairs only). */
export function discoverSnapshotCleanup(db: Database, ownerKind: SnapshotOwner['kind'], unreleasedBefore: Date): Promise<Workspace[]> {
  return db.system.workspacesWithSnapshotCleanup(ownerKind, unreleasedBefore);
}

/**
 * Continues the purge of a released snapshot: one releaseByKey call per transaction until no member remains
 * (decision A). Safe to run concurrently with any other release of the same key (the row lock serializes them).
 */
export async function purgeUntilDone(
  db: Database,
  resolution: AudienceResolution<Tx>,
  workspace: Workspace,
  captureKey: string,
  reason: SnapshotReleaseReason,
): Promise<{ calls: number }> {
  for (let calls = 1; calls <= MAX_PURGE_CALLS; calls++) {
    const r = await db.withTenant({ ...workspace, userId: null }, (tx) => resolution.releaseByKey({ tx, ...workspace }, captureKey, reason));
    if (!r.membersRemaining) return { calls };
  }
  throw new Error(`purge of snapshot key ${captureKey} did not finish within ${MAX_PURGE_CALLS} calls`);
}

/**
 * Purge recovery for one workspace: finishes every released-but-unpurged snapshot (crash after release, or halfway
 * through the purge, or after the last chunk but before purged_at). Returns ids-only counts for logs and metrics.
 */
export async function resumeSnapshotPurges(
  db: Database,
  resolution: AudienceResolution<Tx>,
  workspace: Workspace,
  opts: { ownerKind?: SnapshotOwner['kind']; limit?: number } = {},
): Promise<{ snapshots: number }> {
  const pending = await db.withTenant({ ...workspace, userId: null }, (tx) =>
    resolution.listReleasedUnpurged({ tx, ...workspace }, opts.ownerKind ?? 'campaign_execution', opts.limit ?? 100),
  );
  // The reason is ignored for an already released snapshot (the first reason is kept).
  for (const s of pending) await purgeUntilDone(db, resolution, workspace, s.captureKey, 'orphan_sweep');
  return { snapshots: pending.length };
}
