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
