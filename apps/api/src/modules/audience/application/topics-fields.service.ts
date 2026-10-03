import { Inject, Injectable } from '@nestjs/common';
import { type Database, isUniqueViolation, type Tx } from '@workeasy/db';
import type { CreateCustomFieldRequest, CustomFieldView, TopicView } from '@workeasy/shared';
import { v7 as uuidv7 } from 'uuid';
import { AppError, Errors } from '../../../common/errors.js';
import type { TenantRequestContext } from '../../../common/request-context.js';
import { DATABASE } from '../../../infrastructure/providers.js';
import { inTenant } from '../../tenancy/application/tenant-tx.js';
import { definitionProblems, MAX_FIELDS_PER_WORKSPACE } from '../domain/custom-fields.js';

export const DEFAULT_TOPIC = { key: 'marketing', name: 'Marketing', description: 'General marketing communication' } as const;

/**
 * Every workspace has exactly one default topic [ZOHO_PARITY: a default "Marketing" topic exists]. Created with the
 * workspace (and back-filled by the Phase 5 migration); this also heals any workspace that somehow lacks one.
 */
export async function ensureDefaultTopic(tx: Tx, orgId: string, workspaceId: string): Promise<void> {
  if (await tx.topic.count({ where: { isDefault: true } })) return;
  const existing = await tx.topic.findFirst({ where: { key: DEFAULT_TOPIC.key } });
  if (existing) {
    if (existing.status === 'active' && existing.kind === 'topic') await tx.topic.update({ where: { id: existing.id }, data: { isDefault: true } });
    return;
  }
  await tx.topic.create({ data: { id: uuidv7(), orgId, workspaceId, key: DEFAULT_TOPIC.key, name: DEFAULT_TOPIC.name, description: DEFAULT_TOPIC.description, isDefault: true } });
}

function keyFromName(name: string): string {
  const k = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 36);
  return /^[a-z]/.test(k) && k.length >= 2 ? k : `t_${k || 'topic'}`.slice(0, 40);
}

@Injectable()
export class TopicsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(ctx: TenantRequestContext): Promise<TopicView[]> {
    return inTenant(this.db, ctx, async ({ tx }) => {
      await ensureDefaultTopic(tx, ctx.access.orgId, ctx.access.workspaceId!);
      const topics = await tx.topic.findMany({ orderBy: [{ kind: 'asc' }, { position: 'asc' }, { name: 'asc' }] });
      const counts = topics.length
        ? await tx.contactTopicPreference.groupBy({ by: ['topicId'], where: { status: 'subscribed', contact: { deletedAt: null } }, _count: { _all: true } })
        : [];
      const byId = new Map(counts.map((c) => [c.topicId, c._count._all]));
      return topics.map((t) => this.view(t, byId.get(t.id) ?? 0));
    });
  }

  async create(ctx: TenantRequestContext, input: { name: string; key?: string; kind: 'topic' | 'category'; description: string; parentId?: string | null }): Promise<TopicView> {
    try {
      return await inTenant(this.db, ctx, async ({ tx, event }) => {
        await ensureDefaultTopic(tx, ctx.access.orgId, ctx.access.workspaceId!);
        if (input.parentId) await this.assertCategory(tx, input.parentId, input.kind);
        const t = await tx.topic.create({
          data: {
            orgId: ctx.access.orgId,
            workspaceId: ctx.access.workspaceId!,
            key: input.key ?? keyFromName(input.name),
            name: input.name,
            kind: input.kind,
            description: input.description,
            parentId: input.parentId ?? null,
            position: await tx.topic.count(),
          },
        });
        await event('topic.created', t.id, { key: t.key, kind: t.kind });
        return this.view(t, 0);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw Errors.conflict('A topic with this key already exists', { key: ['Choose another key'] });
      throw err;
    }
  }

  async update(ctx: TenantRequestContext, topicId: string, input: { name?: string; description?: string; parentId?: string | null; version: number }): Promise<TopicView> {
    return inTenant(this.db, ctx, async ({ tx, event }) => {
      const t = await this.require(tx, topicId);
      if (input.parentId) {
        if (input.parentId === topicId) throw Errors.validation({ parentId: ['A topic cannot be its own category'] });
        await this.assertCategory(tx, input.parentId, t.kind as 'topic' | 'category');
      }
      const changes = (['name', 'description', 'parentId'] as const).filter((k) => input[k] !== undefined && input[k] !== t[k]);
      if (changes.length) {
        const r = await tx.topic.updateMany({
          where: { id: topicId, version: input.version },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
            updatedAt: new Date(),
            version: { increment: 1 },
          },
        });
        if (r.count !== 1) throw Errors.versionConflict();
        await event('topic.updated', topicId, { changes: [...changes] });
      }
      return this.viewWithCount(tx, topicId);
    });
  }

  /** Topics are archived, never deleted: consent evidence and (later) campaigns reference them. */
  async setArchived(ctx: TenantRequestContext, topicId: string, archived: boolean): Promise<TopicView> {
    return inTenant(this.db, ctx, async ({ tx, event }) => {
      const t = await this.require(tx, topicId);
      if ((t.status === 'archived') === archived) return this.viewWithCount(tx, topicId);
      if (archived) {
        if (t.isDefault) throw Errors.precondition('The default topic cannot be archived. Make another topic the default first.');
        if (t.kind === 'topic' && (await tx.topic.count({ where: { kind: 'topic', status: 'active' } })) <= 1) {
          throw Errors.precondition('A workspace needs at least one active topic');
        }
        if (t.kind === 'category' && (await tx.topic.count({ where: { parentId: topicId, status: 'active' } }))) {
          throw Errors.precondition('Archive or move the topics in this category first');
        }
      }
      await tx.topic.update({ where: { id: topicId }, data: { status: archived ? 'archived' : 'active', updatedAt: new Date(), version: { increment: 1 } } });
      await event(archived ? 'topic.archived' : 'topic.restored', topicId, {});
      return this.viewWithCount(tx, topicId);
    });
  }

  async makeDefault(ctx: TenantRequestContext, topicId: string): Promise<TopicView> {
    return inTenant(
      this.db,
      ctx,
      async ({ tx, event }) => {
        const t = await this.require(tx, topicId);
        if (t.kind !== 'topic' || t.status !== 'active') throw Errors.precondition('Only an active topic can be the default');
        if (t.isDefault) return this.viewWithCount(tx, topicId);
        const previous = await tx.topic.findFirst({ where: { isDefault: true }, select: { id: true } });
        await tx.topic.updateMany({ where: { isDefault: true }, data: { isDefault: false, updatedAt: new Date() } });
        await tx.topic.update({ where: { id: topicId }, data: { isDefault: true, updatedAt: new Date(), version: { increment: 1 } } });
        await event('topic.default_changed', topicId, { previousDefaultId: previous?.id ?? null });
        return this.viewWithCount(tx, topicId);
      },
      { isolationLevel: 'Serializable' },
    );
  }

  private async require(tx: Tx, topicId: string) {
    const t = await tx.topic.findUnique({ where: { id: topicId } });
    if (!t) throw Errors.notFound('Topic');
    return t;
  }

  private async assertCategory(tx: Tx, parentId: string, childKind: 'topic' | 'category') {
    if (childKind === 'category') throw Errors.validation({ parentId: ['Categories cannot be nested'] });
    const p = await tx.topic.findUnique({ where: { id: parentId } });
    if (!p || p.kind !== 'category' || p.status !== 'active') throw Errors.validation({ parentId: ['Choose an active category'] });
  }

  private async viewWithCount(tx: Tx, topicId: string): Promise<TopicView> {
    const t = await this.require(tx, topicId);
    return this.view(t, await tx.contactTopicPreference.count({ where: { topicId, status: 'subscribed', contact: { deletedAt: null } } }));
  }

  private view(
    t: { id: string; key: string; name: string; description: string; kind: string; parentId: string | null; status: string; isDefault: boolean; version: number },
    subscriberCount: number,
  ): TopicView {
    return {
      id: t.id,
      key: t.key,
      name: t.name,
      description: t.description,
      kind: t.kind as TopicView['kind'],
      parentId: t.parentId,
      status: t.status as TopicView['status'],
      isDefault: t.isDefault,
      subscriberCount,
      version: t.version,
    };
  }
}

@Injectable()
export class CustomFieldsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(ctx: TenantRequestContext): Promise<CustomFieldView[]> {
    return inTenant(this.db, ctx, async ({ tx }) =>
      (await tx.customFieldDefinition.findMany({ orderBy: [{ status: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }] })).map(this.view),
    );
  }

  async create(ctx: TenantRequestContext, input: CreateCustomFieldRequest): Promise<CustomFieldView> {
    const problems = definitionProblems({ ...input, status: 'active' });
    if (problems.length) throw Errors.validation({ definition: problems });
    try {
      return await inTenant(this.db, ctx, async ({ tx, event }) => {
        const count = await tx.customFieldDefinition.count();
        if (count >= MAX_FIELDS_PER_WORKSPACE) throw Errors.precondition(`A workspace can have at most ${MAX_FIELDS_PER_WORKSPACE} custom fields`);
        // A new required field would make every existing contact invalid; it starts optional until data exists.
        if (input.required && (await tx.contact.count({ where: { deletedAt: null } })) > 0) {
          throw new AppError('precondition_failed', 422, 'A new field cannot be required while contacts exist. Create it as optional, fill it in, then make it required.', {
            required: ['Not allowed while contacts exist'],
          });
        }
        const f = await tx.customFieldDefinition.create({
          data: {
            orgId: ctx.access.orgId,
            workspaceId: ctx.access.workspaceId!,
            key: input.key,
            label: input.label,
            type: input.type,
            description: input.description,
            required: input.required,
            options: input.options,
            validation: input.validation,
            position: count,
          },
        });
        await event('custom_field.created', f.id, { key: f.key, type: f.type });
        return this.view(f);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw Errors.conflict('A field with this key already exists', { key: ['Choose another key'] });
      throw err;
    }
  }

  async update(
    ctx: TenantRequestContext,
    fieldId: string,
    input: Partial<Omit<CreateCustomFieldRequest, 'options'>> & { options?: { key: string; label: string; archived: boolean }[]; version: number },
  ): Promise<CustomFieldView> {
    try {
      return await inTenant(this.db, ctx, async ({ tx, event }) => {
        const f = await this.require(tx, fieldId);
        if (f.keyLocked && input.key !== undefined && input.key !== f.key) {
          throw Errors.validation({ key: ['This key is already used by contact data and cannot change'] });
        }
        if (f.keyLocked && input.type !== undefined && input.type !== f.type) {
          throw Errors.validation({ type: ['The type cannot change once contacts have values'] });
        }
        const oldOptions = f.options as { key: string }[];
        if (input.options && oldOptions.some((o) => !input.options!.some((n) => n.key === o.key))) {
          throw Errors.validation({ options: ['Options cannot be removed; archive them instead'] });
        }
        if (input.required === true && !f.required) {
          const missing = await tx.$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM contacts WHERE deleted_at IS NULL AND erased_at IS NULL AND NOT (custom_fields ? ${f.key})`;
          if (missing[0]!.n > 0) {
            throw new AppError('precondition_failed', 422, `${missing[0]!.n} contacts have no value for this field yet. Fill them in before making it required.`, {
              required: ['Some contacts have no value'],
            });
          }
        }
        const next = { key: input.key ?? f.key, type: input.type ?? f.type, options: input.options ?? (f.options as never), required: input.required ?? f.required, status: f.status };
        const problems = definitionProblems(next as never);
        if (problems.length) throw Errors.validation({ definition: problems });
        const changes = (['key', 'label', 'type', 'description', 'required', 'options', 'validation'] as const).filter(
          (k) => input[k] !== undefined && JSON.stringify(input[k]) !== JSON.stringify(f[k]),
        );
        if (changes.length) {
          const r = await tx.customFieldDefinition.updateMany({
            where: { id: fieldId, version: input.version },
            data: {
              ...Object.fromEntries(changes.map((k) => [k, input[k]])),
              updatedAt: new Date(),
              version: { increment: 1 },
            },
          });
          if (r.count !== 1) throw Errors.versionConflict();
          await event('custom_field.updated', fieldId, { changes: [...changes] });
        }
        return this.view(await this.require(tx, fieldId));
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw Errors.conflict('A field with this key already exists', { key: ['Choose another key'] });
      throw err;
    }
  }

  /** Archiving keeps all stored values (read-only) and removes the field from forms and new imports. */
  async setArchived(ctx: TenantRequestContext, fieldId: string, archived: boolean): Promise<CustomFieldView> {
    return inTenant(this.db, ctx, async ({ tx, event, audit }) => {
      const f = await this.require(tx, fieldId);
      if ((f.status === 'archived') === archived) return this.view(f);
      await tx.customFieldDefinition.update({
        where: { id: fieldId },
        data: { status: archived ? 'archived' : 'active', required: archived ? false : f.required, updatedAt: new Date(), version: { increment: 1 } },
      });
      await event(archived ? 'custom_field.archived' : 'custom_field.restored', fieldId, {});
      if (archived) await audit({ action: 'custom_field.archived', targetType: 'custom_field', targetId: fieldId, metadata: { key: f.key } });
      return this.view(await this.require(tx, fieldId));
    });
  }

  /** Only fields that never held data can be deleted; used fields are archived to preserve data. */
  async delete(ctx: TenantRequestContext, fieldId: string): Promise<void> {
    await inTenant(this.db, ctx, async ({ tx, event, audit }) => {
      const f = await this.require(tx, fieldId);
      if (f.keyLocked) throw Errors.precondition('This field holds contact data. Archive it instead of deleting it.');
      await tx.customFieldDefinition.delete({ where: { id: fieldId } });
      await event('custom_field.deleted', fieldId, { key: f.key });
      await audit({ action: 'custom_field.deleted', targetType: 'custom_field', targetId: fieldId, metadata: { key: f.key } });
    });
  }

  async reorder(ctx: TenantRequestContext, fieldIds: string[]): Promise<CustomFieldView[]> {
    await inTenant(this.db, ctx, async ({ tx }) => {
      const all = await tx.customFieldDefinition.findMany({ select: { id: true } });
      if (all.length !== fieldIds.length || all.some((f) => !fieldIds.includes(f.id))) {
        throw Errors.validation({ fieldIds: ['List every field exactly once'] });
      }
      for (const [position, id] of fieldIds.entries()) {
        await tx.customFieldDefinition.update({ where: { id }, data: { position, updatedAt: new Date() } });
      }
    });
    return this.list(ctx);
  }

  private async require(tx: Tx, fieldId: string) {
    const f = await tx.customFieldDefinition.findUnique({ where: { id: fieldId } });
    if (!f) throw Errors.notFound('Custom field');
    return f;
  }

  private view = (f: {
    id: string;
    key: string;
    label: string;
    description: string;
    type: string;
    required: boolean;
    options: unknown;
    validation: unknown;
    position: number;
    status: string;
    keyLocked: boolean;
    version: number;
  }): CustomFieldView => ({
    id: f.id,
    key: f.key,
    label: f.label,
    description: f.description,
    type: f.type as CustomFieldView['type'],
    required: f.required,
    options: f.options as CustomFieldView['options'],
    validation: f.validation as CustomFieldView['validation'],
    position: f.position,
    status: f.status as CustomFieldView['status'],
    keyLocked: f.keyLocked,
    version: f.version,
  });
}
