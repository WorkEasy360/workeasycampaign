'use client';

import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { RECIPIENT_STATUSES, type RecipientListItem, type RecipientStatus } from '@workeasy/shared';
import { useState } from 'react';
import { Badge, Button, Card, Field, Select, Spinner, Table, Td, Th } from '@/components/ui';
import { http } from '@/lib/api';
import { useWorkspaceApi } from '@/lib/audience';
import { reasonLabel } from '@/lib/campaigns';
import { relativeTime } from '@/lib/format';
import { useCan } from '@/lib/session';
import { ErrorAlert } from './common';

const STATUS_LABEL: Record<RecipientStatus, string> = {
  pending: 'Waiting',
  skipped: 'Skipped',
  skipped_at_send: 'Skipped at send',
  queued: 'Queued',
  sending: 'Sending',
  sent: 'Sent',
  failed: 'Failed',
  cancelled: 'Cancelled',
  unknown: 'Unknown',
};
const TONE: Partial<Record<RecipientStatus, 'success' | 'warning' | 'danger' | 'neutral'>> = { sent: 'success', skipped: 'warning', skipped_at_send: 'warning', failed: 'danger' };

/**
 * Row 23: who this run was for and what happened to each — display names from the server (never addresses). Needs
 * contacts.read (the card is hidden without it; the API enforces it).
 */
export function RecipientsCard({ campaignId, executionId, live, progress }: { campaignId: string; executionId: string; live: boolean; progress: string }) {
  const can = useCan();
  const { workspaceId, path } = useWorkspaceApi();
  const [status, setStatus] = useState<RecipientStatus | ''>('');
  const list = useInfiniteQuery({
    // `progress` (execution status + last progress) is part of the key: the list refreshes whenever the run moves on —
    // including the final transition, after which polling stops (regression: a finished run kept showing an empty list).
    queryKey: ['campaigns', workspaceId, 'recipients', campaignId, executionId, status, progress],
    placeholderData: keepPreviousData, // no spinner flash while the next progress step loads
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) =>
      http.get<{ data: RecipientListItem[]; nextCursor: string | null }>(
        path(`/campaigns/${campaignId}/executions/${executionId}/recipients?limit=50${status ? `&status=${status}` : ''}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
        signal,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!workspaceId && can('contacts.read'),
    refetchInterval: live ? 5_000 : false,
  });
  if (!can('contacts.read')) return null;
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <Card title="Recipients" description="Each contact in this run and what happened to them. Skipped contacts show why.">
      <div className="mb-3 w-48">
        <Field label="Show">
          {(p) => (
            <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as RecipientStatus | '')}>
              <option value="">Everyone</option>
              {RECIPIENT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      {list.isLoading ? (
        <Spinner label="Loading recipients" />
      ) : list.isError ? (
        <ErrorAlert error={list.error} title="Recipients could not be loaded" onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-ink-muted">No recipients{status ? ` with status “${STATUS_LABEL[status]}”` : ' yet'}.</p>
      ) : (
        <>
          <Table label="Recipients">
            <thead>
              <tr>
                <Th>Contact</Th>
                <Th>Status</Th>
                <Th>Why</Th>
                <Th>Updated</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <Td>{r.contact.displayName}</Td>
                  <Td>
                    <Badge tone={TONE[r.status] ?? 'neutral'}>{STATUS_LABEL[r.status]}</Badge>
                  </Td>
                  <Td>{r.reasonCodes.length ? r.reasonCodes.map(reasonLabel).join(', ') : <span className="text-ink-muted">—</span>}</Td>
                  <Td>{relativeTime(r.updatedAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {list.hasNextPage && (
            <div className="mt-3 flex justify-center">
              <Button variant="secondary" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
