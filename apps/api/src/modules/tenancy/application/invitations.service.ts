import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@workeasy/db';
import type { CreateInvitationRequest, InvitationPreview, InvitationView, Permission } from '@workeasy/shared';
import type { AppConfig } from '../../../config/env.js';
import { Errors } from '../../../common/errors.js';
import type { TenantRequestContext, UserRequestContext } from '../../../common/request-context.js';
import { MAILER, type Mailer } from '../../../infrastructure/mail/mailer.js';
import { Mail } from '../../../infrastructure/mail/templates.js';
import { APP_CONFIG, DATABASE } from '../../../infrastructure/providers.js';
import { hashToken, newToken } from '../../../infrastructure/tokens.js';
import { canGrant } from '../domain/access-policy.js';
import { AccessService } from './access.service.js';
import { inTenant } from './tenant-tx.js';

export const INVITATION_TTL_DAYS = 7;
type Grant = { workspaceId: string; roleId: string };

@Injectable()
export class InvitationsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly access: AccessService,
  ) {}

  async create(ctx: TenantRequestContext, input: CreateInvitationRequest): Promise<InvitationView> {
    const email = input.email.trim();
    const emailNormalized = email.toLowerCase();
    const actorIsOwner = ctx.access.orgRoleKey === 'owner';

    // Workspace grants: the inviter must be able to grant that role in THAT workspace.
    const checks: { grant: Grant; actorPermissions: ReadonlySet<Permission> }[] = [];
    for (const grant of dedupe(input.workspaces)) {
      const wsAccess = await this.access.workspace(ctx.principal, grant.workspaceId);
      if (!wsAccess || wsAccess.orgId !== ctx.access.orgId) {
        throw Errors.validation({ workspaces: ['One of the selected workspaces is not available'] });
      }
      checks.push({ grant, actorPermissions: wsAccess.permissions });
    }
    const grants = checks.map((c) => c.grant);

    const token = newToken();
    const view = await inTenant(this.db, ctx, async ({ tx, audit, event }) => {
      const role = await tx.role.findFirst({
        where: { id: input.organizationRoleId, orgId: ctx.access.orgId, scope: 'organization', deletedAt: null },
      });
      if (!role) throw Errors.validation({ organizationRoleId: ['Choose an organization role'] });
      const orgGrant = canGrant({
        actorPermissions: ctx.access.permissions,
        actorIsOwner,
        targetRoleKey: role.key,
        targetPermissions: role.permissions,
        scope: 'organization',
      });
      if (!orgGrant.ok) throw Errors.forbidden(orgGrant.reason);

      const wsRoles = await tx.role.findMany({
        where: { orgId: ctx.access.orgId, scope: 'workspace', deletedAt: null, id: { in: grants.map((g) => g.roleId) } },
      });
      for (const { grant, actorPermissions } of checks) {
        const wsRole = wsRoles.find((r) => r.id === grant.roleId);
        if (!wsRole) throw Errors.validation({ workspaces: ['Choose a workspace role for every workspace'] });
        const ok = canGrant({
          actorPermissions,
          actorIsOwner,
          targetRoleKey: wsRole.key,
          targetPermissions: wsRole.permissions,
          scope: 'workspace',
        });
        if (!ok.ok) throw Errors.forbidden(ok.reason);
      }

      const existingMember = await tx.organizationMembership.findFirst({
        where: { orgId: ctx.access.orgId, status: { in: ['active', 'suspended'] }, user: { emailNormalized } },
        select: { id: true },
      });
      if (existingMember) throw Errors.conflict('This person is already a member of the organization', { email: ['Already a member'] });

      // A new invitation supersedes any pending one for the same email.
      await tx.invitation.updateMany({
        where: { orgId: ctx.access.orgId, emailNormalized, status: 'pending' },
        data: { status: 'revoked', revokedAt: new Date(), version: { increment: 1 } },
      });
      const inv = await tx.invitation.create({
        data: {
          orgId: ctx.access.orgId,
          email,
          emailNormalized,
          organizationRoleId: role.id,
          workspaceGrants: grants.map(({ workspaceId, roleId }) => ({ workspaceId, roleId })),
          tokenHash: hashToken(token),
          invitedByUserId: ctx.principal.userId,
          expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * 86_400_000),
        },
      });
      await audit({
        action: 'invitation.created',
        targetType: 'invitation',
        targetId: inv.id,
        metadata: { email, organizationRoleId: role.id, workspaces: grants.map((g) => g.workspaceId) },
      });
      await event('invitation.created', inv.id, { email, roleId: role.id });
      const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.access.orgId }, select: { name: true } });
      return { id: inv.id, orgName: org.name };
    });

    await this.mailer.send(Mail.invitation(email, ctx.principal.displayName, view.orgName, this.link(token)));
    return (await this.list(ctx)).find((i) => i.id === view.id)!;
  }

  async list(ctx: TenantRequestContext): Promise<InvitationView[]> {
    return inTenant(this.db, ctx, async ({ tx }) => {
      const rows = await tx.invitation.findMany({
        where: { orgId: ctx.access.orgId, OR: [{ status: 'pending' }, { createdAt: { gt: new Date(Date.now() - 30 * 86_400_000) } }] },
        include: { organizationRole: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
      const wsIds = [...new Set(rows.flatMap((r) => (r.workspaceGrants as Grant[]).map((g) => g.workspaceId)))];
      const roleIds = [...new Set(rows.flatMap((r) => (r.workspaceGrants as Grant[]).map((g) => g.roleId)))];
      const inviterIds = [...new Set(rows.map((r) => r.invitedByUserId).filter((x): x is string => !!x))];
      // Sequential on purpose: a transaction is one connection; parallel queries on it are queued anyway.
      const workspaces = await tx.workspace.findMany({ where: { id: { in: wsIds } }, select: { id: true, name: true } });
      const roles = await tx.role.findMany({ where: { id: { in: roleIds } }, select: { id: true, name: true } });
      const inviters = await tx.user.findMany({ where: { id: { in: inviterIds } }, select: { id: true, displayName: true } });
      const now = Date.now();
      return rows.map((r) => ({
        id: r.id,
        email: r.email,
        status: r.status === 'pending' && r.expiresAt.getTime() <= now ? 'expired' : (r.status as InvitationView['status']),
        organizationRole: r.organizationRole,
        workspaces: (r.workspaceGrants as Grant[]).flatMap((g) => {
          const ws = workspaces.find((w) => w.id === g.workspaceId);
          const role = roles.find((x) => x.id === g.roleId);
          return ws && role ? [{ id: ws.id, name: ws.name, role }] : [];
        }),
        invitedBy: inviters.find((u) => u.id === r.invitedByUserId) ?? null,
        expiresAt: r.expiresAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
      }));
    });
  }

  async revoke(ctx: TenantRequestContext, invitationId: string): Promise<void> {
    await inTenant(this.db, ctx, async ({ tx, audit, event }) => {
      const r = await tx.invitation.updateMany({
        where: { id: invitationId, orgId: ctx.access.orgId, status: 'pending' },
        data: { status: 'revoked', revokedAt: new Date(), version: { increment: 1 } },
      });
      if (r.count !== 1) throw Errors.notFound('Pending invitation');
      await audit({ action: 'invitation.revoked', targetType: 'invitation', targetId: invitationId });
      await event('invitation.revoked', invitationId, {});
    });
  }

  /** New token (old link stops working) and a fresh expiry. */
  async resend(ctx: TenantRequestContext, invitationId: string): Promise<void> {
    const token = newToken();
    const info = await inTenant(this.db, ctx, async ({ tx, audit }) => {
      const inv = await tx.invitation.findFirst({ where: { id: invitationId, orgId: ctx.access.orgId, status: 'pending' } });
      if (!inv) throw Errors.notFound('Pending invitation');
      await tx.invitation.update({
        where: { id: inv.id },
        data: { tokenHash: hashToken(token), expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * 86_400_000), version: { increment: 1 } },
      });
      await audit({ action: 'invitation.resent', targetType: 'invitation', targetId: inv.id, metadata: { email: inv.email } });
      const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.access.orgId }, select: { name: true } });
      return { email: inv.email, orgName: org.name };
    });
    await this.mailer.send(Mail.invitation(info.email, ctx.principal.displayName, info.orgName, this.link(token)));
  }

  /** Public: what the invitation is for, so the invitee knows which account to use. */
  async preview(token: string): Promise<InvitationPreview> {
    const inv = await this.db.system.findInvitation(hashToken(token));
    if (!inv) throw Errors.tokenInvalid('This invitation link is invalid');
    const expired = inv.status === 'pending' && inv.expiresAt.getTime() <= Date.now();
    return {
      organizationName: inv.orgName,
      email: inv.email,
      expiresAt: inv.expiresAt.toISOString(),
      status: expired ? 'expired' : (inv.status as InvitationPreview['status']),
    };
  }

  /**
   * The invitee accepts while signed in with the invited, VERIFIED email. Grants are re-validated now: a role or
   * workspace deleted since the invitation was sent is skipped (workspaces) or blocks acceptance (org role).
   */
  async accept(ctx: UserRequestContext, token: string): Promise<{ organizationId: string }> {
    const inv = await this.db.system.findInvitation(hashToken(token));
    if (!inv || inv.status !== 'pending' || inv.expiresAt.getTime() <= Date.now()) {
      throw Errors.tokenInvalid('This invitation is no longer valid. Ask for a new one.');
    }
    if (!ctx.principal.emailVerified) throw Errors.emailNotVerified();
    if (ctx.principal.email.toLowerCase() !== inv.emailNormalized) {
      throw Errors.forbidden(`This invitation was sent to ${inv.email}. Sign in with that address to accept it.`);
    }
    const userId = ctx.principal.userId;
    const tctx: TenantRequestContext = {
      ...ctx,
      access: { orgId: inv.orgId, workspaceId: null, orgRoleKey: null, permissions: new Set(), workspaceAccess: null },
    };

    await inTenant(
      this.db,
      tctx,
      async ({ tx, audit, event }) => {
        const claimed = await tx.invitation.updateMany({
          where: { id: inv.id, status: 'pending' },
          data: { status: 'accepted', acceptedAt: new Date(), acceptedByUserId: userId, version: { increment: 1 } },
        });
        if (claimed.count !== 1) throw Errors.tokenInvalid('This invitation was already used');
        const full = await tx.invitation.findUniqueOrThrow({ where: { id: inv.id } });
        const role = await tx.role.findFirst({ where: { id: full.organizationRoleId, deletedAt: null } });
        if (!role) throw Errors.precondition('The role in this invitation no longer exists. Ask for a new invitation.');

        const existing = await tx.organizationMembership.findUnique({ where: { orgId_userId: { orgId: inv.orgId, userId } } });
        if (existing?.status === 'suspended') throw Errors.forbidden('Your membership of this organization is suspended');
        let membershipId: string;
        if (existing?.status === 'active') {
          membershipId = existing.id; // already a member: accepting is a no-op for the org role
        } else if (existing) {
          await tx.organizationMembership.update({
            where: { id: existing.id },
            data: { status: 'active', roleId: role.id, removedAt: null, suspendedAt: null, joinedAt: new Date(), updatedAt: new Date(), version: { increment: 1 } },
          });
          membershipId = existing.id;
        } else {
          membershipId = (await tx.organizationMembership.create({ data: { orgId: inv.orgId, userId, roleId: role.id } })).id;
        }
        if (existing?.status !== 'active') {
          await event('membership.added', membershipId, { userId, roleId: role.id, via: 'invitation' });
        }

        for (const g of full.workspaceGrants as Grant[]) {
          const ws = await tx.workspace.findFirst({ where: { id: g.workspaceId, status: 'active' } });
          const wsRole = await tx.role.findFirst({ where: { id: g.roleId, scope: 'workspace', deletedAt: null } });
          if (!ws || !wsRole) continue;
          const already = await tx.workspaceMembership.findUnique({ where: { workspaceId_userId: { workspaceId: ws.id, userId } } });
          if (already) continue;
          const created = await tx.workspaceMembership.create({ data: { orgId: inv.orgId, workspaceId: ws.id, userId, roleId: wsRole.id } });
          await event('workspace_membership.added', created.id, { userId, roleId: wsRole.id }, { workspaceId: ws.id });
        }
        await audit({ action: 'invitation.accepted', targetType: 'invitation', targetId: inv.id, metadata: { email: inv.email } });
        await event('invitation.accepted', inv.id, { userId });
      },
      { isolationLevel: 'Serializable' },
    );
    return { organizationId: inv.orgId };
  }

  private link(token: string) {
    return `${this.config.appUrl}/invitations/accept?token=${token}`;
  }
}

function dedupe(grants: Grant[]): Grant[] {
  const seen = new Map<string, Grant>();
  for (const g of grants) seen.set(g.workspaceId, g);
  return [...seen.values()];
}
