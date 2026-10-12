'use client';

import { useQuery } from '@tanstack/react-query';
import type { CampaignAudienceSample } from '@workeasy/shared';
import { Users } from 'lucide-react';
import { useState } from 'react';
import { Alert, Badge, Button, Spinner } from '@/components/ui';
import { http } from '@/lib/api';
import { useWorkspaceApi } from '@/lib/audience';
import { reasonLabel } from '@/lib/campaigns';
import { useCan } from '@/lib/session';
import { ErrorAlert } from './common';

/**
 * Sample recipients (Phase 7.4): a few contacts of the SAVED draft's live audience, chosen at random by the server,
 * with whether each can receive the campaign right now. Names only — no addresses. Needs contacts.read.
 */
export function AudienceSample({ campaignId, dirty }: { campaignId: string; dirty: boolean }) {
  const can = useCan();
  const { workspaceId, path } = useWorkspaceApi();
  const [round, setRound] = useState(0);
  const q = useQuery({
    queryKey: ['campaign-audience-sample', workspaceId, campaignId, round] as const,
    queryFn: ({ signal }) => http.get<CampaignAudienceSample>(path(`/campaigns/${campaignId}/audience-sample`), signal),
    enabled: round > 0,
    retry: false,
  });
  if (!can('contacts.read')) return null;
  return (
    <div className="space-y-2 rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">Sample recipients</p>
        <Button size="sm" variant="secondary" icon={<Users className="size-4" aria-hidden />} disabled={dirty} loading={q.isFetching} onClick={() => setRound((r) => r + 1)}>
          {round === 0 ? 'Show a sample' : 'Another sample'}
        </Button>
      </div>
      {dirty && <p className="text-xs text-ink-muted">Save the draft to sample its audience.</p>}
      {round > 0 &&
        (q.isLoading ? (
          <Spinner label="Sampling the audience" />
        ) : q.isError ? (
          <ErrorAlert error={q.error} title="The sample could not be taken" onRetry={() => void q.refetch()} />
        ) : q.data?.unavailable ? (
          <Alert tone="warning">The audience is being prepared. Try again in about 30 seconds.</Alert>
        ) : !q.data?.sample.length ? (
          <p className="text-sm text-ink-muted">This audience has no contacts yet.</p>
        ) : (
          <ul className="divide-y divide-line" aria-label="Sample recipients">
            {q.data.sample.map((s) => (
              <li key={s.contactId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span>{s.displayName}</span>
                {s.eligible ? (
                  <Badge tone="success">Can receive it</Badge>
                ) : (
                  <span className="flex flex-wrap items-center gap-1">
                    <Badge tone="warning">Will be skipped</Badge>
                    <span className="text-xs text-ink-muted">{s.reasons.map(reasonLabel).join(', ')}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        ))}
      <p className="text-xs text-ink-muted">A random handful from the live audience, checked now. Who receives the campaign is fixed when sending starts.</p>
    </div>
  );
}
