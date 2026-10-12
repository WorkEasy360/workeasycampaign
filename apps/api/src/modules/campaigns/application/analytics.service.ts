import { Inject, Injectable } from '@nestjs/common';
import type { ChannelAdapter } from '@workeasy/channels';
import type { Database, Tx } from '@workeasy/db';
import type { CampaignAnalytics, CampaignAnalyticsQuery, CampaignResults, Channel, PipelineMetrics } from '@workeasy/shared';
import type { AppConfig } from '../../../config/env.js';
import type { TenantRequestContext } from '../../../common/request-context.js';
import { Errors } from '../../../common/errors.js';
import { APP_CONFIG, DATABASE, DELIVERY_ADAPTER, SMS_ADAPTER, WHATSAPP_ADAPTER } from '../../../infrastructure/providers.js';
import { inTenant } from '../../tenancy/application/tenant-tx.js';
import { isDeliveryAvailable } from '../domain/delivery-mode.js';
import { type EngagementCounts, engagementMetrics, type TrackingCapabilities } from '../domain/engagement.js';

const DEFAULT_DAYS = 30;
const TOP_CAMPAIGNS = 20;
const MAX_DAYS = 366;
const RECENT_RUNS = 10;

/** Sums come back as bigint (no int overflow in SQL) and are converted with Number(). */
type Big = number | bigint;
type Sums = { runs: Big; planned: Big; skipped: Big; sent: Big; failed: Big };
type Engaged = { delivered: Big; bounced_hard: Big; bounced_soft: Big; complained: Big; unsubscribed: Big; opened_unique: Big; clicked_unique: Big };

/**
 * Engagement sums over the executions of the FROM clause (alias `g` = execution_engagement, LEFT JOINed). A constant:
 * the queries below interpolate only constants ($queryRawUnsafe); every value is a bound parameter ($1…).
 */
const ENGAGED_SQL = `coalesce(sum(g.delivered), 0)::bigint AS delivered, coalesce(sum(g.bounced_hard), 0)::bigint AS bounced_hard,
  coalesce(sum(g.bounced_soft), 0)::bigint AS bounced_soft, coalesce(sum(g.complained), 0)::bigint AS complained,
  coalesce(sum(g.unsubscribed), 0)::bigint AS unsubscribed, coalesce(sum(g.opened_unique), 0)::bigint AS opened_unique,
  coalesce(sum(g.clicked_unique), 0)::bigint AS clicked_unique`;

/**
 * Campaign analytics (docs/architecture/analytics-tracking.md §4; Phase 7.10). Pipeline metrics are sums of the
 * Campaign-owned execution counters of COMPLETED runs whose `completed_at` is in the period (the runner recomputes
 * those counters from recipient rows at completion). Delivery outcomes and engagement are sums of the per-execution
 * rollups (`execution_engagement`, maintained by webhook ingestion and the unsubscribe endpoint) of the same runs —
 * never recomputed from recipient rows or raw events on a request. What this deployment cannot measure is reported with
 * its reason, never as zero. Read-only, RLS-scoped, aggregates only.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DELIVERY_ADAPTER) private readonly adapter: (ChannelAdapter & { provider?: string }) | null,
    @Inject(SMS_ADAPTER) private readonly smsAdapter: (ChannelAdapter & { provider?: string }) | null,
    @Inject(WHATSAPP_ADAPTER) private readonly whatsappAdapter: (ChannelAdapter & { provider?: string }) | null,
  ) {}

  /**
   * What can be measured here, per channel (see TrackingCapabilities). SMS (Twilio status callbacks): delivered and
   * failed only. WhatsApp (Meta statuses): delivered, failed and read receipts (reported as opens; a recipient can turn
   * read receipts off, so it is a lower bound). Neither reports complaints, deferrals or unsubscribes.
   */
  tracking(channel: Channel = 'email'): TrackingCapabilities & { provider: string | null } {
    const available = isDeliveryAvailable(this.config.campaignDeliveryMode);
    if (channel !== 'email') {
      const a = available ? (channel === 'sms' ? this.smsAdapter : this.whatsappAdapter) : null;
      const secret = channel === 'sms' ? this.config.smsProvider?.authToken : this.config.whatsappProvider?.appSecret;
      const feedback = !!a?.capabilities.feedbackWebhooks && !!a.provider && !!secret;
      return {
        provider: a?.provider ?? null,
        feedback,
        unsubscribes: false,
        opens: channel === 'whatsapp' && a?.capabilities.tracking.opens ? 'tracked' : 'unsupported',
        clicks: 'unsupported',
        complaints: false,
        deferrals: false,
        unsubscribeFeedback: false,
      };
    }
    const a = available ? this.adapter : null;
    const feedback = !!a?.capabilities.feedbackWebhooks && !!a.provider && !!this.config.deliveryWebhookSigningKey;
    const level = (can: boolean, on: boolean) => (!can ? ('unsupported' as const) : on ? ('tracked' as const) : ('not_enabled' as const));
    return {
      provider: a?.provider ?? null,
      feedback,
      unsubscribes: !!a,
      opens: level(!!a?.capabilities.tracking.opens, this.config.deliveryTracking.opens),
      clicks: level(!!a?.capabilities.tracking.clicks, this.config.deliveryTracking.clicks),
    };
  }

  private basis(t: ReturnType<AnalyticsService['tracking']>, channel: Channel = 'email'): CampaignAnalytics['engagementBasis'] {
    // Email opens include automated opens (Apple MPP, scanners); WhatsApp read receipts do not (they are a lower bound).
    return t.feedback && t.provider ? { source: 'provider_webhooks', provider: t.provider, opensIncludeAutomated: channel === 'email' } : null;
  }

  async campaigns(ctx: TenantRequestContext, q: CampaignAnalyticsQuery): Promise<CampaignAnalytics> {
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - DEFAULT_DAYS * 86_400_000);
    // The span rule applies AFTER defaults (a lone `from` must not widen the period to the whole history).
    if (from >= to) throw Errors.validation({ from: ['from must be before to'] });
    if (to.getTime() - from.getTime() > MAX_DAYS * 86_400_000) throw Errors.validation({ from: [`At most ${MAX_DAYS} days`] });
    const ws = ctx.access.workspaceId!;
    const t = this.tracking();
    return inTenant(this.db, ctx, async ({ tx }) => {
      // Workspace engagement covers EMAIL campaigns (rates over email sends); SMS / WhatsApp results are per campaign, with
      // their own channel capabilities. The pipeline covers every channel.
      const [total] = await tx.$queryRawUnsafe<(Sums & Engaged & { email_sent: Big })[]>(
        `SELECT count(*)::int AS runs, coalesce(sum(e.planned), 0)::bigint AS planned, coalesce(sum(e.skipped), 0)::bigint AS skipped,
                coalesce(sum(e.sent), 0)::bigint AS sent, coalesce(sum(e.failed), 0)::bigint AS failed, ${ENGAGED_SQL},
                coalesce(sum(e.sent) FILTER (WHERE c.channel = 'email'), 0)::bigint AS email_sent
           FROM campaign_executions e
           JOIN campaigns c ON c.id = e.campaign_id
           LEFT JOIN execution_engagement g ON g.execution_id = e.id AND c.channel = 'email'
          WHERE e.workspace_id = $1::uuid AND e.status = 'completed' AND e.completed_at >= $2 AND e.completed_at < $3`,
        ws, from, to,
      );
      const reasons = await this.reasons(tx, ws, from, to, null);
      const top = await tx.$queryRawUnsafe<(Sums & Engaged & { campaign_id: string; name: string; channel: Channel; last_completed_at: Date })[]>(
        `SELECT e.campaign_id::text AS campaign_id, c.name, c.channel, max(e.completed_at) AS last_completed_at, count(*)::int AS runs,
                sum(e.planned)::bigint AS planned, sum(e.skipped)::bigint AS skipped, sum(e.sent)::bigint AS sent, sum(e.failed)::bigint AS failed, ${ENGAGED_SQL}
           FROM campaign_executions e
           JOIN campaigns c ON c.id = e.campaign_id
           LEFT JOIN execution_engagement g ON g.execution_id = e.id
          WHERE e.workspace_id = $1::uuid AND e.status = 'completed' AND e.completed_at >= $2 AND e.completed_at < $3
          GROUP BY e.campaign_id, c.name, c.channel
          ORDER BY sum(e.sent) DESC, max(e.completed_at) DESC
          LIMIT ${TOP_CAMPAIGNS}`,
        ws, from, to,
      );
      const perReasons = top.length ? await this.reasons(tx, ws, from, to, top.map((x) => x.campaign_id)) : new Map<string, Record<string, number>>();
      return {
        period: { from: from.toISOString(), to: to.toISOString() },
        deliveryMode: this.config.campaignDeliveryMode,
        pipeline: pipeline(total!, reasons.get('*') ?? {}),
        engagement: engagementMetrics({ ...counts(total!), sent: Number(total!.email_sent) }, t),
        engagementBasis: this.basis(t),
        perCampaign: top.map((x) => ({
          campaignId: x.campaign_id,
          name: x.name,
          lastCompletedAt: x.last_completed_at.toISOString(),
          pipeline: pipeline(x, perReasons.get(x.campaign_id) ?? {}),
          engagement: engagementMetrics(counts(x), this.tracking(x.channel)),
        })),
      };
    });
  }

  /** One campaign's results: all completed runs together, and the latest runs one by one (Phase 7.10). */
  async campaign(ctx: TenantRequestContext, campaignId: string): Promise<CampaignResults> {
    const ws = ctx.access.workspaceId!;
    return inTenant(this.db, ctx, async ({ tx }) => {
      const c = await tx.campaign.findFirst({ where: { id: campaignId, workspaceId: ws, deletedAt: null }, select: { id: true, channel: true } });
      if (!c) throw Errors.notFound('Campaign');
      const t = this.tracking(c.channel as Channel);
      const [total] = await tx.$queryRawUnsafe<(Sums & Engaged & { last_event_at: Date | null })[]>(
        `SELECT count(*)::int AS runs, coalesce(sum(e.planned), 0)::bigint AS planned, coalesce(sum(e.skipped), 0)::bigint AS skipped,
                coalesce(sum(e.sent), 0)::bigint AS sent, coalesce(sum(e.failed), 0)::bigint AS failed, ${ENGAGED_SQL}, max(g.last_event_at) AS last_event_at
           FROM campaign_executions e LEFT JOIN execution_engagement g ON g.execution_id = e.id
          WHERE e.workspace_id = $1::uuid AND e.campaign_id = $2::uuid AND e.status = 'completed'`,
        ws, campaignId,
      );
      const runs = await tx.$queryRawUnsafe<(Engaged & { id: string; status: string; started_at: Date | null; completed_at: Date | null; planned: Big; skipped: Big; sent: Big; failed: Big; skipped_by_reason: Record<string, number> })[]>(
        `SELECT e.id::text AS id, e.status, e.started_at, e.completed_at, e.planned::bigint AS planned, e.skipped::bigint AS skipped, e.sent::bigint AS sent,
                e.failed::bigint AS failed, e.skipped_by_reason,
                coalesce(g.delivered, 0) AS delivered, coalesce(g.bounced_hard, 0) AS bounced_hard, coalesce(g.bounced_soft, 0) AS bounced_soft,
                coalesce(g.complained, 0) AS complained, coalesce(g.unsubscribed, 0) AS unsubscribed, coalesce(g.opened_unique, 0) AS opened_unique,
                coalesce(g.clicked_unique, 0) AS clicked_unique
           FROM campaign_executions e LEFT JOIN execution_engagement g ON g.execution_id = e.id
          WHERE e.workspace_id = $1::uuid AND e.campaign_id = $2::uuid
          ORDER BY e.run_number DESC
          LIMIT ${RECENT_RUNS}`,
        ws, campaignId,
      );
      const allReasons = new Map<string, number>();
      const [completedReasons] = await tx.$queryRawUnsafe<{ r: Record<string, string> | null }[]>(
        `SELECT jsonb_object_agg(k, n) AS r FROM (
           SELECT x.key AS k, sum(x.value::bigint)::text AS n
             FROM campaign_executions e CROSS JOIN LATERAL jsonb_each_text(e.skipped_by_reason) AS x(key, value)
            WHERE e.workspace_id = $1::uuid AND e.campaign_id = $2::uuid AND e.status = 'completed'
            GROUP BY x.key) s`,
        ws, campaignId,
      );
      for (const [k, v] of Object.entries(completedReasons?.r ?? {})) allReasons.set(k, Number(v));
      return {
        campaignId,
        deliveryMode: this.config.campaignDeliveryMode,
        pipeline: pipeline(total!, Object.fromEntries(allReasons)),
        engagement: engagementMetrics(counts(total!), t),
        engagementBasis: this.basis(t, c.channel as Channel),
        lastEventAt: total!.last_event_at ? total!.last_event_at.toISOString() : null,
        runs: runs.map((r) => ({
          executionId: r.id,
          status: r.status,
          startedAt: r.started_at?.toISOString() ?? null,
          completedAt: r.completed_at?.toISOString() ?? null,
          pipeline: pipeline({ runs: 1, planned: r.planned, skipped: r.skipped, sent: r.sent, failed: r.failed }, numbers(r.skipped_by_reason)),
          engagement: engagementMetrics(counts({ ...r, sent: r.sent }), t),
        })),
      };
    });
  }

  /** Skip reasons summed over the period: key '*' for the workspace, or per campaign id when `campaignIds` is given. */
  private async reasons(tx: Tx, ws: string, from: Date, to: Date, campaignIds: string[] | null): Promise<Map<string, Record<string, number>>> {
    const rows = await tx.$queryRaw<{ scope: string; reason: string; n: bigint }[]>`
      SELECT CASE WHEN ${campaignIds}::uuid[] IS NULL THEN '*' ELSE e.campaign_id::text END AS scope, r.key AS reason, sum(r.value::bigint)::bigint AS n
        FROM campaign_executions e CROSS JOIN LATERAL jsonb_each_text(e.skipped_by_reason) AS r(key, value)
       WHERE e.workspace_id = ${ws}::uuid AND e.status = 'completed' AND e.completed_at >= ${from} AND e.completed_at < ${to}
         AND (${campaignIds}::uuid[] IS NULL OR e.campaign_id = ANY (${campaignIds}::uuid[]))
       GROUP BY 1, 2`;
    const out = new Map<string, Record<string, number>>();
    for (const r of rows) (out.get(r.scope) ?? out.set(r.scope, {}).get(r.scope)!)[r.reason] = Number(r.n);
    return out;
  }
}

function counts(r: Engaged & { sent: Big }): EngagementCounts {
  return {
    sent: Number(r.sent),
    delivered: Number(r.delivered),
    bouncedHard: Number(r.bounced_hard),
    bouncedSoft: Number(r.bounced_soft),
    complained: Number(r.complained),
    unsubscribed: Number(r.unsubscribed),
    openedUnique: Number(r.opened_unique),
    clickedUnique: Number(r.clicked_unique),
  };
}

function numbers(o: Record<string, unknown> | null): Record<string, number> {
  return Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, Number(v)]));
}

function pipeline(raw: Sums, skippedByReason: Record<string, number>): PipelineMetrics {
  const s = { runs: Number(raw.runs), planned: Number(raw.planned), skipped: Number(raw.skipped), sent: Number(raw.sent), failed: Number(raw.failed) };
  const captured = s.planned + s.skipped;
  return { runs: s.runs, planned: s.planned, skipped: s.skipped, sent: s.sent, failed: s.failed, skippedByReason, reachRate: captured ? s.sent / captured : null };
}
