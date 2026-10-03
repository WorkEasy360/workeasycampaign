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
  organizationSlugTaken(slug: string): Promise<boolean>;
  recordSecurityEvent(event: SecurityEventInput): Promise<void>;
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
    async organizationSlugTaken(slug) {
      const rows = await prisma.$queryRaw<{ taken: boolean }[]>`SELECT app.organization_slug_taken(${slug}) AS taken`;
      return rows[0]!.taken;
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
