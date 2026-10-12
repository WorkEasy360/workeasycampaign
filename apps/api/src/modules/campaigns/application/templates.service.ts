import { Inject, Injectable } from '@nestjs/common';
import { canonicalContentV2, canonicalContentV3, contentIssues, contentIssuesV3 } from '@workeasy/content';
import { type Database, isUniqueViolation, type Tx } from '@workeasy/db';
import {
  type ApplyTemplateRequest,
  type CampaignView,
  type CreateTemplateRequest,
  type EmailContentV2,
  type EmailContentV2Draft,
  type EmailContentV3,
  type EmailContentV3Draft,
  emailContentV2DraftSchema,
  emailContentV2Schema,
  emailContentV3DraftSchema,
  emailContentV3Schema,
  type Permission,
  type RestoreTemplateRequest,
  type TemplateListItem,
  type TemplateListQuery,
  type TemplateVersionChange,
  type TemplateVersionListItem,
  type TemplateVersionListQuery,
  type TemplateVersionView,
  type TemplateView,
  type UpdateTemplateRequest,
} from '@workeasy/shared';
import { AppError, Errors } from '../../../common/errors.js';
import { cursorScope, decodeCursor, encodeCursor } from '../../../common/pagination.js';
import type { TenantRequestContext } from '../../../common/request-context.js';
import { DATABASE } from '../../../infrastructure/providers.js';
import { inTenant } from '../../tenancy/application/tenant-tx.js';
import { campaignNotFound } from './campaign-errors.js';
import { actorsById, draftOf } from './campaign-views.js';
import { CampaignsService } from './campaigns.service.js';

const nameKey = (name: string) => name.trim().toLowerCase();
const templateNotFound = () => Errors.notFound('Template');
const nameTaken = () => Errors.conflict('A template with this name already exists', { name: ['Choose another name'] });
const versionNotFound = () => Errors.notFound('Template version');

type TemplateRow = {
  id: string;
  orgId: string;
  workspaceId: string;
  name: string;
  description: string;
  category: string | null;
  content: unknown;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  createdByUserId: string | null;
};

/**
 * Email templates (docs/contracts/phase-6-content-amendment.md §6, rows T1–T7; decision C8). Workspace-owned rows
 * under forced RLS; content is `email.content.v2` or `v3` (Phase 7 §C), validated on write AND read (a stored row that no longer parses is
 * a loud error, never served). Changes are audited; reads are not. Applying a template copies its content through the
 * ordinary draft update (same state rules, optimistic lock, permission checks and `campaign.updated` event).
 */
@Injectable()
export class TemplatesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly campaigns: CampaignsService,
  ) {}

  /** T1 — most recently updated first; no content in the list. */
  async list(ctx: TenantRequestContext, q: TemplateListQuery): Promise<{ data: TemplateListItem[]; nextCursor: string | null }> {
    return inTenant(this.db, ctx, async ({ tx }) => {
      const scope = cursorScope(ctx.access, 'templates', { q: q.q, category: q.category });
      const c = decodeCursor(q.cursor, scope);
      const rows = await tx.emailTemplate.findMany({
        where: {
          deletedAt: null,
          ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}),
          ...(q.category ? { category: { equals: q.category, mode: 'insensitive' } } : {}),
          ...(c ? { OR: [{ updatedAt: { lt: new Date(c.t) } }, { updatedAt: new Date(c.t), id: { lt: c.id } }] } : {}),
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
      });
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      return {
        data: page.map((r) => {
          const content = readContent(r.content);
          return { id: r.id, name: r.name, description: r.description, category: r.category, subject: content.subject, blockCount: content.body.blocks.length, version: r.version, updatedAt: r.updatedAt.toISOString() };
        }),
        nextCursor: rows.length > q.limit && last ? encodeCursor({ t: last.updatedAt.toISOString(), id: last.id }, scope) : null,
      };
    });
  }

  /** T3. */
  async get(ctx: TenantRequestContext, templateId: string): Promise<TemplateView> {
    return inTenant(this.db, ctx, async ({ tx }) => this.view(tx, await requireTemplate(tx, templateId)));
  }

  /** T2 / T7 ("save as template" from a campaign whose draft content is v2 and complete). */
  async create(ctx: TenantRequestContext, input: CreateTemplateRequest): Promise<TemplateView> {
    if ('fromCampaignId' in input) await this.campaigns.requirePermissions(ctx, new Set<Permission>(['campaigns.read']), 'save_as_template');
    try {
      return await inTenant(this.db, ctx, async ({ tx, audit }) => {
        const content =
          'content' in input
            ? canonical(input.content)
            : 'fromTemplateId' in input
              ? readContent((await requireTemplate(tx, input.fromTemplateId)).content) // a deleted or foreign template: 404
              : await contentOfCampaign(tx, input.fromCampaignId);
        const row = await tx.emailTemplate.create({
          data: {
            orgId: ctx.access.orgId,
            workspaceId: ctx.access.workspaceId!,
            name: input.name,
            nameKey: nameKey(input.name),
            description: input.description ?? '',
            category: input.category ?? null,
            content,
            createdByUserId: ctx.principal.userId,
          },
        });
        await recordVersion(tx, row, 'created', ctx.principal.userId);
        await audit({ action: 'template.created', targetType: 'template', targetId: row.id, metadata: 'fromCampaignId' in input ? { fromCampaignId: input.fromCampaignId } : 'fromTemplateId' in input ? { fromTemplateId: input.fromTemplateId } : {} });
        return this.view(tx, row);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken();
      throw err;
    }
  }

  /** T4 — optimistic lock on `version`. */
  async update(ctx: TenantRequestContext, templateId: string, input: UpdateTemplateRequest): Promise<TemplateView> {
    try {
      return await inTenant(this.db, ctx, async ({ tx, audit }) => {
        const row = await requireTemplate(tx, templateId);
        const content = input.content ? canonical(input.content) : undefined;
        const changes = [
          ...(input.name !== undefined && input.name !== row.name ? ['name'] : []),
          ...(input.description !== undefined && input.description !== row.description ? ['description'] : []),
          ...(input.category !== undefined && input.category !== row.category ? ['category'] : []),
          ...(content && JSON.stringify(content) !== JSON.stringify(readContent(row.content)) ? ['content'] : []),
        ];
        if (row.version !== input.expectedVersion) throw Errors.versionConflict();
        if (!changes.length) return this.view(tx, row);
        const r = await tx.emailTemplate.updateMany({
          where: { id: templateId, version: input.expectedVersion, deletedAt: null },
          data: {
            ...(input.name !== undefined ? { name: input.name, nameKey: nameKey(input.name) } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.category !== undefined ? { category: input.category } : {}),
            ...(content ? { content } : {}),
            updatedAt: new Date(),
            version: { increment: 1 },
          },
        });
        if (r.count !== 1) throw Errors.versionConflict();
        const updated = await requireTemplate(tx, templateId);
        await recordVersion(tx, updated, 'updated', ctx.principal.userId);
        await audit({ action: 'template.updated', targetType: 'template', targetId: templateId, metadata: { changes: changes.join(','), version: updated.version } });
        return this.view(tx, updated);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken();
      throw err;
    }
  }

  /** T5 — soft delete; the name becomes reusable. Campaigns that applied it are unaffected (they hold a copy). */
  async delete(ctx: TenantRequestContext, templateId: string): Promise<void> {
    await inTenant(this.db, ctx, async ({ tx, audit }) => {
      await requireTemplate(tx, templateId);
      await tx.emailTemplate.update({ where: { id: templateId }, data: { deletedAt: new Date(), nameKey: null, updatedAt: new Date(), version: { increment: 1 } } });
      await audit({ action: 'template.deleted', targetType: 'template', targetId: templateId });
    });
  }

  /** 7.1 — the history of a live template, newest first (keyset on version). A deleted template's history is a 404. */
  async versions(ctx: TenantRequestContext, templateId: string, q: TemplateVersionListQuery): Promise<{ data: TemplateVersionListItem[]; nextCursor: string | null }> {
    return inTenant(this.db, ctx, async ({ tx }) => {
      await requireTemplate(tx, templateId);
      const scope = cursorScope(ctx.access, 'template_versions', { templateId });
      const c = decodeCursor(q.cursor, scope);
      // The cursor names the last row seen (signed, scoped to this template); the keyset is its version.
      const after = c ? await tx.emailTemplateVersion.findFirst({ where: { id: c.id, templateId }, select: { version: true } }) : null;
      if (c && !after) throw Errors.validation({ cursor: ['Invalid cursor'] });
      const rows = await tx.emailTemplateVersion.findMany({
        where: { templateId, ...(after ? { version: { lt: after.version } } : {}) },
        orderBy: { version: 'desc' },
        take: q.limit + 1,
      });
      const page = rows.slice(0, q.limit);
      const actors = await actorsById(tx, page.map((r) => r.createdByUserId));
      const last = page.at(-1);
      return {
        data: page.map((r) => versionItem(r, actors)),
        nextCursor: rows.length > q.limit && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }, scope) : null,
      };
    });
  }

  /** 7.1 — one recorded version, with its content. */
  async version(ctx: TenantRequestContext, templateId: string, version: number): Promise<TemplateVersionView> {
    return inTenant(this.db, ctx, async ({ tx }) => {
      await requireTemplate(tx, templateId);
      const r = await tx.emailTemplateVersion.findUnique({ where: { templateId_version: { templateId, version } } });
      if (!r) throw versionNotFound();
      const actors = await actorsById(tx, [r.createdByUserId]);
      return { ...versionItem(r, actors), description: r.description, category: r.category, content: readContent(r.content) };
    });
  }

  /**
   * 7.1 — restore = a NEW version with the description, category and content of `version` (history is never rewritten).
   * Optimistic lock on the template's version; restoring a state equal to the current one changes nothing.
   */
  async restore(ctx: TenantRequestContext, templateId: string, input: RestoreTemplateRequest): Promise<TemplateView> {
    return inTenant(this.db, ctx, async ({ tx, audit }) => {
      const row = await requireTemplate(tx, templateId);
      const from = await tx.emailTemplateVersion.findUnique({ where: { templateId_version: { templateId, version: input.version } } });
      if (!from) throw versionNotFound();
      if (row.version !== input.expectedVersion) throw Errors.versionConflict();
      const content = readContent(from.content);
      const same = from.description === row.description && from.category === row.category && JSON.stringify(content) === JSON.stringify(readContent(row.content));
      if (same) return this.view(tx, row);
      const r = await tx.emailTemplate.updateMany({
        where: { id: templateId, version: input.expectedVersion, deletedAt: null },
        data: { description: from.description, category: from.category, content, updatedAt: new Date(), version: { increment: 1 } },
      });
      if (r.count !== 1) throw Errors.versionConflict();
      const updated = await requireTemplate(tx, templateId);
      await recordVersion(tx, updated, 'restored', ctx.principal.userId, input.version);
      await audit({ action: 'template.restored', targetType: 'template', targetId: templateId, metadata: { fromVersion: input.version, version: updated.version } });
      return this.view(tx, updated);
    });
  }

  /** 7.1 — distinct categories of live templates (case-insensitively distinct; the most recent spelling wins). */
  async categories(ctx: TenantRequestContext): Promise<string[]> {
    return inTenant(this.db, ctx, async ({ tx }) => {
      const rows = await tx.emailTemplate.findMany({
        where: { deletedAt: null, category: { not: null } },
        select: { category: true },
        orderBy: { updatedAt: 'desc' },
        take: 1000,
      });
      const byKey = new Map<string, string>();
      for (const r of rows) if (r.category && !byKey.has(r.category.toLowerCase())) byKey.set(r.category.toLowerCase(), r.category);
      return [...byKey.values()].sort((a, b) => a.localeCompare(b));
    });
  }

  /** T6 — copy the template's content into the draft's default message (needs templates.read and campaigns.update). */
  async apply(ctx: TenantRequestContext, campaignId: string, input: ApplyTemplateRequest): Promise<CampaignView> {
    await this.campaigns.requirePermissions(ctx, new Set<Permission>(['templates.read']), 'apply_template');
    const content = await inTenant(this.db, ctx, async ({ tx }) => readContent((await requireTemplate(tx, input.templateId)).content));
    // The audit is written in the same transaction as the draft change, and only when something changed.
    return this.campaigns.update(
      ctx,
      campaignId,
      { expectedVersion: input.expectedVersion, messages: [{ variantKey: 'default', content }] },
      { audit: { action: 'campaign.template_applied', targetType: 'campaign', targetId: campaignId, metadata: { templateId: input.templateId } } },
    );
  }

  private async view(tx: Tx, row: TemplateRow): Promise<TemplateView> {
    const actors = await actorsById(tx, [row.createdByUserId]);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      category: row.category,
      content: readContent(row.content),
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      createdBy: row.createdByUserId ? (actors.get(row.createdByUserId) ?? null) : null,
    };
  }
}

type VersionRow = { version: number; change: string; restoredFromVersion: number | null; name: string; content: unknown; createdAt: Date; createdByUserId: string | null };

function versionItem(r: VersionRow, actors: Map<string, { id: string; displayName: string }>): TemplateVersionListItem {
  return {
    version: r.version,
    change: r.change as TemplateVersionChange,
    restoredFromVersion: r.restoredFromVersion,
    name: r.name,
    subject: readContent(r.content).subject,
    createdAt: r.createdAt.toISOString(),
    createdBy: r.createdByUserId ? (actors.get(r.createdByUserId) ?? null) : null,
  };
}

/** The template's state after a change, as an immutable history row (same transaction as the change). */
async function recordVersion(tx: Tx, row: TemplateRow, change: Exclude<TemplateVersionChange, 'imported'>, userId: string | null, restoredFromVersion?: number) {
  await tx.emailTemplateVersion.create({
    data: {
      orgId: row.orgId,
      workspaceId: row.workspaceId,
      templateId: row.id,
      version: row.version,
      change,
      restoredFromVersion: restoredFromVersion ?? null,
      name: row.name,
      description: row.description,
      category: row.category,
      content: row.content as object,
      createdByUserId: userId,
    },
  });
}

async function requireTemplate(tx: Tx, templateId: string) {
  const row = await tx.emailTemplate.findFirst({ where: { id: templateId, deletedAt: null } });
  if (!row) throw templateNotFound();
  return row;
}

/**
 * The canonical stored form (amendment §2): the same normalization versions use. Incomplete content is a 422 with one
 * field error per problem, keyed by its pointer inside the content (e.g. "content/body/blocks/2/href").
 */
function canonical(content: EmailContentV2Draft | EmailContentV3Draft): EmailContentV2 | EmailContentV3 {
  const issues = content.schema === 'email.content.v3' ? contentIssuesV3(content) : contentIssues(content);
  const c = issues.length ? null : content.schema === 'email.content.v3' ? canonicalContentV3(content) : canonicalContentV2(content);
  if (!c) {
    const fields: Record<string, string[]> = {};
    for (const i of issues) (fields[`content${i.pointer}`] ??= []).push(i.message);
    throw new AppError('validation_failed', 422, 'Fix the template content before saving it', fields);
  }
  return c;
}

/** T7: the campaign's draft content, which must be v2 and complete. */
async function contentOfCampaign(tx: Tx, campaignId: string): Promise<EmailContentV2 | EmailContentV3> {
  const row = await tx.campaign.findUnique({ where: { id: campaignId } });
  if (!row) throw campaignNotFound();
  const content = draftOf(row).messages.find((m) => m.variantKey === 'default')?.content;
  const v3 = emailContentV3DraftSchema.safeParse(content);
  const parsed = v3.success ? v3 : emailContentV2DraftSchema.safeParse(content);
  if (!parsed.success) throw new AppError('validation_failed', 422, 'Only designed emails (block content) can be saved as templates');
  const c = parsed.data.schema === 'email.content.v3' ? canonicalContentV3(parsed.data) : canonicalContentV2(parsed.data);
  if (!c) throw new AppError('validation_failed', 422, 'Finish the message (fix its content problems) before saving it as a template');
  return c;
}

/** Validated on read: a stored row that does not parse is a defect surfaced loudly, never served. */
function readContent(raw: unknown): EmailContentV2 | EmailContentV3 {
  return (raw as { schema?: unknown } | null)?.schema === 'email.content.v3' ? emailContentV3Schema.parse(raw) : emailContentV2Schema.parse(raw);
}
