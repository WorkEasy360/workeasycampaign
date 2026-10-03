'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createListRequest, type ListView } from '@workeasy/shared';
import { ListPlus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { AudiencePage } from '@/components/audience-shell';
import { Alert, Badge, Button, ConfirmDialog, Dialog, EmptyState, Field, Input, PageHeader, Spinner, Table, Td, Th, useToast } from '@/components/ui';
import { http } from '@/lib/api';
import { audienceKeys, useLists, useWorkspaceApi } from '@/lib/audience';
import { relativeTime } from '@/lib/format';
import { errorMessage, useForm } from '@/lib/forms';
import { useCan } from '@/lib/session';

function ListsInner() {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const { workspaceId, path } = useWorkspaceApi();
  const lists = useLists();
  const [editing, setEditing] = useState<ListView | 'new' | null>(null);
  const [deleting, setDeleting] = useState<ListView | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: audienceKeys.lists(workspaceId!) });
  const act = useMutation({
    mutationFn: ({ list, kind }: { list: ListView; kind: 'archive' | 'restore' | 'delete' }) =>
      kind === 'delete' ? http.delete(path(`/lists/${list.id}`)) : http.post(path(`/lists/${list.id}/${kind}`)),
    onSuccess: async (_d, { kind }) => {
      setDeleting(null);
      toast('success', kind === 'delete' ? 'List deleted' : kind === 'archive' ? 'List archived' : 'List restored');
      await refresh();
    },
    onError: (err) => toast('danger', errorMessage(err)),
  });
  const manage = can('lists.manage');
  const rows = lists.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Lists"
        description="Static groups you add contacts to by hand, by import or in bulk. Archived lists keep their members but cannot change."
        actions={manage && <Button icon={<ListPlus className="size-4" />} onClick={() => setEditing('new')}>New list</Button>}
      />
      {lists.isLoading ? (
        <Spinner />
      ) : lists.isError ? (
        <Alert tone="danger">{errorMessage(lists.error)}</Alert>
      ) : rows.length === 0 ? (
        <EmptyState title="No lists yet" action={manage && <Button onClick={() => setEditing('new')}>Create your first list</Button>}>
          Lists are the simplest way to group contacts, for example “Newsletter” or “Expo 2026 visitors”.
        </EmptyState>
      ) : (
        <Table label="Lists">
          <thead>
            <tr>
              <Th>Name</Th>
              <Th className="text-right">Contacts</Th>
              <Th>Updated</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.id}>
                <Td>
                  <Link href={`/contacts?listId=${l.id}`} className="font-medium hover:text-accent">
                    {l.name}
                  </Link>{' '}
                  {l.status === 'archived' && <Badge>Archived</Badge>}
                  {l.description && <span className="block text-xs text-ink-muted">{l.description}</span>}
                </Td>
                <Td className="text-right tabular-nums">{l.memberCount.toLocaleString()}</Td>
                <Td>{relativeTime(l.updatedAt)}</Td>
                <Td className="whitespace-nowrap text-right">
                  {manage && (
                    <>
                      {l.status === 'active' && (
                        <Button size="sm" variant="ghost" onClick={() => setEditing(l)}>
                          Edit
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => act.mutate({ list: l, kind: l.status === 'active' ? 'archive' : 'restore' })}>
                        {l.status === 'active' ? 'Archive' : 'Restore'}
                      </Button>
                      <Button size="sm" variant="ghost" className="text-danger" onClick={() => setDeleting(l)}>
                        Delete
                      </Button>
                    </>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <ListDialog list={editing} onClose={() => setEditing(null)} onSaved={refresh} />
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && act.mutate({ list: deleting, kind: 'delete' })}
        title={`Delete “${deleting?.name}”?`}
        body={`The list and its ${deleting?.memberCount ?? 0} memberships are removed. The contacts themselves are not deleted.`}
        confirmLabel="Delete list"
        busy={act.isPending}
      />
    </>
  );
}

function ListDialog({ list, onClose, onSaved }: { list: ListView | 'new' | null; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const { path } = useWorkspaceApi();
  const toast = useToast();
  const form = useForm(createListRequest);
  const existing = list && list !== 'new' ? list : null;
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [openFor, setOpenFor] = useState<unknown>(null);
  if (list !== openFor) {
    setOpenFor(list);
    setName(existing?.name ?? '');
    setDescription(existing?.description ?? '');
  }
  return (
    <Dialog
      open={!!list}
      onClose={onClose}
      title={existing ? 'Edit list' : 'New list'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={form.submitting}
            onClick={() =>
              void form.submit({ name, description }, async (data) => {
                if (existing) await http.patch(path(`/lists/${existing.id}`), { ...data, version: existing.version });
                else await http.post(path('/lists'), data);
                toast('success', existing ? 'List saved' : 'List created');
                await onSaved();
                onClose();
              })
            }
          >
            {existing ? 'Save' : 'Create list'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {form.formError && <Alert tone="danger">{form.formError}</Alert>}
        <Field label="Name" errors={form.fieldErrors.name}>
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />}
        </Field>
        <Field label="Description (optional)" errors={form.fieldErrors.description}>
          {(p) => <Input {...p} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />}
        </Field>
      </div>
    </Dialog>
  );
}

export default function ListsPage() {
  return (
    <AudiencePage>
      <ListsInner />
    </AudiencePage>
  );
}
