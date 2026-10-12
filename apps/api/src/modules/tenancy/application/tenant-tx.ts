import type { Database, Tx, TxOptions } from '@workeasy/db';
import type { TenantRequestContext } from '../../../common/request-context.js';
import { recordAudit, type AuditEntry } from '../../audit/audit.js';
import { appendDomainEvent, appendDomainEvents, type EventOrigin } from '../../events/domain-events.js';
import type { DomainEventPayload, DomainEventType } from '../../events/catalogue.js';

/**
 * A unit of work bound to the request's AUTHORIZED tenant context (never to ids from the body), with helpers that
 * write the audit record and domain events in the same transaction as the change.
 */
export interface TenantUnitOfWork {
  tx: Tx;
  audit(entry: AuditEntry): Promise<void>;
  event<T extends DomainEventType>(
    type: T,
    aggregateId: string,
    payload: DomainEventPayload<T>,
    opts?: { workspaceId?: string | null },
  ): Promise<string>;
  /** Batch variant: one event per aggregate, all in this transaction. */
  events<T extends DomainEventType>(type: T, items: { aggregateId: string; payload: DomainEventPayload<T> }[]): Promise<void>;
  /** Origin used for events written by this unit of work. */
  origin: EventOrigin;
}

/**
 * PostgreSQL deadlock (40P01) or serialization failure (40001), however Prisma wraps it (P2034 or the driver error as
 * cause). The transaction was rolled back entirely, so running the unit of work again is safe.
 */
export function isRetryableConflict(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; cause?: unknown; meta?: { code?: unknown } } | null;
  const code = typeof e?.code === 'string' ? e.code : '';
  if (['40P01', '40001', 'P2034'].includes(code) || e?.meta?.code === '40P01' || e?.meta?.code === '40001') return true;
  if (typeof e?.message === 'string' && /deadlock detected|could not serialize access/i.test(e.message)) return true;
  return e?.cause ? isRetryableConflict(e.cause) : false;
}

export const CONFLICT_ATTEMPTS = 3;

/**
 * `inTenant` that re-runs the whole unit of work after a deadlock or serialization failure (at most CONFLICT_ATTEMPTS
 * attempts). Only for units of work whose effects are all inside the transaction and that re-read what they change
 * (membership writes do: they diff against the current rows), so a retry is idempotent.
 */
export async function inTenantRetrying<T>(
  db: Database,
  ctx: TenantRequestContext,
  fn: (uow: TenantUnitOfWork) => Promise<T>,
  options?: TxOptions & { workspaceScoped?: boolean; source?: string },
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await inTenant(db, ctx, fn, options);
    } catch (err) {
      if (attempt >= CONFLICT_ATTEMPTS || !isRetryableConflict(err)) throw err;
      await new Promise((r) => setTimeout(r, 25 * attempt + Math.floor(Math.random() * 50)));
    }
  }
}

/**
 * A tenant unit of work without a signed-in user (Phase 7.8): public flows acting on behalf of a contact (e.g. an
 * unsubscribe link). Events carry actor `system` with the given source; the audit has no principal. The tenant comes
 * from a server-verified source (a signed token), never from request fields.
 */
export function inTenantAsSystem<T>(
  db: Database,
  tenant: { orgId: string; workspaceId: string },
  meta: { source: string; correlationId: string; ipAddress?: string | null; userAgent?: string | null },
  fn: (uow: TenantUnitOfWork) => Promise<T>,
  options?: TxOptions,
): Promise<T> {
  const { orgId, workspaceId } = tenant;
  const origin: EventOrigin = { orgId, actorType: 'system', actorId: null, source: meta.source, correlationId: meta.correlationId };
  return db.withTenant(
    { orgId, workspaceId, userId: null },
    (tx) =>
      fn({
        tx,
        audit: (entry) =>
          recordAudit(tx, { orgId, principal: null, meta: { requestId: meta.correlationId, ipAddress: meta.ipAddress ?? null, userAgent: meta.userAgent ?? null } }, { workspaceId, ...entry }),
        event: (type, aggregateId, payload, opts) => appendDomainEvent(tx, origin, { type, aggregateId, payload, workspaceId: opts?.workspaceId ?? workspaceId }),
        events: (type, items) => appendDomainEvents(tx, origin, type, items.map((i) => ({ ...i, workspaceId }))),
        origin,
      }),
    options,
  );
}

export function inTenant<T>(
  db: Database,
  ctx: TenantRequestContext,
  fn: (uow: TenantUnitOfWork) => Promise<T>,
  options?: TxOptions & { workspaceScoped?: boolean; /** Event source (default "api"); background jobs pass e.g. "import". */ source?: string },
): Promise<T> {
  const { orgId, workspaceId } = ctx.access;
  const origin: EventOrigin = {
    orgId,
    actorType: 'user',
    actorId: ctx.principal.userId,
    source: options?.source ?? 'api',
    correlationId: ctx.meta.requestId,
  };
  return db.withTenant(
    { orgId, workspaceId: options?.workspaceScoped === false ? null : workspaceId, userId: ctx.principal.userId },
    (tx) =>
      fn({
        tx,
        audit: (entry) =>
          recordAudit(tx, { orgId, principal: ctx.principal, meta: ctx.meta }, { workspaceId, ...entry }),
        event: (type, aggregateId, payload, opts) =>
          appendDomainEvent(tx, origin, { type, aggregateId, payload, workspaceId: opts?.workspaceId ?? workspaceId }),
        events: (type, items) => appendDomainEvents(tx, origin, type, items.map((i) => ({ ...i, workspaceId }))),
        origin,
      }),
    options,
  );
}
