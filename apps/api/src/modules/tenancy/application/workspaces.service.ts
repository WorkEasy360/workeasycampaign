import { Inject, Injectable } from '@nestjs/common';
import { type Database, isUniqueViolation, type Tx } from '@workeasy/db';
import type { WorkspaceView } from '@workeasy/shared';
import { Errors } from '../../../common/errors.js';
import type { TenantRequestContext } from '../../../common/request-context.js';
import { DATABASE } from '../../../infrastructure/providers.js';
import { slugify, withSuffix } from '../domain/slug.js';
import { toWorkspaceView } from './organizations.service.js';
import { inTenant } from './tenant-tx.js';
import { ensureDefaultTopic } from '../../audience/application/topics-fields.service.js';

@Injectable()
export class WorkspacesService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Workspaces the caller can enter: all of them with workspaces.access_all, otherwise explicit memberships. */
  async list(ctx: TenantRequestContext): Promise<WorkspaceView[]> {
    const all = ctx.access.permissions.has('workspaces.access_all');
    const rows = await inTenant(this.db, ctx, ({ tx }) =>
      tx.workspace.findMany({
        where: all ? {} : { memberships: { some: { userId: ctx.principal.userId } } },
        orderBy: [{ status: 'asc' }, { name: 'asc' }],
      }),
    );
    return rows.map(toWorkspaceView);
  }

  async create(ctx: TenantRequestContext, input: { name: string; timezone: string }): Promise<WorkspaceView> {
    const view = await this.createWorkspace(ctx, input);
    await this.db.withTenant({ orgId: ctx.access.orgId, workspaceId: view.id, userId: ctx.principal.userId }, (tx) =>
      ensureDefaultTopic(tx, ctx.access.orgId, view.id),
    );
    return view;
  }

  private async createWorkspace(ctx: TenantRequestContext, input: { name: string; timezone: string }): Promise<WorkspaceView> {
    try {
      return await inTenant(this.db, ctx, async ({ tx, audit, event }) => {
        const slug = await this.freeSlug(tx, slugify(input.name));
        const ws = await tx.workspace.create({
          data: { orgId: ctx.access.orgId, name: input.name, slug, timezone: input.timezone },
        });
        // A creator who does not already administer every workspace becomes this workspace's admin, so they can
        // always enter what they created.
        if (!ctx.access.permissions.has('workspaces.access_all')) {
          const adminRole = await tx.role.findFirstOrThrow({
            where: { orgId: ctx.access.orgId, key: 'workspace_admin', scope: 'workspace' },
          });
          await tx.workspaceMembership.create({
            data: { orgId: ctx.access.orgId, workspaceId: ws.id, userId: ctx.principal.userId, roleId: adminRole.id },
          });
        }
        await audit({ action: 'workspace.created', workspaceId: ws.id, targetType: 'workspace', targetId: ws.id, metadata: { name: ws.name } });
        await event('workspace.created', ws.id, { name: ws.name, slug: ws.slug }, { workspaceId: ws.id });
        return toWorkspaceView(ws);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw Errors.conflict('A workspace with a similar name was just created. Try again.');
      throw err;
    }
  }

  async get(ctx: TenantRequestContext) {
    return inTenant(this.db, ctx, async ({ tx }) => {
      const ws = await tx.workspace.findUniqueOrThrow({ where: { id: ctx.access.workspaceId! } });
      // Workspace-owned settings are created lazily under the workspace context (RLS: org + workspace).
      const settings =
        (await tx.workspaceSettings.findUnique({ where: { workspaceId: ws.id } })) ??
        (ctx.access.permissions.has('workspace.update')
          ? await tx.workspaceSettings.create({ data: { orgId: ws.orgId, workspaceId: ws.id } })
          : null);
      return {
        workspace: toWorkspaceView(ws),
        settings: settings ? { locale: settings.locale, defaultSenderName: settings.defaultSenderName, defaultReplyTo: settings.defaultReplyTo } : null,
        access: ctx.access.workspaceAccess,
      };
    });
  }

  async update(ctx: TenantRequestContext, input: { name?: string; timezone?: string; version: number }) {
    await inTenant(this.db, ctx, async ({ tx, audit, event }) => {
      const id = ctx.access.workspaceId!;
      const before = await tx.workspace.findUniqueOrThrow({ where: { id } });
      if (before.status === 'archived') throw Errors.precondition('Restore the workspace before editing it');
      const changes = Object.entries({ name: input.name, timezone: input.timezone }).filter(
        ([k, v]) => v !== undefined && v !== before[k as 'name' | 'timezone'],
      );
      if (!changes.length) return;
      const r = await tx.workspace.updateMany({
        where: { id, version: input.version },
        data: { ...Object.fromEntries(changes), updatedAt: new Date(), version: { increment: 1 } },
      });
      if (r.count !== 1) throw Errors.versionConflict();
      await audit({
        action: 'workspace.updated',
        targetType: 'workspace',
        targetId: id,
        metadata: Object.fromEntries(changes.map(([k, v]) => [k, { from: before[k as 'name' | 'timezone'], to: v }])),
      });
      await event('workspace.updated', id, { changes: changes.map(([k]) => k) });
    });
    return this.get(ctx);
  }

  /** Archive/restore via the organization route: workspace id comes from the path but must belong to this org (RLS). */
  async setArchived(ctx: TenantRequestContext, workspaceId: string, archived: boolean): Promise<WorkspaceView> {
    return inTenant(this.db, ctx, async ({ tx, audit, event }) => {
      const ws = await tx.workspace.findUnique({ where: { id: workspaceId } });
      if (!ws) throw Errors.notFound('Workspace');
      if ((ws.status === 'archived') === archived) return toWorkspaceView(ws);
      if (archived) {
        const active = await tx.workspace.count({ where: { status: 'active' } });
        if (active <= 1) throw Errors.precondition('An organization needs at least one active workspace');
      }
      const updated = await tx.workspace.update({
        where: { id: workspaceId },
        data: {
          status: archived ? 'archived' : 'active',
          archivedAt: archived ? new Date() : null,
          updatedAt: new Date(),
          version: { increment: 1 },
        },
      });
      await audit({
        action: archived ? 'workspace.archived' : 'workspace.restored',
        workspaceId,
        targetType: 'workspace',
        targetId: workspaceId,
        metadata: { name: ws.name },
      });
      await event(archived ? 'workspace.archived' : 'workspace.restored', workspaceId, {}, { workspaceId });
      return toWorkspaceView(updated);
    }, { workspaceScoped: false });
  }

  private async freeSlug(tx: Tx, base: string): Promise<string> {
    let candidate = base;
    for (let i = 0; i < 5; i++) {
      if (!(await tx.workspace.findFirst({ where: { slug: candidate }, select: { id: true } }))) return candidate;
      candidate = withSuffix(base);
    }
    return withSuffix(base);
  }
}
