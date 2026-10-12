'use client';

import { useQuery } from '@tanstack/react-query';
import type { CampaignAnalytics } from '@workeasy/shared';
import { Card, Spinner } from '@/components/ui';
import { http } from '@/lib/api';
import { useWorkspaceApi } from '@/lib/audience';
import { reasonLabel } from '@/lib/campaigns';
import { useCan } from '@/lib/session';
import { ErrorAlert } from './common';
import { EngagementGrid, nothingTracked } from './engagement';

/**
 * Campaign results of the last 30 days (docs/architecture/analytics-tracking.md; Phase 7.10). Shows only measured
 * numbers; delivery outcomes and engagement appear where this deployment measures them, each other metric says why not.
 */
export function CampaignResults() {
  const can = useCan();
  const { workspaceId, path } = useWorkspaceApi();
  const q = useQuery({
    queryKey: ['campaigns', workspaceId, 'analytics', '30d'],
    queryFn: ({ signal }) => http.get<CampaignAnalytics>(path('/campaigns/analytics'), signal),
    enabled: !!workspaceId && can('reports.read'),
    staleTime: 60_000,
  });
  if (!can('reports.read') || !workspaceId) return null;
  const p = q.data?.pipeline;
  const topReasons = p ? Object.entries(p.skippedByReason).sort((a, b) => b[1] - a[1]).slice(0, 3) : [];
  return (
    <Card title="Campaign results" description="Completed sends in the last 30 days.">
      {q.isLoading ? (
        <Spinner label="Loading results" />
      ) : q.isError ? (
        <ErrorAlert error={q.error} title="Results could not be loaded" onRetry={() => void q.refetch()} />
      ) : p && p.runs === 0 ? (
        <p className="text-sm text-ink-muted">No campaign finished sending in the last 30 days.</p>
      ) : p ? (
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Sends completed" value={p.runs.toLocaleString()} />
            <Stat label="Sent" value={p.sent.toLocaleString()} />
            <Stat label="Skipped" value={p.skipped.toLocaleString()} />
            <Stat label="Reached" value={p.reachRate === null ? '—' : `${Math.round(p.reachRate * 100)}%`} />
          </dl>
          {topReasons.length > 0 && (
            <p className="text-xs text-ink-muted">
              Most common reasons for skipping: {topReasons.map(([code, n]) => `${reasonLabel(code)} (${n.toLocaleString()})`).join(', ')}.
            </p>
          )}
          {q.data?.deliveryMode === 'test' && <p className="text-xs text-ink-muted">Test delivery mode: “sent” messages did not leave the system.</p>}
          {q.data && nothingTracked(q.data.engagement) ? (
            <p className="rounded-control bg-surface-muted p-3 text-xs text-ink-muted">
              Opens, clicks, bounces and unsubscribes are not tracked yet. They appear here once real delivery and tracking are enabled — until then
              nothing is estimated.
            </p>
          ) : q.data ? (
            <EngagementGrid engagement={q.data.engagement} basis={q.data.engagementBasis} />
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
