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

  // ─── Audience (Phase 5). Payloads carry ids, never personal data (docs/events.md). Membership facts use the
  // contact as aggregate so the contact timeline is one indexed query.
  'contact.created': { version: 1, aggregate: 'contact', payload: z.object({ source: z.string(), importId: id.optional() }) },
  'contact.updated': { version: 1, aggregate: 'contact', payload: z.object({ changes: z.array(z.string()), importId: id.optional() }) },
  'contact.deleted': { version: 1, aggregate: 'contact', payload: z.object({}) },
  'contact.restored': { version: 1, aggregate: 'contact', payload: z.object({}) },
  'contact.erased': { version: 1, aggregate: 'contact', payload: z.object({}) },
  'contact.subscription_changed': { version: 1, aggregate: 'contact', payload: z.object({ from: z.string(), to: z.string(), by: z.string() }) },
  'contact.identity_added': { version: 1, aggregate: 'contact', payload: z.object({ identityId: id, kind: z.string() }) },
  'contact.identity_removed': { version: 1, aggregate: 'contact', payload: z.object({ identityId: id, kind: z.string() }) },
  'list.created': { version: 1, aggregate: 'list', payload: z.object({ name: z.string() }) },
  'list.updated': { version: 1, aggregate: 'list', payload: z.object({ changes: z.array(z.string()) }) },
  'list.archived': { version: 1, aggregate: 'list', payload: z.object({}) },
  'list.restored': { version: 1, aggregate: 'list', payload: z.object({}) },
  'list.deleted': { version: 1, aggregate: 'list', payload: z.object({ membersRemoved: z.number().int() }) },
  'list.member_added': { version: 1, aggregate: 'contact', payload: z.object({ listId: id, source: z.string() }) },
  'list.member_removed': { version: 1, aggregate: 'contact', payload: z.object({ listId: id }) },
  'tag.created': { version: 1, aggregate: 'tag', payload: z.object({ name: z.string() }) },
  'tag.updated': { version: 1, aggregate: 'tag', payload: z.object({ changes: z.array(z.string()) }) },
  'tag.deleted': { version: 1, aggregate: 'tag', payload: z.object({ untagged: z.number().int() }) },
  'contact.tagged': { version: 1, aggregate: 'contact', payload: z.object({ tagId: id }) },
  'contact.untagged': { version: 1, aggregate: 'contact', payload: z.object({ tagId: id }) },
  'topic.created': { version: 1, aggregate: 'topic', payload: z.object({ key: z.string(), kind: z.string() }) },
  'topic.updated': { version: 1, aggregate: 'topic', payload: z.object({ changes: z.array(z.string()) }) },
  'topic.archived': { version: 1, aggregate: 'topic', payload: z.object({}) },
  'topic.restored': { version: 1, aggregate: 'topic', payload: z.object({}) },
  'topic.default_changed': { version: 1, aggregate: 'topic', payload: z.object({ previousDefaultId: id.nullable() }) },
  'contact.topic_subscribed': { version: 1, aggregate: 'contact', payload: z.object({ topicId: id, consentEventId: id }) },
  'contact.topic_unsubscribed': { version: 1, aggregate: 'contact', payload: z.object({ topicId: id, consentEventId: id }) },
  'consent.recorded': { version: 1, aggregate: 'contact', payload: z.object({ channel: z.string(), action: z.string(), newState: z.string(), consentEventId: id }) },
  'suppression.added': { version: 1, aggregate: 'suppression', payload: z.object({ channel: z.string(), reason: z.string(), contactId: id.nullable(), targetType: z.enum(['contact', 'address']) }) },
  'suppression.lifted': { version: 1, aggregate: 'suppression', payload: z.object({ contactId: id.nullable() }) },
  'custom_field.created': { version: 1, aggregate: 'custom_field', payload: z.object({ key: z.string(), type: z.string() }) },
  'custom_field.updated': { version: 1, aggregate: 'custom_field', payload: z.object({ changes: z.array(z.string()) }) },
  'custom_field.archived': { version: 1, aggregate: 'custom_field', payload: z.object({}) },
  'custom_field.restored': { version: 1, aggregate: 'custom_field', payload: z.object({}) },
  'custom_field.deleted': { version: 1, aggregate: 'custom_field', payload: z.object({ key: z.string() }) },
  'import.started': { version: 1, aggregate: 'import', payload: z.object({ totalRows: z.number().int().nullable() }) },
  'import.completed': {
    version: 1,
    aggregate: 'import',
    payload: z.object({
      created: z.number().int(),
      updated: z.number().int(),
      skipped: z.number().int(),
      errors: z.number().int(),
      listIds: z.array(id),
      tagIds: z.array(id),
    }),
  },
  'import.failed': { version: 1, aggregate: 'import', payload: z.object({ reason: z.string() }) },
} as const;

export type DomainEventType = keyof typeof DOMAIN_EVENTS;
export type DomainEventPayload<T extends DomainEventType> = z.input<(typeof DOMAIN_EVENTS)[T]['payload']>;
