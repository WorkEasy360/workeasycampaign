'use client';

import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BulkActionResult, ContactPage, CustomFieldView } from '@workeasy/shared';
import { Plus, Search, Upload, Users } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { AudiencePage } from '@/components/audience-shell';
import { CustomFieldInput } from '@/components/custom-field-input';
import { Alert, Badge, Button, ConfirmDialog, Dialog, EmptyState, Field, Input, PageHeader, Select, Spinner, Table, Td, Th, useToast } from '@/components/ui';
import { ApiError, http, idempotencyKey } from '@/lib/api';
import { audienceKeys, CHANNEL_LABEL, SUBSCRIPTION_LABEL, useCustomFields, useLists, useTags, useTopics, useWorkspaceApi } from '@/lib/audience';
import { relativeTime } from '@/lib/format';
import { errorMessage } from '@/lib/forms';
import { useCan } from '@/lib/session';

type Filters = { q: string; listId: string; tagId: string; topicId: string; subscriptionType: string; suppressed: string; deleted: string };
const EMPTY: Filters = { q: '', listId: '', tagId: '', topicId: '', subscriptionType: '', suppressed: '', deleted: 'exclude' };

function toParams(f: Filters): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v && !(k === 'deleted' && v === 'exclude')) p.set(k, v);
  return p.toString();
}

function ContactsInner() {
  const can = useCan();
  const router = useRouter();
  const params = useSearchParams();
  const { workspaceId, path } = useWorkspaceApi();
  const [filters, setFilters] = useState<Filters>({ ...EMPTY, listId: params.get('listId') ?? '', tagId: params.get('tagId') ?? '' });
  const [search, setSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => ({ ...f, q: search.trim().length >= 2 ? search.trim() : '' })), 300);
    return () => clearTimeout(t);
  }, [search]);
  const qs = toParams(filters);

  const contacts = useInfiniteQuery({
    queryKey: audienceKeys.contacts(workspaceId!, qs),
    initialPageParam: '',
    queryFn: ({ pageParam }) => http.get<ContactPage>(path(`/contacts?limit=50&${qs}${pageParam ? `&cursor=${pageParam}` : ''}`)),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const count = useQuery({ queryKey: audienceKeys.contactCount(workspaceId!, qs), queryFn: () => http.get<{ count: number }>(path(`/contacts/count?${qs}`)) });
  const lists = useLists();
  const tags = useTags();
  const topics = useTopics();

  const rows = useMemo(() => contacts.data?.pages.flatMap((p) => p.data) ?? [], [contacts.data]);
  const truncated = contacts.data?.pages[0]?.searchTruncated ?? false;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    setSelected(new Set());
    setAllMatching(false);
  }, [qs]);

  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const selectionCount = allMatching ? (count.data?.count ?? 0) : selected.size;
  const filtersActive = qs !== '';

  return (
    <>
      <PageHeader
        title="Contacts"
        description="Everyone you can reach in this workspace."
        actions={
          <div className="flex gap-2">
            {can('contacts.import') && (
              <Link href="/imports">
                <Button variant="secondary" icon={<Upload className="size-4" />}>
                  Import
                </Button>
              </Link>
            )}
            {can('contacts.create') && (
              <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
                New contact
              </Button>
            )}
          </div>
        }
      />

      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-[2fr_repeat(5,1fr)]">
        <label className="relative">
          <span className="sr-only">Search contacts</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-faint" aria-hidden />
          <Input className="pl-9" placeholder="Search name, email or phone" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <Select aria-label="Filter by list" value={filters.listId} onChange={(e) => setFilters((f) => ({ ...f, listId: e.target.value }))}>
          <option value="">Any list</option>
          {lists.data?.data.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
        <Select aria-label="Filter by tag" value={filters.tagId} onChange={(e) => setFilters((f) => ({ ...f, tagId: e.target.value }))}>
          <option value="">Any tag</option>
          {tags.data?.data.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
        <Select aria-label="Filter by topic" value={filters.topicId} onChange={(e) => setFilters((f) => ({ ...f, topicId: e.target.value }))}>
          <option value="">Any topic</option>
          {topics.data?.data
            .filter((t) => t.kind === 'topic')
            .map((t) => (
              <option key={t.id} value={t.id}>
                Subscribed: {t.name}
              </option>
            ))}
        </Select>
        <Select aria-label="Filter by subscription" value={filters.subscriptionType} onChange={(e) => setFilters((f) => ({ ...f, subscriptionType: e.target.value }))}>
          <option value="">Any status</option>
          {Object.entries(SUBSCRIPTION_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        <Select
          aria-label="More filters"
          value={filters.deleted === 'only' ? 'deleted' : filters.suppressed}
          onChange={(e) => {
            const v = e.target.value;
            setFilters((f) => ({ ...f, deleted: v === 'deleted' ? 'only' : 'exclude', suppressed: v === 'true' || v === 'false' ? v : '' }));
          }}
        >
          <option value="">All contacts</option>
          <option value="true">Suppressed only</option>
          <option value="false">Not suppressed</option>
          <option value="deleted">Deleted (restorable)</option>
        </Select>
      </div>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm text-ink-muted">
        <span aria-live="polite">
          {count.data ? `${count.data.count.toLocaleString()} contact${count.data.count === 1 ? '' : 's'}` : '…'}
          {filtersActive && ' match these filters'}
          {truncated && ' — showing the first 1,000 search matches; refine your search'}
        </span>
        {filtersActive && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setFilters(EMPTY);
              setSearch('');
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      {selectionCount > 0 && (
        <BulkBar
          count={selectionCount}
          allMatching={allMatching}
          canSelectAll={!allMatching && allOnPage && (count.data?.count ?? 0) > rows.length}
          totalMatching={count.data?.count ?? 0}
          onSelectAll={() => setAllMatching(true)}
          onClear={() => {
            setSelected(new Set());
            setAllMatching(false);
          }}
          selection={allMatching ? { filter: Object.fromEntries(new URLSearchParams(qs)) } : { contactIds: [...selected] }}
        />
      )}

      {contacts.isLoading ? (
        <Spinner />
      ) : contacts.isError ? (
        <Alert tone="danger">{errorMessage(contacts.error)}</Alert>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Users className="size-8" />}
          title={filtersActive ? 'No contacts match' : 'No contacts yet'}
          action={
            !filtersActive && can('contacts.import') ? (
              <Link href="/imports">
                <Button>Import contacts</Button>
              </Link>
            ) : undefined
          }
        >
          {filtersActive ? 'Try a different search or clear the filters.' : 'Add contacts one by one or import a CSV file.'}
        </EmptyState>
      ) : (
        <>
          <Table label="Contacts">
            <thead>
              <tr>
                <Th className="w-10">
                  <input
                    type="checkbox"
                    aria-label="Select all contacts on this page"
                    className="size-4"
                    checked={allOnPage || allMatching}
                    onChange={(e) => {
                      setAllMatching(false);
                      setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set());
                    }}
                  />
                </Th>
                <Th>Name</Th>
                <Th>Email</Th>
                <Th>Phone</Th>
                <Th>Status</Th>
                <Th>Added</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="hover:bg-surface-muted">
                  <Td>
                    <input
                      type="checkbox"
                      className="size-4"
                      aria-label={`Select ${c.displayName}`}
                      checked={allMatching || selected.has(c.id)}
                      onChange={(e) => {
                        setAllMatching(false);
                        setSelected((s) => {
                          const n = new Set(s);
                          if (e.target.checked) n.add(c.id);
                          else n.delete(c.id);
                          return n;
                        });
                      }}
                    />
                  </Td>
                  <Td>
                    <Link href={`/contacts/${c.id}`} className="font-medium text-ink hover:text-accent hover:underline">
                      {c.displayName}
                    </Link>
                    {c.company && <p className="text-xs text-ink-muted">{c.company}</p>}
                  </Td>
                  <Td className="text-ink-muted">{c.email ?? '—'}</Td>
                  <Td className="text-ink-muted">{c.phone ?? '—'}</Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {c.deletedAt ? <Badge tone="danger">Deleted</Badge> : <Badge tone={c.subscriptionType === 'marketing' ? 'success' : 'neutral'}>{SUBSCRIPTION_LABEL[c.subscriptionType]}</Badge>}
                      {c.suppressed && <Badge tone="warning">Do not contact</Badge>}
                    </div>
                  </Td>
                  <Td className="text-ink-muted">{relativeTime(c.createdAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {contacts.hasNextPage && (
            <div className="mt-4 text-center">
              <Button variant="secondary" loading={contacts.isFetchingNextPage} onClick={() => void contacts.fetchNextPage()}>
                Load more
              </Button>
            </div>
          )}
        </>
      )}
      <CreateContactDialog open={creating} onClose={() => setCreating(false)} onCreated={(id) => router.push(`/contacts/${id}`)} />
    </>
  );
}

const BULK_ACTIONS = [
  { value: 'add_to_list', label: 'Add to list', permission: 'lists.manage' },
  { value: 'remove_from_list', label: 'Remove from list', permission: 'lists.manage' },
  { value: 'tag', label: 'Add tag', permission: 'tags.manage' },
  { value: 'untag', label: 'Remove tag', permission: 'tags.manage' },
  { value: 'unsubscribe', label: 'Unsubscribe', permission: 'contacts.update', destructive: true },
  { value: 'suppress', label: 'Add to do-not-contact', permission: 'suppression.manage', destructive: true },
  { value: 'delete', label: 'Delete', permission: 'contacts.delete', destructive: true },
] as const;

function BulkBar({
  count,
  allMatching,
  canSelectAll,
  totalMatching,
  onSelectAll,
  onClear,
  selection,
}: {
  count: number;
  allMatching: boolean;
  canSelectAll: boolean;
  totalMatching: number;
  onSelectAll: () => void;
  onClear: () => void;
  selection: { contactIds: string[] } | { filter: Record<string, string> };
}) {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const { workspaceId, path } = useWorkspaceApi();
  const lists = useLists();
  const tags = useTags();
  const [action, setAction] = useState<(typeof BULK_ACTIONS)[number] | null>(null);
  const [target, setTarget] = useState('');
  const [channel, setChannel] = useState('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(idempotencyKey);
  const available = BULK_ACTIONS.filter((a) => can(a.permission));
  if (!available.length) return null;

  async function run() {
    if (!action) return;
    setBusy(true);
    setError(null);
    try {
      const body = {
        action: action.value,
        selection,
        ...(action.value.includes('list') ? { listId: target } : {}),
        ...(action.value === 'tag' || action.value === 'untag' ? { tagId: target } : {}),
        ...(action.value === 'suppress' ? { channel, reason: 'manual' } : {}),
      };
      const r = await http.post<BulkActionResult>(path('/contacts/bulk'), body, { 'idempotency-key': key });
      toast('success', `${action.label}: ${r.affected.toLocaleString()} changed${r.skipped ? `, ${r.skipped.toLocaleString()} already done or unavailable` : ''}${r.truncated ? ' (first 10,000 only)' : ''}`);
      await qc.invalidateQueries({ queryKey: ['contacts', workspaceId] });
      await qc.invalidateQueries({ queryKey: ['contact-count', workspaceId] });
      setAction(null);
      setKey(idempotencyKey());
      onClear();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const needsList = action?.value === 'add_to_list' || action?.value === 'remove_from_list';
  const needsTag = action?.value === 'tag' || action?.value === 'untag';
  const ready = !!action && (!needsList || !!target) && (!needsTag || !!target);

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-control border border-accent/30 bg-accent-soft px-3 py-2 text-sm" role="region" aria-label="Bulk actions">
      <strong>{count.toLocaleString()} selected</strong>
      {canSelectAll && (
        <Button size="sm" variant="ghost" onClick={onSelectAll}>
          Select all {totalMatching.toLocaleString()} matching
        </Button>
      )}
      {allMatching && <span className="text-ink-muted">(all matching the filters)</span>}
      <div className="ml-auto flex flex-wrap gap-2">
        <Select
          aria-label="Bulk action"
          className="h-8 w-48"
          value={action?.value ?? ''}
          onChange={(e) => {
            setAction(BULK_ACTIONS.find((a) => a.value === e.target.value) ?? null);
            setTarget('');
            setError(null);
          }}
        >
          <option value="">Choose an action…</option>
          {available.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </Select>
        <Button size="sm" variant="ghost" onClick={onClear}>
          Clear selection
        </Button>
      </div>
      <Dialog
        open={!!action}
        onClose={() => setAction(null)}
        title={`${action?.label ?? ''} — ${count.toLocaleString()} contact${count === 1 ? '' : 's'}`}
        description={action && 'destructive' in action ? 'This changes many contacts at once. It is recorded in the audit log.' : undefined}
        footer={
          <>
            <Button variant="secondary" onClick={() => setAction(null)}>
              Cancel
            </Button>
            <Button variant={action && 'destructive' in action ? 'danger' : 'primary'} loading={busy} disabled={!ready} onClick={() => void run()}>
              {action?.label}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          {needsList && (
            <Field label="List">
              {(p) => (
                <Select {...p} value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="">Choose a list</option>
                  {lists.data?.data
                    .filter((l) => l.status === 'active')
                    .map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                </Select>
              )}
            </Field>
          )}
          {needsTag && (
            <Field label="Tag">
              {(p) => (
                <Select {...p} value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="">Choose a tag</option>
                  {tags.data?.data.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          {action?.value === 'suppress' && (
            <Field label="Channel" hint="Suppressed contacts never receive messages on this channel, whatever their consent.">
              {(p) => (
                <Select {...p} value={channel} onChange={(e) => setChannel(e.target.value)}>
                  {Object.entries(CHANNEL_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          {action?.value === 'unsubscribe' && <p className="text-sm text-ink-muted">They will stop receiving marketing. You can resubscribe them later unless they unsubscribe themselves.</p>}
          {action?.value === 'delete' && <p className="text-sm text-ink-muted">Deleted contacts can be restored from the “Deleted” filter.</p>}
        </div>
      </Dialog>
    </div>
  );
}

function CreateContactDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const { workspaceId, path } = useWorkspaceApi();
  const qc = useQueryClient();
  const fields = useCustomFields();
  const [values, setValues] = useState({ firstName: '', lastName: '', email: '', phone: '', defaultCountry: '', company: '', subscriptionType: 'marketing' });
  const [custom, setCustom] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(idempotencyKey);
  const activeFields = (fields.data?.data ?? []).filter((f: CustomFieldView) => f.status === 'active');
  const set = (k: keyof typeof values) => (e: { target: { value: string } }) => setValues((v) => ({ ...v, [k]: e.target.value }));

  async function submit() {
    setBusy(true);
    setErrors({});
    setFormError(null);
    try {
      const body = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== '')) as Record<string, unknown>;
      body.customFields = Object.fromEntries(Object.entries(custom).filter(([, v]) => v !== null && v !== ''));
      const c = await http.post<{ id: string }>(path('/contacts'), body, { 'idempotency-key': key });
      await qc.invalidateQueries({ queryKey: ['contacts', workspaceId] });
      await qc.invalidateQueries({ queryKey: ['contact-count', workspaceId] });
      setValues({ firstName: '', lastName: '', email: '', phone: '', defaultCountry: '', company: '', subscriptionType: 'marketing' });
      setCustom({});
      setKey(idempotencyKey());
      onCreated(c.id);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fields);
        setFormError(err.message);
      } else setFormError('Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New contact"
      description="Enter at least an email address or a phone number."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} onClick={() => void submit()}>
            Create contact
          </Button>
        </>
      }
    >
      <div className="grid max-h-[60vh] gap-4 overflow-auto pr-1 sm:grid-cols-2">
        {formError && (
          <div className="sm:col-span-2">
            <Alert tone="danger">{formError}</Alert>
          </div>
        )}
        <Field label="First name" errors={errors.firstName}>
          {(p) => <Input {...p} value={values.firstName} onChange={set('firstName')} autoFocus />}
        </Field>
        <Field label="Last name" errors={errors.lastName}>
          {(p) => <Input {...p} value={values.lastName} onChange={set('lastName')} />}
        </Field>
        <Field label="Email" errors={errors.email}>
          {(p) => <Input {...p} type="email" value={values.email} onChange={set('email')} />}
        </Field>
        <Field label="Phone" hint="With country code, or pick a default country" errors={errors.phone}>
          {(p) => <Input {...p} type="tel" value={values.phone} onChange={set('phone')} />}
        </Field>
        <Field label="Default country (for national numbers)" hint="Two letters, e.g. IN or US" errors={errors.defaultCountry}>
          {(p) => <Input {...p} maxLength={2} value={values.defaultCountry} onChange={(e) => setValues((v) => ({ ...v, defaultCountry: e.target.value.toUpperCase() }))} />}
        </Field>
        <Field label="Company" errors={errors.company}>
          {(p) => <Input {...p} value={values.company} onChange={set('company')} />}
        </Field>
        <Field label="Subscription" hint="Non-marketing contacts only receive transactional messages." errors={errors.subscriptionType}>
          {(p) => (
            <Select {...p} value={values.subscriptionType} onChange={set('subscriptionType')}>
              <option value="marketing">Marketing</option>
              <option value="non_marketing">Non-marketing</option>
            </Select>
          )}
        </Field>
        {activeFields.map((f) => (
          <CustomFieldInput key={f.id} field={f} value={custom[f.key]} onChange={(v) => setCustom((c) => ({ ...c, [f.key]: v }))} errors={errors[`customFields.${f.key}`]} />
        ))}
      </div>
    </Dialog>
  );
}

export default function ContactsPage() {
  return (
    <AudiencePage>
      <Suspense fallback={<Spinner />}>
        <ContactsInner />
      </Suspense>
    </AudiencePage>
  );
}
