import { Inject, Injectable } from '@nestjs/common';
import type { Database, Tx } from '@workeasy/db';
import type { OrganizationMemberView, WorkspaceMemberView } from '@workeasy/shared';
import { Errors } from '../../../common/errors.js';
import { decodeCursor, pageOf } from '../../../common/pagination.js';
import type { TenantRequestContext } from '../../../common/request-context.js';
import { DATABASE } from '../../../infrastructure/providers.js';
import { canGrant } from '../domain/access-policy.js';
import { effectiveRolePermissions } from '../domain/system-roles.js';
import { inTenant } from './tenant-tx.js';

const OWNER = 'owner';

@Injectable()
export class MembersService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  // ─── Organization members ────────────────────────────────────────────────────────────────────────────────

  async listOrganizationMembers(ctx: TenantRequestContext, limit: number, cursor?: string) {
    const c = decodeCursor(cursor);
    const rows = await inTenant(this.db, ctx, ({ tx }) =>
      tx.organizationMembership.findMany({
        where: {
          orgId: ctx.access.orgId,
          status: { not: 'removed' },
          ...(c ? { OR: [{ joinedAt: { gt: new Date(c.t) } }, { joinedAt: new Date(c.t), id: { gt: c.id } }] } : {}),
        },
        include: {
          user: { select: { email: true, displayName: true } },
          role: { select: { id: true, name: true } },
          workspaceMemberships: { select: { id: true } },
        },
        orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
        take: limit + 1,
      }),
    );
    const page = pageOf(rows, limit, (r) => ({ t: r.joinedAt.toISOString(), id: r.id }));
    return {
      data: page.data.map(
        (m): OrganizationMemberView => ({
          userId: m.userId,
          email: m.user.email,
          displayName: m.user.displayName,
          status: m.status as OrganizationMemberView['status'],
          role: m.role,
          workspaceCount: m.workspaceMemberships.length,
          joinedAt: m.joinedAt.toISOString(),
          version: m.version,
        }),
      ),
      nextCursor: page.nextCursor,
    };
  }

  async updateOrganizationMember(
    ctx: TenantRequestContext,
    userId: string,
    input: { roleId?: string; status?: 'active' | 'suspended'; version: number },
  ) {
    if (userId === ctx.principal.userId) {
      throw Errors.precondition('You cannot change your own role or status. Ask another admin.');
    }
    await inTenant(
      this.db,
      ctx,
      async ({ tx, audit, event }) => {
        const m = await this.loadMember(tx, ctx.access.orgId, userId);
        const actorIsOwner = ctx.access.orgRoleKey === OWNER;
        if (m.role.key === OWNER && !actorIsOwner) throw Errors.forbidden('Only an owner can change another owner');

        let roleChange: { from: string; to: string; toKey: string | null } | null = null;
        if (input.roleId && input.roleId !== m.roleId) {
          const role = await tx.role.findFirst({
            where: { id: input.roleId, orgId: ctx.access.orgId, scope: 'organization', deletedAt: null },
          });
          if (!role) throw Errors.validation({ roleId: ['Choose an organization role'] });
          const grant = canGrant({
            actorPermissions: ctx.access.permissions,
            actorIsOwner,
            targetRoleKey: role.key,
            targetPermissions: effectiveRolePermissions(role),
            scope: 'organization',
          });
          if (!grant.ok) throw Errors.forbidden(grant.reason);
          roleChange = { from: m.roleId, to: role.id, toKey: role.key };
        }
        const statusChange = input.status && input.status !== m.status ? input.status : null;

        const losesOwnership = m.role.key === OWNER && ((roleChange && roleChange.toKey !== OWNER) || statusChange === 'suspended');
        if (losesOwnership) await this.assertAnotherOwner(tx, ctx.access.orgId, userId);
        if (!roleChange && !statusChange) return;

        const r = await tx.organizationMembership.updateMany({
          where: { id: m.id, version: input.version },
          data: {
            ...(roleChange ? { roleId: roleChange.to } : {}),
            ...(statusChange ? { status: statusChange, suspendedAt: statusChange === 'suspended' ? new Date() : null } : {}),
            updatedAt: new Date(),
            version: { increment: 1 },
          },
        });
        if (r.count !== 1) throw Errors.versionConflict();

        if (roleChange) {
          await audit({ action: 'member.role_changed', targetType: 'user', targetId: userId, metadata: { fromRoleId: roleChange.from, toRoleId: roleChange.to, email: m.user.email } });
          await event('membership.role_changed', m.id, { userId, fromRoleId: roleChange.from, toRoleId: roleChange.to });
        }
        if (statusChange) {
          await audit({ action: statusChange === 'suspended' ? 'member.suspended' : 'member.reactivated', targetType: 'user', targetId: userId, metadata: { email: m.user.email } });
          await event('membership.status_changed', m.id, { userId, from: m.status, to: statusChange });
        }
      },
      { isolationLevel: 'Serializable' },
    );
  }

  /** Removes the member and all their workspace memberships in this organization. Access ends on the next request. */
  async removeOrganizationMember(ctx: TenantRequestContext, userId: string, opts: { leaving?: boolean } = {}) {
    if (userId === ctx.principal.userId && !opts.leaving) {
      throw Errors.precondition('Use "Leave organization" to remove yourself');
    }
    await inTenant(
      this.db,
      ctx,
      async ({ tx, audit, event }) => {
        const m = await this.loadMember(tx, ctx.access.orgId, userId);
        if (!opts.leaving && m.role.key === OWNER && ctx.access.orgRoleKey !== OWNER) {
          throw Errors.forbidden('Only an owner can remove another owner');
        }
        if (m.role.key === OWNER) await this.assertAnotherOwner(tx, ctx.access.orgId, userId);
        const removedWs = await tx.workspaceMembership.findMany({ where: { orgId: ctx.access.orgId, userId }, select: { id: true, workspaceId: true } });
        await tx.workspaceMembership.deleteMany({ where: { orgId: ctx.access.orgId, userId } });
        await tx.organizationMembership.update({
          where: { id: m.id },
          data: { status: 'removed', removedAt: new Date(), updatedAt: new Date(), version: { increment: 1 } },
        });
        await audit({ action: 'member.removed', targetType: 'user', targetId: userId, metadata: { email: m.user.email, leftVoluntarily: !!opts.leaving } });
        await event('membership.status_changed', m.id, { userId, from: m.status, to: 'removed' });
        for (const w of removedWs) await event('workspace_membership.removed', w.id, { userId }, { workspaceId: w.workspaceId });
      },
      { isolationLevel: 'Serializable' },
    );
  }

  // ─── Workspace members ───────────────────────────────────────────────────────────────────────────────────

  async listWorkspaceMembers(ctx: TenantRequestContext): Promise<WorkspaceMemberView[]> {
    return inTenant(this.db, ctx, async ({ tx }) => {
      const explicit = await tx.workspaceMembership.findMany({
        where: { workspaceId: ctx.access.workspaceId!, orgMembership: { status: 'active' } },
        include: { user: { select: { email: true, displayName: true } }, role: { select: { id: true, name: true } } },
      });
      // Members whose organization role administers every workspace have access without an explicit membership.
      const implicit = await tx.organizationMembership.findMany({
        where: { orgId: ctx.access.orgId, status: 'active' },
        include: {
          user: { select: { email: true, displayName: true } },
          role: { select: { id: true, name: true, isSystem: true, key: true, permissions: true } },
        },
      }).then((rows) => rows.filter((m) => effectiveRolePermissions(m.role).includes('workspaces.access_all')));
      const byUser = new Map<string, WorkspaceMemberView>();
      for (const m of implicit) {
        byUser.set(m.userId, {
          userId: m.userId,
          email: m.user.email,
          displayName: m.user.displayName,
          role: { id: m.role.id, name: m.role.name },
          access: 'organization',
        });
      }
      for (const m of explicit) {
        if (!byUser.has(m.userId)) {
          byUser.set(m.userId, { userId: m.userId, email: m.user.email, displayName: m.user.displayName, role: m.role, access: 'explicit' });
        }
      }
      return [...byUser.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
    });
  }

  async putWorkspaceMember(ctx: TenantRequestContext, userId: string, roleId: string) {
    await inTenant(this.db, ctx, async ({ tx, audit, event }) => {
      const workspaceId = ctx.access.workspaceId!;
      const orgMember = await tx.organizationMembership.findUnique({
        where: { orgId_userId: { orgId: ctx.access.orgId, userId } },
        select: { status: true, user: { select: { email: true } } },
      });
      if (!orgMember || orgMember.status !== 'active') {
        throw Errors.precondition('Only active members of the organization can be added. Invite them first.');
      }
      const role = await tx.role.findFirst({ where: { id: roleId, orgId: ctx.access.orgId, scope: 'workspace', deletedAt: null } });
      if (!role) throw Errors.validation({ roleId: ['Choose a workspace role'] });
      const grant = canGrant({
        actorPermissions: ctx.access.permissions,
        actorIsOwner: ctx.access.orgRoleKey === OWNER,
        targetRoleKey: role.key,
        targetPermissions: effectiveRolePermissions(role),
        scope: 'workspace',
      });
      if (!grant.ok) throw Errors.forbidden(grant.reason);

      const existing = await tx.workspaceMembership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
      if (existing?.roleId === role.id) return;
      if (existing) {
        await tx.workspaceMembership.update({
          where: { id: existing.id },
          data: { roleId: role.id, updatedAt: new Date(), version: { increment: 1 } },
        });
        await audit({ action: 'workspace_member.role_changed', targetType: 'user', targetId: userId, metadata: { fromRoleId: existing.roleId, toRoleId: role.id, email: orgMember.user.email } });
        await event('workspace_membership.role_changed', existing.id, { userId, fromRoleId: existing.roleId, toRoleId: role.id });
      } else {
        const created = await tx.workspaceMembership.create({ data: { orgId: ctx.access.orgId, workspaceId, userId, roleId: role.id } });
        await audit({ action: 'workspace_member.added', targetType: 'user', targetId: userId, metadata: { roleId: role.id, email: orgMember.user.email } });
        await event('workspace_membership.added', created.id, { userId, roleId: role.id });
      }
    });
  }

  async removeWorkspaceMember(ctx: TenantRequestContext, userId: string) {
    await inTenant(this.db, ctx, async ({ tx, audit, event }) => {
      const workspaceId = ctx.access.workspaceId!;
      const existing = await tx.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId, userId } },
        include: { role: { select: { permissions: true, key: true, isSystem: true } }, user: { select: { email: true } } },
      });
      if (!existing) throw Errors.notFound('Workspace member');
      // Removing someone requires being able to grant what they hold (a manager cannot remove a workspace admin).
      const grant = canGrant({
        actorPermissions: ctx.access.permissions,
        actorIsOwner: ctx.access.orgRoleKey === OWNER,
        targetRoleKey: existing.role.key,
        targetPermissions: effectiveRolePermissions(existing.role),
        scope: 'workspace',
      });
      if (!grant.ok) throw Errors.forbidden('You cannot remove someone with more access than you');
      await tx.workspaceMembership.delete({ where: { id: existing.id } });
      await audit({ action: 'workspace_member.removed', targetType: 'user', targetId: userId, metadata: { email: existing.user.email } });
      await event('workspace_membership.removed', existing.id, { userId });
    });
  }

  // ─── helpers ─────────────────────────────────────────────────────────────────────────────────────────────

  private async loadMember(tx: Tx, orgId: string, userId: string) {
    const m = await tx.organizationMembership.findUnique({
      where: { orgId_userId: { orgId, userId } },
      include: { role: { select: { key: true, permissions: true, isSystem: true } }, user: { select: { email: true } } },
    });
    if (!m || m.status === 'removed') throw Errors.notFound('Member');
    return m;
  }

  /** Runs inside a SERIALIZABLE transaction so two concurrent demotions cannot both pass the check. */
  private async assertAnotherOwner(tx: Tx, orgId: string, exceptUserId: string) {
    const others = await tx.organizationMembership.count({
      where: { orgId, status: 'active', userId: { not: exceptUserId }, role: { key: OWNER, isSystem: true } },
    });
    if (others === 0) throw Errors.precondition('An organization must always have at least one active owner');
  }
}
