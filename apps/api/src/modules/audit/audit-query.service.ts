import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@workeasy/db';
import type { AuditLogView } from '@workeasy/shared';
import { decodeCursor, pageOf } from '../../common/pagination.js';
import type { TenantRequestContext } from '../../common/request-context.js';
import { DATABASE } from '../../infrastructure/providers.js';
import { inTenant } from '../tenancy/application/tenant-tx.js';

export interface AuditFilter {
  limit: number;
  cursor?: string;
  action?: string;
  actorId?: string;
  workspaceId?: string;
}

@Injectable()
export class AuditQueryService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(ctx: TenantRequestContext, f: AuditFilter) {
    const c = decodeCursor(f.cursor);
    const rows = await inTenant(this.db, ctx, ({ tx }) =>
      tx.auditLog.findMany({
        where: {
          orgId: ctx.access.orgId,
          ...(f.action ? { action: { startsWith: f.action } } : {}),
          ...(f.actorId ? { actorId: f.actorId } : {}),
          ...(f.workspaceId ? { workspaceId: f.workspaceId } : {}),
          ...(c ? { OR: [{ occurredAt: { lt: new Date(c.t) } }, { occurredAt: new Date(c.t), id: { lt: c.id } }] } : {}),
        },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: f.limit + 1,
      }),
    );
    const page = pageOf(rows, f.limit, (r) => ({ t: r.occurredAt.toISOString(), id: r.id }));
    return { data: page.data.map(toView), nextCursor: page.nextCursor };
  }

  /**
   * CSV export (up to 10 000 rows). The export itself is audited. Cells starting with = + - @ are prefixed with
   * an apostrophe so spreadsheet apps do not execute them (CSV formula injection).
   */
  async exportCsv(ctx: TenantRequestContext, f: Omit<AuditFilter, 'limit' | 'cursor'>): Promise<string> {
    return inTenant(this.db, ctx, async ({ tx, audit }) => {
      const rows = await tx.auditLog.findMany({
        where: {
          orgId: ctx.access.orgId,
          ...(f.action ? { action: { startsWith: f.action } } : {}),
          ...(f.actorId ? { actorId: f.actorId } : {}),
          ...(f.workspaceId ? { workspaceId: f.workspaceId } : {}),
        },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: 10_000,
      });
      await audit({ action: 'audit.exported', metadata: { rows: rows.length, filter: f } });
      const header = ['occurred_at', 'action', 'outcome', 'actor_email', 'actor_id', 'target_type', 'target_id', 'workspace_id', 'ip_address', 'metadata'];
      const lines = rows.map((r) => {
        const v = toView(r);
        return [v.occurredAt, v.action, v.outcome, (r.metadata as Record<string, unknown>).actorEmail ?? '', v.actor.id ?? '', v.target.type ?? '', v.target.id ?? '', v.workspaceId ?? '', v.ipAddress ?? '', JSON.stringify(v.metadata)]
          .map(csvCell)
          .join(',');
      });
      return [header.join(','), ...lines].join('\r\n');
    });
  }
}

function toView(r: {
  id: string;
  occurredAt: Date;
  action: string;
  outcome: string;
  actorType: string;
  actorId: string | null;
  targetType: string | null;
  targetId: string | null;
  workspaceId: string | null;
  ipAddress: string | null;
  metadata: unknown;
}): AuditLogView {
  const { actorName, ...metadata } = (r.metadata ?? {}) as Record<string, unknown>;
  return {
    id: r.id,
    occurredAt: r.occurredAt.toISOString(),
    action: r.action,
    outcome: r.outcome as AuditLogView['outcome'],
    actor: { type: r.actorType, id: r.actorId, displayName: typeof actorName === 'string' ? actorName : null },
    target: { type: r.targetType, id: r.targetId },
    workspaceId: r.workspaceId,
    ipAddress: r.ipAddress,
    metadata,
  };
}

export function csvCell(value: unknown): string {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
