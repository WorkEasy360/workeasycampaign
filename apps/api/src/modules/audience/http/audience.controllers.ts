import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import {
  addIdentityRequest,
  bulkActionRequest,
  changeSubscriptionRequest,
  contactListQuery,
  createContactRequest,
  createCustomFieldRequest,
  createListRequest,
  createSuppressionRequest,
  createTagRequest,
  createTopicRequest,
  eligibilityCheckRequest,
  importMappingRequest,
  liftSuppressionRequest,
  listQuery,
  membersRequest,
  paginationQuery,
  recordConsentRequest,
  reorderCustomFieldsRequest,
  retentionPolicyRequest,
  suppressionQuery,
  topicPreferenceRequest,
  updateContactRequest,
  updateCustomFieldRequest,
  updateListRequest,
  updateTagRequest,
  updateTopicRequest,
} from '@workeasy/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { RateLimit, WorkspaceAccess } from '../../../common/access.js';
import { Errors } from '../../../common/errors.js';
import { IdempotencyService } from '../../../common/idempotency.js';
import { TenantCtx, type TenantRequestContext } from '../../../common/request-context.js';
import { parse, routeId } from '../../../common/validation.js';
import { BulkService } from '../application/bulk.service.js';
import { ConsentService } from '../application/consent.service.js';
import { ContactsService } from '../application/contacts.service.js';
import { ImportsService } from '../application/imports.service.js';
import { ListsService, TagsService } from '../application/lists-tags.service.js';
import { EligibilityService, SuppressionService } from '../application/suppression-eligibility.service.js';
import { CustomFieldsService, TopicsService } from '../application/topics-fields.service.js';

const IDEMPOTENCY = 'idempotency-key';
const filterOnly = contactListQuery.omit({ limit: true, cursor: true, sort: true, order: true });
const issuesQuery = paginationQuery.extend({ phase: z.enum(['dry_run', 'run']).default('dry_run') });

@Controller('v1/workspaces/:workspaceId/contacts')
export class ContactsController {
  constructor(
    private readonly contacts: ContactsService,
    private readonly consent: ConsentService,
    private readonly bulk: BulkService,
    private readonly tags: TagsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @WorkspaceAccess('contacts.read')
  list(@TenantCtx() ctx: TenantRequestContext, @Query() q: unknown) {
    return this.contacts.list(ctx, parse(contactListQuery, q));
  }

  @Get('count')
  @WorkspaceAccess('contacts.read')
  count(@TenantCtx() ctx: TenantRequestContext, @Query() q: unknown) {
    return this.contacts.count(ctx, parse(filterOnly, q));
  }

  @Post()
  @WorkspaceAccess('contacts.create')
  async create(@TenantCtx() ctx: TenantRequestContext, @Body() body: unknown, @Headers(IDEMPOTENCY) key: string | undefined, @Res({ passthrough: true }) reply: FastifyReply) {
    const input = parse(createContactRequest, body);
    const r = await this.idempotency.run(ctx.principal.userId, key, `POST /v1/workspaces/${ctx.access.workspaceId}/contacts`, input, async () => ({
      status: 201,
      body: await this.contacts.create(ctx, input),
    }));
    reply.status(r.status);
    return r.body;
  }

  @Post('bulk')
  @HttpCode(200)
  @WorkspaceAccess('contacts.read')
  @RateLimit({ name: 'contacts.bulk', by: 'user', limit: 60, windowSeconds: 3600 })
  async bulkAction(@TenantCtx() ctx: TenantRequestContext, @Body() body: unknown, @Headers(IDEMPOTENCY) key: string | undefined) {
    const input = parse(bulkActionRequest, body);
    return (
      await this.idempotency.run(ctx.principal.userId, key, `POST /v1/workspaces/${ctx.access.workspaceId}/contacts/bulk`, input, async () => ({
        status: 200,
        body: await this.bulk.run(ctx, input),
      }))
    ).body;
  }

  @Get(':contactId')
  @WorkspaceAccess('contacts.read')
  get(@TenantCtx() ctx: TenantRequestContext, @Param('contactId') id: string) {
    return this.contacts.get(ctx, routeId(id, 'Contact'));
  }

  @Patch(':contactId')
  @WorkspaceAccess('contacts.update')
  update(@TenantCtx() ctx: TenantRequestContext, @Param('contactId') id: string, @Body() body: unknown) {
    return this.contacts.update(ctx, routeId(id, 'Contact'), parse(updateContactRequest, body));
  }

  @Delete(':contactId')
  @HttpCode(204)
  @WorkspaceAccess('contacts.delete')
  async remove(@TenantCtx() ctx: TenantRequestContext, @Param('contactId') id: string) {
    await this.contacts.softDelete(ctx, routeId(id, 'Contact'));
  }

  @Post(':contactId/restore')
  @HttpCode(200)
  @WorkspaceAccess('contacts.delete')
  restore(@TenantCtx() ctx: TenantRequestContext, @Param('contactId') id: string) {
    return this.contacts.restore(ctx, routeId(id, 'Contact'));
  }

  @Post(':contactId/erase')
  @HttpCode(204)
  @WorkspaceAccess('contacts.delete')
  async erase(@TenantCtx() ctx: TenantRequestContext, @Param('contactId') id: string, @Body() body: unknown) {
    parse(z.object({ confirm: z.literal('ERASE', { error: 'Type ERASE to confirm' }) }), body);
    await this.contacts.erase(ctx, routeId(id, 'Contact'));
  }

  @Put(':contactId/subscription')
  @WorkspaceAccess('contacts.update')
  subscription(@TenantCtx() ctx: TenantRequestContext, @Param('contactId') id: string, @Body() body: unknown) {
    const input = parse(changeSubscriptionRequest, body);
    return this.contacts.changeSubscription(ctx, routeId(id, 'Contact'), input.subscriptionType, input.version);
  }

  @Post(':contactId/identities')
  @WorkspaceAccess('contacts.update')
  addIdentity(@TenantCtx() ctx: TenantRequestContext, @Param('contactId') id: string, @Body() body: unknown) {
    return this.contacts.addIdentity(ctx, routeId(id, 'Contact'), parse(addIdentityRequest, body));
  }

  @Delete(':contactId/identities/:identityId')
  @WorkspaceAccess('contacts.update')
  removeIdentity(@TenantCtx() ctx: TenantRequestContext, @Param('contactId') id: string, @Param('identityId') identityId: string) {
    return this.contacts.removeIdentity(ctx, routeId(id, 'Contact'), routeId(identityId, 'Identity'));
  }

  @Post(':contactId/identities/:identityId/primary')
  @HttpCode(200)
  @WorkspaceAccess('contacts.update')
  makePrimary(@TenantCtx() ctx: TenantRequestContext, @Param('contactId') id: string, @Param('identityId') identityId: string) {
    return this.contacts.makePrimary(ctx, routeId(id, 'Contact'), routeId(identityId, 'Identity'));
  }

  @Get(':contactId/timeline')
  @WorkspaceAccess('contacts.read')
  timeline(@TenantCtx() ctx: TenantRequestContext, @Param('contactId') id: string, @Query() q: unknown) {
    const { limit, cursor } = parse(paginationQuery, q);
    return this.contacts.timeline(ctx, routeId(id, 'Contact'), limit, cursor);
  }

  @Get(':contactId/consent')
  @WorkspaceAccess('consent.read')
  consentHistory(@TenantCtx() ctx: TenantRequestContext, @Param('contactId') id: string, @Query() q: unknown) {
    const { limit, cursor } = parse(paginationQuery, q);
    return this.consent.history(ctx, routeId(id, 'Contact'), limit, cursor);
  }

  @Post(':contactId/consent')
  @WorkspaceAccess('consent.manage')
  recordConsent(@TenantCtx() ctx: TenantRequestContext, @Param('contactId') id: string, @Body() body: unknown) {
    return this.consent.record(ctx, routeId(id, 'Contact'), parse(recordConsentRequest, body));
  }

  @Put(':contactId/topics/:topicId')
  @WorkspaceAccess('consent.manage')
  setTopic(@TenantCtx() ctx: TenantRequestContext, @Param('contactId') id: string, @Param('topicId') topicId: string, @Body() body: unknown) {
    const input = parse(topicPreferenceRequest, body);
    return this.consent.setTopic(ctx, routeId(id, 'Contact'), routeId(topicId, 'Topic'), input.status, input.evidenceNote);
  }

  @Put(':contactId/tags/:tagId')
  @HttpCode(204)
  @WorkspaceAccess('tags.manage')
  async tag(@TenantCtx() ctx: TenantRequestContext, @Param('contactId') id: string, @Param('tagId') tagId: string) {
    await this.tags.tag(ctx, routeId(tagId, 'Tag'), [routeId(id, 'Contact')]);
  }

  @Delete(':contactId/tags/:tagId')
  @HttpCode(204)
  @WorkspaceAccess('tags.manage')
  async untag(@TenantCtx() ctx: TenantRequestContext, @Param('contactId') id: string, @Param('tagId') tagId: string) {
    await this.tags.untag(ctx, routeId(tagId, 'Tag'), [routeId(id, 'Contact')]);
  }
}

@Controller('v1/workspaces/:workspaceId/lists')
export class ListsController {
  constructor(private readonly lists: ListsService) {}

  @Get()
  @WorkspaceAccess('lists.read')
  list(@TenantCtx() ctx: TenantRequestContext, @Query() q: unknown) {
    return this.lists.list(ctx, parse(listQuery, q));
  }

  @Post()
  @WorkspaceAccess('lists.manage')
  create(@TenantCtx() ctx: TenantRequestContext, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    reply.status(201);
    return this.lists.create(ctx, parse(createListRequest, body));
  }

  @Get(':listId')
  @WorkspaceAccess('lists.read')
  get(@TenantCtx() ctx: TenantRequestContext, @Param('listId') id: string) {
    return this.lists.get(ctx, routeId(id, 'List'));
  }

  @Patch(':listId')
  @WorkspaceAccess('lists.manage')
  update(@TenantCtx() ctx: TenantRequestContext, @Param('listId') id: string, @Body() body: unknown) {
    return this.lists.update(ctx, routeId(id, 'List'), parse(updateListRequest, body));
  }

  @Post(':listId/archive')
  @HttpCode(200)
  @WorkspaceAccess('lists.manage')
  archive(@TenantCtx() ctx: TenantRequestContext, @Param('listId') id: string) {
    return this.lists.setArchived(ctx, routeId(id, 'List'), true);
  }

  @Post(':listId/restore')
  @HttpCode(200)
  @WorkspaceAccess('lists.manage')
  restore(@TenantCtx() ctx: TenantRequestContext, @Param('listId') id: string) {
    return this.lists.setArchived(ctx, routeId(id, 'List'), false);
  }

  @Delete(':listId')
  @HttpCode(204)
  @WorkspaceAccess('lists.manage')
  async remove(@TenantCtx() ctx: TenantRequestContext, @Param('listId') id: string) {
    await this.lists.delete(ctx, routeId(id, 'List'));
  }

  @Post(':listId/members')
  @HttpCode(200)
  @WorkspaceAccess('lists.manage')
  addMembers(@TenantCtx() ctx: TenantRequestContext, @Param('listId') id: string, @Body() body: unknown) {
    return this.lists.addMembers(ctx, routeId(id, 'List'), parse(membersRequest, body).contactIds);
  }

  @Delete(':listId/members')
  @HttpCode(200)
  @WorkspaceAccess('lists.manage')
  removeMembers(@TenantCtx() ctx: TenantRequestContext, @Param('listId') id: string, @Body() body: unknown) {
    return this.lists.removeMembers(ctx, routeId(id, 'List'), parse(membersRequest, body).contactIds);
  }
}

@Controller('v1/workspaces/:workspaceId/tags')
export class TagsController {
  constructor(private readonly tags: TagsService) {}

  @Get()
  @WorkspaceAccess('tags.read')
  async list(@TenantCtx() ctx: TenantRequestContext) {
    return { data: await this.tags.list(ctx) };
  }

  @Post()
  @WorkspaceAccess('tags.manage')
  create(@TenantCtx() ctx: TenantRequestContext, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    reply.status(201);
    return this.tags.create(ctx, parse(createTagRequest, body));
  }

  @Patch(':tagId')
  @WorkspaceAccess('tags.manage')
  update(@TenantCtx() ctx: TenantRequestContext, @Param('tagId') id: string, @Body() body: unknown) {
    return this.tags.update(ctx, routeId(id, 'Tag'), parse(updateTagRequest, body));
  }

  @Delete(':tagId')
  @HttpCode(204)
  @WorkspaceAccess('tags.manage')
  async remove(@TenantCtx() ctx: TenantRequestContext, @Param('tagId') id: string) {
    await this.tags.delete(ctx, routeId(id, 'Tag'));
  }
}

@Controller('v1/workspaces/:workspaceId/topics')
export class TopicsController {
  constructor(private readonly topics: TopicsService) {}

  @Get()
  @WorkspaceAccess('topics.read')
  async list(@TenantCtx() ctx: TenantRequestContext) {
    return { data: await this.topics.list(ctx) };
  }

  @Post()
  @WorkspaceAccess('topics.manage')
  create(@TenantCtx() ctx: TenantRequestContext, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    reply.status(201);
    return this.topics.create(ctx, parse(createTopicRequest, body));
  }

  @Patch(':topicId')
  @WorkspaceAccess('topics.manage')
  update(@TenantCtx() ctx: TenantRequestContext, @Param('topicId') id: string, @Body() body: unknown) {
    return this.topics.update(ctx, routeId(id, 'Topic'), parse(updateTopicRequest, body));
  }

  @Post(':topicId/archive')
  @HttpCode(200)
  @WorkspaceAccess('topics.manage')
  archive(@TenantCtx() ctx: TenantRequestContext, @Param('topicId') id: string) {
    return this.topics.setArchived(ctx, routeId(id, 'Topic'), true);
  }

  @Post(':topicId/restore')
  @HttpCode(200)
  @WorkspaceAccess('topics.manage')
  restore(@TenantCtx() ctx: TenantRequestContext, @Param('topicId') id: string) {
    return this.topics.setArchived(ctx, routeId(id, 'Topic'), false);
  }

  @Post(':topicId/default')
  @HttpCode(200)
  @WorkspaceAccess('topics.manage')
  makeDefault(@TenantCtx() ctx: TenantRequestContext, @Param('topicId') id: string) {
    return this.topics.makeDefault(ctx, routeId(id, 'Topic'));
  }
}

@Controller('v1/workspaces/:workspaceId/custom-fields')
export class CustomFieldsController {
  constructor(private readonly fields: CustomFieldsService) {}

  @Get()
  @WorkspaceAccess('contacts.read')
  async list(@TenantCtx() ctx: TenantRequestContext) {
    return { data: await this.fields.list(ctx) };
  }

  @Post()
  @WorkspaceAccess('custom_fields.manage')
  create(@TenantCtx() ctx: TenantRequestContext, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    reply.status(201);
    return this.fields.create(ctx, parse(createCustomFieldRequest, body));
  }

  @Put('order')
  @WorkspaceAccess('custom_fields.manage')
  async reorder(@TenantCtx() ctx: TenantRequestContext, @Body() body: unknown) {
    return { data: await this.fields.reorder(ctx, parse(reorderCustomFieldsRequest, body).fieldIds) };
  }

  @Patch(':fieldId')
  @WorkspaceAccess('custom_fields.manage')
  update(@TenantCtx() ctx: TenantRequestContext, @Param('fieldId') id: string, @Body() body: unknown) {
    return this.fields.update(ctx, routeId(id, 'Custom field'), parse(updateCustomFieldRequest, body));
  }

  @Post(':fieldId/archive')
  @HttpCode(200)
  @WorkspaceAccess('custom_fields.manage')
  archive(@TenantCtx() ctx: TenantRequestContext, @Param('fieldId') id: string) {
    return this.fields.setArchived(ctx, routeId(id, 'Custom field'), true);
  }

  @Post(':fieldId/restore')
  @HttpCode(200)
  @WorkspaceAccess('custom_fields.manage')
  restore(@TenantCtx() ctx: TenantRequestContext, @Param('fieldId') id: string) {
    return this.fields.setArchived(ctx, routeId(id, 'Custom field'), false);
  }

  @Delete(':fieldId')
  @HttpCode(204)
  @WorkspaceAccess('custom_fields.manage')
  async remove(@TenantCtx() ctx: TenantRequestContext, @Param('fieldId') id: string) {
    await this.fields.delete(ctx, routeId(id, 'Custom field'));
  }
}

@Controller('v1/workspaces/:workspaceId')
export class ComplianceController {
  constructor(
    private readonly suppression: SuppressionService,
    private readonly consent: ConsentService,
    private readonly eligibility: EligibilityService,
  ) {}

  @Get('suppressions')
  @WorkspaceAccess('suppression.read')
  list(@TenantCtx() ctx: TenantRequestContext, @Query() q: unknown) {
    return this.suppression.list(ctx, parse(suppressionQuery, q));
  }

  @Post('suppressions')
  @WorkspaceAccess('suppression.manage')
  create(@TenantCtx() ctx: TenantRequestContext, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    reply.status(201);
    return this.suppression.create(ctx, parse(createSuppressionRequest, body));
  }

  @Post('suppressions/:suppressionId/lift')
  @HttpCode(200)
  @WorkspaceAccess('suppression.manage')
  lift(@TenantCtx() ctx: TenantRequestContext, @Param('suppressionId') id: string, @Body() body: unknown) {
    return this.suppression.lift(ctx, routeId(id, 'Suppression'), parse(liftSuppressionRequest, body).reason);
  }

  @Get('consent/retention-policy')
  @WorkspaceAccess('consent.read')
  policy(@TenantCtx() ctx: TenantRequestContext) {
    return this.consent.getPolicy(ctx);
  }

  @Put('consent/retention-policy')
  @WorkspaceAccess('consent.manage')
  setPolicy(@TenantCtx() ctx: TenantRequestContext, @Body() body: unknown) {
    return this.consent.setPolicy(ctx, parse(retentionPolicyRequest, body));
  }

  @Post('consent/retention-purge')
  @HttpCode(200)
  @WorkspaceAccess('consent.manage')
  @RateLimit({ name: 'consent.purge', by: 'user', limit: 10, windowSeconds: 3600 })
  purge(@TenantCtx() ctx: TenantRequestContext) {
    return this.consent.purge(ctx);
  }

  @Post('eligibility/check')
  @HttpCode(200)
  @WorkspaceAccess('contacts.read')
  check(@TenantCtx() ctx: TenantRequestContext, @Body() body: unknown) {
    return this.eligibility.check(ctx, parse(eligibilityCheckRequest, body));
  }
}

@Controller('v1/workspaces/:workspaceId/imports')
export class ImportsController {
  constructor(
    private readonly imports: ImportsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @WorkspaceAccess('contacts.import')
  list(@TenantCtx() ctx: TenantRequestContext, @Query() q: unknown) {
    const { limit, cursor } = parse(paginationQuery, q);
    return this.imports.list(ctx, limit, cursor);
  }

  /** Raw CSV body (Content-Type: text/csv). Streamed to storage; never buffered whole. */
  @Post()
  @WorkspaceAccess('contacts.import')
  @RateLimit({ name: 'imports.upload', by: 'user', limit: 30, windowSeconds: 3600 })
  async upload(@TenantCtx() ctx: TenantRequestContext, @Req() req: FastifyRequest, @Query() q: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const { fileName } = parse(z.object({ fileName: z.string().max(255).optional() }), q);
    const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim();
    if (type !== 'text/csv') throw Errors.validation({ file: ['Upload a CSV file (Content-Type: text/csv)'] });
    reply.status(201);
    return this.imports.upload(ctx, fileName, req.body as Readable);
  }

  @Get(':importId')
  @WorkspaceAccess('contacts.import')
  get(@TenantCtx() ctx: TenantRequestContext, @Param('importId') id: string) {
    return this.imports.get(ctx, routeId(id, 'Import'));
  }

  @Get(':importId/preview')
  @WorkspaceAccess('contacts.import')
  preview(@TenantCtx() ctx: TenantRequestContext, @Param('importId') id: string) {
    return this.imports.preview(ctx, routeId(id, 'Import'));
  }

  @Put(':importId/mapping')
  @WorkspaceAccess('contacts.import')
  mapping(@TenantCtx() ctx: TenantRequestContext, @Param('importId') id: string, @Body() body: unknown) {
    return this.imports.setMapping(ctx, routeId(id, 'Import'), parse(importMappingRequest, body));
  }

  @Post(':importId/dry-run')
  @HttpCode(200)
  @WorkspaceAccess('contacts.import')
  @RateLimit({ name: 'imports.dry_run', by: 'user', limit: 60, windowSeconds: 3600 })
  dryRun(@TenantCtx() ctx: TenantRequestContext, @Param('importId') id: string) {
    return this.imports.dryRun(ctx, routeId(id, 'Import'));
  }

  @Post(':importId/start')
  @HttpCode(202)
  @WorkspaceAccess('contacts.import')
  async start(@TenantCtx() ctx: TenantRequestContext, @Param('importId') id: string, @Headers(IDEMPOTENCY) key: string | undefined) {
    const importId = routeId(id, 'Import');
    return (
      await this.idempotency.run(ctx.principal.userId, key, `POST imports/${importId}/start`, {}, async () => ({ status: 202, body: await this.imports.start(ctx, importId) }))
    ).body;
  }

  @Post(':importId/retry')
  @HttpCode(202)
  @WorkspaceAccess('contacts.import')
  retry(@TenantCtx() ctx: TenantRequestContext, @Param('importId') id: string) {
    return this.imports.retry(ctx, routeId(id, 'Import'));
  }

  @Post(':importId/cancel')
  @HttpCode(200)
  @WorkspaceAccess('contacts.import')
  cancel(@TenantCtx() ctx: TenantRequestContext, @Param('importId') id: string) {
    return this.imports.cancel(ctx, routeId(id, 'Import'));
  }

  @Get(':importId/issues')
  @WorkspaceAccess('contacts.import')
  issues(@TenantCtx() ctx: TenantRequestContext, @Param('importId') id: string, @Query() q: unknown) {
    const { phase, limit, cursor } = parse(issuesQuery, q);
    return this.imports.issues(ctx, routeId(id, 'Import'), phase, limit, cursor);
  }

  @Get(':importId/issues.csv')
  @WorkspaceAccess('contacts.import')
  async issuesCsv(@TenantCtx() ctx: TenantRequestContext, @Param('importId') id: string, @Query() q: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const { phase } = parse(issuesQuery, q);
    const csv = await this.imports.issuesCsv(ctx, routeId(id, 'Import'), phase);
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="import-issues-${phase}.csv"`);
    return csv;
  }
}
