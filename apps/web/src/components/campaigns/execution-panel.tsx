'use client';

import type { CampaignView, ExecutionSummary } from '@workeasy/shared';
import { Card, Table, Td, Th } from '@/components/ui';
import { inZone, reasonLabel, useExecutions, viewerTimeZone } from '@/lib/campaigns';
import { relativeTime } from '@/lib/format';
import { ExecutionBadge } from './common';
import { RecipientsCard } from './recipients-card';
import { SendingSpeed } from './sending-speed';

const LIVE = ['pending', 'materializing', 'delivering', 'paused'];

/** Progress from server counts only (never estimated). Polled by the campaign query while the campaign is live. */
export function ExecutionPanel({ campaign }: { campaign: CampaignView }) {
  const e = campaign.currentExecution;
  const runs = useExecutions(campaign.id, !!e && LIVE.includes(e.status));
  const history = (runs.data?.data ?? []).filter((r) => r.id !== e?.id);
  return (
    <div className="space-y-6">
      {e ? <CurrentRun e={e} campaignId={campaign.id} /> : <Card title="Sending">This campaign has not been sent yet.</Card>}
      {e && e.status !== 'pending' && <RecipientsCard campaignId={campaign.id} executionId={e.id} live={LIVE.includes(e.status)} progress={`${e.status}:${e.lastProgressAt ?? ""}`} />}
      {history.length > 0 && (
        <Card title="Earlier runs">
          <Table label="Earlier runs">
            <thead>
              <tr>
                <Th>Run</Th>
                <Th>Status</Th>
                <Th className="text-right">Sent</Th>
                <Th className="text-right">Skipped</Th>
                <Th>Finished</Th>
              </tr>
            </thead>
            <tbody>
              {history.map((r) => (
                <tr key={r.id}>
                  <Td>#{r.runNumber}</Td>
                  <Td>
                    <ExecutionBadge status={r.status} />
                  </Td>
                  <Td className="text-right tabular-nums">{r.counts.sent.toLocaleString()}</Td>
                  <Td className="text-right tabular-nums">{r.counts.skipped.toLocaleString()}</Td>
                  <Td>{r.completedAt ? relativeTime(r.completedAt) : '—'}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}

function CurrentRun({ e, campaignId }: { e: ExecutionSummary; campaignId: string }) {
  const tz = viewerTimeZone();
  const c = e.counts;
  const pct = c.planned > 0 ? Math.min(100, Math.round((c.sent / c.planned) * 100)) : 0;
  const reasons = Object.entries(e.skippedByReason).sort((a, b) => b[1] - a[1]);
  const headline =
    e.status === 'pending'
      ? `Scheduled for ${inZone(e.sendAt, tz)}`
      : e.status === 'materializing'
        ? `Preparing recipients — ${c.planned.toLocaleString()} ready so far`
        : e.status === 'delivering'
          ? `Sent ${c.sent.toLocaleString()} of ${c.planned.toLocaleString()} planned`
          : e.status === 'paused'
            ? `Paused — sent ${c.sent.toLocaleString()} of ${c.planned.toLocaleString()} planned`
            : e.status === 'completed'
              ? `Finished — sent ${c.sent.toLocaleString()} of ${c.planned.toLocaleString()} planned`
              : e.status === 'cancelled'
                ? `Cancelled — ${c.sent.toLocaleString()} sent before cancelling`
                : 'Not sent';
  return (
    <Card title={`Run #${e.runNumber}`} actions={<ExecutionBadge status={e.status} />}>
      <div className="space-y-4">
        <p className="text-sm font-medium" role="status" aria-live="polite">
          {headline}
        </p>
        {(e.status === 'delivering' || e.status === 'paused' || e.status === 'completed') && c.planned > 0 && (
          <div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-surface-muted" role="progressbar" aria-label="Sent" aria-valuemin={0} aria-valuemax={c.planned} aria-valuenow={c.sent} aria-valuetext={`${c.sent} of ${c.planned} sent`}>
              <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}
        {e.health === 'stalled' && (
          <p className="rounded-control bg-warning-soft px-3 py-2 text-sm">
            Sending is delayed by a temporary system problem. It resumes automatically from where it stopped — no recipient receives the message twice.
          </p>
        )}
        {e.health === 'retrying' && <p className="rounded-control bg-warning-soft px-3 py-2 text-sm">A temporary problem occurred; retrying automatically.</p>}
        {e.failure && (
          <p className="rounded-control bg-danger-soft px-3 py-2 text-sm">
            Stopped because of a configuration problem ({reasonLabel(e.failure.code)}). Return the campaign to draft, fix it and schedule it again.
          </p>
        )}
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          {(
            [
              ['Planned', c.planned],
              ['Sent', c.sent],
              ['Skipped', c.skipped],
              ['Failed', c.failed],
              ['Cancelled', c.cancelled],
              ['Unknown outcome', c.unknown],
            ] as const
          ).map(([label, n]) => (
            <div key={label}>
              <dt className="text-ink-muted">{label}</dt>
              <dd className="text-lg font-semibold tabular-nums">{n.toLocaleString()}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-ink-muted">Sent means the provider accepted the message. Delivery is confirmed only by the provider’s report (see the results).</p>
        <SendingSpeed campaignId={campaignId} execution={e} />
        {e.materializedAt && (
          <p className="text-xs text-ink-muted">
            Frozen audience: the recipients were fixed when sending started ({relativeTime(e.materializedAt)}). Contacts added to the lists or tags later are not included.
          </p>
        )}
        {reasons.length > 0 && (
          <div className="text-sm">
            <p className="text-ink-muted">Skipped because</p>
            <ul className="mt-1 space-y-0.5">
              {reasons.map(([code, n]) => (
                <li key={code} className="flex justify-between gap-4">
                  <span>{reasonLabel(code)}</span>
                  <span className="tabular-nums">{n.toLocaleString()}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <ul className="grid grid-cols-1 gap-1 text-xs text-ink-muted sm:grid-cols-2" aria-label="Timeline">
          {e.startedAt && <li>Started {inZone(e.startedAt, tz)}</li>}
          {e.materializedAt && <li>Recipients fixed {inZone(e.materializedAt, tz)}</li>}
          {e.lastProgressAt && !e.completedAt && <li>Last progress {relativeTime(e.lastProgressAt)}</li>}
          {e.completedAt && <li>Completed {inZone(e.completedAt, tz)}</li>}
        </ul>
      </div>
    </Card>
  );
}
