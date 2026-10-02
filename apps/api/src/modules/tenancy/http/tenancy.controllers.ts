import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import {
  createInvitationRequest,
  createOrganizationRequest,
  createRoleRequest,
  createWorkspaceRequest,
  deleteOrganizationRequest,
  invitationTokenRequest,
  paginationQuery,
  putWorkspaceMemberRequest,
  switchContextRequest,
  updateOrganizationMemberRequest,
  updateOrganizationRequest,
  updateRoleRequest,
  updateWorkspaceRequest,
} from '@workeasy/shared';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { Authenticated, OrgAccess, Public, RateLimit, WorkspaceAccess } from '../../../common/access.js';
import { IdempotencyService } from '../../../common/idempotency.js';
import { TenantCtx, type TenantRequestContext, UserCtx, type UserRequestContext } from '../../../common/request-context.js';
import { parse, routeId } from '../../../common/validation.js';
import { ContextService } from '../application/context.service.js';
import { InvitationsService } from '../application/invitations.service.js';
import { MembersService } from '../application/members.service.js';
import { OrganizationsService } from '../application/organizations.service.js';
import { RolesService } from '../application/roles.service.js';
import { WorkspacesService } from '../application/workspaces.service.js';

const IDEMPOTENCY_HEADER = 'idempotency-key';

@Controller('v1/organizations')
export class OrganizationsController {
  constructor(
    private readonly orgs: OrganizationsService,
    private readonly workspaces: WorkspacesService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Authenticated()
  async list(@UserCtx() ctx: UserRequestContext) {
    return { data: await this.orgs.listMine(ctx.principal.userId) };
  }

  @Post()
  @Authenticated()
  @RateLimit({ name: 'org.create', by: 'user', limit: 10, windowSeconds: 3600 })
  async create(
    @UserCtx() ctx: UserRequestContext,
    @Body() body: unknown,
    @Headers(IDEMPOTENCY_HEADER) key: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parse(createOrganizationRequest, body);
    const r = await this.idempotency.run(ctx.principal.userId, key, 'POST /v1/organizations', input, async () => ({
      status: 201,
      body: await this.orgs.create(ctx, input),
    }));
    reply.status(r.status);
    if (r.replayed) reply.header('idempotent-replayed', 'true');
    return r.body;
  }

  @Get(':orgId')
  @OrgAccess(null)
  get(@TenantCtx() ctx: TenantRequestContext) {
    return this.orgs.get(ctx);
  }

  @Patch(':orgId')
  @OrgAccess('org.update')
  update(@TenantCtx() ctx: TenantRequestContext, @Body() body: unknown) {
    return this.orgs.update(ctx, parse(updateOrganizationRequest, body));
  }

  @Delete(':orgId')
  @HttpCode(204)
  @OrgAccess('org.delete')
  async remove(@TenantCtx() ctx: TenantRequestContext, @Body() body: unknown) {
    await this.orgs.delete(ctx, parse(deleteOrganizationRequest, body).confirmName);
  }

  @Get(':orgId/workspaces')
  @OrgAccess(null)
  async listWorkspaces(@TenantCtx() ctx: TenantRequestContext) {
    return { data: await this.workspaces.list(ctx) };
  }

  @Post(':orgId/workspaces')
  @OrgAccess('workspaces.create')
  async createWorkspace(
    @TenantCtx() ctx: TenantRequestContext,
    @Body() body: unknown,
    @Headers(IDEMPOTENCY_HEADER) key: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parse(createWorkspaceRequest, body);
    const r = await this.idempotency.run(ctx.principal.userId, key, `POST /v1/organizations/${ctx.access.orgId}/workspaces`, input, async () => ({
      status: 201,
      body: await this.workspaces.create(ctx, input),
    }));
    reply.status(r.status);
    return r.body;
  }

  @Post(':orgId/workspaces/:workspaceId/archive')
  @HttpCode(200)
  @OrgAccess('workspaces.manage')
  archive(@TenantCtx() ctx: TenantRequestContext, @Param('workspaceId') workspaceId: string) {
    return this.workspaces.setArchived(ctx, routeId(workspaceId, 'Workspace'), true);
  }

  @Post(':orgId/workspaces/:workspaceId/restore')
  @HttpCode(200)
  @OrgAccess('workspaces.manage')
  restore(@TenantCtx() ctx: TenantRequestContext, @Param('workspaceId') workspaceId: string) {
    return this.workspaces.setArchived(ctx, routeId(workspaceId, 'Workspace'), false);
  }
}

@Controller('v1/workspaces')
export class WorkspacesController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly members: MembersService,
  ) {}

  @Get(':workspaceId')
  @WorkspaceAccess('workspace.read')
  get(@TenantCtx() ctx: TenantRequestContext) {
    return this.workspaces.get(ctx);
  }

  @Patch(':workspaceId')
  @WorkspaceAccess('workspace.update')
  update(@TenantCtx() ctx: TenantRequestContext, @Body() body: unknown) {
    return this.workspaces.update(ctx, parse(updateWorkspaceRequest, body));
  }

  @Get(':workspaceId/members')
  @WorkspaceAccess('workspace_members.read')
  async listMembers(@TenantCtx() ctx: TenantRequestContext) {
    return { data: await this.members.listWorkspaceMembers(ctx) };
  }

  @Put(':workspaceId/members/:userId')
  @HttpCode(204)
  @WorkspaceAccess('workspace_members.manage')
  async putMember(@TenantCtx() ctx: TenantRequestContext, @Param('userId') userId: string, @Body() body: unknown) {
    await this.members.putWorkspaceMember(ctx, routeId(userId, 'Member'), parse(putWorkspaceMemberRequest, body).roleId);
  }

  @Delete(':workspaceId/members/:userId')
  @HttpCode(204)
  @WorkspaceAccess('workspace_members.manage')
  async removeMember(@TenantCtx() ctx: TenantRequestContext, @Param('userId') userId: string) {
    await this.members.removeWorkspaceMember(ctx, routeId(userId, 'Member'));
  }
}

@Controller('v1/organizations/:orgId')
export class OrganizationMembersController {
  constructor(
    private readonly members: MembersService,
    private readonly invitations: InvitationsService,
    private readonly roles: RolesService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('members')
  @OrgAccess('members.read')
  list(@TenantCtx() ctx: TenantRequestContext, @Query() query: unknown) {
    const { limit, cursor } = parse(paginationQuery, query);
    return this.members.listOrganizationMembers(ctx, limit, cursor);
  }

  @Patch('members/:userId')
  @HttpCode(204)
  @OrgAccess('members.manage')
  async update(@TenantCtx() ctx: TenantRequestContext, @Param('userId') userId: string, @Body() body: unknown) {
    await this.members.updateOrganizationMember(ctx, routeId(userId, 'Member'), parse(updateOrganizationMemberRequest, body));
  }

  @Delete('members/:userId')
  @HttpCode(204)
  @OrgAccess('members.manage')
  async remove(@TenantCtx() ctx: TenantRequestContext, @Param('userId') userId: string) {
    await this.members.removeOrganizationMember(ctx, routeId(userId, 'Member'));
  }

  @Post('leave')
  @HttpCode(204)
  @OrgAccess(null)
  async leave(@TenantCtx() ctx: TenantRequestContext) {
    await this.members.removeOrganizationMember(ctx, ctx.principal.userId, { leaving: true });
  }

  @Get('invitations')
  @OrgAccess('members.read')
  async listInvitations(@TenantCtx() ctx: TenantRequestContext) {
    return { data: await this.invitations.list(ctx) };
  }

  @Post('invitations')
  @OrgAccess('members.invite')
  @RateLimit({ name: 'invitations.create', by: 'user', limit: 100, windowSeconds: 3600 })
  async invite(
    @TenantCtx() ctx: TenantRequestContext,
    @Body() body: unknown,
    @Headers(IDEMPOTENCY_HEADER) key: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parse(createInvitationRequest, body);
    const r = await this.idempotency.run(ctx.principal.userId, key, `POST /v1/organizations/${ctx.access.orgId}/invitations`, input, async () => ({
      status: 201,
      body: await this.invitations.create(ctx, input),
    }));
    reply.status(r.status);
    return r.body;
  }

  @Delete('invitations/:invitationId')
  @HttpCode(204)
  @OrgAccess('members.invite')
  async revokeInvitation(@TenantCtx() ctx: TenantRequestContext, @Param('invitationId') id: string) {
    await this.invitations.revoke(ctx, routeId(id, 'Invitation'));
  }

  @Post('invitations/:invitationId/resend')
  @HttpCode(204)
  @OrgAccess('members.invite')
  @RateLimit({ name: 'invitations.resend', by: 'user', limit: 30, windowSeconds: 3600 })
  async resendInvitation(@TenantCtx() ctx: TenantRequestContext, @Param('invitationId') id: string) {
    await this.invitations.resend(ctx, routeId(id, 'Invitation'));
  }

  @Get('roles')
  @OrgAccess('roles.read')
  async listRoles(@TenantCtx() ctx: TenantRequestContext) {
    return { data: await this.roles.list(ctx) };
  }

  @Post('roles')
  @OrgAccess('roles.manage')
  createRole(@TenantCtx() ctx: TenantRequestContext, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    reply.status(201);
    return this.roles.create(ctx, parse(createRoleRequest, body));
  }

  @Patch('roles/:roleId')
  @OrgAccess('roles.manage')
  updateRole(@TenantCtx() ctx: TenantRequestContext, @Param('roleId') roleId: string, @Body() body: unknown) {
    return this.roles.update(ctx, routeId(roleId, 'Role'), parse(updateRoleRequest, body));
  }

  @Delete('roles/:roleId')
  @HttpCode(204)
  @OrgAccess('roles.manage')
  async deleteRole(@TenantCtx() ctx: TenantRequestContext, @Param('roleId') roleId: string) {
    await this.roles.delete(ctx, routeId(roleId, 'Role'));
  }
}

@Controller('v1')
export class InvitationsPublicController {
  constructor(
    private readonly invitations: InvitationsService,
    private readonly roles: RolesService,
    private readonly context: ContextService,
  ) {}

  @Post('invitations/preview')
  @HttpCode(200)
  @Public()
  @RateLimit({ name: 'invitations.preview', by: 'ip', limit: 60, windowSeconds: 3600 })
  preview(@Body() body: unknown) {
    return this.invitations.preview(parse(invitationTokenRequest, body).token);
  }

  @Post('invitations/accept')
  @HttpCode(200)
  @Authenticated()
  @RateLimit({ name: 'invitations.accept', by: 'user', limit: 30, windowSeconds: 3600 })
  accept(@UserCtx() ctx: UserRequestContext, @Body() body: unknown) {
    return this.invitations.accept(ctx, parse(invitationTokenRequest, body).token);
  }

  @Get('permissions')
  @Authenticated()
  permissions() {
    return { data: this.roles.catalogue() };
  }

  @Get('me/context')
  @Authenticated()
  current(@UserCtx() ctx: UserRequestContext, @Query() query: unknown) {
    const q = parse(z.object({ organizationId: z.uuid().optional(), workspaceId: z.uuid().optional() }), query);
    return this.context.current(ctx, q);
  }

  @Put('me/context')
  @Authenticated()
  switch(@UserCtx() ctx: UserRequestContext, @Body() body: unknown) {
    const input = parse(switchContextRequest, body);
    return this.context.switch(ctx, input.organizationId, input.workspaceId);
  }
}
