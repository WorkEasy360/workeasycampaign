import { Controller, Get, Query } from '@nestjs/common';
import { usageSummaryQuery } from '@workeasy/shared';
import { OrgAccess, RateLimit } from '../../common/access.js';
import { TenantCtx, type TenantRequestContext } from '../../common/request-context.js';
import { parse } from '../../common/validation.js';
import { UsageService } from './usage.service.js';

/** An organization's metered usage (Phase 7.13): quantities per meter and workspace — no prices. */
@Controller('v1/organizations/:orgId/usage')
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get()
  @OrgAccess('billing.manage')
  @RateLimit({ name: 'usage.read', by: 'user', limit: 300, windowSeconds: 3600 })
  summary(@TenantCtx() ctx: TenantRequestContext, @Query() q: unknown) {
    return this.usage.summary(ctx, parse(usageSummaryQuery, q));
  }
}
