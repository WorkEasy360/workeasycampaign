/**
 * @workeasy/db — the ONLY way application code reaches PostgreSQL.
 *
 * There is deliberately no export of PrismaClient. Callers get a transaction handle that is already bound to a
 * context (tenant, workspace and/or user) and PostgreSQL row-level security enforces that context, so:
 *   - forgetting the context returns no rows (it never returns everyone's rows);
 *   - code cannot widen its own scope, because the runtime role (workeasy_app) cannot bypass RLS.
 * Cross-tenant lookups that are genuinely needed (session by token, invitation by token, provider callbacks) are
 * exposed as named methods on `system`, backed by SECURITY DEFINER functions that return the minimum.
 *
 * See docs/tenancy.md.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from './generated/prisma/client.js';

export type { Prisma } from './generated/prisma/client.js';
/** Sets a nullable JSON column to SQL NULL (Prisma distinguishes this from "not provided"). */
export const DbNull = Prisma.DbNull;
export type * from './generated/prisma/models.js';
export {
  sqlStateOf,
  isUniqueViolation,
  isForeignKeyViolation,
  isPermissionDenied,
  isSerializationFailure,
  isNotFound,
} from './errors.js';

/** A transaction already scoped by context. Use it for the whole unit of work; do not let it escape. */
export type Tx = Prisma.TransactionClient;

export interface TenantContext {
  orgId: string;
  /** Required for workspace-owned data; null for organization-level work. */
  workspaceId: string | null;
  /** The acting user, when there is one (null for system jobs and webhooks). */
  userId: string | null;
}

export interface TxOptions {
  isolationLevel?: 'ReadCommitted' | 'RepeatableRead' | 'Serializable';
  /** Milliseconds. */
  timeout?: number;
}

export interface ResolvedSession {
  sessionId: string;
  userId: string;
  userStatus: string;
  userEmail: string;
  userDisplayName: string;
  userEmailVerified: boolean;
  provider: string;
  authMethods: string[];
  createdAt: Date;
  rotatedAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
  isPreviousToken: boolean;
}

export interface InvitationLookup {
  id: string;
  orgId: string;
  orgName: string;
  email: string;
  emailNormalized: string;
  status: string;
  expiresAt: Date;
}

export interface ProviderMessageRoute {
  orgId: string;
  workspaceId: string;
  deliveryId: string;
}

export interface SecurityEventInput {
  userId: string | null;
  type: string;
  ipAddress: string | null;
  userAgent: string | null;
  correlationId: string;
  metadata?: Record<string, unknown>;
}

/** Narrow cross-tenant operations. Each maps to one SECURITY DEFINER function in the `app` schema. */
export interface SystemQueries {
  linkIdentity(input: {
    provider: string;
    subject: string;
    email: string;
    displayName: string;
    emailVerified: boolean;
  }): Promise<string>;
  resolveSession(tokenHash: string): Promise<ResolvedSession | null>;
  findInvitation(tokenHash: string): Promise<InvitationLookup | null>;
  resolveProviderMessage(provider: string, providerMessageId: string): Promise<ProviderMessageRoute | null>;
  /**
   * SMS inbound opt-out (messaging amendment §4): contacts whose phone identity is `phoneE164` in the workspaces that
   * texted that number through `provider`. Ids only (at most 1,000); each change is then made inside its tenant.
   */
  smsOptOutTargets(provider: string, phoneE164: string): Promise<{ orgId: string; workspaceId: string; contactId: string }[]>;
  organizationSlugTaken(slug: string): Promise<boolean>;
  recordSecurityEvent(event: SecurityEventInput): Promise<void>;
  /**
   * Workspaces with Audience snapshot cleanup to do (docs/contracts/phase-5-audience.md §9.6, decision J): an unreleased
   * snapshot of this owner kind captured before `unreleasedBefore`, or a released snapshot whose member purge is
   * incomplete. Workspace pairs only; each is then processed inside withTenant for that workspace.
   */
  workspacesWithSnapshotCleanup(ownerKind: 'campaign_execution', unreleasedBefore: Date): Promise<{ orgId: string; workspaceId: string }[]>;
  /**
   * Workspaces with Audience count-bitmap maintenance to do (Phase 6.3 G2): a bitmap that is not valid and not held by a
   * live rebuild lease, or a valid one not reconciled since `reconcileBefore`. Workspace pairs and state only; each is
   * then processed inside withTenant for that workspace.
   */
  workspacesWithCountMaintenance(
    reconcileBefore: Date,
    limit: number,
  ): Promise<{ orgId: string; workspaceId: string; state: 'valid' | 'invalid' | 'rebuilding' }[]>;
  /**
   * Workspaces with campaign execution work to recover (Phase 6.9, contract §6.4/§11): an active execution without a
   * live lease, a send-now execution still pending after `staleBefore`, a cancelled execution with non-final
   * recipients, or a releasable execution whose snapshot release did not complete. Workspace pairs only; each is then
   * processed inside withTenant for that workspace.
   */
  workspacesWithCampaignRecovery(staleBefore: Date): Promise<{ orgId: string; workspaceId: string }[]>;
  /**
   * Scheduled campaign executions that are due (Phase 7.5): pending with send_at <= now, oldest first, at most `limit`
   * (1–1000). Ids and tenant pairs only; each is started inside its tenant by the ordinary, re-checking start job.
   */
  dueCampaignExecutions(now: Date, limit: number): Promise<{ orgId: string; workspaceId: string; executionId: string; sendAt: Date }[]>;
  /** Durable job queue (Phase 7.6; docs/architecture/durable-job-queue.md). Claims due jobs and jobs whose lease expired. */
  claimJobs(worker: string, names: readonly string[], limit: number, leaseSeconds: number): Promise<ClaimedJob[]>;
  /** Heartbeat: false when the lease is no longer this worker's (it expired and the job was reclaimed). */
  extendJobLease(id: string, worker: string, leaseSeconds: number): Promise<boolean>;
  completeJob(id: string, worker: string): Promise<boolean>;
  /** Retry after `retryInSeconds` unless permanent or out of attempts ('dead'); null when the lease was lost. */
  failJob(id: string, worker: string, errorCode: string, retryInSeconds: number, permanent: boolean): Promise<'queued' | 'dead' | null>;
  jobQueueStats(): Promise<{ name: string; status: string; jobs: number; oldestDueSeconds: number | null }[]>;
  purgeJobs(finishedBefore: Date, limit: number): Promise<number>;
  /**
   * Webhook signature tokens (Phase 7.9): `new` on first use, `retry` for the same token with the same body (a provider
   * retry), `forged` for the same token with a different body. Both hashes are SHA-256.
   */
  claimWebhookToken(provider: string, tokenHash: Buffer, bodyHash: Buffer): Promise<'new' | 'retry' | 'forged'>;
  /**
   * Sending-rate token buckets (Phase 7.11), shared by all processes: takes up to `wanted` from every scope at once
   * (rates per second, bursts in tokens). `waitMs` = time until one more token is available when the grant is short.
   */
  takeSendTokens(buckets: SendRateBucket[], wanted: number): Promise<{ granted: number; waitMs: number }>;
  /** Gives back tokens taken but not used. */
  refundSendTokens(buckets: SendRateBucket[], count: number): Promise<void>;
  /** Active workspaces of active organizations, keyset by workspace id (daily usage snapshots, Phase 7.13). */
  usageSnapshotWorkspaces(after: string | null, limit: number): Promise<{ orgId: string; workspaceId: string }[]>;
}

/** One sending-rate bucket: `provider:<name>`, `workspace:<id>` or `execution:<id>`. */
export interface SendRateBucket {
  scope: string;
  ratePerSecond: number;
  burst: number;
}

export interface ClaimedJob {
  id: string;
  name: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

/**
 * Enqueues a job INSIDE the caller's tenant transaction (atomic with the caller's writes). The tenant comes from the
 * transaction's tenant context; the payload's `tenant` must match it (refused otherwise). Returns the job id, or null
 * when a job with the same dedupe key is already queued or running.
 */
export async function enqueueJob(
  tx: Tx,
  job: { name: string; payload: { tenant: { orgId: string; workspaceId: string | null } } & Record<string, unknown>; runAfter?: Date; maxAttempts?: number; dedupeKey?: string },
): Promise<string | null> {
  const rows = await tx.$queryRaw<{ id: string | null }[]>`
    SELECT app.enqueue_job(${job.name}, ${JSON.stringify(job.payload)}::jsonb, ${job.runAfter ?? null}::timestamptz,
                           ${job.maxAttempts ?? null}::int, ${job.dedupeKey ?? null}) AS id`;
  return rows[0]?.id ?? null;
}

export interface Database {
  /** Organization- or workspace-scoped unit of work. */
  withTenant<T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>, options?: TxOptions): Promise<T>;
  /** User-scoped unit of work (own sessions, own memberships across organizations). No tenant is set. */
  asUser<T>(userId: string, fn: (tx: Tx) => Promise<T>, options?: TxOptions): Promise<T>;
  readonly system: SystemQueries;
  ping(): Promise<void>;
  disconnect(): Promise<void>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string | null, name: string): void {
  if (value !== null && !UUID_RE.test(value)) throw new TypeError(`${name} must be a UUID`);
}

export interface DatabaseOptions {
  url: string;
  /** Pool size per process. */
  maxConnections?: number;
  applicationName?: string;
}

export function createDatabase(options: DatabaseOptions): Database {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: options.url,
      max: options.maxConnections ?? 10,
      application_name: options.applicationName ?? 'workeasy',
      // The pg adapter sends timestamps without an offset; pin the session to UTC so they are never re-interpreted
      // in the server's local zone (regression test: test/timezone.test.ts).
      options: '-c TimeZone=UTC',
    }),
  });

  async function scoped<T>(
    ctx: { orgId: string | null; workspaceId: string | null; userId: string | null },
    fn: (tx: Tx) => Promise<T>,
    opts: TxOptions = {},
  ): Promise<T> {
    assertUuid(ctx.orgId, 'orgId');
    assertUuid(ctx.workspaceId, 'workspaceId');
    assertUuid(ctx.userId, 'userId');
    return prisma.$transaction(
      async (tx) => {
        // Transaction-local (third argument true): cannot leak to the next user of this pooled connection.
        await tx.$executeRaw`SELECT set_config('app.org_id', ${ctx.orgId ?? ''}, true),
                                    set_config('app.workspace_id', ${ctx.workspaceId ?? ''}, true),
                                    set_config('app.user_id', ${ctx.userId ?? ''}, true)`;
        return fn(tx);
      },
      {
        isolationLevel: opts.isolationLevel ? Prisma.TransactionIsolationLevel[opts.isolationLevel] : undefined,
        timeout: opts.timeout ?? 10_000,
        maxWait: 5_000,
      },
    );
  }

  const system: SystemQueries = {
    async linkIdentity(i) {
      const rows = await prisma.$queryRaw<{ id: string }[]>`
        SELECT app.link_identity(${i.provider}, ${i.subject}, ${i.email}, ${i.displayName}, ${i.emailVerified}) AS id`;
      return rows[0]!.id;
    },
    async resolveSession(tokenHash) {
      const rows = await prisma.$queryRaw<
        {
          session_id: string;
          user_id: string;
          user_status: string;
          user_email: string;
          user_display_name: string;
          user_email_verified: boolean;
          provider: string;
          auth_methods: string[];
          created_at: Date;
          rotated_at: Date;
          idle_expires_at: Date;
          absolute_expires_at: Date;
          revoked_at: Date | null;
          is_previous_token: boolean;
        }[]
      >`SELECT * FROM app.resolve_session(${tokenHash})`;
      const r = rows[0];
      return r
        ? {
            sessionId: r.session_id,
            userId: r.user_id,
            userStatus: r.user_status,
            userEmail: r.user_email,
            userDisplayName: r.user_display_name,
            userEmailVerified: r.user_email_verified,
            provider: r.provider,
            authMethods: r.auth_methods,
            createdAt: r.created_at,
            rotatedAt: r.rotated_at,
            idleExpiresAt: r.idle_expires_at,
            absoluteExpiresAt: r.absolute_expires_at,
            revokedAt: r.revoked_at,
            isPreviousToken: r.is_previous_token,
          }
        : null;
    },
    async findInvitation(tokenHash) {
      const rows = await prisma.$queryRaw<
        {
          id: string;
          org_id: string;
          org_name: string;
          email: string;
          email_normalized: string;
          status: string;
          expires_at: Date;
        }[]
      >`SELECT * FROM app.find_invitation(${tokenHash})`;
      const r = rows[0];
      return r
        ? {
            id: r.id,
            orgId: r.org_id,
            orgName: r.org_name,
            email: r.email,
            emailNormalized: r.email_normalized,
            status: r.status,
            expiresAt: r.expires_at,
          }
        : null;
    },
    async resolveProviderMessage(provider, providerMessageId) {
      const rows = await prisma.$queryRaw<{ org_id: string; workspace_id: string; delivery_id: string }[]>`
        SELECT * FROM app.resolve_provider_message(${provider}, ${providerMessageId})`;
      const r = rows[0];
      return r ? { orgId: r.org_id, workspaceId: r.workspace_id, deliveryId: r.delivery_id } : null;
    },
    async smsOptOutTargets(provider, phoneE164) {
      if (!/^\+[1-9]\d{6,14}$/.test(phoneE164)) return [];
      const rows = await prisma.$queryRaw<{ org_id: string; workspace_id: string; contact_id: string }[]>`
        SELECT org_id, workspace_id, contact_id FROM app.sms_opt_out_targets(${provider}, ${phoneE164}) ORDER BY org_id, workspace_id, contact_id`;
      return rows.map((r) => ({ orgId: r.org_id, workspaceId: r.workspace_id, contactId: r.contact_id }));
    },
    async organizationSlugTaken(slug) {
      const rows = await prisma.$queryRaw<{ taken: boolean }[]>`SELECT app.organization_slug_taken(${slug}) AS taken`;
      return rows[0]!.taken;
    },
    async workspacesWithSnapshotCleanup(ownerKind, unreleasedBefore) {
      const rows = await prisma.$queryRaw<{ org_id: string; workspace_id: string }[]>`
        SELECT org_id, workspace_id FROM app.workspaces_with_snapshot_cleanup(${ownerKind}, ${unreleasedBefore}::timestamptz)
        ORDER BY org_id, workspace_id`;
      return rows.map((r) => ({ orgId: r.org_id, workspaceId: r.workspace_id }));
    },
    async workspacesWithCampaignRecovery(staleBefore) {
      const rows = await prisma.$queryRaw<{ org_id: string; workspace_id: string }[]>`
        SELECT org_id, workspace_id FROM app.workspaces_with_campaign_recovery(${staleBefore}::timestamptz) ORDER BY org_id, workspace_id`;
      return rows.map((r) => ({ orgId: r.org_id, workspaceId: r.workspace_id }));
    },
    async dueCampaignExecutions(now, limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new TypeError('limit must be an integer 1–1000');
      const rows = await prisma.$queryRaw<{ org_id: string; workspace_id: string; execution_id: string; send_at: Date }[]>`
        SELECT org_id, workspace_id, execution_id, send_at FROM app.due_campaign_executions(${now}::timestamptz, ${limit}::int)`;
      return rows.map((r) => ({ orgId: r.org_id, workspaceId: r.workspace_id, executionId: r.execution_id, sendAt: r.send_at }));
    },
    async claimJobs(worker, names, limit, leaseSeconds) {
      const rows = await prisma.$queryRaw<{ id: string; name: string; payload: unknown; attempts: number; max_attempts: number }[]>`
        SELECT id, name, payload, attempts, max_attempts FROM app.claim_jobs(${worker}, ${[...names]}::text[], ${limit}::int, ${leaseSeconds}::int)`;
      return rows.map((r) => ({ id: r.id, name: r.name, payload: r.payload, attempts: r.attempts, maxAttempts: r.max_attempts }));
    },
    async extendJobLease(id, worker, leaseSeconds) {
      const [r] = await prisma.$queryRaw<{ ok: boolean }[]>`SELECT app.extend_job_lease(${id}::uuid, ${worker}, ${leaseSeconds}::int) AS ok`;
      return !!r?.ok;
    },
    async completeJob(id, worker) {
      const [r] = await prisma.$queryRaw<{ ok: boolean }[]>`SELECT app.complete_job(${id}::uuid, ${worker}) AS ok`;
      return !!r?.ok;
    },
    async failJob(id, worker, errorCode, retryInSeconds, permanent) {
      const [r] = await prisma.$queryRaw<{ status: string | null }[]>`
        SELECT app.fail_job(${id}::uuid, ${worker}, ${errorCode}, ${Math.round(retryInSeconds)}::int, ${permanent}) AS status`;
      return (r?.status ?? null) as 'queued' | 'dead' | null;
    },
    async jobQueueStats() {
      const rows = await prisma.$queryRaw<{ name: string; status: string; jobs: bigint; oldest_due_seconds: number | null }[]>`
        SELECT name, status, jobs, oldest_due_seconds FROM app.job_queue_stats()`;
      return rows.map((r) => ({ name: r.name, status: r.status, jobs: Number(r.jobs), oldestDueSeconds: r.oldest_due_seconds }));
    },
    async purgeJobs(finishedBefore, limit) {
      const [r] = await prisma.$queryRaw<{ n: number }[]>`SELECT app.purge_jobs(${finishedBefore}::timestamptz, ${limit}::int) AS n`;
      return r?.n ?? 0;
    },
    async claimWebhookToken(provider, tokenHash, bodyHash) {
      if (tokenHash.length !== 32 || bodyHash.length !== 32) throw new TypeError('hashes must be SHA-256 digests');
      const [r] = await prisma.$queryRaw<{ r: 'new' | 'retry' | 'forged' }[]>`SELECT app.claim_webhook_token(${provider}, ${tokenHash}, ${bodyHash}) AS r`;
      return r!.r;
    },
    async takeSendTokens(buckets, wanted) {
      // Scope order is the lock order inside the function; sorted here too so inserts of new buckets follow it.
      const b = [...buckets].sort((x, y) => (x.scope < y.scope ? -1 : x.scope > y.scope ? 1 : 0));
      const [r] = await prisma.$queryRaw<{ granted: number; wait_ms: number }[]>`
        SELECT granted, wait_ms FROM app.take_send_tokens(${b.map((x) => x.scope)}::text[], ${b.map((x) => x.ratePerSecond)}::float8[],
                                                         ${b.map((x) => x.burst)}::float8[], ${wanted}::int)`;
      return { granted: r!.granted, waitMs: r!.wait_ms };
    },
    async refundSendTokens(buckets, count) {
      if (count <= 0 || !buckets.length) return;
      await prisma.$executeRaw`SELECT app.refund_send_tokens(${buckets.map((x) => x.scope)}::text[], ${buckets.map((x) => x.burst)}::float8[], ${count}::int)`;
    },
    async usageSnapshotWorkspaces(after, limit) {
      const rows = await prisma.$queryRaw<{ org_id: string; workspace_id: string }[]>`
        SELECT org_id, workspace_id FROM app.usage_snapshot_workspaces(${after}::uuid, ${limit}::int)`;
      return rows.map((r) => ({ orgId: r.org_id, workspaceId: r.workspace_id }));
    },
    async workspacesWithCountMaintenance(reconcileBefore, limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new TypeError('limit must be an integer 1–10000');
      const rows = await prisma.$queryRaw<{ org_id: string; workspace_id: string; state: 'valid' | 'invalid' | 'rebuilding' }[]>`
        SELECT org_id, workspace_id, state FROM app.audience_count_workspaces_due(${reconcileBefore}::timestamptz, ${limit}::int)`;
      return rows.map((r) => ({ orgId: r.org_id, workspaceId: r.workspace_id, state: r.state }));
    },
    async recordSecurityEvent(e) {
      await prisma.$executeRaw`SELECT app.record_security_event(${e.userId}::uuid, ${e.type}, ${e.ipAddress},
        ${e.userAgent}, ${e.correlationId}::uuid, ${JSON.stringify(e.metadata ?? {})}::jsonb)`;
    },
  };

  return {
    withTenant: (ctx, fn, opts) => scoped(ctx, fn, opts),
    asUser: (userId, fn, opts) => scoped({ orgId: null, workspaceId: null, userId }, fn, opts),
    system,
    async ping() {
      await prisma.$queryRaw`SELECT 1`;
    },
    disconnect: () => prisma.$disconnect(),
  };
}
