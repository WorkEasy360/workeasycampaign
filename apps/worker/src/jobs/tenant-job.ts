import type { Database, TenantContext, Tx } from '@workeasy/db';
import { UnrecoverableError } from 'bullmq';
import { z } from 'zod';

/**
 * Every tenant job carries this envelope. It is built SERVER-SIDE from an authorized request or another job's
 * context (`tenantJobData`), never from user input, and is validated again before the handler runs.
 */
const envelope = z.object({
  tenant: z.object({ orgId: z.uuid(), workspaceId: z.uuid().nullable() }),
  actor: z.object({ type: z.enum(['user', 'system', 'api_key']), id: z.string().nullable() }),
  correlationId: z.uuid(),
  payload: z.unknown(),
});
export type TenantJobData<P> = Omit<z.infer<typeof envelope>, 'payload'> & { payload: P };

export interface TenantJobContext<P> {
  /** RLS-scoped transaction: the handler can only see the job's tenant (and workspace, if set). */
  tx: Tx;
  tenant: TenantContext;
  actor: TenantJobData<P>['actor'];
  correlationId: string;
  payload: P;
}

export interface TenantJob<P> {
  name: string;
  /** BullMQ-compatible processor. */
  process(job: { name: string; data: unknown }): Promise<void>;
  /** Build job data from an already-authorized context. */
  data(ctx: { orgId: string; workspaceId: string | null; actor: TenantJobData<P>['actor']; correlationId: string }, payload: P): TenantJobData<P>;
}

export function defineTenantJob<P>(
  name: string,
  payloadSchema: z.ZodType<P>,
  db: Database,
  handler: (ctx: TenantJobContext<P>) => Promise<void>,
): TenantJob<P> {
  return {
    name,
    data: (ctx, payload) => ({
      tenant: { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      actor: ctx.actor,
      correlationId: ctx.correlationId,
      payload,
    }),
    async process(job) {
      const parsed = envelope.safeParse(job.data);
      // Missing/invalid tenant context is a programming error: never retry, never run unscoped.
      if (!parsed.success) throw new UnrecoverableError(`${name}: job has no valid tenant context`);
      const payload = payloadSchema.safeParse(parsed.data.payload);
      if (!payload.success) throw new UnrecoverableError(`${name}: invalid payload`);
      const tenant: TenantContext = {
        orgId: parsed.data.tenant.orgId,
        workspaceId: parsed.data.tenant.workspaceId,
        userId: parsed.data.actor.type === 'user' ? parsed.data.actor.id : null,
      };
      await db.withTenant(tenant, (tx) =>
        handler({ tx, tenant, actor: parsed.data.actor, correlationId: parsed.data.correlationId, payload: payload.data }),
      );
    },
  };
}
