'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createWorkspaceRequest, type WorkspaceView } from '@workeasy/shared';
import { Archive, LayoutGrid, Plus, RotateCcw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Badge, Button, ConfirmDialog, Dialog, EmptyState, Field, Input, PageHeader, Spinner, Table, Td, Th, useToast } from '@/components/ui';
import { http, idempotencyKey } from '@/lib/api';
import { errorMessage, useForm } from '@/lib/forms';
import { keys, useAppContext, useCan, useResetCache } from '@/lib/session';

export default function WorkspacesPage() {
  const ctx = useAppContext();
  const can = useCan();
  const qc = useQueryClient();
  const router = useRouter();
  const reset = useResetCache();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState<WorkspaceView | null>(null);
  const list = useQuery({ queryKey: keys.workspaces(ctx.orgId), queryFn: () => http.get<{ data: WorkspaceView[] }>(`/v1/organizations/${ctx.orgId}/workspaces`) });

  const toggleArchive = useMutation({
    mutationFn: ({ ws, archive }: { ws: WorkspaceView; archive: boolean }) =>
      http.post(`/v1/organizations/${ctx.orgId}/workspaces/${ws.id}/${archive ? 'archive' : 'restore'}`),
    onSuccess: (_d, v) => {
      setArchiving(null);
      toast('success', v.archive ? `${v.ws.name} archived` : `${v.ws.name} restored`);
      void qc.invalidateQueries({ queryKey: keys.workspaces(ctx.orgId) });
    },
  });

  async function open(ws: WorkspaceView) {
    await http.put('/v1/me/context', { organizationId: ctx.orgId, workspaceId: ws.id });
    await reset();
    router.push('/dashboard');
  }

  return (
    <>
      <PageHeader
        title="Workspaces"
        description="Workspaces keep contacts, campaigns and reports separate inside your organization."
        actions={can('workspaces.create') && <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New workspace</Button>}
      />
      {list.isLoading && <Spinner />}
      {list.isError && <Alert tone="danger">{errorMessage(list.error)}</Alert>}
      {list.data?.data.length === 0 && (
        <EmptyState icon={<LayoutGrid className="size-8" />} title="No workspaces you can open">
          Ask an organization admin to add you to a workspace.
        </EmptyState>
      )}
      {!!list.data?.data.length && (
        <Table label="Workspaces">
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Time zone</Th>
              <Th>Status</Th>
              <Th className="text-right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {list.data.data.map((w) => (
              <tr key={w.id}>
                <Td>
                  <span className="font-medium">{w.name}</span>
                  {w.id === ctx.workspaceId && <Badge tone="accent">Current</Badge>}
                </Td>
                <Td className="text-ink-muted">{w.timezone}</Td>
                <Td>{w.status === 'active' ? <Badge tone="success">Active</Badge> : <Badge tone="warning">Archived</Badge>}</Td>
                <Td className="text-right">
                  <div className="flex justify-end gap-2">
                    {w.id !== ctx.workspaceId && w.status === 'active' && (
                      <Button size="sm" variant="secondary" onClick={() => open(w)}>
                        Open
                      </Button>
                    )}
                    {can('workspaces.manage') &&
                      (w.status === 'active' ? (
                        <Button size="sm" variant="ghost" icon={<Archive className="size-4" />} onClick={() => setArchiving(w)}>
                          Archive
                        </Button>
                      ) : (
                        <Button size="sm" variant="ghost" icon={<RotateCcw className="size-4" />} loading={toggleArchive.isPending} onClick={() => toggleArchive.mutate({ ws: w, archive: false })}>
                          Restore
                        </Button>
                      ))}
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <CreateWorkspaceDialog open={creating} onClose={() => setCreating(false)} orgId={ctx.orgId} />
      <ConfirmDialog
        open={!!archiving}
        onClose={() => setArchiving(null)}
        onConfirm={() => archiving && toggleArchive.mutate({ ws: archiving, archive: true })}
        title={`Archive ${archiving?.name ?? ''}?`}
        body="Archived workspaces become read-only for everyone. Nothing is deleted, and you can restore it at any time."
        confirmLabel="Archive workspace"
        busy={toggleArchive.isPending}
        error={toggleArchive.isError ? errorMessage(toggleArchive.error) : null}
      />
    </>
  );
}

function CreateWorkspaceDialog({ open, onClose, orgId }: { open: boolean; onClose: () => void; orgId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [key] = useState(idempotencyKey);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const { fieldErrors, formError, submitting, submit } = useForm(createWorkspaceRequest);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New workspace"
      description="Use separate workspaces for brands, regions or clients."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={submitting}
            onClick={() =>
              void submit({ name, timezone }, async (data) => {
                await http.post(`/v1/organizations/${orgId}/workspaces`, data, { 'idempotency-key': `${key}-${name}` });
                await qc.invalidateQueries({ queryKey: keys.workspaces(orgId) });
                toast('success', `${data.name} created`);
                setName('');
                onClose();
              })
            }
          >
            Create workspace
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {formError && <Alert tone="danger">{formError}</Alert>}
        <Field label="Name" hint={`Time zone: ${timezone} (change it later in settings)`} errors={fieldErrors.name}>
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}
        </Field>
      </div>
    </Dialog>
  );
}
