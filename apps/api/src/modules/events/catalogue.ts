import { z } from 'zod';

/**
 * Domain event catalogue (docs/events.md). Each (type, version) has a payload schema; appendDomainEvent validates
 * against it so malformed events never reach the append-only table. Bump `version` for breaking payload changes
 * and keep the old schema for replay.
 */
const id = z.uuid();

export const DOMAIN_EVENTS = {
  'organization.created': { version: 1, aggregate: 'organization', payload: z.object({ name: z.string(), slug: z.string(), ownerUserId: id }) },
  'organization.updated': { version: 1, aggregate: 'organization', payload: z.object({ changes: z.array(z.string()) }) },
  'organization.deleted': { version: 1, aggregate: 'organization', payload: z.object({}) },
  'workspace.created': { version: 1, aggregate: 'workspace', payload: z.object({ name: z.string(), slug: z.string() }) },
  'workspace.updated': { version: 1, aggregate: 'workspace', payload: z.object({ changes: z.array(z.string()) }) },
  'workspace.archived': { version: 1, aggregate: 'workspace', payload: z.object({}) },
  'workspace.restored': { version: 1, aggregate: 'workspace', payload: z.object({}) },
  'membership.added': { version: 1, aggregate: 'organization_membership', payload: z.object({ userId: id, roleId: id, via: z.enum(['creation', 'invitation']) }) },
  'membership.role_changed': { version: 1, aggregate: 'organization_membership', payload: z.object({ userId: id, fromRoleId: id, toRoleId: id }) },
  'membership.status_changed': { version: 1, aggregate: 'organization_membership', payload: z.object({ userId: id, from: z.string(), to: z.string() }) },
  'workspace_membership.added': { version: 1, aggregate: 'workspace_membership', payload: z.object({ userId: id, roleId: id }) },
  'workspace_membership.role_changed': { version: 1, aggregate: 'workspace_membership', payload: z.object({ userId: id, fromRoleId: id, toRoleId: id }) },
  'workspace_membership.removed': { version: 1, aggregate: 'workspace_membership', payload: z.object({ userId: id }) },
  'invitation.created': { version: 1, aggregate: 'invitation', payload: z.object({ email: z.string(), roleId: id }) },
  'invitation.revoked': { version: 1, aggregate: 'invitation', payload: z.object({}) },
  'invitation.accepted': { version: 1, aggregate: 'invitation', payload: z.object({ userId: id }) },
  'role.created': { version: 1, aggregate: 'role', payload: z.object({ name: z.string(), scope: z.string(), permissions: z.array(z.string()) }) },
  'role.updated': { version: 1, aggregate: 'role', payload: z.object({ changes: z.array(z.string()), permissions: z.array(z.string()).optional() }) },
  'role.deleted': { version: 1, aggregate: 'role', payload: z.object({}) },
} as const;

export type DomainEventType = keyof typeof DOMAIN_EVENTS;
export type DomainEventPayload<T extends DomainEventType> = z.input<(typeof DOMAIN_EVENTS)[T]['payload']>;
