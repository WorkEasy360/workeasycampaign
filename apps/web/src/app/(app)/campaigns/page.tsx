'use client';

import { useQueryClient } from '@tanstack/react-query';
import { type CampaignListItem, type CampaignStatus, type CampaignView, createCampaignRequest } from '@workeasy/shared';
import { Mail, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { CampaignsPage, ErrorAlert, StatusBadge } from '@/components/campaigns/common';
import { Alert, Button, Dialog, EmptyState, Field, Input, PageHeader, Select, Spinner, Table, Td, Th, useToast } from '@/components/ui';
import { http, idempotencyKey } from '@/lib/api';
import { CHANNEL_LABEL, useTopics, useWorkspaceApi } from '@/lib/audience';
import { campaignKeys, inZone, useCampaignCounts, useCampaignList, useCapabilities } from '@/lib/campaigns';
import { cx, relativeTime } from '@/lib/format';
import { useForm } from '@/lib/forms';
import { useCan } from '@/lib/session';

/** Architecture §6: All · Drafts · Scheduled · Sending (incl. paused) · Sent; cancelled/failed through All. */
const TABS: { key: string; label: string; statuses: CampaignStatus[] | null }[] = [
  { key: 'all', label: 'All', statuses: null },
  { key: 'draft', label: 'Drafts', statuses: ['draft'] },
  { key: 'scheduled', label: 'Scheduled', statuses: ['scheduled'] },
  { key: 'sending', label: 'Sending', statuses: ['sending', 'paused'] },
  { key: 'sent', label: 'Sent', statuses: ['completed'] },
];

function CampaignsInner() {
  const can = useCan();
  const [tab, setTab] = useState('all');
  const [channel, setChannel] = useState('');
  const [deleted, setDeleted] = useState(false);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim().length >= 2 ? search.trim() : ''), 300);
    return () => clearTimeout(t);
  }, [search]);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    for (const s of TABS.find((x) => x.key === tab)?.statuses ?? []) p.append('status', s);
    if (channel) p.set('channel', channel);
    if (q) p.set('q', q);
    if (deleted) p.set('deleted', 'only');
    return p;
  }, [tab, channel, q, deleted]);
  const list = useCampaignList(params);
  const counts = useCampaignCounts();
  const topics = useTopics();
  const topicName = new Map((can('topics.read') ? (topics.data?.data ?? []) : []).map((t) => [t.id, t.name]));
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  const filtered = !!(q || channel || deleted || tab !== 'all');
  const count = (statuses: CampaignStatus[] | null) =>
    counts.data ? (statuses ?? (Object.keys(counts.data) as CampaignStatus[])).reduce((a, s) => a + counts.data![s], 0) : null;

  return (
    <>
      <PageHeader
        title="Campaigns"
        description="Plan a message, choose who receives it, review it, then schedule it. Every campaign is checked before it can be sent."
        actions={can('campaigns.create') && <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New campaign</Button>}
      />
      <nav aria-label="Campaign status" className="mb-4 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((t) => {
          const n = count(t.statuses);
          return (
            <button
              key={t.key}
              type="button"
              aria-current={tab === t.key ? 'page' : undefined}
              onClick={() => setTab(t.key)}
              className={cx('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', tab === t.key ? 'border-accent text-accent' : 'border-transparent text-ink-muted hover:text-ink')}
            >
              {t.label}
              {n !== null && <span className="ml-1.5 rounded-full bg-surface-muted px-1.5 text-xs tabular-nums text-ink-muted">{n}</span>}
            </button>
          );
        })}
      </nav>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1">
          <Field label="Search campaigns">
            {(p) => (
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-3 size-4 text-ink-faint" aria-hidden />
                <Input {...p} type="search" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name (at least 2 characters)" />
              </div>
            )}
          </Field>
        </div>
        <div className="w-44">
          <Field label="Channel">
            {(p) => (
              <Select {...p} value={channel} onChange={(e) => setChannel(e.target.value)}>
                <option value="">All channels</option>
                <option value="email">Email</option>
                <option value="sms">SMS</option>
                <option value="whatsapp">WhatsApp</option>
              </Select>
            )}
          </Field>
        </div>
        <label className="flex h-10 items-center gap-2 text-sm text-ink-muted">
          <input type="checkbox" checked={deleted} onChange={(e) => setDeleted(e.target.checked)} className="size-4 accent-[var(--color-accent)]" />
          Show deleted
        </label>
      </div>
      {list.isLoading ? (
        <Spinner label="Loading campaigns" />
      ) : list.isError ? (
        <ErrorAlert error={list.error} title="Campaigns could not be loaded" onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Mail className="size-8" />}
          title={filtered ? 'No campaigns match' : 'No campaigns yet'}
          action={!filtered && can('campaigns.create') && <Button onClick={() => setCreating(true)}>Create your first campaign</Button>}
        >
          {filtered
            ? 'Try another status, channel or search.'
            : 'A campaign is one message to a chosen audience. You prepare it as a draft, review it, then schedule it — nothing is sent until you confirm.'}
        </EmptyState>
      ) : (
        <>
          <Table label="Campaigns">
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Status</Th>
                <Th>Channel</Th>
                <Th>Topic</Th>
                <Th>Send time</Th>
                <Th>Updated</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <Row key={c.id} c={c} topic={c.topicId ? topicName.get(c.topicId) : undefined} />
              ))}
            </tbody>
          </Table>
          {list.hasNextPage && (
            <div className="mt-4 flex justify-center">
              <Button variant="secondary" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                Load more
              </Button>
            </div>
          )}
        </>
      )}
      <CreateCampaignDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function Row({ c, topic }: { c: CampaignListItem; topic?: string }) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const sendAt = c.currentExecution?.sendAt;
  return (
    <tr>
      <Td>
        <Link href={`/campaigns/${c.id}`} className="font-medium hover:text-accent">
          {c.name}
        </Link>
        {c.deletedAt && <span className="ml-2 text-xs text-ink-muted">(deleted)</span>}
        {c.status === 'draft' && c.readiness === 'not_ready' && !c.deletedAt && <span className="block text-xs text-ink-muted">Needs attention before sending</span>}
      </Td>
      <Td>
        <StatusBadge status={c.status} />
      </Td>
      <Td>{CHANNEL_LABEL[c.channel]}</Td>
      <Td>{topic ?? (c.topicId ? '—' : <span className="text-ink-muted">Not set</span>)}</Td>
      <Td>{sendAt ? <span title={new Date(sendAt).toISOString()}>{inZone(sendAt, tz)}</span> : <span className="text-ink-muted">—</span>}</Td>
      <Td>{relativeTime(c.updatedAt)}</Td>
    </tr>
  );
}

function CreateCampaignDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { workspaceId, path } = useWorkspaceApi();
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const router = useRouter();
  const caps = useCapabilities();
  const topics = useTopics();
  const form = useForm(createCampaignRequest);
  const [name, setName] = useState('');
  const [channel, setChannel] = useState<'email' | 'sms' | 'whatsapp'>('email');
  const [key, setKey] = useState(idempotencyKey);
  const defaultTopic = can('topics.read') ? topics.data?.data.find((t) => t.isDefault && t.kind === 'topic' && t.status === 'active')?.id : undefined;
  const enabled = (ch: string) => caps.data?.channels.find((x) => x.channel === ch)?.enabled ?? ch === 'email';
  useEffect(() => {
    if (open) {
      setName('');
      setChannel('email');
      form.setFormError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New campaign"
      description="Start a draft. You can change everything until you schedule it."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={form.submitting}
            onClick={() =>
              void form.submit({ name, channel, ...(defaultTopic ? { topicId: defaultTopic } : {}) }, async (data) => {
                const created = await http.post<CampaignView>(path('/campaigns'), data, { 'idempotency-key': key });
                setKey(idempotencyKey());
                await qc.invalidateQueries({ queryKey: campaignKeys.all(workspaceId!) });
                toast('success', 'Draft created');
                onClose();
                router.push(`/campaigns/${created.id}`);
              })
            }
          >
            Create draft
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {form.formError && <Alert tone="danger">{form.formError}</Alert>}
        <Field label="Campaign name" errors={form.fieldErrors.name} hint="Only your team sees this name.">
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} data-autofocus />}
        </Field>
        <Field label="Channel" errors={form.fieldErrors.channel}>
          {(p) => (
            <Select {...p} value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)}>
              <option value="email">Email</option>
              <option value="sms" disabled={!enabled('sms')}>
                SMS{enabled('sms') ? '' : ' — not configured'}
              </option>
              <option value="whatsapp" disabled={!enabled('whatsapp')}>
                WhatsApp{enabled('whatsapp') ? '' : ' — not configured'}
              </option>
            </Select>
          )}
        </Field>
      </div>
    </Dialog>
  );
}

export default function Page() {
  return (
    <CampaignsPage>
      <CampaignsInner />
    </CampaignsPage>
  );
}
