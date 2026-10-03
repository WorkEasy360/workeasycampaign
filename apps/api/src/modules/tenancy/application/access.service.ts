import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@workeasy/db';
import type { AccessContext } from '../../../common/request-context.js';
import { DATABASE } from '../../../infrastructure/providers.js';
import type { AuthenticatedPrincipal } from '../../identity/domain/principal.js';
import { organizationPermissions, workspacePermissions } from '../domain/access-policy.js';
import { effectiveRolePermissions } from '../domain/system-roles.js';

/**
 * Resolves what a principal may do in an organization/workspace. Never trusts ids from the client on their own:
 * an id is only a key to look up the caller's OWN membership. Re-evaluated on every request (no caching), so a
 * revoked membership, suspension, role change or deactivation applies to the very next request.
 */
@Injectable()
export class AccessService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async organization(principal: AuthenticatedPrincipal, orgId: string): Promise<AccessContext | null> {
    const facts = await this.orgFacts(principal.userId, orgId);
    if (!facts) return null;
    const permissions = organizationPermissions({ orgMembershipStatus: facts.status, orgRolePermissions: facts.rolePermissions });
    if (!permissions.size) return null;
    return { orgId, workspaceId: null, orgRoleKey: facts.roleKey, permissions, workspaceAccess: null };
  }

  async workspace(principal: AuthenticatedPrincipal, workspaceId: string): Promise<AccessContext | null> {
    const orgId = await this.organizationOfWorkspace(principal.userId, workspaceId);
    if (!orgId) return null;
    const facts = await this.orgFacts(principal.userId, orgId);
    if (!facts) return null;
    const ws = await this.db.withTenant({ orgId, workspaceId, userId: principal.userId }, async (tx) => {
      const workspace = await tx.workspace.findUnique({ where: { id: workspaceId }, select: { status: true } });
      if (!workspace) return null;
      const m = await tx.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: principal.userId } },
        select: { role: { select: { permissions: true, isSystem: true, key: true } } },
      });
      return { status: workspace.status, rolePermissions: m ? effectiveRolePermissions(m.role) : null };
    });
    if (!ws) return null;
    const result = workspacePermissions({
      orgMembershipStatus: facts.status,
      orgRolePermissions: facts.rolePermissions,
      workspaceRolePermissions: ws.rolePermissions,
      workspaceStatus: ws.status,
    });
    if (!result) return null;
    return { orgId, workspaceId, orgRoleKey: facts.roleKey, permissions: result.permissions, workspaceAccess: result.access };
  }

  /** The caller's membership facts in one organization, or null if they are not an active member of an active org. */
  private async orgFacts(userId: string, orgId: string) {
    return this.db.withTenant({ orgId, workspaceId: null, userId }, async (tx) => {
      const m = await tx.organizationMembership.findUnique({
        where: { orgId_userId: { orgId, userId } },
        select: { status: true, role: { select: { key: true, permissions: true, isSystem: true } } },
      });
      if (!m || m.status !== 'active') return null;
      const org = await tx.organization.findUnique({ where: { id: orgId }, select: { status: true } });
      if (org?.status !== 'active') return null;
      return { status: m.status, roleKey: m.role.key, rolePermissions: effectiveRolePermissions(m.role) };
    });
  }

  /**
   * Finds which organization a workspace belongs to — but only through the caller's own memberships:
   * an explicit workspace membership, or an organization in which they administer every workspace.
   */
  private async organizationOfWorkspace(userId: string, workspaceId: string): Promise<string | null> {
    const own = await this.db.asUser(userId, async (tx) => ({
      wsMembership: await tx.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId, userId } },
        select: { orgId: true },
      }),
      orgMemberships: await tx.organizationMembership.findMany({
        where: { userId, status: 'active' },
        select: { orgId: true, role: { select: { permissions: true, isSystem: true, key: true } } },
      }),
    }));
    if (own.wsMembership) return own.wsMembership.orgId;
    for (const m of own.orgMemberships) {
      if (!effectiveRolePermissions(m.role).includes('workspaces.access_all')) continue;
      const found = await this.db.withTenant({ orgId: m.orgId, workspaceId: null, userId }, (tx) =>
        tx.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } }),
      );
      if (found) return m.orgId;
    }
    return null;
  }
}
