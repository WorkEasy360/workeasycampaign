'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConsentEventView, ContactDetail, EligibilityResult, Page, TimelineEntry } from '@workeasy/shared';
import { ArrowLeft, ShieldAlert, Star, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { AudiencePage } from '@/components/audience-shell';
import { CustomFieldInput } from '@/components/custom-field-input';
import { Alert, Badge, Button, Card, ConfirmDialog, Dialog, Field, Input, PageHeader, Select, Spinner, useToast } from '@/components/ui';
import { ApiError, http } from '@/lib/api';
import { audienceKeys, CHANNEL_LABEL, SUBSCRIPTION_LABEL, useCustomFields, useLists, useTags, useTopics, useWorkspaceApi } from '@/lib/audience';
import { dateTime, humanizeAction, relativeTime } from '@/lib/format';
import { errorMessage } from '@/lib/forms';
import { useCan } from '@/lib/session';

function useContact(contactId: string) {
  const { workspaceId, path } = useWorkspaceApi();
  return useQuery({ queryKey: audienceKeys.contact(workspaceId!, contactId), queryFn: () => http.get<ContactDetail>(path(`/contacts/${contactId}`)), retry: false });
}

function useRefresh(contactId: string) {
  const qc = useQueryClient();
  const { workspaceId } = useWorkspaceApi();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: audienceKeys.contact(workspaceId!, contactId) }),
      qc.invalidateQueries({ queryKey: audienceKeys.timeline(workspaceId!, contactId) }),
      qc.invalidateQueries({ queryKey: audienceKeys.consentHistory(workspaceId!, contactId) }),
      qc.invalidateQueries({ queryKey: ['contacts', workspaceId] }),
    ]);
}

function ContactInner({ contactId }: { contactId: string }) {
  const contact = useContact(contactId);
  const can = useCan();
  if (contact.isLoading) return <Spinner />;
  if (contact.isError) {
    return (
      <Alert tone="danger" title="Contact not available">
        {errorMessage(contact.error)} <Link href="/contacts" className="text-accent underline">Back to contacts</Link>
      </Alert>
    );
  }
  const c = contact.data!;
  return (
    <>
      <Link href="/contacts" className="mb-3 inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden /> Contacts
      </Link>
      <PageHeader
        title={c.displayName}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {c.deletedAt ? <Badge tone="danger">Deleted {relativeTime(c.deletedAt)}</Badge> : <Badge tone={c.subscriptionType === 'marketing' ? 'success' : 'neutral'}>{SUBSCRIPTION_LABEL[c.subscriptionType]}</Badge>}
            {c.suppressed && <Badge tone="warning">Do not contact</Badge>}
            {c.unsubscribedBy === 'contact' && <Badge>Unsubscribed themselves</Badge>}
            <span className="text-ink-faint">Added {relativeTime(c.createdAt)} · source: {c.source}</span>
          </span>
        }
        actions={<DangerActions contact={c} />}
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <ProfileCard contact={c} editable={can('contacts.update') && !c.deletedAt} />
          <IdentitiesCard contact={c} editable={can('contacts.update') && !c.deletedAt} />
          <ConsentCard contact={c} />
          <TimelineCard contactId={c.id} />
        </div>
        <div className="space-y-6">
          <EligibilityCard contact={c} />
          <GroupsCard contact={c} />
          <TopicsCard contact={c} />
          <SuppressionCard contact={c} />
        </div>
      </div>
    </>
  );
}

function DangerActions({ contact: c }: { contact: ContactDetail }) {
  const can = useCan();
  const router = useRouter();
  const toast = useToast();
  const { path } = useWorkspaceApi();
  const refresh = useRefresh(c.id);
  const [confirm, setConfirm] = useState<'delete' | 'erase' | null>(null);
  const act = useMutation({
    mutationFn: async (kind: 'delete' | 'restore' | 'erase') =>
      kind === 'delete' ? http.delete(path(`/contacts/${c.id}`)) : kind === 'restore' ? http.post(path(`/contacts/${c.id}/restore`)) : http.post(path(`/contacts/${c.id}/erase`), { confirm: 'ERASE' }),
    onSuccess: async (_d, kind) => {
      setConfirm(null);
      if (kind === 'erase') {
        toast('success', 'Personal data erased');
        router.replace('/contacts');
        return;
      }
      toast('success', kind === 'delete' ? 'Contact deleted' : 'Contact restored');
      await refresh();
    },
  });
  if (!can('contacts.delete')) return null;
  return (
    <div className="flex gap-2">
      {c.deletedAt ? (
        <Button variant="secondary" loading={act.isPending} onClick={() => act.mutate('restore')}>
          Restore
        </Button>
      ) : (
        <Button variant="secondary" icon={<Trash2 className="size-4" />} onClick={() => setConfirm('delete')}>
          Delete
        </Button>
      )}
      <Button variant="ghost" className="text-danger" onClick={() => setConfirm('erase')}>
        Erase personal data
      </Button>
      <ConfirmDialog
        open={confirm === 'delete'}
        onClose={() => setConfirm(null)}
        onConfirm={() => act.mutate('delete')}
        title={`Delete ${c.displayName}?`}
        body="The contact is hidden everywhere and can be restored later."
        confirmLabel="Delete contact"
        busy={act.isPending}
        error={act.isError ? errorMessage(act.error) : null}
      />
      <ConfirmDialog
        open={confirm === 'erase'}
        onClose={() => setConfirm(null)}
        onConfirm={() => act.mutate('erase')}
        title="Permanently erase personal data?"
        body="Names, addresses, custom fields, lists and tags are removed and cannot be recovered. Consent evidence is kept in pseudonymous form for the retention period, as required to prove past consent."
        confirmLabel="Erase permanently"
        confirmText="ERASE"
        busy={act.isPending}
        error={act.isError ? errorMessage(act.error) : null}
      />
    </div>
  );
}

function ProfileCard({ contact: c, editable }: { contact: ContactDetail; editable: boolean }) {
  const { path } = useWorkspaceApi();
  const toast = useToast();
  const refresh = useRefresh(c.id);
  const fields = useCustomFields();
  const [values, setValues] = useState({ firstName: c.firstName ?? '', lastName: c.lastName ?? '', company: c.company ?? '', timezone: c.timezone ?? '', locale: c.locale ?? '' });
  const [custom, setCustom] = useState<Record<string, unknown>>(c.customFields);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setValues({ firstName: c.firstName ?? '', lastName: c.lastName ?? '', company: c.company ?? '', timezone: c.timezone ?? '', locale: c.locale ?? '' });
    setCustom(c.customFields);
  }, [c]);
  const defs = fields.data?.data ?? [];
  const shown = defs.filter((f) => f.status === 'active' || c.customFields[f.key] !== undefined);

  async function save() {
    setBusy(true);
    setErrors({});
    setError(null);
    try {
      const changedCustom = Object.fromEntries(
        Object.entries(custom).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(c.customFields[k]) && defs.find((d) => d.key === k)?.status === 'active'),
      );
      for (const k of Object.keys(c.customFields)) if (!(k in custom)) changedCustom[k] = null;
      await http.patch(path(`/contacts/${c.id}`), {
        firstName: values.firstName,
        lastName: values.lastName,
        company: values.company,
        timezone: values.timezone || null,
        locale: values.locale || null,
        ...(Object.keys(changedCustom).length ? { customFields: changedCustom } : {}),
        version: c.version,
      });
      toast('success', 'Contact saved');
      await refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fields);
        setError(err.code === 'version_conflict' ? 'Someone else changed this contact. Reload to see the latest version.' : err.message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Profile" actions={editable && <Button size="sm" loading={busy} onClick={() => void save()}>Save</Button>}>
      {error && (
        <div className="mb-4">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {(['firstName', 'lastName', 'company', 'timezone', 'locale'] as const).map((k) => (
          <Field key={k} label={{ firstName: 'First name', lastName: 'Last name', company: 'Company', timezone: 'Time zone', locale: 'Language' }[k]} hint={k === 'timezone' ? 'e.g. Asia/Kolkata' : k === 'locale' ? 'e.g. en-IN' : undefined} errors={errors[k]}>
            {(p) => <Input {...p} disabled={!editable} value={values[k]} onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))} />}
          </Field>
        ))}
        {shown.map((f) => (
          <CustomFieldInput key={f.id} field={f} disabled={!editable} value={custom[f.key]} onChange={(v) => setCustom((x) => ({ ...x, [f.key]: v }))} errors={errors[`customFields.${f.key}`]} />
        ))}
      </div>
    </Card>
  );
}

function IdentitiesCard({ contact: c, editable }: { contact: ContactDetail; editable: boolean }) {
  const { path } = useWorkspaceApi();
  const refresh = useRefresh(c.id);
  const toast = useToast();
  const [kind, setKind] = useState('email');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: async () => {
      setValue('');
      setError(null);
      await refresh();
    },
    onError: (err) => (err instanceof ApiError ? setError(err.message) : toast('danger', 'Something went wrong')),
  });
  return (
    <Card title="Email, phone and other identities" description="Each address belongs to one contact in this workspace.">
      <ul className="divide-y divide-line">
        {c.identities.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
            <Badge>{i.kind === 'external' ? i.provider : CHANNEL_LABEL[i.kind === 'phone' ? 'sms' : (i.kind as 'email' | 'whatsapp')] ?? i.kind}</Badge>
            <span className="flex-1 break-all font-medium">{i.value}</span>
            {i.isPrimary ? (
              <Badge tone="accent">Primary</Badge>
            ) : (
              editable && (
                <Button size="sm" variant="ghost" icon={<Star className="size-3.5" />} onClick={() => run.mutate(() => http.post(path(`/contacts/${c.id}/identities/${i.id}/primary`)))}>
                  Make primary
                </Button>
              )
            )}
            {editable && (
              <Button size="sm" variant="ghost" aria-label={`Remove ${i.value}`} onClick={() => run.mutate(() => http.delete(path(`/contacts/${c.id}/identities/${i.id}`)))}>
                <Trash2 className="size-4" />
              </Button>
            )}
          </li>
        ))}
      </ul>
      {editable && (
        <form
          className="mt-4 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run.mutate(() => http.post(path(`/contacts/${c.id}/identities`), { kind, value }));
          }}
        >
          <Field label="Type">
            {(p) => (
              <Select {...p} className="w-36" value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="email">Email</option>
                <option value="phone">Phone</option>
                <option value="whatsapp">WhatsApp</option>
              </Select>
            )}
          </Field>
          <div className="min-w-48 flex-1">
            <Field label="Value">{(p) => <Input {...p} value={value} onChange={(e) => setValue(e.target.value)} placeholder={kind === 'email' ? 'name@example.com' : '+91 98765 43210'} />}</Field>
          </div>
          <Button type="submit" variant="secondary" loading={run.isPending} disabled={!value.trim()}>
            Add
          </Button>
        </form>
      )}
      {error && (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
    </Card>
  );
}

function ConsentCard({ contact: c }: { contact: ContactDetail }) {
  const can = useCan();
  const { workspaceId, path } = useWorkspaceApi();
  const refresh = useRefresh(c.id);
  const toast = useToast();
  const [recording, setRecording] = useState<'email' | 'sms' | 'whatsapp' | null>(null);
  const [form, setForm] = useState({ action: 'subscribed', lawfulBasis: 'consent', source: 'paper', evidenceNote: '', evidenceReference: '' });
  const [error, setError] = useState<string | null>(null);
  const history = useInfiniteQuery({
    queryKey: audienceKeys.consentHistory(workspaceId!, c.id),
    initialPageParam: '',
    queryFn: ({ pageParam }) => http.get<Page<ConsentEventView>>(path(`/contacts/${c.id}/consent?limit=10${pageParam ? `&cursor=${pageParam}` : ''}`)),
    getNextPageParam: (l) => l.nextCursor ?? undefined,
    enabled: can('consent.read'),
  });
  const record = useMutation({
    mutationFn: () =>
      http.post<{ changed: boolean }>(path(`/contacts/${c.id}/consent`), {
        channel: recording,
        action: form.action,
        source: form.source,
        ...(form.action === 'subscribed' || form.action === 'confirmed' ? { lawfulBasis: form.lawfulBasis } : {}),
        ...(form.evidenceNote ? { evidenceNote: form.evidenceNote } : {}),
        ...(form.evidenceReference ? { evidenceReference: form.evidenceReference } : {}),
      }),
    onSuccess: async (r) => {
      toast(r.changed ? 'success' : 'info', r.changed ? 'Consent recorded' : 'Nothing changed — consent was already in that state');
      setRecording(null);
      await refresh();
    },
    onError: (err) => setError(errorMessage(err)),
  });
  if (!can('consent.read')) return null;
  const tone = { granted: 'success', pending: 'warning', withdrawn: 'danger', none: 'neutral' } as const;

  return (
    <Card title="Consent" description="Evidence is append-only: every change is kept with who, when and how.">
      <div className="grid gap-3 sm:grid-cols-3">
        {c.consent.map((s) => (
          <div key={s.channel} className="rounded-control border border-line p-3">
            <p className="text-sm font-medium">{CHANNEL_LABEL[s.channel]}</p>
            <div className="mt-1 flex items-center gap-2">
              <Badge tone={tone[s.state]}>{s.state === 'none' ? 'No consent' : s.state}</Badge>
              {s.changedBy === 'contact' && <span className="text-xs text-ink-muted">by contact</span>}
            </div>
            {s.changedAt && <p className="mt-1 text-xs text-ink-faint">{relativeTime(s.changedAt)}</p>}
            {can('consent.manage') && !c.deletedAt && (
              <Button
                size="sm"
                variant="ghost"
                className="mt-2"
                onClick={() => {
                  setForm({ action: s.state === 'granted' ? 'revoked' : 'subscribed', lawfulBasis: 'consent', source: 'paper', evidenceNote: '', evidenceReference: '' });
                  setError(null);
                  setRecording(s.channel);
                }}
              >
                Record change
              </Button>
            )}
          </div>
        ))}
      </div>
      <h3 className="mb-2 mt-6 text-sm font-semibold">History</h3>
      {history.data?.pages[0]?.data.length === 0 ? (
        <p className="text-sm text-ink-muted">No consent has been recorded for this contact.</p>
      ) : (
        <ol className="space-y-2 text-sm">
          {history.data?.pages.flatMap((p) => p.data).map((e) => (
            <li key={e.id} className="rounded-control bg-surface-muted px-3 py-2">
              <span className="font-medium">{e.scope.type === 'channel' ? CHANNEL_LABEL[e.scope.channel] : `Topic: ${e.scope.topicName ?? 'archived'}`}</span> —{' '}
              {humanizeAction(e.action)} ({e.previousState} → {e.newState}) · {e.source} · by {e.actor.type}
              {e.lawfulBasis && ` · basis: ${e.lawfulBasis.replaceAll('_', ' ')}`}
              <span className="block text-xs text-ink-faint">
                {dateTime(e.occurredAt)}
                {typeof e.evidence.note === 'string' && ` · “${e.evidence.note}”`}
                {typeof e.evidence.reference === 'string' && ` · ref ${e.evidence.reference}`}
                {typeof e.evidence.importId === 'string' && ` · import row ${String(e.evidence.row)}`}
              </span>
            </li>
          ))}
        </ol>
      )}
      {history.hasNextPage && (
        <Button size="sm" variant="ghost" className="mt-2" onClick={() => void history.fetchNextPage()}>
          Older entries
        </Button>
      )}
      <Dialog
        open={!!recording}
        onClose={() => setRecording(null)}
        title={`Record ${recording ? CHANNEL_LABEL[recording] : ''} consent`}
        description="Only record what you can prove. Staff cannot re-subscribe someone who unsubscribed themselves."
        footer={
          <>
            <Button variant="secondary" onClick={() => setRecording(null)}>
              Cancel
            </Button>
            <Button loading={record.isPending} onClick={() => record.mutate()}>
              Record
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="What happened">
            {(p) => (
              <Select {...p} value={form.action} onChange={(e) => setForm((f) => ({ ...f, action: e.target.value }))}>
                <option value="subscribed">They gave consent</option>
                <option value="pending">Consent requested (awaiting confirmation)</option>
                <option value="confirmed">They confirmed (double opt-in)</option>
                <option value="unsubscribed">They withdrew consent</option>
                <option value="revoked">Withdrawn by us (compliance)</option>
              </Select>
            )}
          </Field>
          {(form.action === 'subscribed' || form.action === 'confirmed') && (
            <Field label="Lawful basis">
              {(p) => (
                <Select {...p} value={form.lawfulBasis} onChange={(e) => setForm((f) => ({ ...f, lawfulBasis: e.target.value }))}>
                  {['consent', 'contract', 'legal_obligation', 'vital_interests', 'public_task', 'legitimate_interests'].map((b) => (
                    <option key={b} value={b}>
                      {b.replaceAll('_', ' ')}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <Field label="Collected through">
            {(p) => (
              <Select {...p} value={form.source} onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))}>
                <option value="paper">Paper or signed form</option>
                <option value="verbal">Verbal (phone or in person)</option>
                <option value="form">Web form</option>
                <option value="admin">Other</option>
              </Select>
            )}
          </Field>
          <Field label="Evidence" hint="How you know — e.g. ‘Signed sheet, Mumbai expo, 3 Oct’">
            {(p) => <Input {...p} value={form.evidenceNote} onChange={(e) => setForm((f) => ({ ...f, evidenceNote: e.target.value }))} />}
          </Field>
          <Field label="Reference (optional)" hint="Ticket, document or file number">
            {(p) => <Input {...p} value={form.evidenceReference} onChange={(e) => setForm((f) => ({ ...f, evidenceReference: e.target.value }))} />}
          </Field>
        </div>
      </Dialog>
    </Card>
  );
}

function EligibilityCard({ contact: c }: { contact: ContactDetail }) {
  const { path } = useWorkspaceApi();
  const topics = useTopics();
  const [channel, setChannel] = useState<'email' | 'sms' | 'whatsapp'>('email');
  const [topicId, setTopicId] = useState('');
  const result = useQuery({
    queryKey: ['eligibility', c.id, c.version, channel, topicId, c.suppressions.length, c.consent.map((s) => s.state).join(), c.topics.map((t) => t.status).join()],
    queryFn: () => http.post<{ results: EligibilityResult[] }>(path('/eligibility/check'), { contactIds: [c.id], channel, ...(topicId ? { topicId } : {}) }),
  });
  const r = result.data?.results[0];
  return (
    <Card title="Can we message this contact?" description="The same check every campaign will use.">
      <div className="mb-3 grid grid-cols-2 gap-2">
        <Select aria-label="Channel" value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)}>
          <option value="email">Email</option>
          <option value="sms">SMS</option>
          <option value="whatsapp">WhatsApp</option>
        </Select>
        <Select aria-label="Topic" value={topicId} onChange={(e) => setTopicId(e.target.value)}>
          <option value="">Any topic</option>
          {topics.data?.data
            .filter((t) => t.kind === 'topic' && t.status === 'active')
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
        </Select>
      </div>
      {!r ? (
        <Spinner label="Checking" />
      ) : r.eligible ? (
        <Alert tone="success" title="Eligible">Marketing on {CHANNEL_LABEL[channel]} can reach this contact.</Alert>
      ) : (
        <div role="status" className="rounded-control bg-warning-soft p-3 text-sm">
          <p className="mb-1 flex items-center gap-2 font-medium">
            <ShieldAlert className="size-4" aria-hidden /> Not eligible
          </p>
          <ul className="ml-6 list-disc text-ink-muted">
            {r.reasons.map((x) => (
              <li key={x.code}>
                {x.message} <code className="text-xs">{x.code}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function GroupsCard({ contact: c }: { contact: ContactDetail }) {
  const can = useCan();
  const { path } = useWorkspaceApi();
  const refresh = useRefresh(c.id);
  const toast = useToast();
  const lists = useLists();
  const tags = useTags();
  const [listId, setListId] = useState('');
  const [tagId, setTagId] = useState('');
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: async () => {
      setListId('');
      setTagId('');
      await refresh();
    },
    onError: (err) => toast('danger', errorMessage(err)),
  });
  const editable = !c.deletedAt;
  return (
    <Card title="Lists and tags">
      <Section title="Lists">
        {c.lists.length === 0 ? <p className="text-sm text-ink-muted">Not on any list.</p> : null}
        <div className="flex flex-wrap gap-2">
          {c.lists.map((l) => (
            <span key={l.id} className="inline-flex items-center gap-1 rounded-full bg-surface-muted px-2 py-0.5 text-xs">
              {l.name}
              {can('lists.manage') && editable && (
                <button type="button" aria-label={`Remove from ${l.name}`} className="text-ink-faint hover:text-danger" onClick={() => run.mutate(() => http.delete(path(`/lists/${l.id}/members`), { contactIds: [c.id] }))}>
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
        {can('lists.manage') && editable && (
          <div className="mt-2 flex gap-2">
            <Select aria-label="Add to list" className="h-8" value={listId} onChange={(e) => setListId(e.target.value)}>
              <option value="">Add to list…</option>
              {lists.data?.data
                .filter((l) => l.status === 'active' && !c.lists.some((x) => x.id === l.id))
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
            </Select>
            <Button size="sm" variant="secondary" aria-label="Add to selected list" disabled={!listId} onClick={() => run.mutate(() => http.post(path(`/lists/${listId}/members`), { contactIds: [c.id] }))}>
              Add
            </Button>
          </div>
        )}
      </Section>
      <Section title="Tags">
        {c.tags.length === 0 ? <p className="text-sm text-ink-muted">No tags.</p> : null}
        <div className="flex flex-wrap gap-2">
          {c.tags.map((t) => (
            <span key={t.id} className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent">
              {t.name}
              {can('tags.manage') && editable && (
                <button type="button" aria-label={`Remove tag ${t.name}`} className="hover:text-danger" onClick={() => run.mutate(() => http.delete(path(`/contacts/${c.id}/tags/${t.id}`)))}>
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
        {can('tags.manage') && editable && (
          <div className="mt-2 flex gap-2">
            <Select aria-label="Add tag" className="h-8" value={tagId} onChange={(e) => setTagId(e.target.value)}>
              <option value="">Add tag…</option>
              {tags.data?.data
                .filter((t) => !c.tags.some((x) => x.id === t.id))
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </Select>
            <Button size="sm" variant="secondary" aria-label="Add selected tag" disabled={!tagId} onClick={() => run.mutate(() => http.put(path(`/contacts/${c.id}/tags/${tagId}`), {}))}>
              Add
            </Button>
          </div>
        )}
      </Section>
    </Card>
  );
}

function TopicsCard({ contact: c }: { contact: ContactDetail }) {
  const can = useCan();
  const { path } = useWorkspaceApi();
  const refresh = useRefresh(c.id);
  const toast = useToast();
  const topics = useTopics();
  const set = useMutation({
    mutationFn: ({ topicId, status }: { topicId: string; status: 'subscribed' | 'unsubscribed' }) => http.put<{ changed: boolean }>(path(`/contacts/${c.id}/topics/${topicId}`), { status }),
    onSuccess: async () => refresh(),
    onError: (err) => toast('danger', errorMessage(err)),
  });
  const all = (topics.data?.data ?? []).filter((t) => t.kind === 'topic');
  return (
    <Card title="Topics" description="What this person wants to hear about.">
      <ul className="space-y-2">
        {all.map((t) => {
          const pref = c.topics.find((p) => p.topic.id === t.id);
          const subscribed = pref?.status === 'subscribed';
          return (
            <li key={t.id} className="flex items-center justify-between gap-2 text-sm">
              <span>
                {t.name} {t.status === 'archived' && <Badge>archived</Badge>}
                {pref?.changedBy === 'contact' && pref.status === 'unsubscribed' && <span className="block text-xs text-ink-faint">Unsubscribed themselves</span>}
              </span>
              {can('consent.manage') && !c.deletedAt ? (
                <Button
                  size="sm"
                  variant={subscribed ? 'secondary' : 'ghost'}
                  disabled={t.status === 'archived' && !subscribed}
                  aria-pressed={subscribed}
                  onClick={() => set.mutate({ topicId: t.id, status: subscribed ? 'unsubscribed' : 'subscribed' })}
                >
                  {subscribed ? 'Subscribed' : 'Subscribe'}
                </Button>
              ) : (
                <Badge tone={subscribed ? 'success' : 'neutral'}>{subscribed ? 'Subscribed' : 'Not subscribed'}</Badge>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function SuppressionCard({ contact: c }: { contact: ContactDetail }) {
  const can = useCan();
  const { path } = useWorkspaceApi();
  const refresh = useRefresh(c.id);
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [channel, setChannel] = useState('all');
  const [reason, setReason] = useState('manual');
  const [note, setNote] = useState('');
  const [lifting, setLifting] = useState<string | null>(null);
  const [liftReason, setLiftReason] = useState('');
  const add = useMutation({
    mutationFn: () => http.post(path('/suppressions'), { contactId: c.id, channel, reason, note }),
    onSuccess: async () => {
      setAdding(false);
      setNote('');
      toast('success', 'Added to the do-not-contact list');
      await refresh();
    },
  });
  const lift = useMutation({
    mutationFn: () => http.post(path(`/suppressions/${lifting}/lift`), { reason: liftReason }),
    onSuccess: async () => {
      setLifting(null);
      setLiftReason('');
      toast('success', 'Suppression lifted');
      await refresh();
    },
  });
  if (!can('suppression.read')) return null;
  return (
    <Card
      title="Do not contact"
      description="Suppression overrides consent and applies to every message, transactional included."
      actions={can('suppression.manage') && <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>Suppress</Button>}
    >
      {c.suppressions.length === 0 ? (
        <p className="text-sm text-ink-muted">Not suppressed.</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {c.suppressions.map((s) => (
            <li key={s.id} className="rounded-control bg-warning-soft px-3 py-2">
              <span className="font-medium">{CHANNEL_LABEL[s.channel]}</span> · {s.reason.replaceAll('_', ' ')}
              {s.target.type === 'address' && <span className="block text-xs">via address {s.target.value}</span>}
              {s.note && <span className="block text-xs text-ink-muted">“{s.note}”</span>}
              <span className="block text-xs text-ink-faint">{relativeTime(s.createdAt)}</span>
              {can('suppression.manage') && (
                <Button size="sm" variant="ghost" onClick={() => setLifting(s.id)}>
                  Lift
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title="Add to do-not-contact"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={add.isPending} onClick={() => add.mutate()}>
              Suppress
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {add.isError && <Alert tone="danger">{errorMessage(add.error)}</Alert>}
          <Field label="Channel">
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
          <Field label="Reason">
            {(p) => (
              <Select {...p} value={reason} onChange={(e) => setReason(e.target.value)}>
                <option value="manual">Manual</option>
                <option value="unsubscribe_request">They asked not to be contacted</option>
                <option value="compliance">Compliance / legal</option>
                <option value="invalid_address">Invalid address</option>
              </Select>
            )}
          </Field>
          <Field label="Note (optional)">{(p) => <Input {...p} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        </div>
      </Dialog>
      <Dialog
        open={!!lifting}
        onClose={() => setLifting(null)}
        title="Lift suppression"
        description="The history is kept. Explain why messages may resume."
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
    </Card>
  );
}

function TimelineCard({ contactId }: { contactId: string }) {
  const { workspaceId, path } = useWorkspaceApi();
  const lists = useLists();
  const tags = useTags();
  const topics = useTopics();
  const tl = useInfiniteQuery({
    queryKey: audienceKeys.timeline(workspaceId!, contactId),
    initialPageParam: '',
    queryFn: ({ pageParam }) => http.get<Page<TimelineEntry>>(path(`/contacts/${contactId}/timeline?limit=20${pageParam ? `&cursor=${pageParam}` : ''}`)),
    getNextPageParam: (l) => l.nextCursor ?? undefined,
  });
  const nameOf = (data: Record<string, unknown>) => {
    if (typeof data.listId === 'string') return lists.data?.data.find((l) => l.id === data.listId)?.name ?? 'a list';
    if (typeof data.tagId === 'string') return tags.data?.data.find((t) => t.id === data.tagId)?.name ?? 'a tag';
    if (typeof data.topicId === 'string') return topics.data?.data.find((t) => t.id === data.topicId)?.name ?? 'a topic';
    if (typeof data.channel === 'string') return `${data.channel} → ${String(data.newState ?? data.action ?? '')}`;
    if (Array.isArray(data.changes)) return (data.changes as string[]).join(', ');
    if (typeof data.kind === 'string') return data.kind;
    if (typeof data.to === 'string') return `${String(data.from)} → ${data.to}`;
    return '';
  };
  const entries = tl.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <Card title="Activity" description="Profile, identity, list, tag, topic and consent changes. Message activity appears here once campaigns are sending.">
      {tl.isLoading ? (
        <Spinner />
      ) : entries.length === 0 ? (
        <p className="text-sm text-ink-muted">No activity yet.</p>
      ) : (
        <ol className="relative space-y-3 border-l border-line pl-4">
          {entries.map((e) => (
            <li key={e.id} className="text-sm">
              <span className="absolute -left-1.5 mt-1.5 size-3 rounded-full border-2 border-surface bg-accent" aria-hidden />
              <span className="font-medium">{humanizeAction(e.type)}</span> {nameOf(e.data) && <span className="text-ink-muted">· {nameOf(e.data)}</span>}
              <span className="block text-xs text-ink-faint">
                {dateTime(e.occurredAt)} · {e.actor.type}
              </span>
            </li>
          ))}
        </ol>
      )}
      {tl.hasNextPage && (
        <Button size="sm" variant="ghost" className="mt-3" onClick={() => void tl.fetchNextPage()}>
          Older activity
        </Button>
      )}
    </Card>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-4 last:mb-0">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">{title}</h3>
      {children}
    </div>
  );
}

export default function ContactDetailPage() {
  const { contactId } = useParams<{ contactId: string }>();
  return (
    <AudiencePage>
      <ContactInner contactId={contactId} />
    </AudiencePage>
  );
}
