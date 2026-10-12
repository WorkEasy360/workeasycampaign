import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import {
  campaignAnalyticsQuery,
  campaignCommandRequest,
  campaignPreviewRequest,
  campaignTestSendRequest,
  executionSendingRateRequest,
  recipientListQuery,
  campaignHistoryQuery,
  campaignListQuery,
  campaignVersionedCommandRequest,
  cloneCampaignRequest,
  createCampaignRequest,
  rescheduleCampaignRequest,
  scheduleCampaignRequest,
  updateCampaignRequest,
} from '@workeasy/shared';
import type { FastifyReply } from 'fastify';
import { RateLimit, WorkspaceAccess } from '../../../common/access.js';
import { IdempotencyService } from '../../../common/idempotency.js';
import { TenantCtx, type TenantRequestContext } from '../../../common/request-context.js';
import { parse, routeId } from '../../../common/validation.js';
import { AnalyticsService } from '../application/analytics.service.js';
import { CampaignsService } from '../application/campaigns.service.js';
import { LifecycleService } from '../application/lifecycle.service.js';
import { PreflightService } from '../application/preflight.service.js';
import { PreviewService } from '../application/preview.service.js';
import { TestSendService } from '../application/test-send.service.js';
import { RecipientsService } from '../application/recipients.service.js';

const IDEMPOTENCY = 'idempotency-key';

/**
 * Campaign drafts, pre-flight and lifecycle commands (contract §15 rows 1–20; executions 21–23 arrive with 6.9). The workspace comes from the route and the authorized tenant context;
 * bodies are strict (an unknown field such as workspaceId or orgId is a 400, never applied).
 */
@Controller('v1/workspaces/:workspaceId/campaigns')
export class CampaignsController {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly idempotency: IdempotencyService,
    private readonly preflights: PreflightService,
    private readonly lifecycle: LifecycleService,
    private readonly previews: PreviewService,
    private readonly testSends: TestSendService,
    private readonly recipientsService: RecipientsService,
    private readonly analyticsService: AnalyticsService,
  ) {}

  @Get('capabilities')
  @WorkspaceAccess('campaigns.read')
  capabilities() {
    return this.campaigns.capabilities();
  }

  /** Analytics v1 (docs/architecture/analytics-tracking.md §4): measured pipeline metrics; engagement marked not tracked. */
  @Get('analytics')
  @WorkspaceAccess('reports.read')
  @RateLimit({ name: 'campaigns.analytics', by: 'user', limit: 300, windowSeconds: 3600 })
  analytics(@TenantCtx() ctx: TenantRequestContext, @Query() q: unknown) {
    return this.analyticsService.campaigns(ctx, parse(campaignAnalyticsQuery, q));
  }

  /** One campaign's results (Phase 7.10): delivery outcomes and engagement from rollups, all runs and the latest 10. */
  @Get(':campaignId/results')
  @WorkspaceAccess('reports.read')
  @RateLimit({ name: 'campaigns.analytics', by: 'user', limit: 300, windowSeconds: 3600 })
  results(@TenantCtx() ctx: TenantRequestContext, @Param('campaignId') id: string) {
    return this.analyticsService.campaign(ctx, routeId(id, 'Campaign'));
  }

  @Get('counts')
  @WorkspaceAccess('campaigns.read')
  counts(@TenantCtx() ctx: TenantRequestContext) {
    return this.campaigns.counts(ctx);
  }

  @Get()
  @WorkspaceAccess('campaigns.read')
  list(@TenantCtx() ctx: TenantRequestContext, @Query() q: unknown) {
    return this.campaigns.list(ctx, parse(campaignListQuery, q));
  }

  @Post()
  @WorkspaceAccess('campaigns.create')
  async create(@TenantCtx() ctx: TenantRequestContext, @Body() body: unknown, @Headers(IDEMPOTENCY) key: string | undefined, @Res({ passthrough: true }) reply: FastifyReply) {
    const input = parse(createCampaignRequest, body);
    const r = await this.idempotency.run(ctx.principal.userId, key, `POST /v1/workspaces/${ctx.access.workspaceId}/campaigns`, input, async () => ({
      status: 201,
      body: await this.campaigns.create(ctx, input),
    }));
    reply.status(r.status);
    return r.body;
  }

  @Get(':campaignId')
  @WorkspaceAccess('campaigns.read')
  get(@TenantCtx() ctx: TenantRequestContext, @Param('campaignId') id: string) {
    return this.campaigns.get(ctx, routeId(id, 'Campaign'));
  }

  @Patch(':campaignId')
  @WorkspaceAccess('campaigns.update')
  update(@TenantCtx() ctx: TenantRequestContext, @Param('campaignId') id: string, @Body() body: unknown) {
    return this.campaigns.update(ctx, routeId(id, 'Campaign'), parse(updateCampaignRequest, body));
  }

  @Delete(':campaignId')
  @HttpCode(200)
  @WorkspaceAccess('campaigns.delete')
  delete(@TenantCtx() ctx: TenantRequestContext, @Param('campaignId') id: string, @Body() body: unknown) {
    return this.campaigns.delete(ctx, routeId(id, 'Campaign'), parse(campaignVersionedCommandRequest, body).expectedVersion);
  }

  @Post(':campaignId/restore')
  @HttpCode(200)
  @WorkspaceAccess('campaigns.delete')
  restore(@TenantCtx() ctx: TenantRequestContext, @Param('campaignId') id: string, @Body() body: unknown) {
    parse(campaignCommandRequest, body);
    return this.campaigns.restore(ctx, routeId(id, 'Campaign'));
  }

  @Post(':campaignId/clone')
  @WorkspaceAccess('campaigns.create')
  async clone(
    @TenantCtx() ctx: TenantRequestContext,
    @Param('campaignId') id: string,
    @Body() body: unknown,
    @Headers(IDEMPOTENCY) key: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const campaignId = routeId(id, 'Campaign');
    const input = parse(cloneCampaignRequest, body);
    const r = await this.idempotency.run(ctx.principal.userId, key, `POST /v1/workspaces/${ctx.access.workspaceId}/campaigns/${campaignId}/clone`, input, async () => ({
      status: 201,
      body: await this.campaigns.clone(ctx, campaignId, input),
    }));
    reply.status(r.status);
    return r.body;
  }

  /** Phase 7.4: a few contacts of the live audience with their eligibility (names and reason codes; + contacts.read). */
  @Get(':campaignId/audience-sample')
  @WorkspaceAccess('campaigns.read')
  @RateLimit({ name: 'campaigns.audience_sample', by: 'user', limit: 300, windowSeconds: 3600 })
  audienceSample(@TenantCtx() ctx: TenantRequestContext, @Param('campaignId') id: string) {
    return this.preflights.audienceSample(ctx, routeId(id, 'Campaign'));
  }

  /**
   * Phase 7.3: send the current draft to the requesting user's own verified address (never an address from the request).
   * Needs campaigns.update (+ contacts.read with a contact); 20 per user per hour.
   */
  @Post(':campaignId/test-send')
  @HttpCode(200)
  @WorkspaceAccess('campaigns.update')
  @RateLimit({ name: 'campaigns.test_send', by: 'user', limit: 20, windowSeconds: 3600 })
  testSend(@TenantCtx() ctx: TenantRequestContext, @Param('campaignId') id: string, @Body() body: unknown) {
    return this.testSends.send(ctx, routeId(id, 'Campaign'), parse(campaignTestSendRequest, body ?? {}));
  }

  /** Content amendment §5: render the current draft (example profile, or one contact with contacts.read). Read-only. */
  @Post(':campaignId/preview')
  @HttpCode(200)
  @WorkspaceAccess('campaigns.read')
  @RateLimit({ name: 'campaigns.preview', by: 'user', limit: 600, windowSeconds: 3600 })
  preview(@TenantCtx() ctx: TenantRequestContext, @Param('campaignId') id: string, @Body() body: unknown) {
    return this.previews.preview(ctx, routeId(id, 'Campaign'), parse(campaignPreviewRequest, body ?? {}));
  }

  @Post(':campaignId/preflight')
  @HttpCode(200)
  @WorkspaceAccess('campaigns.read')
  @RateLimit({ name: 'campaigns.preflight', by: 'user', limit: 60, windowSeconds: 3600 })
  preflight(@TenantCtx() ctx: TenantRequestContext, @Param('campaignId') id: string, @Body() body: unknown) {
    parse(campaignCommandRequest, body ?? {});
    return this.preflights.preflight(ctx, routeId(id, 'Campaign'));
  }

  @Post(':campaignId/schedule')
  @HttpCode(200)
  @WorkspaceAccess('campaigns.send')
  schedule(@TenantCtx() ctx: TenantRequestContext, @Param('campaignId') id: string, @Body() body: unknown, @Headers(IDEMPOTENCY) key: string | undefined) {
    const input = parse(scheduleCampaignRequest, body);
    return this.command(ctx, id, 'schedule', key, input, (campaignId) => this.lifecycle.schedule(ctx, campaignId, input));
  }

  @Post(':campaignId/reschedule')
  @HttpCode(200)
  @WorkspaceAccess('campaigns.send')
  reschedule(@TenantCtx() ctx: TenantRequestContext, @Param('campaignId') id: string, @Body() body: unknown, @Headers(IDEMPOTENCY) key: string | undefined) {
    const input = parse(rescheduleCampaignRequest, body);
    return this.command(ctx, id, 'reschedule', key, input, (campaignId) => this.lifecycle.reschedule(ctx, campaignId, input));
  }

  @Post(':campaignId/unschedule')
  @HttpCode(200)
  @WorkspaceAccess('campaigns.send')
  unschedule(@TenantCtx() ctx: TenantRequestContext, @Param('campaignId') id: string, @Body() body: unknown, @Headers(IDEMPOTENCY) key: string | undefined) {
    const input = parse(campaignVersionedCommandRequest, body);
    return this.command(ctx, id, 'unschedule', key, input, (campaignId) => this.lifecycle.unschedule(ctx, campaignId, input));
  }

  @Post(':campaignId/pause')
  @HttpCode(200)
  @WorkspaceAccess('campaigns.send')
  pause(@TenantCtx() ctx: TenantRequestContext, @Param('campaignId') id: string, @Body() body: unknown, @Headers(IDEMPOTENCY) key: string | undefined) {
    const input = parse(campaignCommandRequest, body ?? {});
    return this.command(ctx, id, 'pause', key, input, (campaignId) => this.lifecycle.pause(ctx, campaignId));
  }

  @Post(':campaignId/resume')
  @HttpCode(200)
  @WorkspaceAccess('campaigns.send')
  resume(@TenantCtx() ctx: TenantRequestContext, @Param('campaignId') id: string, @Body() body: unknown, @Headers(IDEMPOTENCY) key: string | undefined) {
    const input = parse(campaignCommandRequest, body ?? {});
    return this.command(ctx, id, 'resume', key, input, (campaignId) => this.lifecycle.resume(ctx, campaignId));
  }

  @Post(':campaignId/cancel')
  @HttpCode(200)
  @WorkspaceAccess('campaigns.send')
  cancel(@TenantCtx() ctx: TenantRequestContext, @Param('campaignId') id: string, @Body() body: unknown, @Headers(IDEMPOTENCY) key: string | undefined) {
    const input = parse(campaignVersionedCommandRequest, body);
    return this.command(ctx, id, 'cancel', key, input, (campaignId) => this.lifecycle.cancel(ctx, campaignId, input));
  }

  @Post(':campaignId/return-to-draft')
  @HttpCode(200)
  @WorkspaceAccess('campaigns.update')
  returnToDraft(@TenantCtx() ctx: TenantRequestContext, @Param('campaignId') id: string, @Body() body: unknown) {
    parse(campaignCommandRequest, body ?? {});
    return this.lifecycle.returnToDraft(ctx, routeId(id, 'Campaign'));
  }

  @Post(':campaignId/versions/:versionId/restore')
  @HttpCode(200)
  @WorkspaceAccess('campaigns.update')
  restoreVersion(@TenantCtx() ctx: TenantRequestContext, @Param('campaignId') id: string, @Param('versionId') versionId: string, @Body() body: unknown) {
    return this.lifecycle.restoreVersion(ctx, routeId(id, 'Campaign'), routeId(versionId, 'Version'), parse(campaignVersionedCommandRequest, body));
  }

  @Get(':campaignId/executions')
  @WorkspaceAccess('campaigns.read')
  executions(@TenantCtx() ctx: TenantRequestContext, @Param('campaignId') id: string, @Query() q: unknown) {
    return this.campaigns.executions(ctx, routeId(id, 'Campaign'), parse(campaignHistoryQuery, q));
  }

  /** Phase 7.11: a run's sending speed (hand-offs per hour, or null for no campaign limit); next batch onwards. */
  @Put(':campaignId/executions/:executionId/sending-rate')
  @WorkspaceAccess('campaigns.send')
  @RateLimit({ name: 'campaigns.sending_rate', by: 'user', limit: 120, windowSeconds: 3600 })
  sendingRate(@TenantCtx() ctx: TenantRequestContext, @Param('campaignId') id: string, @Param('executionId') executionId: string, @Body() body: unknown) {
    return this.lifecycle.setSendingRate(ctx, routeId(id, 'Campaign'), routeId(executionId, 'Execution'), parse(executionSendingRateRequest, body).maxPerHour);
  }

  @Get(':campaignId/executions/:executionId')
  @WorkspaceAccess('campaigns.read')
  execution(@TenantCtx() ctx: TenantRequestContext, @Param('campaignId') id: string, @Param('executionId') executionId: string) {
    return this.campaigns.execution(ctx, routeId(id, 'Campaign'), routeId(executionId, 'Execution'));
  }

  /** Row 23: recipients of one execution, with contact display names from the Audience Profiles port (+ contacts.read). */
  @Get(':campaignId/executions/:executionId/recipients')
  @WorkspaceAccess('campaigns.read')
  @RateLimit({ name: 'campaigns.recipients', by: 'user', limit: 1200, windowSeconds: 3600 })
  recipients(@TenantCtx() ctx: TenantRequestContext, @Param('campaignId') id: string, @Param('executionId') executionId: string, @Query() q: unknown) {
    return this.recipientsService.list(ctx, routeId(id, 'Campaign'), routeId(executionId, 'Execution'), parse(recipientListQuery, q));
  }

  @Get(':campaignId/versions')
  @WorkspaceAccess('campaigns.read')
  versions(@TenantCtx() ctx: TenantRequestContext, @Param('campaignId') id: string, @Query() q: unknown) {
    return this.campaigns.versions(ctx, routeId(id, 'Campaign'), parse(campaignHistoryQuery, q));
  }

  @Get(':campaignId/versions/:versionId')
  @WorkspaceAccess('campaigns.read')
  version(@TenantCtx() ctx: TenantRequestContext, @Param('campaignId') id: string, @Param('versionId') versionId: string) {
    return this.campaigns.version(ctx, routeId(id, 'Campaign'), routeId(versionId, 'Version'));
  }

  /**
   * A lifecycle command with optional Idempotency-Key (database-backed, claim-first, per user, 24 h): a retry with the
   * same key and body replays the stored response instead of running the command again; the same key with another
   * body or command is a 409. The scope binds the key to the workspace, campaign and command.
   */
  private async command<T>(
    ctx: TenantRequestContext,
    id: string,
    command: string,
    key: string | undefined,
    input: unknown,
    work: (campaignId: string) => Promise<T>,
  ): Promise<T> {
    const campaignId = routeId(id, 'Campaign');
    const scope = `POST /v1/workspaces/${ctx.access.workspaceId}/campaigns/${campaignId}/${command}`;
    const r = await this.idempotency.run(ctx.principal.userId, key, scope, input, async () => ({ status: 200, body: await work(campaignId) }));
    return r.body;
  }
}
