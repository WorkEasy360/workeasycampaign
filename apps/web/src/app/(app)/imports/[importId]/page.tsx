'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IMPORT_TARGETS, type ImportIssueView, type ImportOptions, type ImportPreview, type ImportView, type Page } from '@workeasy/shared';
import { ArrowLeft, Download } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { AudiencePage } from '@/components/audience-shell';
import { Alert, Badge, Button, Card, ConfirmDialog, Field, Input, PageHeader, Select, Spinner, Table, Td, Th, useToast } from '@/components/ui';
import { http, idempotencyKey } from '@/lib/api';
import { audienceKeys, IMPORT_STATUS, useCustomFields, useLists, useTags, useTopics, useWorkspaceApi } from '@/lib/audience';
import { dateTime } from '@/lib/format';
import { errorMessage } from '@/lib/forms';

const TARGET_LABEL: Record<(typeof IMPORT_TARGETS)[number], string> = {
  email: 'Email',
  phone: 'Phone',
  whatsapp: 'WhatsApp number',
  first_name: 'First name',
  last_name: 'Last name',
  company: 'Company',
  timezone: 'Time zone',
  locale: 'Language',
};

type Options = ImportOptions & { consentEnabled: boolean };

function defaultOptions(o: Partial<ImportOptions>): Options {
  return {
    mode: o.mode ?? 'create_or_update',
    blankClears: o.blankClears ?? false,
    listIds: o.listIds ?? [],
    tagIds: o.tagIds ?? [],
    topicIds: o.topicIds ?? [],
    ...(o.defaultCountry ? { defaultCountry: o.defaultCountry } : {}),
    ...(o.subscriptionType ? { subscriptionType: o.subscriptionType } : {}),
    consent: o.consent ?? { channel: 'email', lawfulBasis: 'consent', evidenceNote: '' },
    consentEnabled: !!o.consent,
  };
}

function ImportInner({ importId }: { importId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { workspaceId, path } = useWorkspaceApi();
  const key = audienceKeys.importOne(workspaceId!, importId);
  const imp = useQuery({
    queryKey: key,
    queryFn: () => http.get<ImportView>(path(`/imports/${importId}`)),
    refetchInterval: (q) => (q.state.data?.status === 'processing' ? 1500 : false),
    retry: false,
  });
  const editable = imp.data?.status === 'uploaded' || imp.data?.status === 'validated';
  const preview = useQuery({
    queryKey: [...key, 'preview'],
    queryFn: () => http.get<ImportPreview>(path(`/imports/${importId}/preview`)),
    enabled: editable,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const fields = useCustomFields();
  const lists = useLists();
  const tags = useTags();
  const topics = useTopics();
  const [mapping, setMapping] = useState<Record<string, string> | null>(null);
  const [options, setOptions] = useState<Options | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [cancelling, setCancelling] = useState(false);
  const startKey = useRef(idempotencyKey());

  useEffect(() => {
    if (!imp.data || !preview.data || mapping) return;
    setMapping(Object.keys(imp.data.mapping).length ? imp.data.mapping : preview.data.suggestedMapping);
    setOptions(defaultOptions(imp.data.options));
  }, [imp.data, preview.data, mapping]);

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: key }), qc.invalidateQueries({ queryKey: audienceKeys.imports(workspaceId!) })]);

  const validate = useMutation({
    mutationFn: async () => {
      setError(null);
      setFieldErrors({});
      const { consentEnabled, consent, ...rest } = options!;
      await http.put(path(`/imports/${importId}/mapping`), {
        mapping: Object.fromEntries(Object.entries(mapping!).filter(([, t]) => t !== 'ignore')),
        options: { ...rest, ...(consentEnabled ? { consent } : {}) },
        version: imp.data!.version,
      });
      return http.post<ImportView>(path(`/imports/${importId}/dry-run`));
    },
    onSuccess: async (v) => {
      qc.setQueryData(key, v);
      await qc.invalidateQueries({ queryKey: [...key, 'issues', 'dry_run'] });
    },
    onError: (err) => {
      setError(errorMessage(err));
      if (err && typeof err === 'object' && 'fields' in err) setFieldErrors((err as { fields: Record<string, string[]> }).fields);
      void refresh();
    },
  });
  const start = useMutation({
    mutationFn: () => http.post<ImportView>(path(`/imports/${importId}/start`), {}, { 'Idempotency-Key': startKey.current }),
    onSuccess: async (v) => {
      qc.setQueryData(key, v);
      toast('success', 'Import started');
      await refresh();
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const act = useMutation({
    mutationFn: (kind: 'retry' | 'cancel') => http.post<ImportView>(path(`/imports/${importId}/${kind}`)),
    onSuccess: async (v, kind) => {
      setCancelling(false);
      qc.setQueryData(key, v);
      toast('success', kind === 'retry' ? 'Import resumed' : 'Import cancelled');
      await refresh();
    },
    onError: (err) => setError(errorMessage(err)),
  });

  if (imp.isLoading) return <Spinner />;
  if (imp.isError) return <Alert tone="danger" title="Import not available">{errorMessage(imp.error)}</Alert>;
  const i = imp.data!;
  const status = IMPORT_STATUS[i.status];
  const mapped = mapping ? Object.values(mapping) : [];
  const hasIdentity = mapped.some((t) => t === 'email' || t === 'phone' || t === 'whatsapp');
  const needsCountry = mapped.some((t) => t === 'phone' || t === 'whatsapp');
  const pct = i.totalRows ? Math.min(100, Math.round((i.processedRows / i.totalRows) * 100)) : 0;
  const targetOptions = [
    ...IMPORT_TARGETS.map((t) => ({ value: t, label: TARGET_LABEL[t] })),
    ...(fields.data?.data ?? []).filter((f) => f.status === 'active').map((f) => ({ value: `cf:${f.key}`, label: `Custom: ${f.label}` })),
  ];

  return (
    <>
      <Link href="/imports" className="mb-3 inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden /> Imports
      </Link>
      <PageHeader
        title={i.fileName}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={status.tone}>{status.label}</Badge>
            <span>
              {i.totalRows?.toLocaleString() ?? '?'} rows · {(i.fileSize / 1024).toFixed(0)} KB · uploaded {dateTime(i.createdAt)}
            </span>
          </span>
        }
        actions={
          ['uploaded', 'validated', 'processing', 'failed'].includes(i.status) && (
            <Button variant="ghost" className="text-danger" onClick={() => setCancelling(true)}>
              Cancel import
            </Button>
          )
        }
      />
      {error && (
        <div className="mb-4">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      {(i.status === 'processing' || i.status === 'completed' || i.status === 'failed' || (i.status === 'cancelled' && i.processedRows > 0)) && (
        <Card title={i.status === 'processing' ? 'Importing…' : 'Result'} className="mb-6">
          <div className="mb-3 h-2 overflow-hidden rounded-full bg-surface-muted" role="progressbar" aria-label="Import progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
          </div>
          <p className="mb-3 text-sm text-ink-muted">
            {i.processedRows.toLocaleString()} of {i.totalRows?.toLocaleString() ?? '?'} rows processed
          </p>
          <Counts items={[['Created', i.counts.created], ['Updated', i.counts.updated], ['Skipped', i.counts.skipped], ['Errors', i.counts.errors]]} />
          {i.status === 'failed' && (
            <div className="mt-4 space-y-3">
              <Alert tone="danger" title="The import stopped">
                {i.failureReason ?? 'An unexpected error occurred.'} Rows already imported are kept; retrying continues from where it stopped.
              </Alert>
              <Button loading={act.isPending} onClick={() => act.mutate('retry')}>
                Retry
              </Button>
            </div>
          )}
          {i.status !== 'processing' && <Issues importId={importId} phase="run" />}
        </Card>
      )}

      {editable && (
        <>
          <Card title="1. Match columns" description="Choose what each column contains. At least one email, phone or WhatsApp column is needed to identify contacts." className="mb-6">
            {!preview.data || !mapping ? (
              preview.isError ? <Alert tone="danger">{errorMessage(preview.error)}</Alert> : <Spinner />
            ) : (
              <Table label="Column mapping">
                <thead>
                  <tr>
                    <Th>Column</Th>
                    <Th>Sample values</Th>
                    <Th>Import as</Th>
                  </tr>
                </thead>
                <tbody>
                  {preview.data.headers.map((h, col) => (
                    <tr key={col}>
                      <Td className="font-medium">{h || <span className="text-ink-faint">(column {col + 1})</span>}</Td>
                      <Td className="max-w-64 truncate text-xs text-ink-muted" title={preview.data.rows.map((r) => r[col] ?? '').join(', ')}>
                        {preview.data.rows
                          .slice(0, 3)
                          .map((r) => r[col] ?? '')
                          .filter(Boolean)
                          .join(', ') || '—'}
                      </Td>
                      <Td>
                        <Select aria-label={`Import ${h || `column ${col + 1}`} as`} value={mapping[String(col)] ?? 'ignore'} onChange={(e) => setMapping((m) => ({ ...m, [String(col)]: e.target.value }))}>
                          <option value="ignore">Don’t import</option>
                          {targetOptions.map((t) => (
                            <option key={t.value} value={t.value} disabled={t.value !== mapping[String(col)] && mapped.includes(t.value)}>
                              {t.label}
                            </option>
                          ))}
                        </Select>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            {fieldErrors.mapping && <p className="mt-2 text-sm text-danger">{fieldErrors.mapping.join(' ')}</p>}
          </Card>

          {options && (
            <Card title="2. Options" className="mb-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="When a contact already exists">
                  {(p) => (
                    <Select {...p} value={options.mode} onChange={(e) => setOptions({ ...options, mode: e.target.value as Options['mode'] })}>
                      <option value="create_or_update">Update it; create new contacts too</option>
                      <option value="create_only">Skip it; only create new contacts</option>
                      <option value="update_only">Update it; don’t create new contacts</option>
                    </Select>
                  )}
                </Field>
                <Field label="Subscription type for new contacts">
                  {(p) => (
                    <Select {...p} value={options.subscriptionType ?? ''} onChange={(e) => setOptions({ ...options, subscriptionType: (e.target.value || undefined) as Options['subscriptionType'] })}>
                      <option value="">Workspace default</option>
                      <option value="marketing">Marketing</option>
                      <option value="non_marketing">Non-marketing</option>
                    </Select>
                  )}
                </Field>
                {needsCountry && (
                  <Field label="Country for numbers without +code" hint="Two-letter code, e.g. IN" errors={fieldErrors['options.defaultCountry']}>
                    {(p) => <Input {...p} maxLength={2} value={options.defaultCountry ?? ''} onChange={(e) => setOptions({ ...options, defaultCountry: e.target.value.toUpperCase() || undefined })} />}
                  </Field>
                )}
                <Multi label="Add to lists" items={(lists.data?.data ?? []).filter((l) => l.status === 'active')} value={options.listIds} onChange={(listIds) => setOptions({ ...options, listIds })} />
                <Multi label="Add tags" items={tags.data?.data ?? []} value={options.tagIds} onChange={(tagIds) => setOptions({ ...options, tagIds })} />
                <Multi
                  label="Subscribe to topics"
                  items={(topics.data?.data ?? []).filter((t) => t.kind === 'topic' && t.status === 'active')}
                  value={options.topicIds}
                  onChange={(topicIds) => setOptions({ ...options, topicIds })}
                />
              </div>
              <label className="mt-4 flex items-center gap-2 text-sm">
                <input type="checkbox" className="size-4" checked={options.blankClears} onChange={(e) => setOptions({ ...options, blankClears: e.target.checked })} />
                Empty cells clear existing values (otherwise they are ignored)
              </label>
              <fieldset className="mt-4 rounded-control border border-line p-4">
                <legend className="px-1 text-sm font-medium">Consent</legend>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="size-4" checked={options.consentEnabled} onChange={(e) => setOptions({ ...options, consentEnabled: e.target.checked })} />
                  These people gave consent, and I can prove it
                </label>
                {options.consentEnabled && options.consent && (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <Field label="Channel">
                      {(p) => (
                        <Select {...p} value={options.consent!.channel} onChange={(e) => setOptions({ ...options, consent: { ...options.consent!, channel: e.target.value as 'email' } })}>
                          <option value="email">Email</option>
                          <option value="sms">SMS</option>
                          <option value="whatsapp">WhatsApp</option>
                        </Select>
                      )}
                    </Field>
                    <Field label="Lawful basis">
                      {(p) => (
                        <Select {...p} value={options.consent!.lawfulBasis} onChange={(e) => setOptions({ ...options, consent: { ...options.consent!, lawfulBasis: e.target.value as 'consent' } })}>
                          {['consent', 'contract', 'legal_obligation', 'vital_interests', 'public_task', 'legitimate_interests'].map((b) => (
                            <option key={b} value={b}>
                              {b.replaceAll('_', ' ')}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    <div className="sm:col-span-2">
                      <Field label="How was consent collected?" hint="Stored as evidence on every imported contact." errors={fieldErrors['options.consent.evidenceNote']}>
                        {(p) => <Input {...p} value={options.consent!.evidenceNote} onChange={(e) => setOptions({ ...options, consent: { ...options.consent!, evidenceNote: e.target.value } })} />}
                      </Field>
                    </div>
                  </div>
                )}
                <p className="mt-2 text-xs text-ink-faint">Contacts who unsubscribed themselves are never re-subscribed by an import.</p>
              </fieldset>
            </Card>
          )}

          <Card title="3. Check and import" className="mb-6">
            {i.dryRun ? (
              <>
                <p className="mb-3 text-sm text-ink-muted">Dry run — nothing has changed yet. This is exactly what the import will do:</p>
                <Counts items={[['Will create', i.dryRun.create], ['Will update', i.dryRun.update], ['Will skip', i.dryRun.skip], ['Errors', i.dryRun.error]]} />
                <Issues importId={importId} phase="dry_run" />
              </>
            ) : (
              <p className="text-sm text-ink-muted">Run a check first. It reads the whole file and reports what would happen, without changing any contact.</p>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant={i.dryRun ? 'secondary' : 'primary'} loading={validate.isPending} disabled={!hasIdentity || !options} onClick={() => validate.mutate()}>
                {i.dryRun ? 'Check again' : 'Check file'}
              </Button>
              {i.status === 'validated' && i.dryRun && (
                <Button loading={start.isPending} disabled={i.dryRun.create + i.dryRun.update === 0} onClick={() => start.mutate()}>
                  Import {(i.dryRun.create + i.dryRun.update).toLocaleString()} contacts
                </Button>
              )}
            </div>
            {!hasIdentity && mapping && <p className="mt-2 text-sm text-warning">Map an email, phone or WhatsApp column to continue.</p>}
            {i.status === 'validated' && <p className="mt-2 text-xs text-ink-faint">Changing the columns or options above requires a new check.</p>}
          </Card>
        </>
      )}

      {i.status === 'cancelled' && <Alert tone="info">This import was cancelled{i.completedAt ? ` ${dateTime(i.completedAt)}` : ''}. The uploaded file has been deleted.</Alert>}

      <ConfirmDialog
        open={cancelling}
        onClose={() => setCancelling(false)}
        onConfirm={() => act.mutate('cancel')}
        title="Cancel this import?"
        body={i.processedRows > 0 ? 'Rows already imported stay imported. The rest of the file is discarded.' : 'The uploaded file is deleted.'}
        confirmLabel="Cancel import"
        busy={act.isPending}
      />
    </>
  );
}

function Counts({ items }: { items: [string, number][] }) {
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map(([label, n]) => (
        <div key={label} className="rounded-control bg-surface-muted p-3">
          <dt className="text-xs text-ink-muted">{label}</dt>
          <dd className="text-xl font-semibold tabular-nums">{n.toLocaleString()}</dd>
        </div>
      ))}
    </dl>
  );
}

function Multi({ label, items, value, onChange }: { label: string; items: { id: string; name: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium">{label}</legend>
      {items.length === 0 ? (
        <p className="text-xs text-ink-faint">None available.</p>
      ) : (
        <div className="flex max-h-32 flex-wrap gap-x-4 gap-y-1 overflow-auto">
          {items.map((it) => (
            <label key={it.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4" checked={value.includes(it.id)} onChange={(e) => onChange(e.target.checked ? [...value, it.id] : value.filter((x) => x !== it.id))} />
              {it.name}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

function Issues({ importId, phase }: { importId: string; phase: 'dry_run' | 'run' }) {
  const { workspaceId, path } = useWorkspaceApi();
  const issues = useInfiniteQuery({
    queryKey: [...audienceKeys.importOne(workspaceId!, importId), 'issues', phase],
    initialPageParam: '',
    queryFn: ({ pageParam }) => http.get<Page<ImportIssueView>>(path(`/imports/${importId}/issues?phase=${phase}&limit=50${pageParam ? `&cursor=${pageParam}` : ''}`)),
    getNextPageParam: (l) => l.nextCursor ?? undefined,
  });
  const rows = issues.data?.pages.flatMap((p) => p.data) ?? [];
  if (!rows.length) return null;
  return (
    <div className="mt-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Problems found</h3>
        <a href={`/api${path(`/imports/${importId}/issues.csv?phase=${phase}`)}`} download className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
          <Download className="size-4" aria-hidden /> Download CSV
        </a>
      </div>
      <Table label="Import problems">
        <thead>
          <tr>
            <Th>Row</Th>
            <Th>Column</Th>
            <Th>Problem</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr key={`${r.rowNumber}-${r.code}-${idx}`}>
              <Td className="tabular-nums">{r.rowNumber}</Td>
              <Td>{r.column ?? '—'}</Td>
              <Td>
                <Badge tone={r.severity === 'error' ? 'danger' : 'warning'}>{r.severity}</Badge> {r.message}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      {issues.hasNextPage && (
        <Button size="sm" variant="ghost" className="mt-2" onClick={() => void issues.fetchNextPage()}>
          More
        </Button>
      )}
    </div>
  );
}

export default function ImportDetailPage() {
  const { importId } = useParams<{ importId: string }>();
  return (
    <AudiencePage>
      <ImportInner importId={importId} />
    </AudiencePage>
  );
}
