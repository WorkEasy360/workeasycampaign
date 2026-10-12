'use client';

import { useQueryClient } from '@tanstack/react-query';
import type { TemplateVersionListItem, TemplateView } from '@workeasy/shared';
import { ArrowLeft, FileText, History, Lock, Save } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { RequireWorkspace } from '@/components/audience-shell';
import { ErrorAlert } from '@/components/campaigns/common';
import { type MessageContent, MessageEditor } from '@/components/campaigns/message-editor';
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, Field, Input, PageHeader, Spinner, useToast } from '@/components/ui';
import { ApiError, http } from '@/lib/api';
import { useWorkspaceApi } from '@/lib/audience';
import { type DesignedContent, emptyDesignedEmail, templateKeys, useTemplate, useTemplateVersions } from '@/lib/content';
import { relativeTime } from '@/lib/format';
import { errorMessage } from '@/lib/forms';
import { useCan } from '@/lib/session';

interface Form {
  name: string;
  description: string;
  category: string;
  content: DesignedContent;
}
const fromView = (t: TemplateView): Form => ({ name: t.name, description: t.description, category: t.category ?? '', content: t.content });
const EMPTY: Form = { name: '', description: '', category: '', content: emptyDesignedEmail() };
const categoryOf = (f: Form) => (f.category.trim() ? f.category.trim() : null);

const CHANGE_LABEL: Record<TemplateVersionListItem['change'], string> = {
  created: 'Created',
  updated: 'Edited',
  restored: 'Restored',
  imported: 'Earlier state',
};

/**
 * Version history (7.1): every saved state, newest first. Restoring copies an older version's content, description and
 * category into a NEW version — nothing in the history is rewritten.
 */
function HistoryCard({ template, dirty, editable, onRestored }: { template: TemplateView; dirty: boolean; editable: boolean; onRestored: (t: TemplateView) => void }) {
  const { workspaceId, path } = useWorkspaceApi();
  const qc = useQueryClient();
  const toast = useToast();
  const versions = useTemplateVersions(template.id);
  const rows = versions.data?.pages.flatMap((p) => p.data) ?? [];
  const [restoring, setRestoring] = useState<TemplateVersionListItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Card title="History" description="Every saved version of this template. Restoring creates a new version; earlier versions are kept.">
      {versions.isLoading ? (
        <Spinner label="Loading history" />
      ) : versions.isError ? (
        <ErrorAlert error={versions.error} title="The history could not be loaded" onRetry={() => void versions.refetch()} />
      ) : (
        <>
          <ol className="divide-y divide-line" aria-label="Template versions">
            {rows.map((v) => (
              <li key={v.version} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    Version {v.version} <Badge tone={v.version === template.version ? 'accent' : 'neutral'}>{v.version === template.version ? 'Current' : CHANGE_LABEL[v.change]}</Badge>
                    {v.restoredFromVersion && <span className="ml-2 text-xs text-ink-muted">from version {v.restoredFromVersion}</span>}
                  </p>
                  <p className="truncate text-sm text-ink-muted">
                    Subject: {v.subject} · {relativeTime(v.createdAt)}
                    {v.createdBy ? ` · ${v.createdBy.displayName}` : ''}
                  </p>
                </div>
                {editable && v.version !== template.version && (
                  <Button size="sm" variant="secondary" icon={<History className="size-4" aria-hidden />} onClick={() => setRestoring(v)} aria-label={`Restore version ${v.version}`}>
                    Restore
                  </Button>
                )}
              </li>
            ))}
          </ol>
          {versions.hasNextPage && (
            <div className="mt-3 flex justify-center">
              <Button size="sm" variant="secondary" loading={versions.isFetchingNextPage} onClick={() => void versions.fetchNextPage()}>
                Show older versions
              </Button>
            </div>
          )}
        </>
      )}
      <ConfirmDialog
        open={!!restoring}
        title={`Restore version ${restoring?.version ?? ''}?`}
        body={
          dirty
            ? 'Your unsaved changes will be replaced. The content, description and category of that version become a new version; the name stays.'
            : 'The content, description and category of that version become a new version; the name stays. Earlier versions are kept.'
        }
        confirmLabel="Restore version"
        busy={busy}
        error={error}
        onClose={() => {
          setRestoring(null);
          setError(null);
        }}
        onConfirm={() => {
          setBusy(true);
          setError(null);
          http
            .post<TemplateView>(path(`/templates/${template.id}/restore`), { version: restoring!.version, expectedVersion: template.version })
            .then(async (next) => {
              qc.setQueryData(templateKeys.one(workspaceId!, template.id), next);
              await qc.invalidateQueries({ queryKey: templateKeys.all(workspaceId!) });
              onRestored(next);
              toast('success', next.version === template.version ? 'That version is already the current one' : `Version ${restoring!.version} restored as version ${next.version}`);
              setRestoring(null);
            })
            .catch((err: unknown) =>
              setError(err instanceof ApiError && err.code === 'version_conflict' ? 'This template was changed by someone else. Reload the page to see the latest version.' : errorMessage(err)),
            )
            .finally(() => setBusy(false));
        }}
      />
    </Card>
  );
}

/** Create (`/templates/new`) or edit one template. Server validation decides; problems are shown per field. */
function TemplateEditor({ templateId }: { templateId: string | null }) {
  const can = useCan();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const { workspaceId, path } = useWorkspaceApi();
  const template = useTemplate(templateId);
  const editable = can('templates.manage');
  const [base, setBase] = useState<TemplateView | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    if (template.data && (!base || template.data.version !== base.version)) {
      setBase(template.data);
      setForm(fromView(template.data));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template.data]);

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(base ? fromView(base) : EMPTY), [form, base]);
  const fields = error instanceof ApiError ? error.fields : {};
  const contentErrors = Object.entries(fields).filter(([k]) => k.startsWith('content'));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!base) {
        const created = await http.post<TemplateView>(path('/templates'), { name: form.name, description: form.description, category: categoryOf(form), content: form.content });
        await qc.invalidateQueries({ queryKey: templateKeys.all(workspaceId!) });
        toast('success', 'Template created');
        router.replace(`/templates/${created.id}`);
        return;
      }
      const next = await http.patch<TemplateView>(path(`/templates/${base.id}`), {
        expectedVersion: base.version,
        name: form.name,
        description: form.description,
        category: categoryOf(form),
        content: form.content,
      });
      qc.setQueryData(templateKeys.one(workspaceId!, base.id), next);
      await qc.invalidateQueries({ queryKey: templateKeys.all(workspaceId!) });
      setBase(next);
      setForm(fromView(next));
      toast('success', 'Template saved');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'version_conflict') setConflict(true);
      else setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (templateId && template.isLoading) return <Spinner label="Loading template" />;
  if (templateId && template.isError) {
    if (template.error instanceof ApiError && template.error.status === 404) {
      return (
        <EmptyState icon={<FileText className="size-8" />} title="Template not found" action={<Link href="/templates" className="text-sm font-medium text-accent hover:underline">Back to templates</Link>}>
          It may have been deleted, or it belongs to another workspace.
        </EmptyState>
      );
    }
    return <ErrorAlert error={template.error} title="This template could not be loaded" onRetry={() => void template.refetch()} />;
  }

  return (
    <>
      <Link href="/templates" className="mb-3 inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden /> Templates
      </Link>
      <PageHeader title={base ? base.name : 'New template'} description="A reusable designed email. Personal fields are filled in for each contact when a campaign uses it." />
      <div className="space-y-6">
        {conflict && (
          <Alert tone="warning" title="Changed by someone else">
            This template was changed after you opened it. Your edits are still here; reload to see the latest version, then apply them again.
            <div className="mt-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setConflict(false);
                  setBase(null);
                  void template.refetch();
                }}
              >
                Reload latest version
              </Button>
            </div>
          </Alert>
        )}
        {error != null && !conflict && <ErrorAlert error={error} title="The template could not be saved" />}
        {contentErrors.length > 0 && (
          <Alert tone="danger" title="Fix the content">
            <ul className="list-disc pl-5">
              {contentErrors.map(([k, msgs]) => (
                <li key={k}>{msgs.join(' ')}</li>
              ))}
            </ul>
          </Alert>
        )}
        {!editable && <Alert tone="info">This template is read-only for you.</Alert>}
        <Card title="Details">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Name" errors={fields.name}>
              {(p) => <Input {...p} value={form.name} disabled={!editable} maxLength={120} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />}
            </Field>
            <Field label="Description (optional)" errors={fields.description}>
              {(p) => <Input {...p} value={form.description} disabled={!editable} maxLength={500} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />}
            </Field>
            <Field label="Category (optional)" hint="For example: Newsletters" errors={fields.category}>
              {(p) => <Input {...p} value={form.category} disabled={!editable} maxLength={60} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} />}
            </Field>
          </div>
        </Card>
        <Card title="Email">
          <MessageEditor value={form.content} disabled={!editable} errors={{}} onChange={(c: MessageContent) => setForm((f) => ({ ...f, content: c as DesignedContent }))} />
        </Card>
        {base && (
          <HistoryCard
            template={base}
            dirty={dirty}
            editable={editable}
            onRestored={(next) => {
              setBase(next);
              setForm(fromView(next));
              setConflict(false);
            }}
          />
        )}
        {editable && (
          <div className="sticky bottom-0 z-10 -mx-1 flex items-center justify-end gap-3 border-t border-line bg-canvas/95 px-1 py-3 backdrop-blur">
            <span className="text-sm text-ink-muted" aria-live="polite">
              {dirty ? 'Unsaved changes' : base ? 'All changes saved' : ''}
            </span>
            <Button icon={<Save className="size-4" aria-hidden />} disabled={!dirty || !form.name.trim()} loading={busy} onClick={() => void save()}>
              {base ? 'Save template' : 'Create template'}
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

export default function Page() {
  const can = useCan();
  const { templateId } = useParams<{ templateId: string }>();
  const isNew = templateId === 'new';
  return (
    <RequireWorkspace>
      {can('templates.read') && (!isNew || can('templates.manage')) ? (
        <TemplateEditor templateId={isNew ? null : templateId} />
      ) : (
        <EmptyState icon={<Lock className="size-8" />} title="You can’t open this">
          Your role in this workspace does not include {isNew ? 'creating templates' : 'access to templates'}. Ask a workspace admin if you need it.
        </EmptyState>
      )}
    </RequireWorkspace>
  );
}
