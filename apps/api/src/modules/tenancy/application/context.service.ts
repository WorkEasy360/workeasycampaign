import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@workeasy/db';
import type { CurrentContext, Permission } from '@workeasy/shared';
import { Errors } from '../../../common/errors.js';
import type { AccessContext, UserRequestContext } from '../../../common/request-context.js';
import { DATABASE } from '../../../infrastructure/providers.js';
import { SessionService } from '../../identity/application/session.service.js';
import { AccessService } from './access.service.js';

/**
 * Current organization/workspace for the UI. The selection is remembered on the session as a convenience only;
 * every API call still carries the ids in its path and is re-authorized by AccessGuard.
 */
@Injectable()
export class ContextService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly access: AccessService,
    private readonly sessions: SessionService,
  ) {}

  async current(ctx: UserRequestContext, requested?: { organizationId?: string; workspaceId?: string }): Promise<CurrentContext> {
    const remembered = await this.sessions.lastContext(ctx.principal.userId, ctx.principal.sessionId);
    const orgId = requested?.organizationId ?? remembered.organizationId;
    const wsId = requested?.workspaceId ?? (requested?.organizationId ? null : remembered.workspaceId);
    return this.build(ctx, orgId, wsId, false);
  }

  async switch(ctx: UserRequestContext, organizationId: string, workspaceId: string | null): Promise<CurrentContext> {
    const result = await this.build(ctx, organizationId, workspaceId, true);
    await this.sessions.rememberContext(ctx.principal.userId, ctx.principal.sessionId, result.organization?.id ?? null, result.workspace?.id ?? null);
    return result;
  }

  private async build(ctx: UserRequestContext, orgId: string | null, wsId: string | null, strict: boolean): Promise<CurrentContext> {
    const user = {
      id: ctx.principal.userId,
      email: ctx.principal.email,
      displayName: ctx.principal.displayName,
      emailVerified: ctx.principal.emailVerified,
    };
    const empty: CurrentContext = { user, organization: null, workspace: null, permissions: [] };
    if (!ctx.principal.emailVerified) return empty;

    let org: AccessContext | null = orgId ? await this.access.organization(ctx.principal, orgId) : null;
    if (!org && strict) throw Errors.notFound('Organization');
    if (!org) {
      // Fall back to the first organization the user belongs to.
      const first = await this.db.asUser(ctx.principal.userId, (tx) =>
        tx.organizationMembership.findFirst({
          where: { userId: ctx.principal.userId, status: 'active', organization: { status: 'active' } },
          orderBy: { joinedAt: 'asc' },
          select: { orgId: true },
        }),
      );
      org = first ? await this.access.organization(ctx.principal, first.orgId) : null;
      wsId = null;
    }
    if (!org) return empty;

    let ws: AccessContext | null = wsId ? await this.access.workspace(ctx.principal, wsId) : null;
    if (ws && ws.orgId !== org.orgId) ws = null;
    if (!ws && wsId && strict) throw Errors.notFound('Workspace');
    if (!ws) ws = await this.firstWorkspace(ctx, org);

    const details = await this.db.withTenant({ orgId: org.orgId, workspaceId: null, userId: ctx.principal.userId }, async (tx) => ({
      org: await tx.organization.findUniqueOrThrow({ where: { id: org!.orgId }, select: { id: true, name: true, slug: true } }),
      ws: ws ? await tx.workspace.findUnique({ where: { id: ws.workspaceId! }, select: { id: true, name: true, slug: true, status: true } }) : null,
    }));
    const permissions = new Set<Permission>([...org.permissions, ...(ws?.permissions ?? [])]);
    return {
      user,
      organization: details.org,
      workspace: details.ws ? { ...details.ws, status: details.ws.status as 'active' | 'archived' } : null,
      permissions: [...permissions].sort(),
    };
  }

  private async firstWorkspace(ctx: UserRequestContext, org: AccessContext): Promise<AccessContext | null> {
    const candidates = await this.db.withTenant({ orgId: org.orgId, workspaceId: null, userId: ctx.principal.userId }, (tx) =>
      tx.workspace.findMany({
        where: {
          status: 'active',
          ...(org.permissions.has('workspaces.access_all') ? {} : { memberships: { some: { userId: ctx.principal.userId } } }),
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
        take: 1,
      }),
    );
    return candidates[0] ? this.access.workspace(ctx.principal, candidates[0].id) : null;
  }
}
