import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { applyTemplateRequest, createTemplateRequest, restoreTemplateRequest, templateListQuery, templateVersionListQuery, updateTemplateRequest } from '@workeasy/shared';
import { RateLimit, WorkspaceAccess } from '../../../common/access.js';
import { Errors } from '../../../common/errors.js';
import { TenantCtx, type TenantRequestContext } from '../../../common/request-context.js';
import { parse, routeId } from '../../../common/validation.js';
import { TemplatesService } from '../application/templates.service.js';

/** A version number in a path: a positive int32, else the version does not exist (404, like an unknown id). */
function versionNumber(raw: string): number {
  if (!/^[1-9]\d{0,9}$/.test(raw) || Number(raw) > 2_147_483_647) throw Errors.notFound('Template version');
  return Number(raw);
}

/**
 * Email templates (docs/contracts/phase-6-content-amendment.md §6, rows T1–T6; history 7.1). The workspace comes from the route
 * and the authorized tenant context; bodies are strict.
 */
@Controller('v1/workspaces/:workspaceId')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get('templates')
  @WorkspaceAccess('templates.read')
  list(@TenantCtx() ctx: TenantRequestContext, @Query() query: unknown) {
    return this.templates.list(ctx, parse(templateListQuery, query));
  }

  @Post('templates')
  @WorkspaceAccess('templates.manage')
  @RateLimit({ name: 'templates.write', by: 'user', limit: 600, windowSeconds: 3600 })
  create(@TenantCtx() ctx: TenantRequestContext, @Body() body: unknown) {
    return this.templates.create(ctx, parse(createTemplateRequest, body));
  }

  @Get('templates/:templateId')
  @WorkspaceAccess('templates.read')
  get(@TenantCtx() ctx: TenantRequestContext, @Param('templateId') id: string) {
    return this.templates.get(ctx, routeId(id, 'Template'));
  }

  @Patch('templates/:templateId')
  @WorkspaceAccess('templates.manage')
  @RateLimit({ name: 'templates.write', by: 'user', limit: 600, windowSeconds: 3600 })
  update(@TenantCtx() ctx: TenantRequestContext, @Param('templateId') id: string, @Body() body: unknown) {
    return this.templates.update(ctx, routeId(id, 'Template'), parse(updateTemplateRequest, body));
  }

  @Delete('templates/:templateId')
  @HttpCode(204)
  @WorkspaceAccess('templates.manage')
  @RateLimit({ name: 'templates.write', by: 'user', limit: 600, windowSeconds: 3600 })
  async delete(@TenantCtx() ctx: TenantRequestContext, @Param('templateId') id: string) {
    await this.templates.delete(ctx, routeId(id, 'Template'));
  }

  /** 7.1: distinct categories of live templates (for the filter). */
  @Get('template-categories')
  @WorkspaceAccess('templates.read')
  async categories(@TenantCtx() ctx: TenantRequestContext) {
    return { data: await this.templates.categories(ctx) };
  }

  /** 7.1: version history, newest first. */
  @Get('templates/:templateId/versions')
  @WorkspaceAccess('templates.read')
  versions(@TenantCtx() ctx: TenantRequestContext, @Param('templateId') id: string, @Query() query: unknown) {
    return this.templates.versions(ctx, routeId(id, 'Template'), parse(templateVersionListQuery, query));
  }

  @Get('templates/:templateId/versions/:version')
  @WorkspaceAccess('templates.read')
  version(@TenantCtx() ctx: TenantRequestContext, @Param('templateId') id: string, @Param('version') version: string) {
    return this.templates.version(ctx, routeId(id, 'Template'), versionNumber(version));
  }

  /** 7.1: restore = a new version copied from an older one (optimistic lock). */
  @Post('templates/:templateId/restore')
  @HttpCode(200)
  @WorkspaceAccess('templates.manage')
  @RateLimit({ name: 'templates.write', by: 'user', limit: 600, windowSeconds: 3600 })
  restore(@TenantCtx() ctx: TenantRequestContext, @Param('templateId') id: string, @Body() body: unknown) {
    return this.templates.restore(ctx, routeId(id, 'Template'), parse(restoreTemplateRequest, body));
  }

  /** T6: also needs templates.read (checked by the service, audited when denied). */
  @Post('campaigns/:campaignId/apply-template')
  @HttpCode(200)
  @WorkspaceAccess('campaigns.update')
  apply(@TenantCtx() ctx: TenantRequestContext, @Param('campaignId') id: string, @Body() body: unknown) {
    return this.templates.apply(ctx, routeId(id, 'Campaign'), parse(applyTemplateRequest, body));
  }
}
