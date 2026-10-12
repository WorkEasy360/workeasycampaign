'use client';

import { useQuery } from '@tanstack/react-query';
import type { UsageMeter, UsageSummary } from '@workeasy/shared';
import { Alert, Card, Spinner, Table, Td, Th } from '@/components/ui';
import { http } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { errorMessage } from '@/lib/forms';
import { useAppContext, useCan } from '@/lib/session';

const LABEL: Record<UsageMeter, { label: string; unit?: 'bytes'; hint: string }> = {
  'campaign.executions': { label: 'Campaign sends', hint: 'Campaign runs started in the period' },
  'messages.sent': { label: 'Messages delivered to the provider', hint: 'Live delivery only — test sends are never counted' },
  'contacts.active': { label: 'Active contacts', hint: 'At the latest daily count' },
  'templates.active': { label: 'Templates', hint: 'At the latest daily count' },
  'storage.bytes': { label: 'Stored import files', unit: 'bytes', hint: 'At the latest daily count' },
  'ai.tokens': { label: 'AI assistance', hint: 'Not enabled in this deployment' },
};

function formatValue(value: number, unit?: 'bytes'): string {
  if (unit !== 'bytes') return value.toLocaleString();
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = value / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** Organization usage (Phase 7.13): what was used in the last 30 days, per workspace. Quantities only — no prices. */
export default function UsagePage() {
  const ctx = useAppContext();
  const can = useCan();
  const allowed = can('billing.manage');
  const q = useQuery({
    queryKey: ['usage', ctx.orgId, '30d'],
    queryFn: ({ signal }) => http.get<UsageSummary>(`/v1/organizations/${ctx.orgId}/usage`, signal),
    enabled: allowed,
    staleTime: 60_000,
  });
  if (!allowed) return <Alert tone="info">Only people who manage billing can see usage.</Alert>;
  if (q.isLoading) return <Spinner label="Loading usage" />;
  if (q.isError) return <Alert tone="danger" title="Usage could not be loaded">{errorMessage(q.error)}</Alert>;
  const s = q.data!;
  return (
    <div className="space-y-6">
      <Card title="Usage" description={`${dateTime(s.period.from)} – ${dateTime(s.period.to)}`}>
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {s.meters.map((m) => (
            <div key={m.meter} className="rounded-control border border-line p-3">
              <dt className="text-sm text-ink-muted">{LABEL[m.meter].label}</dt>
              <dd className="text-xl font-semibold tabular-nums">{formatValue(m.total, LABEL[m.meter].unit)}</dd>
              <dd className="mt-0.5 text-xs text-ink-muted">
                {LABEL[m.meter].hint}
                {m.asOf && ` (${dateTime(m.asOf)})`}
              </dd>
            </div>
          ))}
        </dl>
      </Card>
      {s.meters.some((m) => m.byWorkspace.length > 0) && (
        <Card title="By workspace">
          <Table label="Usage by workspace">
            <thead>
              <tr>
                <Th>Workspace</Th>
                {s.meters.filter((m) => m.meter !== 'ai.tokens').map((m) => (
                  <Th key={m.meter} className="text-right">
                    {LABEL[m.meter].label}
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...new Map(s.meters.flatMap((m) => m.byWorkspace.map((w) => [w.workspaceId, w.name] as const))).entries()].map(([id, name]) => (
                <tr key={id}>
                  <Td>{name || 'Workspace'}</Td>
                  {s.meters.filter((m) => m.meter !== 'ai.tokens').map((m) => (
                    <Td key={m.meter} className="text-right tabular-nums">
                      {formatValue(m.byWorkspace.find((w) => w.workspaceId === id)?.value ?? 0, LABEL[m.meter].unit)}
                    </Td>
                  ))}
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      <p className="text-xs text-ink-muted">Usage is recorded as it happens and counted daily. Plans and prices are not part of this page.</p>
    </div>
  );
}
