'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createTopicRequest, type TopicView } from '@workeasy/shared';
import { FolderPlus, Plus } from 'lucide-react';
import { useState } from 'react';
import { AudiencePage } from '@/components/audience-shell';
import { Alert, Badge, Button, Dialog, Field, Input, PageHeader, Select, Spinner, useToast } from '@/components/ui';
import { http } from '@/lib/api';
import { audienceKeys, useTopics, useWorkspaceApi } from '@/lib/audience';
import { errorMessage, useForm } from '@/lib/forms';
import { useCan } from '@/lib/session';

function TopicsInner() {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const { workspaceId, path } = useWorkspaceApi();
  const topics = useTopics();
  const [editing, setEditing] = useState<TopicView | { kind: 'topic' | 'category' } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: audienceKeys.topics(workspaceId!) });
  const act = useMutation({
    mutationFn: ({ t, kind }: { t: TopicView; kind: 'archive' | 'restore' | 'default' }) => http.post(path(`/topics/${t.id}/${kind}`)),
    onSuccess: async (_d, { kind }) => {
      toast('success', kind === 'default' ? 'Default topic changed' : kind === 'archive' ? 'Archived' : 'Restored');
      await refresh();
    },
    onError: (err) => toast('danger', errorMessage(err)),
  });
  const manage = can('topics.manage');
  const all = topics.data?.data ?? [];
  const categories = all.filter((t) => t.kind === 'category');
  const groups: { category: TopicView | null; topics: TopicView[] }[] = [
    ...categories.map((c) => ({ category: c, topics: all.filter((t) => t.kind === 'topic' && t.parentId === c.id) })),
    { category: null, topics: all.filter((t) => t.kind === 'topic' && (!t.parentId || !categories.some((c) => c.id === t.parentId))) },
  ];

  return (
    <>
      <PageHeader
        title="Topics"
        description="Subjects people can subscribe to individually, grouped into categories. Every workspace has a default topic that new subscribers join."
        actions={
          manage && (
            <div className="flex gap-2">
              <Button variant="secondary" icon={<FolderPlus className="size-4" />} onClick={() => setEditing({ kind: 'category' })}>
                New category
              </Button>
              <Button icon={<Plus className="size-4" />} onClick={() => setEditing({ kind: 'topic' })}>
                New topic
              </Button>
            </div>
          )
        }
      />
      {topics.isLoading ? (
        <Spinner />
      ) : topics.isError ? (
        <Alert tone="danger">{errorMessage(topics.error)}</Alert>
      ) : (
        <div className="space-y-6">
          {groups
            .filter((g) => g.category || g.topics.length)
            .map((g) => (
              <section key={g.category?.id ?? 'none'} aria-label={g.category?.name ?? 'Uncategorized'} className="rounded-card border border-line bg-surface">
                <header className="flex items-center gap-2 border-b border-line px-4 py-3">
                  <h2 className="font-semibold">{g.category?.name ?? 'Uncategorized'}</h2>
                  {g.category?.status === 'archived' && <Badge>Archived</Badge>}
                  {g.category && manage && (
                    <span className="ml-auto flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(g.category)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => act.mutate({ t: g.category!, kind: g.category!.status === 'active' ? 'archive' : 'restore' })}>
                        {g.category.status === 'active' ? 'Archive' : 'Restore'}
                      </Button>
                    </span>
                  )}
                </header>
                {g.topics.length === 0 ? (
                  <p className="px-4 py-3 text-sm text-ink-muted">No topics in this category.</p>
                ) : (
                  <ul className="divide-y divide-line">
                    {g.topics.map((t) => (
                      <li key={t.id} className="flex flex-wrap items-center gap-2 px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <p className="font-medium">
                            {t.name} {t.isDefault && <Badge tone="accent">Default</Badge>} {t.status === 'archived' && <Badge>Archived</Badge>}
                          </p>
                          <p className="text-xs text-ink-muted">
                            <code>{t.key}</code> · {t.subscriberCount.toLocaleString()} subscribed{t.description && ` · ${t.description}`}
                          </p>
                        </div>
                        {manage && (
                          <span className="flex gap-1">
                            <Button size="sm" variant="ghost" onClick={() => setEditing(t)}>
                              Edit
                            </Button>
                            {!t.isDefault && t.status === 'active' && (
                              <Button size="sm" variant="ghost" onClick={() => act.mutate({ t, kind: 'default' })}>
                                Make default
                              </Button>
                            )}
                            {!t.isDefault && (
                              <Button size="sm" variant="ghost" onClick={() => act.mutate({ t, kind: t.status === 'active' ? 'archive' : 'restore' })}>
                                {t.status === 'active' ? 'Archive' : 'Restore'}
                              </Button>
                            )}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
        </div>
      )}
      <TopicDialog value={editing} categories={categories.filter((c) => c.status === 'active')} onClose={() => setEditing(null)} onSaved={refresh} />
    </>
  );
}

function TopicDialog({
  value,
  categories,
  onClose,
  onSaved,
}: {
  value: TopicView | { kind: 'topic' | 'category' } | null;
  categories: TopicView[];
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const { path } = useWorkspaceApi();
  const toast = useToast();
  const form = useForm(createTopicRequest);
  const existing = value && 'id' in value ? value : null;
  const kind = value?.kind ?? 'topic';
  const [v, setV] = useState({ name: '', key: '', description: '', parentId: '' });
  const [openFor, setOpenFor] = useState<unknown>(null);
  if (value !== openFor) {
    setOpenFor(value);
    setV({ name: existing?.name ?? '', key: existing?.key ?? '', description: existing?.description ?? '', parentId: existing?.parentId ?? '' });
  }
  const noun = kind === 'category' ? 'category' : 'topic';
  return (
    <Dialog
      open={!!value}
      onClose={onClose}
      title={existing ? `Edit ${noun}` : `New ${noun}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={form.submitting}
            onClick={() =>
              void form.submit(
                { name: v.name, kind, description: v.description, parentId: kind === 'topic' ? v.parentId || null : null, ...(v.key && !existing ? { key: v.key } : {}) },
                async (data) => {
                  if (existing) {
                    await http.patch(path(`/topics/${existing.id}`), { name: data.name, description: data.description, parentId: data.parentId ?? null, version: existing.version });
                  } else {
                    await http.post(path('/topics'), data);
                  }
                  toast('success', existing ? 'Saved' : `${noun[0]!.toUpperCase()}${noun.slice(1)} created`);
                  await onSaved();
                  onClose();
                },
              )
            }
          >
            {existing ? 'Save' : `Create ${noun}`}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {form.formError && <Alert tone="danger">{form.formError}</Alert>}
        <Field label="Name" errors={form.fieldErrors.name}>
          {(p) => <Input {...p} value={v.name} onChange={(e) => setV((x) => ({ ...x, name: e.target.value }))} />}
        </Field>
        {!existing && (
          <Field label="Key (optional)" hint="Used by integrations; generated from the name if empty. Cannot be changed later." errors={form.fieldErrors.key}>
            {(p) => <Input {...p} value={v.key} placeholder="product_updates" onChange={(e) => setV((x) => ({ ...x, key: e.target.value }))} />}
          </Field>
        )}
        {kind === 'topic' && (
          <Field label="Category" errors={form.fieldErrors.parentId}>
            {(p) => (
              <Select {...p} value={v.parentId} onChange={(e) => setV((x) => ({ ...x, parentId: e.target.value }))}>
                <option value="">None</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label="Description (optional)" errors={form.fieldErrors.description}>
          {(p) => <Input {...p} value={v.description} onChange={(e) => setV((x) => ({ ...x, description: e.target.value }))} />}
        </Field>
      </div>
    </Dialog>
  );
}

export default function TopicsPage() {
  return (
    <AudiencePage>
      <TopicsInner />
    </AudiencePage>
  );
}
