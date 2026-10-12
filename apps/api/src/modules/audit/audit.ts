import type { Tx } from '@workeasy/db';
import type { RequestMeta } from '../../common/request-context.js';
import type { AuthenticatedPrincipal } from '../identity/domain/principal.js';

/** Organization audit actions. Authentication events go to the user's security log instead (no org context). */
export type AuditAction =
  | 'organization.created'
  | 'organization.updated'
  | 'organization.deleted'
  | 'workspace.created'
  | 'workspace.updated'
  | 'workspace.archived'
  | 'workspace.restored'
  | 'invitation.created'
  | 'invitation.resent'
  | 'invitation.revoked'
  | 'invitation.accepted'
  | 'member.role_changed'
  | 'member.suspended'
  | 'member.reactivated'
  | 'member.removed'
  | 'workspace_member.added'
  | 'workspace_member.role_changed'
  | 'workspace_member.removed'
  | 'role.created'
  | 'role.updated'
  | 'role.deleted'
  | 'access.denied'
  | 'audit.exported'
  // Audience (Phase 5): sensitive or bulk actions. Routine edits are covered by domain events.
  | 'contact.erased'
  | 'contacts.bulk_action'
  | 'suppression.added'
  | 'suppression.lifted'
  | 'custom_field.archived'
  | 'custom_field.deleted'
  | 'consent.recorded_by_staff'
  | 'consent.retention_policy_updated'
  | 'consent.retention_purged'
  | 'import.started'
  | 'import.completed'
  | 'import.failed'
  | 'import.cancelled'
  // Campaigns (Phase 6, contract §15 Audit column). Draft edits are covered by domain events only.
  | 'campaign.created'
  | 'campaign.deleted'
  | 'campaign.restored'
  | 'campaign.scheduled'
  | 'campaign.rescheduled'
  | 'campaign.unscheduled'
  | 'campaign.paused'
  | 'campaign.resumed'
  | 'campaign.cancelled'
  // Phase 6.10 (additive): user actions previously covered by events only, and system execution outcomes
  // (actor_type 'system', correlation = the scheduling request). Draft edits stay events-only (routine, frequent).
  | 'campaign.returned_to_draft'
  | 'campaign.version_restored'
  | 'campaign.execution_started'
  | 'campaign.execution_completed'
  | 'campaign.execution_failed'
  // Email templates (content amendment §6): reusable content shared by a workspace — changes are audited.
  | 'template.created'
  | 'template.updated'
  | 'template.deleted'
  | 'template.restored'
  // Reusable saved blocks (Phase 7 §S): changes audited like templates.
  | 'snippet.created'
  | 'snippet.updated'
  | 'snippet.deleted'
  // Sending domains and sender identities (Phase 7.8b).
  | 'sending_domain.created'
  | 'sending_domain.status_changed'
  | 'sending_domain.deleted'
  | 'sender_identity.created'
  | 'sender_identity.updated'
  | 'sender_identity.deleted'
  | 'campaign.template_applied'
  // Phase 7.3: a test send of the draft to the requesting user's own address (no content, no address in metadata).
  | 'campaign.test_sent'
  | 'campaign.sending_rate_changed';

export interface AuditEntry {
  action: AuditAction;
  outcome?: 'success' | 'denied' | 'failure';
  workspaceId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  /** Business facts only. Never secrets, tokens or password material. */
  metadata?: Record<string, unknown>;
}

/**
 * Write an audit record in the same transaction as the change. Append-only: the runtime role cannot update or
 * delete audit rows. The actor's email is snapshotted so the record stays meaningful if the user later leaves.
 */
export async function recordAudit(
  tx: Tx,
  ctx: { orgId: string; principal: AuthenticatedPrincipal | null; meta: RequestMeta },
  entry: AuditEntry,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      orgId: ctx.orgId,
      workspaceId: entry.workspaceId ?? null,
      actorType: ctx.principal ? 'user' : 'system',
      actorId: ctx.principal?.userId ?? null,
      action: entry.action,
      outcome: entry.outcome ?? 'success',
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      ipAddress: ctx.meta.ipAddress,
      userAgent: ctx.meta.userAgent,
      correlationId: ctx.meta.requestId,
      metadata: {
        ...(entry.metadata ?? {}),
        ...(ctx.principal ? { actorEmail: ctx.principal.email, actorName: ctx.principal.displayName } : {}),
      },
    },
  });
}
