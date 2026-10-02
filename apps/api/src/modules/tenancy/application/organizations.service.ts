import { Inject, Injectable } from '@nestjs/common';
import { type Database, isUniqueViolation } from '@workeasy/db';
import type { CreateOrganizationRequest, OrganizationView, WorkspaceView } from '@workeasy/shared';
import { v7 as uuidv7 } from 'uuid';
import { Errors } from '../../../common/errors.js';
import type { TenantRequestContext, UserRequestContext } from '../../../common/request-context.js';
import { DATABASE } from '../../../infrastructure/providers.js';
import { slugify, withSuffix } from '../domain/slug.js';
import { SYSTEM_ROLES } from '../domain/system-roles.js';
import { inTenant } from './tenant-tx.js';

export const toWorkspaceView = (w: {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  timezone: string;
  status: string;
  version: number;
}): WorkspaceView => ({
  id: w.id,
  organizationId: w.orgId,
  name: w.name,
  slug: w.slug,
  timezone: w.timezone,
  status: w.status as WorkspaceView['status'],
  version: w.version,
});

@Injectable()
export class OrganizationsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Organizations the caller is an active member of (RLS: own memberships only). */
  async listMine(userId: string): Promise<OrganizationView[]> {
    const rows = await this.db.asUser(userId, (tx) =>
      tx.organizationMembership.findMany({
        where: { userId, status: 'active', organization: { status: 'active' } },
        select: {
          organization: { select: { id: true, name: true, slug: true, version: true } },
          role: { select: { id: true, name: true } },
        },
        orderBy: { joinedAt: 'asc' },
      }),
    );
    return rows.map((r) => ({ ...r.organization, role: r.role }));
  }

  /**
   * Register → verify → create organization → first workspace → owner + workspace admin.
   * One transaction: the organization never exists without its roles, owner and first workspace.
   */
  async create(ctx: UserRequestContext, input: CreateOrganizationRequest) {
    if (!ctx.principal.emailVerified) throw Errors.emailNotVerified();
    const slug = await this.pickSlug(input.slug, input.name);
    const orgId = uuidv7();
    const workspaceId = uuidv7();
    const tctx: TenantRequestContext = {
      ...ctx,
      access: { orgId, workspaceId: null, orgRoleKey: 'owner', permissions: new Set(), workspaceAccess: null },
    };

    try {
      return await inTenant(this.db, tctx, async ({ tx, audit, event }) => {
        const org = await tx.organization.create({
          data: { id: orgId, name: input.name, slug, createdByUserId: ctx.principal.userId },
        });
        const roleIds = new Map<string, string>();
        await tx.role.createMany({
          data: SYSTEM_ROLES.map((r) => {
            const id = uuidv7();
            roleIds.set(r.key, id);
            return { id, orgId, key: r.key, name: r.name, description: r.description, scope: r.scope, isSystem: true, permissions: r.permissions };
          }),
        });
        const ownerRoleId = roleIds.get('owner')!;
        const wsAdminRoleId = roleIds.get('workspace_admin')!;
        await tx.organizationMembership.create({ data: { orgId, userId: ctx.principal.userId, roleId: ownerRoleId } });
        const workspace = await tx.workspace.create({
          data: { id: workspaceId, orgId, name: input.workspace.name, slug: slugify(input.workspace.name), timezone: input.workspace.timezone },
        });
        await tx.workspaceMembership.create({
          data: { orgId, workspaceId, userId: ctx.principal.userId, roleId: wsAdminRoleId },
        });

        await audit({ action: 'organization.created', targetType: 'organization', targetId: orgId, metadata: { name: org.name, slug } });
        await audit({ action: 'workspace.created', workspaceId, targetType: 'workspace', targetId: workspaceId, metadata: { name: workspace.name } });
        await event('organization.created', orgId, { name: org.name, slug, ownerUserId: ctx.principal.userId });
        await event('membership.added', orgId, { userId: ctx.principal.userId, roleId: ownerRoleId, via: 'creation' });
        await event('workspace.created', workspaceId, { name: workspace.name, slug: workspace.slug }, { workspaceId });
        await event('workspace_membership.added', workspaceId, { userId: ctx.principal.userId, roleId: wsAdminRoleId }, { workspaceId });

        return {
          organization: { id: org.id, name: org.name, slug: org.slug, role: { id: ownerRoleId, name: 'Owner' }, version: org.version } satisfies OrganizationView,
          workspace: toWorkspaceView(workspace),
        };
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw Errors.conflict('That address is already taken', { slug: ['Choose another address'] });
      throw err;
    }
  }

  async get(ctx: TenantRequestContext): Promise<OrganizationView> {
    return inTenant(this.db, ctx, async ({ tx }) => {
      const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.access.orgId } });
      const m = await tx.organizationMembership.findUniqueOrThrow({
        where: { orgId_userId: { orgId: org.id, userId: ctx.principal.userId } },
        select: { role: { select: { id: true, name: true } } },
      });
      return { id: org.id, name: org.name, slug: org.slug, role: m.role, version: org.version };
    });
  }

  async update(ctx: TenantRequestContext, input: { name: string; version: number }): Promise<OrganizationView> {
    await inTenant(this.db, ctx, async ({ tx, audit, event }) => {
      const before = await tx.organization.findUniqueOrThrow({ where: { id: ctx.access.orgId } });
      const r = await tx.organization.updateMany({
        where: { id: ctx.access.orgId, version: input.version },
        data: { name: input.name, updatedAt: new Date(), version: { increment: 1 } },
      });
      if (r.count !== 1) throw Errors.versionConflict();
      await audit({ action: 'organization.updated', targetType: 'organization', targetId: ctx.access.orgId, metadata: { name: { from: before.name, to: input.name } } });
      await event('organization.updated', ctx.access.orgId, { changes: ['name'] });
    });
    return this.get(ctx);
  }

  /** Soft delete. Every member loses access on their next request (AccessService requires an active org). */
  async delete(ctx: TenantRequestContext, confirmName: string): Promise<void> {
    await inTenant(this.db, ctx, async ({ tx, audit, event }) => {
      const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.access.orgId } });
      if (confirmName.trim() !== org.name) {
        throw Errors.validation({ confirmName: ['Type the organization name exactly to confirm'] });
      }
      await tx.organization.update({
        where: { id: org.id },
        data: { status: 'deleted', deletedAt: new Date(), updatedAt: new Date(), version: { increment: 1 } },
      });
      await audit({ action: 'organization.deleted', targetType: 'organization', targetId: org.id, metadata: { name: org.name } });
      await event('organization.deleted', org.id, {});
    });
  }

  private async pickSlug(requested: string | undefined, name: string): Promise<string> {
    if (requested) {
      if (await this.db.system.organizationSlugTaken(requested)) {
        throw Errors.conflict('That address is already taken', { slug: ['Choose another address'] });
      }
      return requested;
    }
    let candidate = slugify(name);
    for (let i = 0; i < 5 && (await this.db.system.organizationSlugTaken(candidate)); i++) candidate = withSuffix(slugify(name));
    return candidate;
  }
}
