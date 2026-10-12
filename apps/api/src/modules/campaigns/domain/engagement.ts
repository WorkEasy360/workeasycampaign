import type { EngagementMetric, EngagementMetrics, Metric } from '@workeasy/shared';

/** Unique per-recipient counts summed over executions (execution_engagement) plus the pipeline's sent. */
export interface EngagementCounts {
  sent: number;
  delivered: number;
  bouncedHard: number;
  bouncedSoft: number;
  complained: number;
  unsubscribed: number;
  openedUnique: number;
  clickedUnique: number;
}

/**
 * What this deployment can measure (Phase 7.10):
 *  - `feedback`     — provider webhooks are configured (delivered, bounces, complaints; opens/clicks if the provider can);
 *  - `unsubscribes` — messages carry our unsubscribe link (a provider delivery port), so unsubscribes are counted even
 *                     without webhooks;
 *  - `opens`/`clicks` — `tracked` (the provider can and we ask it to, per message), `not_enabled` (it can, tracking is
 *                       switched off: DELIVERY_TRACKING), `unsupported` (the provider cannot).
 */
export type Tracked = 'tracked' | 'not_enabled' | 'unsupported';
export interface TrackingCapabilities {
  feedback: boolean;
  unsubscribes: boolean;
  opens: Tracked;
  clicks: Tracked;
  /**
   * What the CHANNEL can report at all (messaging amendment; default true = email). SMS and WhatsApp providers report no
   * complaints, no deferrals and no unsubscribes: those metrics are `provider_unsupported` there, never a zero.
   */
  complaints?: boolean;
  deferrals?: boolean;
  unsubscribeFeedback?: boolean;
}

export const ZERO_COUNTS: EngagementCounts = { sent: 0, delivered: 0, bouncedHard: 0, bouncedSoft: 0, complained: 0, unsubscribed: 0, openedUnique: 0, clickedUnique: 0 };

const NOT_TRACKED: Metric = { available: false, reason: 'tracking_not_enabled' };
const UNSUPPORTED: Metric = { available: false, reason: 'provider_unsupported' };
const NOT_APPLICABLE: Metric = { available: false, reason: 'not_applicable' };
const count = (n: number): Metric => ({ available: true, value: n });
const rate = (n: number, d: number): Metric => (d > 0 ? { available: true, value: Math.min(n / d, 1) } : NOT_APPLICABLE);

/**
 * Engagement metrics from stored counts (analytics-tracking.md §2.2; rates are computed at read time, never stored).
 * Pure. Never returns a number for something that is not measured: not tracked, unsupported and not applicable are
 * distinct reasons; a measured zero is a real zero.
 */
export function engagementMetrics(c: EngagementCounts, t: TrackingCapabilities): EngagementMetrics {
  const m = {} as Record<EngagementMetric, Metric>;
  const fb = (v: Metric) => (t.feedback ? v : NOT_TRACKED);
  m.delivered = fb(count(c.delivered));
  m.deliveryRate = fb(rate(c.delivered, c.sent));
  m.bounced = fb(count(c.bouncedHard));
  m.bounceRate = fb(rate(c.bouncedHard, c.sent));
  const can = (flag: boolean | undefined, v: Metric) => (flag === false ? UNSUPPORTED : v);
  m.deferred = can(t.deferrals, fb(count(c.bouncedSoft)));
  const when = (k: Tracked, v: () => Metric) => (!t.feedback ? NOT_TRACKED : k === 'tracked' ? v() : k === 'unsupported' ? UNSUPPORTED : NOT_TRACKED);
  m.uniqueOpens = when(t.opens, () => count(c.openedUnique));
  m.openRate = when(t.opens, () => rate(c.openedUnique, c.delivered));
  m.uniqueClicks = when(t.clicks, () => count(c.clickedUnique));
  m.clickRate = when(t.clicks, () => rate(c.clickedUnique, c.delivered));
  // CTOR needs both: the less available of the two decides.
  m.ctor = when(t.opens === 'unsupported' || t.clicks === 'unsupported' ? 'unsupported' : t.opens === 'tracked' && t.clicks === 'tracked' ? 'tracked' : 'not_enabled', () => rate(c.clickedUnique, c.openedUnique));
  m.unsubscribed = can(t.unsubscribeFeedback, t.unsubscribes || t.feedback ? count(c.unsubscribed) : NOT_TRACKED);
  m.unsubscribeRate = can(t.unsubscribeFeedback, fb(rate(c.unsubscribed, c.delivered)));
  m.complained = can(t.complaints, fb(count(c.complained)));
  m.complaintRate = can(t.complaints, fb(rate(c.complained, c.delivered)));
  return m;
}
