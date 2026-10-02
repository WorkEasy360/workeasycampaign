import { Controller, Get, Query, Res } from '@nestjs/common';
import { auditLogQuery } from '@workeasy/shared';
import type { FastifyReply } from 'fastify';
import { OrgAccess, RateLimit } from '../../common/access.js';
import { TenantCtx, type TenantRequestContext } from '../../common/request-context.js';
import { parse } from '../../common/validation.js';
import { AuditQueryService } from './audit-query.service.js';

@Controller('v1/organizations/:orgId/audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditQueryService) {}

  @Get()
  @OrgAccess('audit.read')
  list(@TenantCtx() ctx: TenantRequestContext, @Query() query: unknown) {
    return this.audit.list(ctx, parse(auditLogQuery, query));
  }

  @Get('export')
  @OrgAccess('audit.export')
  @RateLimit({ name: 'audit.export', by: 'user', limit: 10, windowSeconds: 3600 })
  async export(@TenantCtx() ctx: TenantRequestContext, @Query() query: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const { action, actorId, workspaceId } = parse(auditLogQuery, query);
    const csv = await this.audit.exportCsv(ctx, { action, actorId, workspaceId });
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`)
      .header('cache-control', 'no-store');
    return csv;
  }
}
