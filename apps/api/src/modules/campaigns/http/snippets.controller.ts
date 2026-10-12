import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { createSnippetRequest, snippetListQuery, updateSnippetRequest } from '@workeasy/shared';
import { RateLimit, WorkspaceAccess } from '../../../common/access.js';
import { TenantCtx, type TenantRequestContext } from '../../../common/request-context.js';
import { parse, routeId } from '../../../common/validation.js';
import { SnippetsService } from '../application/snippets.service.js';

/**
 * Reusable saved blocks (docs/contracts/phase-7-content-amendment.md §S). Same permissions as templates (reusable
 * content of the workspace): read with `templates.read`, change with `templates.manage`; writes share the template
 * write limit.
 */
@Controller('v1/workspaces/:workspaceId/snippets')
export class SnippetsController {
  constructor(private readonly snippets: SnippetsService) {}

  @Get()
  @WorkspaceAccess('templates.read')
  list(@TenantCtx() ctx: TenantRequestContext, @Query() query: unknown) {
    return this.snippets.list(ctx, parse(snippetListQuery, query));
  }

  @Post()
  @WorkspaceAccess('templates.manage')
  @RateLimit({ name: 'templates.write', by: 'user', limit: 600, windowSeconds: 3600 })
  create(@TenantCtx() ctx: TenantRequestContext, @Body() body: unknown) {
    return this.snippets.create(ctx, parse(createSnippetRequest, body));
  }

  @Get(':snippetId')
  @WorkspaceAccess('templates.read')
  get(@TenantCtx() ctx: TenantRequestContext, @Param('snippetId') id: string) {
    return this.snippets.get(ctx, routeId(id, 'Saved block'));
  }

  @Patch(':snippetId')
  @WorkspaceAccess('templates.manage')
  @RateLimit({ name: 'templates.write', by: 'user', limit: 600, windowSeconds: 3600 })
  update(@TenantCtx() ctx: TenantRequestContext, @Param('snippetId') id: string, @Body() body: unknown) {
    return this.snippets.update(ctx, routeId(id, 'Saved block'), parse(updateSnippetRequest, body));
  }

  @Delete(':snippetId')
  @HttpCode(204)
  @WorkspaceAccess('templates.manage')
  @RateLimit({ name: 'templates.write', by: 'user', limit: 600, windowSeconds: 3600 })
  async delete(@TenantCtx() ctx: TenantRequestContext, @Param('snippetId') id: string) {
    await this.snippets.delete(ctx, routeId(id, 'Saved block'));
  }
}
