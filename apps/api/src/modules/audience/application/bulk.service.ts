import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@workeasy/db';
import type { BulkActionRequest, BulkActionResult, Permission } from '@workeasy/shared';
import { Errors } from '../../../common/errors.js';
import type { TenantRequestContext } from '../../../common/request-context.js';
import { DATABASE } from '../../../infrastructure/providers.js';
import { inTenant, inTenantRetrying } from '../../tenancy/application/tenant-tx.js';
import { canChangeSubscription } from '../domain/consent.js';
import { ContactsService } from './contacts.service.js';
import { addToList, removeFromList, requireList, requireTag, tagContacts, untagContacts } from './lists-tags.service.js';
import { addSuppression } from './suppression-eligibility.service.js';

/** "Select all matching" is processed up to this many contacts per request; the result says when it was capped. */
export const BULK_FILTER_CAP = 10_000;
const CHUNK = 500;

/** Each bulk action needs its own permission, on top of contacts.read (checked by the route guard). */
export const BULK_PERMISSION: Record<BulkActionRequest['action'], Permission> = {
  add_to_list: 'lists.manage',
  remove_from_list: 'lists.manage',
  tag: 'tags.manage',
  untag: 'tags.manage',
  suppress: 'suppression.manage',
  unsubscribe: 'contacts.update',
  delete: 'contacts.delete',
};

@Injectable()
export class BulkService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly contacts: ContactsService,
  ) {}

  async run(ctx: TenantRequestContext, req: BulkActionRequest): Promise<BulkActionResult> {
    const permission = BULK_PERMISSION[req.action];
    if (!ctx.access.permissions.has(permission)) {
      await inTenant(this.db, ctx, ({ audit }) =>
        audit({ action: 'access.denied', outcome: 'denied', metadata: { permission, bulkAction: req.action } }),
      );
      throw Errors.forbidden();
    }
    this.assertParams(req);

    // 1. Resolve the selection to live contact ids in this workspace (RLS makes foreign ids invisible).
    const { ids, truncated } = await inTenant(this.db, ctx, async ({ tx }) => {
      if ('contactIds' in req.selection) {
        const rows = await tx.contact.findMany({
          where: { id: { in: [...new Set(req.selection.contactIds)] }, deletedAt: null, erasedAt: null },
          select: { id: true },
        });
        return { ids: rows.map((r) => r.id), truncated: false };
      }
      const { where } = await this.contacts.resolveFilter(tx, { ...req.selection.filter, deleted: 'exclude' });
      const rows = await tx.contact.findMany({ where, select: { id: true }, orderBy: { createdAt: 'desc' }, take: BULK_FILTER_CAP + 1 });
      return { ids: rows.slice(0, BULK_FILTER_CAP).map((r) => r.id), truncated: rows.length > BULK_FILTER_CAP };
    });

    // 2. Apply in chunks: each chunk is one transaction with its events, so a failure never leaves half a chunk.
    let affected = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      // Each chunk is one transaction; a deadlock or serialization failure rolls it back entirely and it is re-run.
      affected += await inTenantRetrying(this.db, ctx, (uow) => this.applyChunk(ctx, uow, req, chunk));
    }

    // 3. One audit record for the whole operation.
    await inTenant(this.db, ctx, ({ audit }) =>
      audit({
        action: 'contacts.bulk_action',
        metadata: {
          bulkAction: req.action,
          selection: 'contactIds' in req.selection ? 'ids' : 'filter',
          matched: ids.length,
          affected,
          truncated,
          listId: req.listId,
          tagId: req.tagId,
          channel: req.channel,
        },
      }),
    );
    const requested = 'contactIds' in req.selection ? new Set(req.selection.contactIds).size : ids.length;
    return { matched: ids.length, affected, skipped: requested - affected, truncated };
  }

  private async applyChunk(ctx: TenantRequestContext, uow: Parameters<Parameters<typeof inTenant>[2]>[0], req: BulkActionRequest, ids: string[]): Promise<number> {
    const { orgId } = ctx.access;
    const workspaceId = ctx.access.workspaceId!;
    const userId = ctx.principal.userId;
    switch (req.action) {
      case 'add_to_list':
        await requireList(uow.tx, req.listId!, { writable: true });
        return addToList(uow, orgId, workspaceId, req.listId!, ids, 'bulk', userId);
      case 'remove_from_list':
        await requireList(uow.tx, req.listId!, { writable: true });
        return removeFromList(uow, req.listId!, ids);
      case 'tag':
        await requireTag(uow.tx, req.tagId!);
        return tagContacts(uow, orgId, workspaceId, req.tagId!, ids, userId);
      case 'untag':
        await requireTag(uow.tx, req.tagId!);
        return untagContacts(uow, req.tagId!, ids);
      case 'suppress': {
        let n = 0;
        for (const contactId of ids) {
          const r = await addSuppression(uow, orgId, workspaceId, {
            channel: req.channel!,
            reason: req.reason ?? 'manual',
            source: 'admin',
            note: req.note ?? '',
            userId,
            target: { contactId },
          });
          if (r.created) n++;
        }
        return n;
      }
      case 'unsubscribe': {
        const rows = await uow.tx.contact.findMany({ where: { id: { in: ids } }, select: { id: true, subscriptionType: true, unsubscribedBy: true } });
        const changing = rows.filter((c) => canChangeSubscription(c.subscriptionType, c.unsubscribedBy, 'unsubscribed', 'user').ok);
        if (!changing.length) return 0;
        const now = new Date();
        await uow.tx.contact.updateMany({
          where: { id: { in: changing.map((c) => c.id) } },
          data: { subscriptionType: 'unsubscribed', unsubscribedBy: 'user', subscriptionChangedAt: now, updatedAt: now, version: { increment: 1 } },
        });
        await uow.events('contact.subscription_changed', changing.map((c) => ({ aggregateId: c.id, payload: { from: c.subscriptionType, to: 'unsubscribed', by: 'user' } })));
        return changing.length;
      }
      case 'delete': {
        // Only contacts still live at this moment are deleted, and only they get an event (a retried or concurrent
        // bulk delete must not emit contact.deleted twice for the same contact).
        const live = (await uow.tx.contact.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true } })).map((c) => c.id);
        if (!live.length) return 0;
        const now = new Date();
        await uow.tx.contact.updateMany({ where: { id: { in: live } }, data: { deletedAt: now, updatedAt: now, version: { increment: 1 } } });
        await uow.events('contact.deleted', live.map((id) => ({ aggregateId: id, payload: {} })));
        return live.length;
      }
    }
  }

  private assertParams(req: BulkActionRequest) {
    if ((req.action === 'add_to_list' || req.action === 'remove_from_list') && !req.listId) throw Errors.validation({ listId: ['Choose a list'] });
    if ((req.action === 'tag' || req.action === 'untag') && !req.tagId) throw Errors.validation({ tagId: ['Choose a tag'] });
    if (req.action === 'suppress' && !req.channel) throw Errors.validation({ channel: ['Choose a channel'] });
  }
}
