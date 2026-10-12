import { Inject, Injectable } from '@nestjs/common';
import { type Database, isUniqueViolation, type Tx } from '@workeasy/db';
import type { ListView, TagView } from '@workeasy/shared';
import { Errors } from '../../../common/errors.js';
import { cursorScope, decodeCursor, encodeCursor } from '../../../common/pagination.js';
import type { TenantRequestContext } from '../../../common/request-context.js';
import { DATABASE } from '../../../infrastructure/providers.js';
import { inTenant, inTenantRetrying, type TenantUnitOfWork } from '../../tenancy/application/tenant-tx.js';

const nameKey = (name: string) => name.trim().toLowerCase();

/** Contacts (by id) that exist, are live and belong to this workspace (RLS). Unknown ids are reported, not ignored. */
export async function liveContactIds(tx: Tx, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  const rows = await tx.contact.findMany({ where: { id: { in: unique }, deletedAt: null, erasedAt: null }, select: { id: true } });
  if (rows.length !== unique.length) throw Errors.validation({ contactIds: ['One or more contacts do not exist or are deleted'] });
  return rows.map((r) => r.id);
}

/**
 * Membership writes insert rows in ascending contact-id order. Two concurrent multi-row inserts into the same list (or
 * tag) with overlapping contacts then meet in the same order on the unique index and one simply waits, instead of the
 * two forming a deadlock cycle (measured: docs/audit/phase-6.3-bitmap-online-rebuild-readiness.md §6).
 */
const ascending = (ids: string[]) => [...new Set(ids)].sort();

/** Membership changes shared by the lists API, bulk actions and imports. Return how many actually changed. */
export async function addToList(uow: TenantUnitOfWork, orgId: string, workspaceId: string, listId: string, contactIds: string[], source: 'manual' | 'bulk' | 'import' | 'api', userId: string | null): Promise<number> {
  const { tx } = uow;
  const existing = await tx.listMembership.findMany({ where: { listId, contactId: { in: contactIds } }, select: { contactId: true } });
  const have = new Set(existing.map((e) => e.contactId));
  const added = ascending(contactIds).filter((id) => !have.has(id));
  if (!added.length) return 0;
  await tx.listMembership.createMany({ data: added.map((contactId) => ({ orgId, workspaceId, listId, contactId, source, addedByUserId: userId })), skipDuplicates: true });
  await uow.events('list.member_added', added.map((contactId) => ({ aggregateId: contactId, payload: { listId, source } })));
  return added.length;
}

export async function removeFromList(uow: TenantUnitOfWork, listId: string, contactIds: string[]): Promise<number> {
  const existing = await uow.tx.listMembership.findMany({ where: { listId, contactId: { in: contactIds } }, select: { contactId: true } });
  if (!existing.length) return 0;
  await uow.tx.listMembership.deleteMany({ where: { listId, contactId: { in: ascending(existing.map((e) => e.contactId)) } } });
  await uow.events('list.member_removed', existing.map((e) => ({ aggregateId: e.contactId, payload: { listId } })));
  return existing.length;
}

export async function tagContacts(uow: TenantUnitOfWork, orgId: string, workspaceId: string, tagId: string, contactIds: string[], userId: string | null): Promise<number> {
  const existing = await uow.tx.contactTag.findMany({ where: { tagId, contactId: { in: contactIds } }, select: { contactId: true } });
  const have = new Set(existing.map((e) => e.contactId));
  const added = ascending(contactIds).filter((id) => !have.has(id));
  if (!added.length) return 0;
  await uow.tx.contactTag.createMany({ data: added.map((contactId) => ({ orgId, workspaceId, tagId, contactId, taggedByUserId: userId })), skipDuplicates: true });
  await uow.events('contact.tagged', added.map((contactId) => ({ aggregateId: contactId, payload: { tagId } })));
  return added.length;
}

export async function untagContacts(uow: TenantUnitOfWork, tagId: string, contactIds: string[]): Promise<number> {
  const existing = await uow.tx.contactTag.findMany({ where: { tagId, contactId: { in: contactIds } }, select: { contactId: true } });
  if (!existing.length) return 0;
  await uow.tx.contactTag.deleteMany({ where: { tagId, contactId: { in: ascending(existing.map((e) => e.contactId)) } } });
  await uow.events('contact.untagged', existing.map((e) => ({ aggregateId: e.contactId, payload: { tagId } })));
  return existing.length;
}

export async function requireList(tx: Tx, listId: string, opts: { writable?: boolean } = {}) {
  const list = await tx.contactList.findFirst({ where: { id: listId, deletedAt: null } });
  if (!list) throw Errors.notFound('List');
  if (opts.writable && list.status === 'archived') throw Errors.precondition('This list is archived. Restore it to change its members.');
  return list;
}

export async function requireTag(tx: Tx, tagId: string) {
  const tag = await tx.tag.findFirst({ where: { id: tagId, deletedAt: null } });
  if (!tag) throw Errors.notFound('Tag');
  return tag;
}

@Injectable()
export class ListsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(ctx: TenantRequestContext, q: { q?: string; status: 'active' | 'archived' | 'all'; limit: number; cursor?: string }) {
    return inTenant(this.db, ctx, async ({ tx }) => {
      const scope = cursorScope(ctx.access, 'lists', { ...q });
      const c = decodeCursor(q.cursor, scope);
      const rows = await tx.contactList.findMany({
        where: {
          deletedAt: null,
          ...(q.status === 'all' ? {} : { status: q.status }),
          ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}),
          ...(c ? { OR: [{ createdAt: { lt: new Date(c.t) } }, { createdAt: new Date(c.t), id: { lt: c.id } }] } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
      });
      const page = rows.slice(0, q.limit);
      const counts = await this.memberCounts(tx, page.map((l) => l.id));
      const last = page.at(-1);
      return {
        data: page.map((l) => this.view(l, counts.get(l.id) ?? 0)),
        nextCursor: rows.length > q.limit && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }, scope) : null,
      };
    });
  }

  async get(ctx: TenantRequestContext, listId: string): Promise<ListView> {
    return inTenant(this.db, ctx, async ({ tx }) => {
      const l = await requireList(tx, listId);
      return this.view(l, (await this.memberCounts(tx, [l.id])).get(l.id) ?? 0);
    });
  }

  async create(ctx: TenantRequestContext, input: { name: string; description: string }): Promise<ListView> {
    try {
      return await inTenant(this.db, ctx, async ({ tx, event }) => {
        const l = await tx.contactList.create({
          data: { orgId: ctx.access.orgId, workspaceId: ctx.access.workspaceId!, name: input.name, nameKey: nameKey(input.name), description: input.description, createdByUserId: ctx.principal.userId },
        });
        await event('list.created', l.id, { name: l.name });
        return this.view(l, 0);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw Errors.conflict('A list with this name already exists', { name: ['Choose another name'] });
      throw err;
    }
  }

  async update(ctx: TenantRequestContext, listId: string, input: { name?: string; description?: string; version: number }): Promise<ListView> {
    try {
      return await inTenant(this.db, ctx, async ({ tx, event }) => {
        const l = await requireList(tx, listId);
        const changes = (['name', 'description'] as const).filter((k) => input[k] !== undefined && input[k] !== l[k]);
        if (changes.length) {
          const r = await tx.contactList.updateMany({
            where: { id: listId, version: input.version },
            data: {
              ...(input.name !== undefined ? { name: input.name, nameKey: nameKey(input.name) } : {}),
              ...(input.description !== undefined ? { description: input.description } : {}),
              updatedAt: new Date(),
              version: { increment: 1 },
            },
          });
          if (r.count !== 1) throw Errors.versionConflict();
          await event('list.updated', listId, { changes: [...changes] });
        }
        const fresh = await requireList(tx, listId);
        return this.view(fresh, (await this.memberCounts(tx, [listId])).get(listId) ?? 0);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw Errors.conflict('A list with this name already exists', { name: ['Choose another name'] });
      throw err;
    }
  }

  async setArchived(ctx: TenantRequestContext, listId: string, archived: boolean): Promise<ListView> {
    return inTenant(this.db, ctx, async ({ tx, event }) => {
      const l = await requireList(tx, listId);
      if ((l.status === 'archived') !== archived) {
        await tx.contactList.update({ where: { id: listId }, data: { status: archived ? 'archived' : 'active', updatedAt: new Date(), version: { increment: 1 } } });
        await event(archived ? 'list.archived' : 'list.restored', listId, {});
      }
      const fresh = await requireList(tx, listId);
      return this.view(fresh, (await this.memberCounts(tx, [listId])).get(listId) ?? 0);
    });
  }

  /** Soft delete: the list disappears and its memberships are removed (contacts are untouched). */
  async delete(ctx: TenantRequestContext, listId: string): Promise<void> {
    await inTenantRetrying(this.db, ctx, async ({ tx, event }) => {
      await requireList(tx, listId);
      const removed = await tx.listMembership.deleteMany({ where: { listId } });
      await tx.contactList.update({ where: { id: listId }, data: { deletedAt: new Date(), nameKey: null, updatedAt: new Date(), version: { increment: 1 } } });
      await event('list.deleted', listId, { membersRemoved: removed.count });
    });
  }

  async addMembers(ctx: TenantRequestContext, listId: string, contactIds: string[]) {
    return inTenantRetrying(this.db, ctx, async (uow) => {
      await requireList(uow.tx, listId, { writable: true });
      const ids = await liveContactIds(uow.tx, contactIds);
      const added = await addToList(uow, ctx.access.orgId, ctx.access.workspaceId!, listId, ids, 'manual', ctx.principal.userId);
      return { added, alreadyMembers: ids.length - added };
    });
  }

  async removeMembers(ctx: TenantRequestContext, listId: string, contactIds: string[]) {
    return inTenantRetrying(this.db, ctx, async (uow) => {
      await requireList(uow.tx, listId, { writable: true });
      const removed = await removeFromList(uow, listId, [...new Set(contactIds)]);
      return { removed };
    });
  }

  private async memberCounts(tx: Tx, listIds: string[]) {
    if (!listIds.length) return new Map<string, number>();
    const rows = await tx.listMembership.groupBy({ by: ['listId'], where: { listId: { in: listIds }, contact: { deletedAt: null } }, _count: { _all: true } });
    return new Map(rows.map((r) => [r.listId, r._count._all]));
  }

  private view(l: { id: string; name: string; description: string; status: string; createdAt: Date; updatedAt: Date; version: number }, memberCount: number): ListView {
    return {
      id: l.id,
      name: l.name,
      description: l.description,
      status: l.status as ListView['status'],
      memberCount,
      createdAt: l.createdAt.toISOString(),
      updatedAt: l.updatedAt.toISOString(),
      version: l.version,
    };
  }
}

@Injectable()
export class TagsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(ctx: TenantRequestContext): Promise<TagView[]> {
    return inTenant(this.db, ctx, async ({ tx }) => {
      const tags = await tx.tag.findMany({ where: { deletedAt: null }, orderBy: { nameKey: 'asc' }, take: 1000 });
      const counts = tags.length
        ? await tx.contactTag.groupBy({ by: ['tagId'], where: { tagId: { in: tags.map((t) => t.id) }, contact: { deletedAt: null } }, _count: { _all: true } })
        : [];
      const byId = new Map(counts.map((r) => [r.tagId, r._count._all]));
      return tags.map((t) => this.view(t, byId.get(t.id) ?? 0));
    });
  }

  async create(ctx: TenantRequestContext, input: { name: string; color: string; description: string }): Promise<TagView> {
    try {
      return await inTenant(this.db, ctx, async ({ tx, event }) => {
        const t = await tx.tag.create({
          data: { orgId: ctx.access.orgId, workspaceId: ctx.access.workspaceId!, name: input.name, nameKey: nameKey(input.name), color: input.color, description: input.description },
        });
        await event('tag.created', t.id, { name: t.name });
        return this.view(t, 0);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw Errors.conflict('A tag with this name already exists', { name: ['Choose another name'] });
      throw err;
    }
  }

  async update(ctx: TenantRequestContext, tagId: string, input: { name?: string; color?: string; description?: string; version: number }): Promise<TagView> {
    try {
      return await inTenant(this.db, ctx, async ({ tx, event }) => {
        const t = await requireTag(tx, tagId);
        const changes = (['name', 'color', 'description'] as const).filter((k) => input[k] !== undefined && input[k] !== t[k]);
        if (changes.length) {
          const r = await tx.tag.updateMany({
            where: { id: tagId, version: input.version },
            data: {
              ...(input.name !== undefined ? { name: input.name, nameKey: nameKey(input.name) } : {}),
              ...(input.color !== undefined ? { color: input.color } : {}),
              ...(input.description !== undefined ? { description: input.description } : {}),
              updatedAt: new Date(),
              version: { increment: 1 },
            },
          });
          if (r.count !== 1) throw Errors.versionConflict();
          await event('tag.updated', tagId, { changes: [...changes] });
        }
        const fresh = await requireTag(tx, tagId);
        const count = await tx.contactTag.count({ where: { tagId, contact: { deletedAt: null } } });
        return this.view(fresh, count);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw Errors.conflict('A tag with this name already exists', { name: ['Choose another name'] });
      throw err;
    }
  }

  async delete(ctx: TenantRequestContext, tagId: string): Promise<void> {
    await inTenantRetrying(this.db, ctx, async ({ tx, event }) => {
      await requireTag(tx, tagId);
      const removed = await tx.contactTag.deleteMany({ where: { tagId } });
      await tx.tag.update({ where: { id: tagId }, data: { deletedAt: new Date(), nameKey: null, updatedAt: new Date(), version: { increment: 1 } } });
      await event('tag.deleted', tagId, { untagged: removed.count });
    });
  }

  async tag(ctx: TenantRequestContext, tagId: string, contactIds: string[]) {
    return inTenantRetrying(this.db, ctx, async (uow) => {
      await requireTag(uow.tx, tagId);
      const ids = await liveContactIds(uow.tx, contactIds);
      return { tagged: await tagContacts(uow, ctx.access.orgId, ctx.access.workspaceId!, tagId, ids, ctx.principal.userId) };
    });
  }

  async untag(ctx: TenantRequestContext, tagId: string, contactIds: string[]) {
    return inTenantRetrying(this.db, ctx, async (uow) => {
      await requireTag(uow.tx, tagId);
      return { untagged: await untagContacts(uow, tagId, [...new Set(contactIds)]) };
    });
  }

  private view(t: { id: string; name: string; color: string; description: string; version: number }, contactCount: number): TagView {
    return { id: t.id, name: t.name, color: t.color, description: t.description, contactCount, version: t.version };
  }
}
