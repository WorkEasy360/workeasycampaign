import { Inject, Injectable } from '@nestjs/common';
import type { Database, Tx } from '@workeasy/db';
import { isPermission, type Permission, PERMISSION_CATALOGUE, type PermissionScope, permissionsForScope, type RoleView } from '@workeasy/shared';
import { Errors } from '../../../common/errors.js';
import type { TenantRequestContext } from '../../../common/request-context.js';
import { DATABASE } from '../../../infrastructure/providers.js';
import { canGrant } from '../domain/access-policy.js';
import { effectiveRolePermissions } from '../domain/system-roles.js';
import { inTenant } from './tenant-tx.js';

@Injectable()
export class RolesService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(ctx: TenantRequestContext): Promise<RoleView[]> {
    return inTenant(this.db, ctx, async ({ tx }) => {
      const roles = await tx.role.findMany({
        where: { orgId: ctx.access.orgId, deletedAt: null },
        include: {
          _count: { select: { organizationMemberships: { where: { status: { not: 'removed' } } }, workspaceMemberships: true } },
        },
        orderBy: [{ scope: 'asc' }, { isSystem: 'desc' }, { name: 'asc' }],
      });
      return roles.map((r) => ({
        id: r.id,
        key: r.key,
        name: r.name,
        description: r.description,
        scope: r.scope as PermissionScope,
        isSystem: r.isSystem,
        permissions: effectiveRolePermissions(r).filter(isPermission),
        version: r.version,
        memberCount: r._count.organizationMemberships + r._count.workspaceMemberships,
      }));
    });
  }

  async create(ctx: TenantRequestContext, input: { name: string; description: string; scope: PermissionScope; permissions: string[] }) {
    const permissions = this.validatePermissions(input.permissions, input.scope);
    this.assertCanGrant(ctx, input.scope, permissions);
    const id = await inTenant(this.db, ctx, async ({ tx, audit, event }) => {
      await this.assertNameFree(tx, ctx.access.orgId, input.name);
      const role = await tx.role.create({
        data: { orgId: ctx.access.orgId, name: input.name, description: input.description, scope: input.scope, permissions },
      });
      await audit({ action: 'role.created', targetType: 'role', targetId: role.id, metadata: { name: role.name, scope: role.scope, permissions } });
      await event('role.created', role.id, { name: role.name, scope: role.scope, permissions });
      return role.id;
    });
    return (await this.list(ctx)).find((r) => r.id === id)!;
  }

  async update(
    ctx: TenantRequestContext,
    roleId: string,
    input: { name?: string; description?: string; permissions?: string[]; version: number },
  ) {
    await inTenant(this.db, ctx, async ({ tx, audit, event }) => {
      const role = await this.loadCustomRole(tx, ctx.access.orgId, roleId);
      const scope = role.scope as PermissionScope;
      let permissions: Permission[] | undefined;
      if (input.permissions) {
        permissions = this.validatePermissions(input.permissions, scope);
        // Both the permissions being added AND removed must be within the actor's own grant.
        this.assertCanGrant(ctx, scope, [...new Set([...permissions, ...role.permissions.filter(isPermission)])]);
      }
      if (input.name && input.name.toLowerCase() !== role.name.toLowerCase()) await this.assertNameFree(tx, ctx.access.orgId, input.name);
      const r = await tx.role.updateMany({
        where: { id: roleId, version: input.version },
        data: {
          ...(input.name ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(permissions ? { permissions } : {}),
          updatedAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (r.count !== 1) throw Errors.versionConflict();
      const changes = Object.keys(input).filter((k) => k !== 'version');
      const added = permissions?.filter((p) => !role.permissions.includes(p)) ?? [];
      const removed = permissions ? role.permissions.filter((p) => !permissions!.includes(p as Permission)) : [];
      await audit({ action: 'role.updated', targetType: 'role', targetId: roleId, metadata: { name: role.name, changes, added, removed } });
      await event('role.updated', roleId, { changes, permissions });
    });
    return (await this.list(ctx)).find((r) => r.id === roleId)!;
  }

  async delete(ctx: TenantRequestContext, roleId: string) {
    await inTenant(this.db, ctx, async ({ tx, audit, event }) => {
      const role = await this.loadCustomRole(tx, ctx.access.orgId, roleId);
      const orgUse = await tx.organizationMembership.count({ where: { roleId, status: { not: 'removed' } } });
      const wsUse = await tx.workspaceMembership.count({ where: { roleId } });
      const inviteUse = await tx.invitation.count({ where: { organizationRoleId: roleId, status: 'pending' } });
      if (orgUse + wsUse + inviteUse > 0) {
        throw Errors.conflict(`This role is still assigned (${orgUse + wsUse} members, ${inviteUse} pending invitations). Reassign them first.`);
      }
      await tx.role.update({ where: { id: roleId }, data: { deletedAt: new Date(), updatedAt: new Date(), version: { increment: 1 } } });
      await audit({ action: 'role.deleted', targetType: 'role', targetId: roleId, metadata: { name: role.name } });
      await event('role.deleted', roleId, {});
    });
  }

  catalogue() {
    return (['organization', 'workspace'] as const).map((scope) => ({
      scope,
      permissions: permissionsForScope(scope).map((p) => ({ key: p, ...PERMISSION_CATALOGUE[p] })),
    }));
  }

  private validatePermissions(raw: string[], scope: PermissionScope): Permission[] {
    const unknown = raw.filter((p) => !isPermission(p) || PERMISSION_CATALOGUE[p].scope !== scope);
    if (unknown.length) throw Errors.validation({ permissions: [`Not valid for a ${scope} role: ${unknown.join(', ')}`] });
    return [...new Set(raw as Permission[])];
  }

  private assertCanGrant(ctx: TenantRequestContext, scope: PermissionScope, permissions: Permission[]) {
    // Workspace roles apply to any workspace, so only members who administer every workspace may shape them.
    const actorPermissions =
      scope === 'organization'
        ? ctx.access.permissions
        : new Set(ctx.access.permissions.has('workspaces.access_all') ? permissionsForScope('workspace') : []);
    const r = canGrant({ actorPermissions, actorIsOwner: ctx.access.orgRoleKey === 'owner', targetRoleKey: null, targetPermissions: permissions, scope });
    if (!r.ok) throw Errors.forbidden(r.reason);
  }

  private async loadCustomRole(tx: Tx, orgId: string, roleId: string) {
    const role = await tx.role.findFirst({ where: { id: roleId, orgId, deletedAt: null } });
    if (!role) throw Errors.notFound('Role');
    if (role.isSystem) throw Errors.precondition('Built-in roles cannot be changed. Create a custom role instead.');
    return role;
  }

  private async assertNameFree(tx: Tx, orgId: string, name: string) {
    const clash = await tx.role.findFirst({ where: { orgId, deletedAt: null, name: { equals: name, mode: 'insensitive' } } });
    if (clash) throw Errors.conflict('A role with this name already exists', { name: ['Choose another name'] });
  }
}
