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
  | 'import.cancelled';

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
