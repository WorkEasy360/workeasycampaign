import type { CampaignAnalytics, EngagementMetric, EngagementMetrics, Metric } from '@workeasy/shared';

/** Display order and labels (Phase 7.10). Counts are unique recipients. */
const SHOWN: { key: EngagementMetric; label: string; kind: 'count' | 'rate' }[] = [
  { key: 'delivered', label: 'Delivered', kind: 'count' },
  { key: 'deliveryRate', label: 'Delivery rate', kind: 'rate' },
  { key: 'bounced', label: 'Bounced', kind: 'count' },
  { key: 'bounceRate', label: 'Bounce rate', kind: 'rate' },
  { key: 'deferred', label: 'Deferred', kind: 'count' },
  { key: 'uniqueOpens', label: 'Opened', kind: 'count' },
  { key: 'openRate', label: 'Open rate', kind: 'rate' },
  { key: 'uniqueClicks', label: 'Clicked', kind: 'count' },
  { key: 'clickRate', label: 'Click rate', kind: 'rate' },
  { key: 'ctor', label: 'Click-to-open', kind: 'rate' },
  { key: 'unsubscribed', label: 'Unsubscribed', kind: 'count' },
  { key: 'unsubscribeRate', label: 'Unsubscribe rate', kind: 'rate' },
  { key: 'complained', label: 'Complaints', kind: 'count' },
  { key: 'complaintRate', label: 'Complaint rate', kind: 'rate' },
];

const REASON: Record<Extract<Metric, { available: false }>['reason'], string> = {
  tracking_not_enabled: 'Not tracked',
  delivery_not_enabled: 'Unavailable',
  provider_unsupported: 'Not supported',
  not_applicable: 'Not applicable',
};

export function formatMetric(m: Metric, kind: 'count' | 'rate'): string {
  if (!m.available) return REASON[m.reason];
  if (m.value === null) return REASON.not_applicable;
  if (kind === 'count') return m.value.toLocaleString();
  const pct = m.value * 100;
  return `${pct > 0 && pct < 0.1 ? '<0.1' : pct.toFixed(pct < 10 ? 1 : 0)}%`;
}

/** True when nothing at all is measured (every metric is not tracked or unavailable). */
export function nothingTracked(e: EngagementMetrics): boolean {
  return Object.values(e).every((m) => !m.available && (m.reason === 'tracking_not_enabled' || m.reason === 'delivery_not_enabled'));
}

/**
 * Delivery outcomes and engagement. Every metric shows its value or why there is none — never a zero for data the
 * system does not have. The basis note says where the numbers come from (provider opens include automated opens).
 */
export function EngagementGrid({ engagement, basis }: { engagement: EngagementMetrics; basis: CampaignAnalytics['engagementBasis'] }) {
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        {SHOWN.map(({ key, label, kind }) => {
          const m = engagement[key];
          const measured = m.available && m.value !== null;
          return (
            <div key={key}>
              <dt className="text-xs text-ink-muted">{label}</dt>
              <dd className={measured ? 'text-lg font-semibold tabular-nums' : 'text-sm text-ink-muted'}>{formatMetric(m, kind)}</dd>
            </div>
          );
        })}
      </dl>
      {basis?.opensIncludeAutomated && (
        <p className="text-xs text-ink-muted">
          Opens and clicks are reported by the email provider ({basis.provider}) and include automated opens (for example Apple Mail Privacy
          Protection and link scanners), so open rates are an upper bound.
        </p>
      )}
      <p className="text-xs text-ink-muted">
        “Not tracked”: this workspace does not receive that feedback. “Not applicable”: a rate with nothing to divide by.
      </p>
    </div>
  );
}
