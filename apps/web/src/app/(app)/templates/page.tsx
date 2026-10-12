'use client';

import { useQueryClient } from '@tanstack/react-query';
import type { TemplateListItem } from '@workeasy/shared';
import { FileText, Lock, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { RequireWorkspace } from '@/components/audience-shell';
import { ErrorAlert } from '@/components/campaigns/common';
import { Badge, Button, ConfirmDialog, EmptyState, Field, Input, PageHeader, Select, Spinner, Table, Td, Th, useToast } from '@/components/ui';
import { http } from '@/lib/api';
import { useWorkspaceApi } from '@/lib/audience';
import { templateKeys, useTemplateCategories, useTemplateList } from '@/lib/content';
import { relativeTime } from '@/lib/format';
import { errorMessage } from '@/lib/forms';
import { useCan } from '@/lib/session';

/** Email templates (content amendment §6): reusable designed emails. Applying one copies it into a campaign. */
function TemplatesInner() {
  const can = useCan();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const categories = useTemplateCategories();
  const [deleting, setDeleting] = useState<TemplateListItem | null>(null);
  const { workspaceId, path } = useWorkspaceApi();
  const qc = useQueryClient();
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim().length >= 2 ? search.trim() : ''), 300);
    return () => clearTimeout(t);
  }, [search]);
  const list = useTemplateList(q, true, category);
  const filtered = !!q || !!category;
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <>
      <PageHeader
        title="Templates"
        description="Designed emails your team can reuse. Using a template copies it into a campaign — later changes to the template never change campaigns that already used it."
        actions={
          can('templates.manage') && (
            <Button icon={<Plus className="size-4" aria-hidden />} onClick={() => router.push('/templates/new')}>
              New template
            </Button>
          )
        }
      />
      <div className="mb-4 flex flex-wrap items-end gap-4">
        <div className="w-full max-w-sm">
        <Field label="Search templates">
          {(p) => (
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-3 size-4 text-ink-faint" aria-hidden />
              <Input {...p} type="search" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name (at least 2 characters)" />
            </div>
          )}
        </Field>
        </div>
        {(categories.data?.data.length ?? 0) > 0 && (
          <div className="w-full max-w-xs">
            <Field label="Category">
              {(p) => (
                <Select {...p} value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="">All categories</option>
                  {categories.data!.data.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        )}
      </div>
      {list.isLoading ? (
        <Spinner label="Loading templates" />
      ) : list.isError ? (
        <ErrorAlert error={list.error} title="Templates could not be loaded" onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState icon={<FileText className="size-8" />} title={filtered ? 'No templates match' : 'No templates yet'}>
          {filtered ? 'Try another name or category.' : 'Create a template here, or save a designed campaign email as a template from the campaign.'}
        </EmptyState>
      ) : (
        <>
          <Table label="Templates">
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Category</Th>
                <Th>Subject</Th>
                <Th>Blocks</Th>
                <Th>Updated</Th>
                {can('templates.manage') && <Th>
                  <span className="sr-only">Actions</span>
                </Th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <Td>
                    <Link href={`/templates/${t.id}`} className="font-medium hover:text-accent">
                      {t.name}
                    </Link>
                    {t.description && <span className="block text-xs text-ink-muted">{t.description}</span>}
                  </Td>
                  <Td>{t.category ? <Badge>{t.category}</Badge> : <span className="text-ink-faint">—</span>}</Td>
                  <Td>{t.subject}</Td>
                  <Td>{t.blockCount}</Td>
                  <Td>{relativeTime(t.updatedAt)}</Td>
                  {can('templates.manage') && (
                    <Td>
                      <Button size="sm" variant="secondary" onClick={() => setDeleting(t)} aria-label={`Delete template ${t.name}`}>
                        Delete
                      </Button>
                    </Td>
                  )}
                </tr>
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
      <ConfirmDialog
        open={!!deleting}
        title={`Delete “${deleting?.name ?? ''}”?`}
        body="Campaigns that already used it keep their copy of the content."
        confirmLabel="Delete template"
        busy={busy}
        error={deleteError}
        onClose={() => {
          setDeleting(null);
          setDeleteError(null);
        }}
        onConfirm={() => {
          setBusy(true);
          setDeleteError(null);
          http
            .delete(path(`/templates/${deleting!.id}`))
            .then(async () => {
              await qc.invalidateQueries({ queryKey: templateKeys.all(workspaceId!) });
              toast('success', 'Template deleted');
              setDeleting(null);
            })
            .catch((err: unknown) => setDeleteError(errorMessage(err)))
            .finally(() => setBusy(false));
        }}
      />
    </>
  );
}

export default function Page() {
  const can = useCan();
  return (
    <RequireWorkspace>
      {can('templates.read') ? (
        <TemplatesInner />
      ) : (
        <EmptyState icon={<Lock className="size-8" />} title="You can’t view templates">
          Your role in this workspace does not include access to templates. Ask a workspace admin if you need it.
        </EmptyState>
      )}
    </RequireWorkspace>
  );
}
