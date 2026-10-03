'use client';

import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { createSuppressionRequest, type Page, type SuppressionView } from '@workeasy/shared';
import { Ban } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { AudiencePage } from '@/components/audience-shell';
import { Alert, Button, Dialog, EmptyState, Field, Input, PageHeader, Select, Spinner, Table, Td, Th, useToast } from '@/components/ui';
import { http } from '@/lib/api';
import { audienceKeys, CHANNEL_LABEL, useWorkspaceApi } from '@/lib/audience';
import { dateTime, relativeTime } from '@/lib/format';
import { errorMessage, useForm } from '@/lib/forms';
import { useCan } from '@/lib/session';

const REASON_LABEL: Record<string, string> = {
  manual: 'Manual',
  hard_bounce: 'Hard bounce',
  complaint: 'Spam complaint',
  compliance: 'Compliance / legal',
  unsubscribe_request: 'Asked not to be contacted',
  invalid_address: 'Invalid address',
};

function SuppressionsInner() {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const { workspaceId, path } = useWorkspaceApi();
  const [status, setStatus] = useState<'active' | 'lifted' | 'all'>('active');
  const [adding, setAdding] = useState(false);
  const [lifting, setLifting] = useState<SuppressionView | null>(null);
  const [liftReason, setLiftReason] = useState('');
  const list = useInfiniteQuery({
    queryKey: audienceKeys.suppressions(workspaceId!, status),
    initialPageParam: '',
    queryFn: ({ pageParam }) => http.get<Page<SuppressionView>>(path(`/suppressions?status=${status}&limit=50${pageParam ? `&cursor=${pageParam}` : ''}`)),
    getNextPageParam: (l) => l.nextCursor ?? undefined,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['suppressions', workspaceId] });
  const lift = useMutation({
    mutationFn: () => http.post(path(`/suppressions/${lifting!.id}/lift`), { reason: liftReason }),
    onSuccess: async () => {
      setLifting(null);
      setLiftReason('');
      toast('success', 'Suppression lifted');
      await refresh();
    },
  });
  const manage = can('suppression.manage');
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <>
      <PageHeader
        title="Do not contact"
        description="Suppressed contacts and addresses never receive messages on that channel, whatever their consent says. Address suppressions also block contacts created later with that address."
        actions={manage && <Button icon={<Ban className="size-4" />} onClick={() => setAdding(true)}>Suppress an address</Button>}
      />
      <div className="mb-4 w-48">
        <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="active">Active</option>
          <option value="lifted">Lifted</option>
          <option value="all">All</option>
        </Select>
      </div>
      {list.isLoading ? (
        <Spinner />
      ) : list.isError ? (
        <Alert tone="danger">{errorMessage(list.error)}</Alert>
      ) : rows.length === 0 ? (
        <EmptyState title={status === 'active' ? 'Nobody is suppressed' : 'Nothing here'}>Suppressions you add, and ones recorded from bounces and complaints later, appear here.</EmptyState>
      ) : (
        <Table label="Suppressions">
          <thead>
            <tr>
              <Th>Who</Th>
              <Th>Channel</Th>
              <Th>Reason</Th>
              <Th>Added</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <Td>
                  {s.target.type === 'contact' ? (
                    <Link href={`/contacts/${s.target.contactId}`} className="font-medium hover:text-accent">
                      {s.target.displayName ?? 'Erased contact'}
                    </Link>
                  ) : (
                    <span className="break-all font-medium">{s.target.value}</span>
                  )}
                  {s.note && <span className="block text-xs text-ink-muted">“{s.note}”</span>}
                  {s.liftedAt && (
                    <span className="block text-xs text-ink-faint">
                      Lifted {relativeTime(s.liftedAt)}: {s.liftReason}
                    </span>
                  )}
                </Td>
                <Td>{CHANNEL_LABEL[s.channel]}</Td>
                <Td>{REASON_LABEL[s.reason] ?? s.reason}</Td>
                <Td title={dateTime(s.createdAt)}>{relativeTime(s.createdAt)}</Td>
                <Td className="text-right">
                  {manage && !s.liftedAt && (
                    <Button size="sm" variant="ghost" onClick={() => setLifting(s)}>
                      Lift
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {list.hasNextPage && (
        <div className="mt-4 text-center">
          <Button variant="secondary" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            Load more
          </Button>
        </div>
      )}
      <AddressDialog open={adding} onClose={() => setAdding(false)} onSaved={refresh} />
      <Dialog
        open={!!lifting}
        onClose={() => setLifting(null)}
        title="Lift suppression"
        description="The record is kept for audit. Explain why messages may resume."
        footer={
          <>
            <Button variant="secondary" onClick={() => setLifting(null)}>
              Cancel
            </Button>
            <Button loading={lift.isPending} disabled={liftReason.trim().length < 3} onClick={() => lift.mutate()}>
              Lift
            </Button>
          </>
        }
      >
        {lift.isError && <Alert tone="danger">{errorMessage(lift.error)}</Alert>}
        <Field label="Reason">{(p) => <Input {...p} value={liftReason} onChange={(e) => setLiftReason(e.target.value)} />}</Field>
      </Dialog>
    </>
  );
}

function AddressDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const { path } = useWorkspaceApi();
  const toast = useToast();
  const form = useForm(createSuppressionRequest);
  const [v, setV] = useState({ identityKind: 'email', value: '', channel: 'email', reason: 'manual', note: '', defaultCountry: '' });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Suppress an address"
      description="Use this for addresses that are not contacts yet, e.g. a request received by post."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={form.submitting}
            onClick={() =>
              void form.submit({ ...v, defaultCountry: v.defaultCountry || undefined }, async (data) => {
                await http.post(path('/suppressions'), data);
                toast('success', 'Address suppressed');
                setV((x) => ({ ...x, value: '', note: '' }));
                await onSaved();
                onClose();
              })
            }
          >
            Suppress
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {form.formError && <Alert tone="danger">{form.formError}</Alert>}
        <div className="grid grid-cols-3 gap-2">
          <Field label="Type">
            {(p) => (
              <Select {...p} value={v.identityKind} onChange={(e) => setV((x) => ({ ...x, identityKind: e.target.value, channel: e.target.value === 'phone' ? 'sms' : e.target.value }))}>
                <option value="email">Email</option>
                <option value="phone">Phone</option>
                <option value="whatsapp">WhatsApp</option>
              </Select>
            )}
          </Field>
          <div className="col-span-2">
            <Field label="Address" errors={form.fieldErrors.value}>
              {(p) => <Input {...p} value={v.value} onChange={(e) => setV((x) => ({ ...x, value: e.target.value }))} />}
            </Field>
          </div>
        </div>
        {v.identityKind !== 'email' && (
          <Field label="Country (if the number has no +code)" hint="Two-letter code, e.g. IN" errors={form.fieldErrors.defaultCountry}>
            {(p) => <Input {...p} maxLength={2} value={v.defaultCountry} onChange={(e) => setV((x) => ({ ...x, defaultCountry: e.target.value.toUpperCase() }))} />}
          </Field>
        )}
        <Field label="Channel" errors={form.fieldErrors.channel}>
          {(p) => (
            <Select {...p} value={v.channel} onChange={(e) => setV((x) => ({ ...x, channel: e.target.value }))}>
              {Object.entries(CHANNEL_LABEL).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Reason">
          {(p) => (
            <Select {...p} value={v.reason} onChange={(e) => setV((x) => ({ ...x, reason: e.target.value }))}>
              {['manual', 'unsubscribe_request', 'compliance', 'invalid_address'].map((r) => (
                <option key={r} value={r}>
                  {REASON_LABEL[r]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Note (optional)">{(p) => <Input {...p} value={v.note} onChange={(e) => setV((x) => ({ ...x, note: e.target.value }))} />}</Field>
      </div>
    </Dialog>
  );
}

export default function SuppressionsPage() {
  return (
    <AudiencePage>
      <SuppressionsInner />
    </AudiencePage>
  );
}
