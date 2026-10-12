/**
 * Campaign analytics v1 (docs/architecture/analytics-tracking.md §4). Only measured numbers: pipeline metrics from
 * Campaign-owned execution counters; engagement metrics are explicit `available: false` until tracking exists — never a
 * fabricated zero. Aggregates only: no contact or recipient data.
 */
import { z } from 'zod';
import { CAMPAIGN_DELIVERY_MODES } from '../campaigns.js';

const uuid = z.uuid();
const utcInstant = z.iso.datetime();

/** UTC period; defaults to the last 30 days, at most 366 days. */
export const campaignAnalyticsQuery = z
  .strictObject({ from: utcInstant.optional(), to: utcInstant.optional() })
  .refine((q) => !q.from || !q.to || Date.parse(q.from) < Date.parse(q.to), { path: ['from'], error: 'from must be before to' })
  .refine((q) => !q.from || !q.to || Date.parse(q.to) - Date.parse(q.from) <= 366 * 86_400_000, { path: ['to'], error: 'At most 366 days' });
export type CampaignAnalyticsQuery = z.infer<typeof campaignAnalyticsQuery>;

/**
 * A measured value, or why there is none (master prompt §17 — never a zero for missing data):
 *  - `tracking_not_enabled`  — NOT TRACKED: this deployment does not receive the feedback (no provider webhooks);
 *  - `delivery_not_enabled`  — UNAVAILABLE: nothing was handed to a provider;
 *  - `provider_unsupported`  — UNAVAILABLE: the configured provider cannot report it;
 *  - `not_applicable`        — NOT APPLICABLE: a rate whose denominator is zero (e.g. click-to-open with no opens).
 * `value: null` is kept for compatibility (pre-7.10 readers) and means the same as not_applicable.
 * A measured 0 is a real zero.
 */
export const METRIC_UNAVAILABLE_REASONS = ['tracking_not_enabled', 'delivery_not_enabled', 'provider_unsupported', 'not_applicable'] as const;
export const metricSchema = z.union([
  z.strictObject({ available: z.literal(true), value: z.number().nullable() }),
  z.strictObject({ available: z.literal(false), reason: z.enum(METRIC_UNAVAILABLE_REASONS) }),
]);
export type Metric = z.infer<typeof metricSchema>;

export const pipelineMetricsSchema = z.strictObject({
  runs: z.number().int().min(0),
  planned: z.number().int().min(0),
  skipped: z.number().int().min(0),
  sent: z.number().int().min(0),
  failed: z.number().int().min(0),
  skippedByReason: z.record(z.string().max(64), z.number().int().min(0)),
  /** sent / (planned + skipped); null when nothing was captured. */
  reachRate: z.number().min(0).max(1).nullable(),
});
export type PipelineMetrics = z.infer<typeof pipelineMetricsSchema>;

/**
 * Delivery outcomes and engagement (analytics-tracking.md §2.2, master prompt §17). Counts are unique per recipient;
 * rates use the denominators documented there (bounce and delivery rate over sent; the others over delivered; CTOR over
 * unique opens). Order is display order. Rejected = pipeline `failed`.
 */
export const ENGAGEMENT_METRICS = [
  'delivered', 'deliveryRate', 'bounced', 'bounceRate', 'deferred',
  'uniqueOpens', 'openRate', 'uniqueClicks', 'clickRate', 'ctor',
  'unsubscribed', 'unsubscribeRate', 'complained', 'complaintRate',
] as const;
export type EngagementMetric = (typeof ENGAGEMENT_METRICS)[number];
const engagementSchema = z.strictObject(Object.fromEntries(ENGAGEMENT_METRICS.map((m) => [m, metricSchema])) as Record<EngagementMetric, typeof metricSchema>);
export type EngagementMetrics = z.infer<typeof engagementSchema>;

/**
 * Where engagement numbers come from, so a reader can judge them. Opens and clicks reported by an email provider are
 * NOT machine-filtered (Apple Mail Privacy Protection, link scanners): open rate is an upper bound. null = nothing tracked.
 */
export const engagementBasisSchema = z
  .strictObject({ source: z.literal('provider_webhooks'), provider: z.string().max(40), opensIncludeAutomated: z.boolean() })
  .nullable();

export const campaignAnalyticsSchema = z.strictObject({
  period: z.strictObject({ from: utcInstant, to: utcInstant }),
  /** "sent" means accepted by the delivery port; in 'test' mode nothing left the system. */
  deliveryMode: z.enum(CAMPAIGN_DELIVERY_MODES),
  pipeline: pipelineMetricsSchema,
  engagement: engagementSchema,
  engagementBasis: engagementBasisSchema,
  /** Up to 20 campaigns with the most sent in the period. */
  perCampaign: z.array(z.strictObject({ campaignId: uuid, name: z.string(), lastCompletedAt: utcInstant, pipeline: pipelineMetricsSchema, engagement: engagementSchema })),
});
export type CampaignAnalytics = z.infer<typeof campaignAnalyticsSchema>;

/** One campaign's results (Phase 7.10): every completed run together, and the latest runs one by one (≤ 10). */
export const campaignResultsSchema = z.strictObject({
  campaignId: uuid,
  deliveryMode: z.enum(CAMPAIGN_DELIVERY_MODES),
  pipeline: pipelineMetricsSchema,
  engagement: engagementSchema,
  engagementBasis: engagementBasisSchema,
  /** Feedback keeps arriving after a run completes; this is the time of the latest event counted (null: none). */
  lastEventAt: utcInstant.nullable(),
  runs: z.array(
    z.strictObject({
      executionId: uuid,
      status: z.string().max(32),
      startedAt: utcInstant.nullable(),
      completedAt: utcInstant.nullable(),
      pipeline: pipelineMetricsSchema,
      engagement: engagementSchema,
    }),
  ),
});
export type CampaignResults = z.infer<typeof campaignResultsSchema>;
