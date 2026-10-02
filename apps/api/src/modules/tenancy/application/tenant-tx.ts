import type { Database, Tx, TxOptions } from '@workeasy/db';
import type { TenantRequestContext } from '../../../common/request-context.js';
import { recordAudit, type AuditEntry } from '../../audit/audit.js';
import { appendDomainEvent, type EventOrigin } from '../../events/domain-events.js';
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
}

export function inTenant<T>(
  db: Database,
  ctx: TenantRequestContext,
  fn: (uow: TenantUnitOfWork) => Promise<T>,
  options?: TxOptions & { workspaceScoped?: boolean },
): Promise<T> {
  const { orgId, workspaceId } = ctx.access;
  const origin: EventOrigin = {
    orgId,
    actorType: 'user',
    actorId: ctx.principal.userId,
    source: 'api',
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
      }),
    options,
  );
}
