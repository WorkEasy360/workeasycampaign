import type { Channel } from '@workeasy/shared';
import type { AuditEntry } from '../../audit/audit.js';
import { Inject, Injectable } from '@nestjs/common';
import { type Database, isForeignKeyViolation, type Tx } from '@workeasy/db';
import {
  CAMPAIGN_STATUSES,
  type CampaignCapabilities,
  type CampaignCountsByStatus,
  type CampaignListItem,
  type CampaignListQuery,
  type CampaignView,
  CHANNELS,
  type CloneCampaignRequest,
  type CreateCampaignRequest,
  type CampaignHistoryQuery,
  type ExecutionSummary,
  type Page,
  type Permission,
  type UpdateCampaignRequest,
  type VersionDetail,
  type VersionSummary,
} from '@workeasy/shared';
import { v7 as uuidv7 } from 'uuid';
import { Errors } from '../../../common/errors.js';
import { cursorScope, decodeCursor, pageOf } from '../../../common/pagination.js';
import type { TenantRequestContext } from '../../../common/request-context.js';
import type { AppConfig } from '../../../config/env.js';
import { APP_CONFIG, DATABASE } from '../../../infrastructure/providers.js';
import { inTenant, type TenantUnitOfWork } from '../../tenancy/application/tenant-tx.js';
import { channelSpec, isChannelAvailable } from '../domain/channels.js';
import { isDeliveryAvailable } from '../domain/delivery-mode.js';
import { type CampaignDraft, draftChangePermissions } from '../domain/draft.js';
import { decideCommand } from '../domain/lifecycle.js';
import { readStoredSnapshot, readVersionSnapshot } from '../domain/version.js';
import { campaignNotFound, channelNotAvailable, rejectionError } from './campaign-errors.js';
import {
  actorsById,
  CAMPAIGN_INCLUDE,
  type CampaignRow,
  campaignListItem,
  campaignView,
  draftOf,
  executionSummary,
  lifecycleState,
  type ViewerContext,
} from './campaign-views.js';

const SEARCH_CAP = 5_000;

/** Draft fields a PATCH can change, in the order the event lists them (contract §16: field NAMES only). */
const DRAFT_FIELDS = ['name', 'description', 'topicId', 'audience', 'sender', 'messages', 'schedule'] as const;
const EVENT_FIELD: Record<(typeof DRAFT_FIELDS)[number], string> = {
  name: 'name',
  description: 'description',
  topicId: 'topic',
  audience: 'audience',
  sender: 'sender',
  messages: 'messages',
  schedule: 'schedule',
};

/**
 * Campaign drafts (milestone 6.6; contract §15 rows 1–9, 18–19). Every command: authorizes (route + composite
 * permissions), locks the campaign row, lets the domain decide (expectedVersion first, then the lifecycle matrix), and
 * writes the change, its domain event and its audit record in ONE transaction (contract §2.2). Tenancy comes only from
 * the authorized request context; RLS makes every other workspace invisible.
 */
@Injectable()
export class CampaignsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  get deliveryAvailable() {
    return isDeliveryAvailable(this.config.campaignDeliveryMode);
  }

  /** The channel is implemented and its provider is configured in this deployment (email: always draftable). */
  channelAvailable(channel: Channel): boolean {
    return isChannelAvailable(channel, { mode: this.config.campaignDeliveryMode, smsConfigured: !!this.config.smsProvider, whatsappConfigured: !!this.config.whatsappProvider });
  }

  /** Real recipients would receive sends: sender problems are blocking (readiness `liveDelivery`). */
  get liveDelivery() {
    return this.config.campaignDeliveryMode === 'live';
  }

  viewer(ctx: TenantRequestContext): ViewerContext {
    return { permissions: ctx.access.permissions, deliveryAvailable: this.deliveryAvailable, liveDelivery: this.liveDelivery, channelAvailable: (c: Channel) => this.channelAvailable(c), now: new Date() };
  }

  /** Row 1. Reports the server's capability; enforcement never depends on it. */
  capabilities(): CampaignCapabilities {
    return {
      deliveryMode: this.config.campaignDeliveryMode,
      channels: CHANNELS.map((channel) => {
        const enabled = this.channelAvailable(channel);
        return { channel, enabled, sendingAvailable: enabled && this.deliveryAvailable };
      }),
    };
  }

  /** Row 2. Keyset over (updated_at DESC, id DESC); a name query is resolved by the workspace-bound search function. */
  async list(ctx: TenantRequestContext, q: CampaignListQuery): Promise<Page<CampaignListItem>> {
    const scope = cursorScope(ctx.access, 'campaigns', { ...q });
    const cursor = decodeCursor(q.cursor, scope);
    return inTenant(this.db, ctx, async ({ tx }) => {
      const ids = q.q
        ? (await tx.$queryRaw<{ campaign_id: string }[]>`SELECT campaign_id FROM app.search_campaign_ids(${q.q}, ${SEARCH_CAP})`).map((r) => r.campaign_id)
        : null;
      const rows = (await tx.campaign.findMany({
        where: {
          workspaceId: ctx.access.workspaceId!,
          deletedAt: q.deleted === 'only' ? { not: null } : null,
          ...(q.status ? { status: { in: q.status } } : {}),
          ...(q.channel ? { channel: q.channel } : {}),
          ...(q.topicId ? { topicId: q.topicId } : {}),
          ...(ids ? { id: { in: ids } } : {}),
          ...(cursor ? { OR: [{ updatedAt: { lt: new Date(cursor.t) } }, { updatedAt: new Date(cursor.t), id: { lt: cursor.id } }] } : {}),
        },
        include: CAMPAIGN_INCLUDE,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
      })) as CampaignRow[];
      const viewer = this.viewer(ctx);
      const page = pageOf(rows, q.limit, (r) => ({ t: r.updatedAt.toISOString(), id: r.id }), scope);
      return { data: page.data.map((r) => campaignListItem(r, viewer)), nextCursor: page.nextCursor };
    });
  }

  /** Row 3. One grouped query; every status present. Deleted campaigns are not counted. */
  async counts(ctx: TenantRequestContext): Promise<CampaignCountsByStatus> {
    return inTenant(this.db, ctx, async ({ tx }) => {
      const groups = await tx.campaign.groupBy({ by: ['status'], where: { workspaceId: ctx.access.workspaceId!, deletedAt: null }, _count: { _all: true } });
      const counts = Object.fromEntries(CAMPAIGN_STATUSES.map((s) => [s, 0])) as CampaignCountsByStatus;
      for (const g of groups) counts[g.status as keyof CampaignCountsByStatus] = g._count._all;
      return counts;
    });
  }

  /** Row 4 (Idempotency-Key handled by the controller). */
  async create(ctx: TenantRequestContext, input: CreateCampaignRequest): Promise<CampaignView> {
    if (!this.channelAvailable(input.channel)) throw channelNotAvailable();
    if (input.topicId) await this.requirePermissions(ctx, new Set(['topics.read']), 'create');
    return this.write(ctx, async (uow) => {
      const id = uuidv7();
      // Phase 7.5: a new draft's schedule time zone is the workspace's (tenancy setting), not a fixed UTC.
      const ws = await uow.tx.workspace.findUnique({ where: { id: ctx.access.workspaceId! }, select: { timezone: true } });
      await uow.tx.campaign.create({
        data: {
          id,
          orgId: ctx.access.orgId,
          workspaceId: ctx.access.workspaceId!,
          name: input.name,
          description: input.description ?? '',
          channel: input.channel,
          topicId: input.topicId ?? null,
          schedule: { mode: 'now', sendAt: null, timezone: ws?.timezone || 'UTC' },
          createdByUserId: ctx.principal.userId,
        },
      });
      await uow.event('campaign.created', id, { channel: input.channel, clonedFrom: null });
      await uow.audit({ action: 'campaign.created', targetType: 'campaign', targetId: id, metadata: { channel: input.channel } });
      return this.viewById(uow.tx, ctx, id);
    });
  }

  /** Row 5. */
  async get(ctx: TenantRequestContext, campaignId: string): Promise<CampaignView> {
    return inTenant(this.db, ctx, ({ tx }) => this.viewById(tx, ctx, campaignId));
  }

  /**
   * Row 6. Each present field replaces the stored one. The domain checks expectedVersion BEFORE any outcome, so a stale
   * request is version_conflict even when nothing would change. A request that changes nothing (after the version
   * check) writes and emits nothing.
   */
  async update(ctx: TenantRequestContext, campaignId: string, input: UpdateCampaignRequest, opts: { audit?: AuditEntry } = {}): Promise<CampaignView> {
    return this.write(ctx, async (uow) => {
      const row = await this.lock(uow.tx, campaignId);
      const decision = decideCommand(lifecycleState(row), 'update', { actor: this.actor(ctx), expectedVersion: input.expectedVersion });
      if (decision.outcome === 'rejected') throw rejectionError(decision.code, decision.message);

      const before = draftOf(row);
      const after: CampaignDraft & { description: string } = {
        ...before,
        description: row.description,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.topicId !== undefined ? { topicId: input.topicId } : {}),
        ...(input.audience ? { audience: input.audience } : {}),
        ...(input.sender ? { sender: input.sender } : {}),
        ...(input.messages ? { messages: input.messages } : {}),
        ...(input.schedule ? { schedule: input.schedule } : {}),
      };
      // Composite rule (contract §8): adding a list/tag or choosing a topic needs that resource's read permission.
      await this.requirePermissions(ctx, draftChangePermissions(before, after), 'update');

      const current = { ...before, description: row.description };
      const changes = DRAFT_FIELDS.filter((f) => input[f] !== undefined && JSON.stringify(after[f]) !== JSON.stringify(current[f]));
      if (!changes.length) return this.viewById(uow.tx, ctx, campaignId);

      const updated = await uow.tx.campaign.updateMany({
        where: { id: campaignId, version: row.version },
        data: {
          name: after.name,
          description: after.description,
          topicId: after.topicId,
          audience: after.audience,
          sender: after.sender,
          messages: after.messages as object[],
          schedule: after.schedule,
          updatedAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw Errors.versionConflict();
      await uow.event('campaign.updated', campaignId, { changes: changes.map((f) => EVENT_FIELD[f]) });
      // A caller-supplied audit entry (e.g. apply-template) commits atomically with the change, and only for a real change.
      if (opts.audit) await uow.audit(opts.audit);
      return this.viewById(uow.tx, ctx, campaignId);
    });
  }

  /** Row 7. Soft delete (no purge in Phase 6, contract §14). */
  async delete(ctx: TenantRequestContext, campaignId: string, expectedVersion: number): Promise<CampaignView> {
    return this.write(ctx, async (uow) => {
      const row = await this.lock(uow.tx, campaignId);
      const decision = decideCommand(lifecycleState(row), 'delete', { actor: this.actor(ctx), expectedVersion });
      if (decision.outcome === 'rejected') throw rejectionError(decision.code, decision.message);
      if (decision.outcome === 'noop') return this.viewById(uow.tx, ctx, campaignId);
      await uow.tx.campaign.update({ where: { id: campaignId }, data: { deletedAt: new Date(), updatedAt: new Date(), version: { increment: 1 } } });
      await uow.event('campaign.deleted', campaignId, {});
      await uow.audit({ action: 'campaign.deleted', targetType: 'campaign', targetId: campaignId });
      return this.viewById(uow.tx, ctx, campaignId);
    });
  }

  /** Row 8. */
  async restore(ctx: TenantRequestContext, campaignId: string): Promise<CampaignView> {
    return this.write(ctx, async (uow) => {
      const row = await this.lock(uow.tx, campaignId);
      const decision = decideCommand(lifecycleState(row), 'restore', { actor: this.actor(ctx) });
      if (decision.outcome === 'rejected') throw rejectionError(decision.code, decision.message);
      if (decision.outcome === 'noop') return this.viewById(uow.tx, ctx, campaignId);
      await uow.tx.campaign.update({ where: { id: campaignId }, data: { deletedAt: null, updatedAt: new Date(), version: { increment: 1 } } });
      await uow.event('campaign.restored', campaignId, {});
      await uow.audit({ action: 'campaign.restored', targetType: 'campaign', targetId: campaignId });
      return this.viewById(uow.tx, ctx, campaignId);
    });
  }

  /**
   * Row 9. A NEW campaign (new id, status draft) whose draft copies the source draft or a chosen version's snapshot.
   * The source is only read; executions and recipients are never copied (contract §4.2). Emits `campaign.created`
   * with `clonedFrom` — there is no `campaign.cloned` event.
   */
  async clone(ctx: TenantRequestContext, campaignId: string, input: CloneCampaignRequest): Promise<CampaignView> {
    await this.requirePermissions(ctx, new Set(['campaigns.read']), 'clone');
    return this.write(ctx, async (uow) => {
      const source = await uow.tx.campaign.findUnique({ where: { id: campaignId } });
      if (!source) throw campaignNotFound();
      const decision = decideCommand(lifecycleState(source), 'clone', { actor: this.actor(ctx) });
      if (decision.outcome === 'rejected') throw rejectionError(decision.code, decision.message);
      let draft = draftOf(source);
      if (input.versionId) {
        const version = await uow.tx.campaignVersion.findFirst({ where: { id: input.versionId, campaignId } });
        if (!version) throw Errors.notFound('Version');
        const s = readVersionSnapshot(version.snapshot);
        draft = {
          ...draft,
          topicId: s.topic.topicIds[0],
          audience: { include: [...s.audience.include], exclude: [...s.audience.exclude] },
          sender: { ...s.sender },
          messages: [{ variantKey: 'default', content: structuredClone(s.messages[0].content) }],
          schedule: { ...s.schedule },
        };
      }
      if (!this.channelAvailable(draft.channel)) throw channelNotAvailable();
      const id = uuidv7();
      await uow.tx.campaign.create({
        data: {
          id,
          orgId: ctx.access.orgId,
          workspaceId: ctx.access.workspaceId!,
          name: input.name ?? copyName(source.name),
          description: source.description,
          channel: draft.channel,
          topicId: draft.topicId,
          audience: draft.audience,
          sender: draft.sender,
          messages: draft.messages as object[],
          schedule: draft.schedule,
          clonedFromId: source.id,
          createdByUserId: ctx.principal.userId,
        },
      });
      const clonedFrom = { campaignId: source.id, versionId: input.versionId ?? null };
      await uow.event('campaign.created', id, { channel: draft.channel, clonedFrom });
      await uow.audit({ action: 'campaign.created', targetType: 'campaign', targetId: id, metadata: { clonedFrom } });
      return this.viewById(uow.tx, ctx, id);
    });
  }

  /** Row 18. Newest first. */
  async versions(ctx: TenantRequestContext, campaignId: string, q: CampaignHistoryQuery): Promise<Page<VersionSummary>> {
    const scope = cursorScope(ctx.access, 'campaign.versions', { campaignId });
    const cursor = decodeCursor(q.cursor, scope);
    return inTenant(this.db, ctx, async ({ tx }) => {
      if (!(await tx.campaign.findUnique({ where: { id: campaignId }, select: { id: true } }))) throw campaignNotFound();
      const rows = await tx.campaignVersion.findMany({
        where: {
          campaignId,
          ...(cursor ? { OR: [{ createdAt: { lt: new Date(cursor.t) } }, { createdAt: new Date(cursor.t), id: { lt: cursor.id } }] } : {}),
        },
        select: { id: true, number: true, reason: true, contentHash: true, createdAt: true, createdByUserId: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
      });
      const page = pageOf(rows, q.limit, (r) => ({ t: r.createdAt.toISOString(), id: r.id }), scope);
      const actors = await actorsById(tx, page.data.map((r) => r.createdByUserId));
      return { data: page.data.map((r) => versionSummary(r, actors)), nextCursor: page.nextCursor };
    });
  }

  /** Row 21 (6.9). Executions of a campaign, newest run first (UUIDv7 ids are creation-ordered). Campaign-owned data only. */
  async executions(ctx: TenantRequestContext, campaignId: string, q: CampaignHistoryQuery): Promise<Page<ExecutionSummary>> {
    const scope = cursorScope(ctx.access, 'campaign.executions', { campaignId });
    const cursor = decodeCursor(q.cursor, scope);
    return inTenant(this.db, ctx, async ({ tx }) => {
      if (!(await tx.campaign.findUnique({ where: { id: campaignId }, select: { id: true } }))) throw campaignNotFound();
      const rows = await tx.campaignExecution.findMany({
        where: { campaignId, ...(cursor ? { id: { lt: cursor.id } } : {}) },
        orderBy: { id: 'desc' },
        take: q.limit + 1,
      });
      const page = pageOf(rows, q.limit, (r) => ({ t: r.sendAt.toISOString(), id: r.id }), scope);
      return { data: page.data.map(executionSummary), nextCursor: page.nextCursor };
    });
  }

  /** Row 22 (6.9). One execution of this campaign; another campaign's or workspace's execution id is 404. */
  async execution(ctx: TenantRequestContext, campaignId: string, executionId: string): Promise<ExecutionSummary> {
    return inTenant(this.db, ctx, async ({ tx }) => {
      const e = await tx.campaignExecution.findFirst({ where: { id: executionId, campaignId } });
      if (!e) throw Errors.notFound('Execution');
      return executionSummary(e);
    });
  }

  /** Row 19. The snapshot is validated on read (contract §4.1). */
  async version(ctx: TenantRequestContext, campaignId: string, versionId: string): Promise<VersionDetail> {
    return inTenant(this.db, ctx, async ({ tx }) => {
      const v = await tx.campaignVersion.findFirst({ where: { id: versionId, campaignId } });
      if (!v) throw Errors.notFound('Version');
      const actors = await actorsById(tx, [v.createdByUserId]);
      return { ...versionSummary(v, actors), snapshot: readStoredSnapshot(v.snapshot) };
    });
  }

  // ─── shared by the lifecycle service ─────────────────────────────────────────────────────────────────────────

  /** One transaction with events + audit; a foreign-key failure on topic_id means "not a topic of this workspace". */
  async write<T>(ctx: TenantRequestContext, fn: (uow: TenantUnitOfWork) => Promise<T>): Promise<T> {
    try {
      return await inTenant(this.db, ctx, fn);
    } catch (err) {
      if (isForeignKeyViolation(err) && String((err as { message?: string }).message ?? '').includes('topic')) {
        throw Errors.validation({ topicId: ['Not a topic of this workspace'] });
      }
      throw err;
    }
  }

  /** Locks the campaign row for the rest of the transaction (lock order: campaign → execution → recipients). */
  async lock(tx: Tx, campaignId: string): Promise<CampaignRow> {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM campaigns WHERE id = ${campaignId}::uuid FOR UPDATE`;
    if (!locked.length) throw campaignNotFound();
    return (await tx.campaign.findUniqueOrThrow({ where: { id: campaignId }, include: CAMPAIGN_INCLUDE })) as CampaignRow;
  }

  async viewById(tx: Tx, ctx: TenantRequestContext, campaignId: string): Promise<CampaignView> {
    const row = (await tx.campaign.findUnique({ where: { id: campaignId }, include: CAMPAIGN_INCLUDE })) as CampaignRow | null;
    if (!row) throw campaignNotFound();
    const actors = await actorsById(tx, [row.createdByUserId]);
    return campaignView(row, this.viewer(ctx), actors.get(row.createdByUserId ?? '') ?? null);
  }

  actor(ctx: TenantRequestContext) {
    return { type: 'user' as const, permissions: ctx.access.permissions };
  }

  /** Missing composite permission → 403, audited in its own transaction (the command's transaction is rolled back). */
  async requirePermissions(ctx: TenantRequestContext, needed: ReadonlySet<string>, operation: string): Promise<void> {
    const missing = [...needed].filter((p) => !ctx.access.permissions.has(p as Permission));
    if (!missing.length) return;
    await inTenant(this.db, ctx, ({ audit }) => audit({ action: 'access.denied', outcome: 'denied', metadata: { permission: missing[0], operation: `campaign.${operation}` } }));
    throw Errors.forbidden();
  }
}

function versionSummary(
  v: { id: string; number: number; reason: string; contentHash: string; createdAt: Date; createdByUserId: string | null },
  actors: Map<string, { id: string; displayName: string }>,
): VersionSummary {
  return {
    id: v.id,
    number: v.number,
    reason: v.reason as VersionSummary['reason'],
    contentHash: v.contentHash,
    createdAt: v.createdAt.toISOString(),
    createdBy: actors.get(v.createdByUserId ?? '') ?? null,
  };
}

const copyName = (name: string) => (name.length > 193 ? `${name.slice(0, 193)} (copy)` : `${name} (copy)`);
