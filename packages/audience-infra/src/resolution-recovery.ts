import type { AudienceRecoveryStatus, AudienceResolutionRecovery } from '@workeasy/audience-core';
import type { Database } from '@workeasy/db';
import { type CountRebuildOptions, rebuildCountBitmap } from './count-bitmap.js';

export interface ResolutionRecoveryLogger {
  info(msg: string, data: Record<string, unknown>): void;
  error(msg: string, data: Record<string, unknown>): void;
}

/**
 * Audience Resolution recovery (v1.2, Audience contract §9.10): makes fast resolution available again for one
 * workspace by rebuilding its count bitmap — the Phase 6.3 online rebuild, unchanged.
 *
 * Deduplication (thundering herd):
 *  - in this process: at most one rebuild per workspace in flight; further requests answer `rebuilding`;
 *  - across processes: the 6.3 rebuild lease (`audience_count_begin_rebuild` refuses while a live lease exists) — a
 *    second process's rebuild ends immediately as `busy`, without work; a live lease is reported as `rebuilding`.
 * Never blocks the caller on the rebuild: the request returns as soon as the state is read and (if needed) the rebuild
 * is started. The rebuild runs in its own short transactions (never the caller's), RLS-scoped to the workspace.
 */
export class PrismaAudienceResolutionRecovery implements AudienceResolutionRecovery {
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly db: Database,
    private readonly log: ResolutionRecoveryLogger = { info: () => undefined, error: () => undefined },
    private readonly rebuild: CountRebuildOptions = {},
  ) {}

  async requestRecovery(workspace: { orgId: string; workspaceId: string }): Promise<{ status: AudienceRecoveryStatus }> {
    const key = workspace.workspaceId;
    if (this.inFlight.has(key)) return { status: 'rebuilding' };
    const [s] = await this.db.withTenant({ ...workspace, userId: null }, (tx) =>
      tx.$queryRawUnsafe<{ state: string; leased: boolean }[]>(
        `SELECT state, coalesce(rebuild_lease_until > now(), false) AS leased FROM audience_count_state WHERE workspace_id = $1::uuid`,
        workspace.workspaceId,
      ),
    );
    if (s?.state === 'valid') return { status: 'ready' };
    if (s?.state === 'rebuilding' && s.leased) return { status: 'rebuilding' };
    if (this.inFlight.has(key)) return { status: 'rebuilding' }; // a concurrent request won the race above
    const run = rebuildCountBitmap(this.db, workspace, this.rebuild)
      .then((r) => this.log.info('audience resolution recovery finished', { workspaceId: workspace.workspaceId, outcome: r.outcome }))
      .catch((err: unknown) =>
        this.log.error('audience resolution recovery failed', { workspaceId: workspace.workspaceId, err: err instanceof Error ? err.message : String(err) }),
      )
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, run);
    return { status: 'requested' };
  }

  /** Resolves when no recovery started by this instance is running (tests, graceful shutdown). */
  async idle(): Promise<void> {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight.values()]);
  }

  /** Rebuilds started by this instance and still running (tests and metrics). */
  get running(): number {
    return this.inFlight.size;
  }
}
