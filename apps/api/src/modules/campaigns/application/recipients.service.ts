import { Inject, Injectable } from '@nestjs/common';
import type { AudienceProfiles } from '@workeasy/audience-core';
import type { Database, Tx } from '@workeasy/db';
import type { Permission, RecipientListItem, RecipientListQuery, RecipientStatus } from '@workeasy/shared';
import { Errors } from '../../../common/errors.js';
import { cursorScope, decodeCursor, encodeCursor } from '../../../common/pagination.js';
import type { TenantRequestContext } from '../../../common/request-context.js';
import { AUDIENCE_PROFILES, DATABASE } from '../../../infrastructure/providers.js';
import { inTenant } from '../../tenancy/application/tenant-tx.js';
import { CampaignsService } from './campaigns.service.js';

/** Statuses whose rows carry reason codes; execution statuses whose per-reason counts are final. */
const REASON_STATUSES: RecipientStatus[] = ['skipped', 'skipped_at_send'];
const FINAL = ['completed', 'cancelled', 'failed'];

/**
 * Row 23 — the recipients of one execution (contract §15; previously deferred for want of an Audience port). Recipient
 * rows are Campaign-owned (ids, status, reason codes); the contact's DISPLAY NAME comes from the Audience Profiles port
 * (RULE 2: never the contacts table) — never an address. Needs `contacts.read` besides `campaigns.read`, because the
 * list names people. Keyset by recipient id; one port call per page (≤ 100 ids).
 */
@Injectable()
export class RecipientsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIENCE_PROFILES) private readonly profiles: AudienceProfiles<Tx>,
    private readonly campaigns: CampaignsService,
  ) {}

  async list(ctx: TenantRequestContext, campaignId: string, executionId: string, q: RecipientListQuery): Promise<{ data: RecipientListItem[]; nextCursor: string | null }> {
    await this.campaigns.requirePermissions(ctx, new Set<Permission>(['contacts.read']), 'recipients');
    const scope = cursorScope(ctx.access, 'campaign.recipients', { campaignId, executionId, status: q.status, reason: q.reason });
    const cursor = decodeCursor(q.cursor, scope);
    return inTenant(this.db, ctx, async ({ tx }) => {
      const execution = await tx.campaignExecution.findFirst({ where: { id: executionId, campaignId }, select: { id: true, status: true, skippedByReason: true } });
      if (!execution) throw Errors.notFound('Execution');
      // Reason codes exist only on skipped rows (capture or send time). A reason filter therefore reads only those rows
      // through the (execution_id, status, id) index — never every recipient (MEASURED: 2 s at 500k before, §6.13). For a
      // finished execution the per-reason counts are authoritative (recomputed from the rows), so a reason it never had
      // is answered without reading any row.
      if (q.reason) {
        if (q.status && !REASON_STATUSES.includes(q.status)) return { data: [], nextCursor: null };
        const counts = (execution.skippedByReason ?? {}) as Record<string, number>;
        if (FINAL.includes(execution.status) && !counts[q.reason]) return { data: [], nextCursor: null };
      }
      const rows = await tx.campaignRecipient.findMany({
        where: {
          executionId,
          ...(q.status ? { status: q.status } : q.reason ? { status: { in: REASON_STATUSES } } : {}),
          ...(q.reason ? { reasonCodes: { has: q.reason } } : {}),
          ...(cursor ? { id: { gt: cursor.id } } : {}),
        },
        orderBy: { id: 'asc' },
        take: q.limit + 1,
        select: { id: true, contactId: true, status: true, reasonCodes: true, updatedAt: true },
      });
      const page = rows.slice(0, q.limit);
      const names = await this.profiles.displayNames({ tx, orgId: ctx.access.orgId, workspaceId: ctx.access.workspaceId! }, page.map((r) => r.contactId));
      const last = page.at(-1);
      return {
        data: page.map((r) => ({
          id: r.id,
          contact: { id: r.contactId, displayName: names.get(r.contactId) ?? 'Unknown contact' },
          status: r.status as RecipientStatus,
          reasonCodes: r.reasonCodes,
          updatedAt: r.updatedAt.toISOString(),
        })),
        nextCursor: rows.length > q.limit && last ? encodeCursor({ t: last.updatedAt.toISOString(), id: last.id }, scope) : null,
      };
    });
  }
}
