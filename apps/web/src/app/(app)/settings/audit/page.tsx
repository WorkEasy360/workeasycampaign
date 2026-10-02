'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import type { AuditLogView, Page } from '@workeasy/shared';
import { Download, ScrollText } from 'lucide-react';
import { useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, Select, Spinner, Table, Td, Th } from '@/components/ui';
import { http } from '@/lib/api';
import { dateTime, humanizeAction } from '@/lib/format';
import { errorMessage } from '@/lib/forms';
import { keys, useAppContext, useCan } from '@/lib/session';

const FILTERS = [
  { value: '', label: 'All activity' },
  { value: 'organization.', label: 'Organization' },
  { value: 'workspace', label: 'Workspaces' },
  { value: 'member.', label: 'Members' },
  { value: 'invitation.', label: 'Invitations' },
  { value: 'role.', label: 'Roles' },
  { value: 'access.denied', label: 'Denied access' },
  { value: 'audit.', label: 'Exports' },
];

export default function AuditPage() {
  const ctx = useAppContext();
  const can = useCan();
  const [action, setAction] = useState('');
  const log = useInfiniteQuery({
    queryKey: keys.audit(ctx.orgId, action),
    initialPageParam: '' as string,
    queryFn: ({ pageParam }) =>
      http.get<Page<AuditLogView>>(
        `/v1/organizations/${ctx.orgId}/audit-logs?limit=50${action ? `&action=${encodeURIComponent(action)}` : ''}${pageParam ? `&cursor=${pageParam}` : ''}`,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = log.data?.pages.flatMap((p) => p.data) ?? [];
  const exportHref = `/api/v1/organizations/${ctx.orgId}/audit-logs/export${action ? `?action=${encodeURIComponent(action)}` : ''}`;

  return (
    <Card
      title="Audit log"
      description="An append-only record of important changes in this organization. Entries cannot be edited or deleted."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Select aria-label="Filter activity" className="h-8 w-44" value={action} onChange={(e) => setAction(e.target.value)}>
            {FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </Select>
          {can('audit.export') && (
            <a href={exportHref} download>
              <Button variant="secondary" size="sm" icon={<Download className="size-4" />}>
                Export CSV
              </Button>
            </a>
          )}
        </div>
      }
    >
      {log.isLoading && <Spinner />}
      {log.isError && <Alert tone="danger">{errorMessage(log.error)}</Alert>}
      {!log.isLoading && rows.length === 0 && <EmptyState icon={<ScrollText className="size-6" />} title="Nothing recorded for this filter yet" />}
      {rows.length > 0 && (
        <Table label="Audit log">
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Who</Th>
              <Th>What</Th>
              <Th>Details</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <Td className="whitespace-nowrap text-ink-muted">{dateTime(r.occurredAt)}</Td>
                <Td>{r.actor.displayName ?? (r.actor.type === 'system' ? 'System' : 'Former member')}</Td>
                <Td>
                  <span className="font-medium">{humanizeAction(r.action)}</span> {r.outcome !== 'success' && <Badge tone="danger">{r.outcome}</Badge>}
                </Td>
                <Td className="max-w-xs truncate text-xs text-ink-muted" title={JSON.stringify(r.metadata)}>
                  {summarize(r)}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {log.hasNextPage && (
        <div className="mt-4 text-center">
          <Button variant="secondary" size="sm" loading={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
            Load more
          </Button>
        </div>
      )}
    </Card>
  );
}

function summarize(r: AuditLogView): string {
  const m = r.metadata as Record<string, unknown>;
  if (typeof m.email === 'string') return m.email;
  if (typeof m.name === 'string') return m.name;
  if (typeof m.permission === 'string') return `needed ${m.permission}`;
  const { actorEmail: _a, ...rest } = m;
  return Object.keys(rest).length ? JSON.stringify(rest) : '—';
}
