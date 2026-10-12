import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { createSenderIdentityRequest, createSendingDomainRequest, updateSenderIdentityRequest } from '@workeasy/shared';
import { RateLimit, WorkspaceAccess } from '../../../common/access.js';
import { TenantCtx, type TenantRequestContext } from '../../../common/request-context.js';
import { parse, routeId } from '../../../common/validation.js';
import { SendersService } from '../application/senders.service.js';

/**
 * Sending domains and sender identities (Phase 7.8b; campaign amendment §S). Reading needs campaigns.read (editors pick
 * a sender); changing needs deliverability.manage. DNS verification is rate-limited (it makes outbound DNS queries).
 */
@Controller('v1/workspaces/:workspaceId')
export class SendersController {
  constructor(private readonly senders: SendersService) {}

  @Get('sending-domains')
  @WorkspaceAccess('campaigns.read')
  async domains(@TenantCtx() ctx: TenantRequestContext) {
    return { data: await this.senders.listDomains(ctx) };
  }

  @Post('sending-domains')
  @WorkspaceAccess('deliverability.manage')
  @RateLimit({ name: 'deliverability.write', by: 'user', limit: 200, windowSeconds: 3600 })
  createDomain(@TenantCtx() ctx: TenantRequestContext, @Body() body: unknown) {
    return this.senders.createDomain(ctx, parse(createSendingDomainRequest, body));
  }

  @Post('sending-domains/:domainId/verify')
  @HttpCode(200)
  @WorkspaceAccess('deliverability.manage')
  @RateLimit({ name: 'deliverability.verify', by: 'user', limit: 60, windowSeconds: 3600 })
  verify(@TenantCtx() ctx: TenantRequestContext, @Param('domainId') id: string) {
    return this.senders.verifyDomain(ctx, routeId(id, 'Sending domain'));
  }

  @Delete('sending-domains/:domainId')
  @HttpCode(204)
  @WorkspaceAccess('deliverability.manage')
  @RateLimit({ name: 'deliverability.write', by: 'user', limit: 200, windowSeconds: 3600 })
  async deleteDomain(@TenantCtx() ctx: TenantRequestContext, @Param('domainId') id: string) {
    await this.senders.deleteDomain(ctx, routeId(id, 'Sending domain'));
  }

  @Get('sender-identities')
  @WorkspaceAccess('campaigns.read')
  async identities(@TenantCtx() ctx: TenantRequestContext) {
    return { data: await this.senders.listIdentities(ctx) };
  }

  @Post('sender-identities')
  @WorkspaceAccess('deliverability.manage')
  @RateLimit({ name: 'deliverability.write', by: 'user', limit: 200, windowSeconds: 3600 })
  createIdentity(@TenantCtx() ctx: TenantRequestContext, @Body() body: unknown) {
    return this.senders.createIdentity(ctx, parse(createSenderIdentityRequest, body));
  }

  @Patch('sender-identities/:identityId')
  @WorkspaceAccess('deliverability.manage')
  @RateLimit({ name: 'deliverability.write', by: 'user', limit: 200, windowSeconds: 3600 })
  updateIdentity(@TenantCtx() ctx: TenantRequestContext, @Param('identityId') id: string, @Body() body: unknown) {
    return this.senders.updateIdentity(ctx, routeId(id, 'Sender identity'), parse(updateSenderIdentityRequest, body));
  }

  @Delete('sender-identities/:identityId')
  @HttpCode(204)
  @WorkspaceAccess('deliverability.manage')
  @RateLimit({ name: 'deliverability.write', by: 'user', limit: 200, windowSeconds: 3600 })
  async deleteIdentity(@TenantCtx() ctx: TenantRequestContext, @Param('identityId') id: string) {
    await this.senders.deleteIdentity(ctx, routeId(id, 'Sender identity'));
  }
}
