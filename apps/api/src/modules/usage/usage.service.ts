import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AudienceUsage } from '@workeasy/audience-core';
import type { Database, Tx } from '@workeasy/db';
import { USAGE_METER_KINDS, USAGE_METERS, type UsageMeter, type UsageSummary, type UsageSummaryQuery } from '@workeasy/shared';
import { Errors } from '../../common/errors.js';
import type { TenantRequestContext } from '../../common/request-context.js';
import { recordUsage, utcDay } from '../../common/usage.js';
import { AUDIENCE_USAGE, DATABASE } from '../../infrastructure/providers.js';
import { inTenant } from '../tenancy/application/tenant-tx.js';

const DEFAULT_DAYS = 30;
const MAX_DAYS = 400;
const PAGE = 200;

/**
 * Usage metering (Phase 7.13; docs/architecture/ai-billing-readiness.md §2).
 *  - Counters (campaign.executions, messages.sent) are written by their owners in the same transaction as the fact.
 *  - Gauges (templates.active, contacts.active, storage.bytes) are snapshotted once per UTC day per active workspace
 *    by `snapshotAll` (scheduler role, hourly, idempotent per day: the first snapshot of a day wins).
 *  - `summary` reads an organization's usage for a period: quantities only. Plans, prices and limits belong to a
 *    future billing context that consumes the same ledger.
 */
@Injectable()
export class UsageService {
  private readonly log = new Logger('Usage');
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIENCE_USAGE) private readonly audience: AudienceUsage<Tx>,
  ) {}

  /** Daily gauges for every active workspace. Returns the number of workspaces measured. */
  async snapshotAll(now = new Date()): Promise<number> {
    const day = utcDay(now);
    const at = new Date(`${day}T00:00:00.000Z`).toISOString();
    let after: string | null = null;
    let n = 0;
    for (;;) {
      const page = await this.db.system.usageSnapshotWorkspaces(after, PAGE);
      if (!page.length) return n;
      for (const w of page) {
        try {
          await this.db.withTenant({ orgId: w.orgId, workspaceId: w.workspaceId, userId: null }, async (tx) => {
            const scope = { tx, orgId: w.orgId, workspaceId: w.workspaceId };
            const templates = await tx.emailTemplate.count({ where: { workspaceId: w.workspaceId, deletedAt: null } });
            const contacts = await this.audience.activeContacts(scope);
            const bytes = await this.audience.storedImportBytes(scope);
            const rec = (meter: UsageMeter, quantity: number) => ({
              schema: 'usage.record.v1' as const,
              recordId: `${meter}:${w.workspaceId}:${day}`,
              meter,
              orgId: w.orgId,
              workspaceId: w.workspaceId,
              quantity,
              at,
            });
            await recordUsage(tx, [rec('templates.active', templates), rec('contacts.active', contacts), rec('storage.bytes', bytes)]);
          });
          n++;
        } catch (err) {
          // One workspace failing never stops the others; the next hourly run retries the day.
          this.log.error(JSON.stringify({ alert: 'usage_snapshot_failed', orgId: w.orgId, workspaceId: w.workspaceId, err: err instanceof Error ? err.name : 'Error' }));
        }
      }
      after = page.at(-1)!.workspaceId;
    }
  }

  start(intervalMs = 3_600_000): void {
    if (this.timer) return;
    const tick = () => {
      if (this.busy) return;
      this.busy = true;
      void this.snapshotAll()
        .catch((err: unknown) => this.log.error(JSON.stringify({ alert: 'usage_snapshot_failed', err: err instanceof Error ? err.name : 'Error' })))
        .finally(() => {
          this.busy = false;
        });
    };
    tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async summary(ctx: TenantRequestContext, q: UsageSummaryQuery): Promise<UsageSummary> {
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - DEFAULT_DAYS * 86_400_000);
    if (from >= to) throw Errors.validation({ from: ['from must be before to'] });
    if (to.getTime() - from.getTime() > MAX_DAYS * 86_400_000) throw Errors.validation({ from: [`At most ${MAX_DAYS} days`] });
    const orgId = ctx.access.orgId;
    return inTenant(
      this.db,
      ctx,
      async ({ tx }) => {
        const counters = await tx.$queryRaw<{ meter: UsageMeter; workspace_id: string | null; value: bigint; as_of: Date | null }[]>`
          SELECT meter, workspace_id::text AS workspace_id, sum(quantity)::bigint AS value, NULL::timestamptz AS as_of
            FROM usage_records
           WHERE org_id = ${orgId}::uuid AND at >= ${from} AND at < ${to} AND meter IN ('campaign.executions', 'messages.sent', 'ai.tokens')
           GROUP BY meter, workspace_id`;
        const gauges = await tx.$queryRaw<{ meter: UsageMeter; workspace_id: string | null; value: bigint; as_of: Date }[]>`
          SELECT DISTINCT ON (meter, workspace_id) meter, workspace_id::text AS workspace_id, quantity::bigint AS value, at AS as_of
            FROM usage_records
           WHERE org_id = ${orgId}::uuid AND at >= ${from} AND at < ${to} AND meter IN ('contacts.active', 'templates.active', 'storage.bytes')
           ORDER BY meter, workspace_id, at DESC`;
        const names = new Map((await tx.workspace.findMany({ where: { orgId }, select: { id: true, name: true } })).map((w) => [w.id, w.name]));
        const rows = [...counters, ...gauges];
        return {
          period: { from: from.toISOString(), to: to.toISOString() },
          meters: USAGE_METERS.map((meter) => {
            const mine = rows.filter((r) => r.meter === meter);
            const asOf = mine.reduce<Date | null>((a, r) => (r.as_of && (!a || r.as_of > a) ? r.as_of : a), null);
            return {
              meter,
              kind: USAGE_METER_KINDS[meter],
              total: mine.reduce((a, r) => a + Number(r.value), 0),
              asOf: USAGE_METER_KINDS[meter] === 'gauge' && asOf ? asOf.toISOString() : null,
              byWorkspace: mine
                .filter((r) => r.workspace_id)
                .map((r) => ({ workspaceId: r.workspace_id!, name: names.get(r.workspace_id!) ?? '', value: Number(r.value) }))
                .sort((a, b) => b.value - a.value),
            };
          }),
        };
      },
      { workspaceScoped: false },
    );
  }
}
