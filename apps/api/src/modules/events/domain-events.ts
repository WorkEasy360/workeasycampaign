import type { Tx } from '@workeasy/db';
import { v7 as uuidv7 } from 'uuid';
import { DOMAIN_EVENTS, type DomainEventPayload, type DomainEventType } from './catalogue.js';

/** Who/what caused the event. Built from the request or job context, never from client input. */
export interface EventOrigin {
  orgId: string;
  actorType: 'user' | 'api_key' | 'system';
  actorId: string | null;
  /** api | worker | webhook:<provider> | import */
  source: string;
  correlationId: string;
  causationId?: string | null;
}

/** Many events of one type in one statement (bulk operations, imports). Same guarantees as appendDomainEvent. */
export async function appendDomainEvents<T extends DomainEventType>(
  tx: Tx,
  origin: EventOrigin,
  type: T,
  items: { aggregateId: string; payload: DomainEventPayload<T>; workspaceId?: string | null }[],
): Promise<void> {
  if (!items.length) return;
  const def = DOMAIN_EVENTS[type];
  const now = new Date();
  await tx.domainEvent.createMany({
    data: items.map((i) => ({
      id: uuidv7(),
      orgId: origin.orgId,
      workspaceId: i.workspaceId ?? null,
      type,
      version: def.version,
      aggregateType: def.aggregate,
      aggregateId: i.aggregateId,
      actorType: origin.actorType,
      actorId: origin.actorId,
      source: origin.source,
      correlationId: origin.correlationId,
      causationId: origin.causationId ?? null,
      idempotencyKey: null,
      payload: def.payload.parse(i.payload),
      occurredAt: now,
    })),
  });
}

/**
 * Append a domain event in the SAME transaction as the state change it describes (transactional outbox):
 * either both are committed or neither is. Returns the event id (usable as causationId for follow-ups).
 */
export async function appendDomainEvent<T extends DomainEventType>(
  tx: Tx,
  origin: EventOrigin,
  event: {
    type: T;
    aggregateId: string;
    workspaceId?: string | null;
    payload: DomainEventPayload<T>;
    idempotencyKey?: string;
    occurredAt?: Date;
  },
): Promise<string> {
  const def = DOMAIN_EVENTS[event.type];
  const payload = def.payload.parse(event.payload);
  const id = uuidv7();
  await tx.domainEvent.create({
    data: {
      id,
      orgId: origin.orgId,
      workspaceId: event.workspaceId ?? null,
      type: event.type,
      version: def.version,
      aggregateType: def.aggregate,
      aggregateId: event.aggregateId,
      actorType: origin.actorType,
      actorId: origin.actorId,
      source: origin.source,
      correlationId: origin.correlationId,
      causationId: origin.causationId ?? null,
      idempotencyKey: event.idempotencyKey ?? null,
      payload,
      occurredAt: event.occurredAt ?? new Date(),
    },
  });
  return id;
}
