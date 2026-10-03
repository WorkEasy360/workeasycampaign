'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createTagRequest, TAG_COLORS, type TagView } from '@workeasy/shared';
import { Tag as TagIcon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { AudiencePage } from '@/components/audience-shell';
import { Alert, Button, ConfirmDialog, Dialog, EmptyState, Field, Input, PageHeader, Spinner, useToast } from '@/components/ui';
import { http } from '@/lib/api';
import { audienceKeys, TAG_SWATCH, useTags, useWorkspaceApi } from '@/lib/audience';
import { cx } from '@/lib/format';
import { errorMessage, useForm } from '@/lib/forms';
import { useCan } from '@/lib/session';

function TagsInner() {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const { workspaceId, path } = useWorkspaceApi();
  const tags = useTags();
  const [editing, setEditing] = useState<TagView | 'new' | null>(null);
  const [deleting, setDeleting] = useState<TagView | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: audienceKeys.tags(workspaceId!) });
  const remove = useMutation({
    mutationFn: (t: TagView) => http.delete(path(`/tags/${t.id}`)),
    onSuccess: async () => {
      setDeleting(null);
      toast('success', 'Tag deleted');
      await refresh();
    },
  });
  const manage = can('tags.manage');
  const rows = tags.data?.data ?? [];
  return (
    <>
      <PageHeader
        title="Tags"
        description="Lightweight labels. A contact can have many tags."
        actions={manage && <Button icon={<TagIcon className="size-4" />} onClick={() => setEditing('new')}>New tag</Button>}
      />
      {tags.isLoading ? (
        <Spinner />
      ) : tags.isError ? (
        <Alert tone="danger">{errorMessage(tags.error)}</Alert>
      ) : rows.length === 0 ? (
        <EmptyState title="No tags yet" action={manage && <Button onClick={() => setEditing('new')}>Create a tag</Button>}>
          Use tags for quick labels such as “VIP” or “Wholesale”.
        </EmptyState>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((t) => (
            <li key={t.id} className="rounded-card border border-line bg-surface p-4">
              <div className="flex items-center gap-2">
                <span className={cx('size-3 rounded-full', TAG_SWATCH[t.color] ?? 'bg-slate-400')} aria-hidden />
                <Link href={`/contacts?tagId=${t.id}`} className="font-medium hover:text-accent">
                  {t.name}
                </Link>
                <span className="ml-auto text-sm tabular-nums text-ink-muted">{t.contactCount.toLocaleString()}</span>
              </div>
              {t.description && <p className="mt-1 text-sm text-ink-muted">{t.description}</p>}
              {manage && (
                <div className="mt-3 flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(t)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" className="text-danger" onClick={() => setDeleting(t)}>
                    Delete
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <TagDialog tag={editing} onClose={() => setEditing(null)} onSaved={refresh} />
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting)}
        title={`Delete tag “${deleting?.name}”?`}
        body={`It is removed from ${deleting?.contactCount ?? 0} contacts.`}
        confirmLabel="Delete tag"
        busy={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : null}
      />
    </>
  );
}

function TagDialog({ tag, onClose, onSaved }: { tag: TagView | 'new' | null; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const { path } = useWorkspaceApi();
  const toast = useToast();
  const form = useForm(createTagRequest);
  const existing = tag && tag !== 'new' ? tag : null;
  const [values, setValues] = useState({ name: '', color: 'slate', description: '' });
  const [openFor, setOpenFor] = useState<unknown>(null);
  if (tag !== openFor) {
    setOpenFor(tag);
    setValues({ name: existing?.name ?? '', color: existing?.color ?? 'slate', description: existing?.description ?? '' });
  }
  return (
    <Dialog
      open={!!tag}
      onClose={onClose}
      title={existing ? 'Edit tag' : 'New tag'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={form.submitting}
            onClick={() =>
              void form.submit(values, async (data) => {
                if (existing) await http.patch(path(`/tags/${existing.id}`), { ...data, version: existing.version });
                else await http.post(path('/tags'), data);
                toast('success', existing ? 'Tag saved' : 'Tag created');
                await onSaved();
                onClose();
              })
            }
          >
            {existing ? 'Save' : 'Create tag'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {form.formError && <Alert tone="danger">{form.formError}</Alert>}
        <Field label="Name" errors={form.fieldErrors.name}>
          {(p) => <Input {...p} value={values.name} maxLength={50} onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))} />}
        </Field>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Color</legend>
          <div className="flex flex-wrap gap-2">
            {TAG_COLORS.map((c) => (
              <label key={c} className="cursor-pointer">
                <input type="radio" name="tag-color" value={c} className="peer sr-only" checked={values.color === c} onChange={() => setValues((v) => ({ ...v, color: c }))} />
                <span className={cx('block size-7 rounded-full ring-offset-2 peer-checked:ring-2 peer-checked:ring-accent peer-focus-visible:ring-2', TAG_SWATCH[c])} title={c} />
                <span className="sr-only">{c}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <Field label="Description (optional)" errors={form.fieldErrors.description}>
          {(p) => <Input {...p} value={values.description} maxLength={300} onChange={(e) => setValues((v) => ({ ...v, description: e.target.value }))} />}
        </Field>
      </div>
    </Dialog>
  );
}

export default function TagsPage() {
  return (
    <AudiencePage>
      <TagsInner />
    </AudiencePage>
  );
}
