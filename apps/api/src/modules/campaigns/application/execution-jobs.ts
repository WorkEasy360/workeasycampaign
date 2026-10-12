import { z } from 'zod';

/**
 * Campaign execution jobs (milestone 6.9). Dispatched through the `JobDispatcher` port (in-process today, the worker
 * later — architecture §11: moving changes only the dispatcher). Every job carries the standard tenant envelope of
 * `apps/worker/src/jobs/tenant-job.ts`, built SERVER-SIDE from an authorized command or another job, and validated
 * again before the handler runs. The handler never trusts it: it re-reads the execution inside `withTenant` for the
 * envelope's workspace (RLS), so a forged or foreign `executionId` finds nothing and the job ends without effect.
 */
export const EXECUTION_JOBS = {
  /** S1: pending → materializing (start-time checks). */
  start: 'campaign.execution.start',
  /** Lease → capture (S2/S3) → pages with Checkpoint A → delivering → claim → Checkpoint B → NullDeliveryPort → complete. */
  run: 'campaign.execution.run',
  /** Terminal execution (cancelled/failed): pending/queued recipients → cancelled in chunks, then snapshot release. */
  finalize: 'campaign.execution.finalize',
  /** Snapshot release procedure (contract §6.4) for a releasable execution. */
  release: 'campaign.execution.release',
} as const;
export type ExecutionJobName = (typeof EXECUTION_JOBS)[keyof typeof EXECUTION_JOBS];

export const executionJobEnvelope = z.strictObject({
  tenant: z.strictObject({ orgId: z.uuid(), workspaceId: z.uuid() }),
  actor: z.strictObject({ type: z.enum(['user', 'system']), id: z.string().nullable() }),
  correlationId: z.uuid(),
  payload: z.strictObject({
    executionId: z.uuid(),
    /** Job-level retry attempt (contract §6.2: up to 5 with backoff, then health = stalled). */
    attempt: z.number().int().min(0).max(10).default(0),
  }),
});
export type ExecutionJobEnvelope = z.infer<typeof executionJobEnvelope>;
