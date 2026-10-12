'use client';

import { useQuery } from '@tanstack/react-query';
import type { CampaignResults, CampaignView } from '@workeasy/shared';
import { Card, Spinner } from '@/components/ui';
import { http } from '@/lib/api';
import { useWorkspaceApi } from '@/lib/audience';
import { relativeTime } from '@/lib/format';
import { useCan } from '@/lib/session';
import { ErrorAlert } from './common';
import { EngagementGrid, formatMetric, nothingTracked } from './engagement';

/**
 * One campaign's results (Phase 7.10): its completed runs together, then the latest runs. Read from rollups; feedback
 * keeps arriving after a run completes, so the time of the latest event is shown. Needs reports.read.
 */
export function CampaignOutcomes({ campaign }: { campaign: CampaignView }) {
  const can = useCan();
  const { workspaceId, path } = useWorkspaceApi();
  const enabled = !!workspaceId && can('reports.read') && campaign.status !== 'draft';
  const q = useQuery({
    queryKey: ['campaigns', workspaceId, campaign.id, 'results'],
    queryFn: ({ signal }) => http.get<CampaignResults>(path(`/campaigns/${campaign.id}/results`), signal),
    enabled,
    staleTime: 30_000,
  });
  if (!enabled) return null;
  const r = q.data;
  return (
    <Card title="Results" description={r?.lastEventAt ? `Latest feedback ${relativeTime(r.lastEventAt)}.` : 'Completed sends of this campaign.'}>
      {q.isLoading ? (
        <Spinner label="Loading results" />
      ) : q.isError ? (
        <ErrorAlert error={q.error} title="Results could not be loaded" onRetry={() => void q.refetch()} />
      ) : r && r.runs.length === 0 ? (
        <p className="text-sm text-ink-muted">Results appear here once this campaign has sent.</p>
      ) : r ? (
        <div className="space-y-5">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Sent" value={r.pipeline.sent.toLocaleString()} />
            <Stat label="Skipped" value={r.pipeline.skipped.toLocaleString()} />
            <Stat label="Rejected" value={r.pipeline.failed.toLocaleString()} />
            <Stat label="Reached" value={r.pipeline.reachRate === null ? 'Not applicable' : `${Math.round(r.pipeline.reachRate * 100)}%`} />
          </dl>
          {r.deliveryMode === 'test' && <p className="text-xs text-ink-muted">Test delivery mode: no message reached a real inbox.</p>}
          {nothingTracked(r.engagement) ? (
            <p className="rounded-control bg-surface-muted p-3 text-xs text-ink-muted">
              Deliveries, opens, clicks, bounces and complaints are not tracked in this workspace — nothing is estimated.
            </p>
          ) : (
            <EngagementGrid engagement={r.engagement} basis={r.engagementBasis} />
          )}
          {r.runs.length > 1 && (
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Latest runs</caption>
              <thead className="text-xs text-ink-muted">
                <tr>
                  <th scope="col" className="py-1 font-medium">Run</th>
                  <th scope="col" className="py-1 font-medium">Sent</th>
                  <th scope="col" className="py-1 font-medium">Delivered</th>
                  <th scope="col" className="py-1 font-medium">Open rate</th>
                  <th scope="col" className="py-1 font-medium">Click rate</th>
                </tr>
              </thead>
              <tbody>
                {r.runs.map((run) => (
                  <tr key={run.executionId} className="border-t border-line">
                    <td className="py-1.5">{run.completedAt ? relativeTime(run.completedAt) : run.status}</td>
                    <td className="py-1.5 tabular-nums">{run.pipeline.sent.toLocaleString()}</td>
                    <td className="py-1.5 tabular-nums">{formatMetric(run.engagement.delivered, 'count')}</td>
                    <td className="py-1.5 tabular-nums">{formatMetric(run.engagement.openRate, 'rate')}</td>
                    <td className="py-1.5 tabular-nums">{formatMetric(run.engagement.clickRate, 'rate')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
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
