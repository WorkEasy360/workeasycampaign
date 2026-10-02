'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Permission, PermissionScope, RoleView } from '@workeasy/shared';
import { Lock, Plus, ShieldCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, ConfirmDialog, Dialog, Field, Input, Select, Spinner, useToast } from '@/components/ui';
import { http } from '@/lib/api';
import { errorMessage } from '@/lib/forms';
import { keys, useAppContext, useCan } from '@/lib/session';

interface CatalogueEntry {
  key: Permission;
  scope: PermissionScope;
  group: string;
  label: string;
}

export default function RolesPage() {
  const ctx = useAppContext();
  const can = useCan();
  const roles = useQuery({ queryKey: keys.roles(ctx.orgId), queryFn: () => http.get<{ data: RoleView[] }>(`/v1/organizations/${ctx.orgId}/roles`) });
  const catalogue = useQuery({
    queryKey: keys.permissions,
    queryFn: () => http.get<{ data: { scope: PermissionScope; permissions: CatalogueEntry[] }[] }>('/v1/permissions'),
    staleTime: Infinity,
  });
  const [editing, setEditing] = useState<RoleView | 'new' | null>(null);
  const [viewing, setViewing] = useState<RoleView | null>(null);

  if (roles.isLoading || catalogue.isLoading) return <Spinner />;
  if (roles.isError) return <Alert tone="danger">{errorMessage(roles.error)}</Alert>;
  const entries = catalogue.data?.data.flatMap((s) => s.permissions) ?? [];

  const section = (scope: PermissionScope, title: string, description: string) => (
    <Card title={title} description={description}>
      <ul className="divide-y divide-line">
        {roles.data!.data
          .filter((r) => r.scope === scope)
          .map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 py-3">
              {r.isSystem ? <Lock className="size-4 text-ink-faint" aria-label="Built-in" /> : <ShieldCheck className="size-4 text-accent" aria-label="Custom" />}
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {r.name} {!r.isSystem && <Badge tone="accent">Custom</Badge>}
                </p>
                <p className="text-sm text-ink-muted">{r.description || `${r.permissions.length} permissions`}</p>
              </div>
              <span className="text-xs text-ink-faint">{r.memberCount} assigned</span>
              <Button size="sm" variant="ghost" onClick={() => (r.isSystem || !can('roles.manage') ? setViewing(r) : setEditing(r))}>
                {r.isSystem || !can('roles.manage') ? 'View' : 'Edit'}
              </Button>
            </li>
          ))}
      </ul>
    </Card>
  );

  return (
    <div className="grid gap-6">
      {can('roles.manage') && (
        <div className="flex justify-end">
          <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            New custom role
          </Button>
        </div>
      )}
      {section('organization', 'Organization roles', 'What someone can do across the organization: members, roles, workspaces, security.')}
      {section('workspace', 'Workspace roles', 'What someone can do inside a workspace: contacts, campaigns, journeys, reports.')}
      <RoleEditor open={editing !== null} role={editing === 'new' ? null : editing} entries={entries} onClose={() => setEditing(null)} />
      <Dialog open={!!viewing} onClose={() => setViewing(null)} title={viewing?.name ?? ''} description={viewing?.isSystem ? 'Built-in roles cannot be changed. Create a custom role for different access.' : undefined}>
        {viewing && <PermissionList role={viewing} entries={entries} />}
      </Dialog>
    </div>
  );
}

function PermissionList({ role, entries }: { role: RoleView; entries: CatalogueEntry[] }) {
  const groups = groupBy(entries.filter((e) => role.permissions.includes(e.key)));
  return (
    <div className="max-h-96 space-y-3 overflow-auto text-sm">
      {Object.entries(groups).map(([group, items]) => (
        <div key={group}>
          <p className="font-medium">{group}</p>
          <ul className="ml-4 list-disc text-ink-muted">
            {items.map((i) => (
              <li key={i.key}>{i.label}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function groupBy(entries: CatalogueEntry[]) {
  return entries.reduce<Record<string, CatalogueEntry[]>>((acc, e) => {
    (acc[e.group] ??= []).push(e);
    return acc;
  }, {});
}

function RoleEditor({ open, role, entries, onClose }: { open: boolean; role: RoleView | null; entries: CatalogueEntry[]; onClose: () => void }) {
  const ctx = useAppContext();
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState<PermissionScope>('workspace');
  const [selected, setSelected] = useState<Set<Permission>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [initFor, setInitFor] = useState<string | null>(null);

  const key = role?.id ?? (open ? 'new' : null);
  if (key !== initFor) {
    setInitFor(key);
    setName(role?.name ?? '');
    setDescription(role?.description ?? '');
    setScope(role?.scope ?? 'workspace');
    setSelected(new Set(role?.permissions ?? []));
  }

  const groups = useMemo(() => groupBy(entries.filter((e) => e.scope === scope)), [entries, scope]);
  const save = useMutation({
    mutationFn: () =>
      role
        ? http.patch(`/v1/organizations/${ctx.orgId}/roles/${role.id}`, { name, description, permissions: [...selected], version: role.version })
        : http.post(`/v1/organizations/${ctx.orgId}/roles`, { name, description, scope, permissions: [...selected] }),
    onSuccess: () => {
      toast('success', role ? 'Role updated' : 'Role created');
      void qc.invalidateQueries({ queryKey: keys.roles(ctx.orgId) });
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => http.delete(`/v1/organizations/${ctx.orgId}/roles/${role!.id}`),
    onSuccess: () => {
      setDeleting(false);
      toast('success', 'Role deleted');
      void qc.invalidateQueries({ queryKey: keys.roles(ctx.orgId) });
      onClose();
    },
  });

  const toggle = (p: Permission) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title={role ? `Edit ${role.name}` : 'New custom role'}
        description="You can only grant permissions you hold yourself."
        footer={
          <>
            {role && (
              <Button variant="ghost" className="mr-auto text-danger" onClick={() => setDeleting(true)}>
                Delete role
              </Button>
            )}
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button loading={save.isPending} disabled={!name.trim() || selected.size === 0} onClick={() => save.mutate()}>
              {role ? 'Save role' : 'Create role'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {save.isError && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
          <Field label="Name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label="Description (optional)">{(p) => <Input {...p} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
          {!role && (
            <Field label="Applies to" hint="Workspace roles are assigned per workspace; organization roles apply to the whole organization.">
              {(p) => (
                <Select
                  {...p}
                  value={scope}
                  onChange={(e) => {
                    setScope(e.target.value as PermissionScope);
                    setSelected(new Set());
                  }}
                >
                  <option value="workspace">A workspace</option>
                  <option value="organization">The organization</option>
                </Select>
              )}
            </Field>
          )}
          <fieldset className="max-h-72 space-y-3 overflow-auto rounded-control border border-line p-3">
            <legend className="px-1 text-sm font-medium">Permissions ({selected.size})</legend>
            {Object.entries(groups).map(([group, items]) => (
              <div key={group}>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">{group}</p>
                <div className="grid gap-1 sm:grid-cols-2">
                  {items.map((i) => (
                    <label key={i.key} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={selected.has(i.key)} onChange={() => toggle(i.key)} />
                      {i.label}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </fieldset>
        </div>
      </Dialog>
      <ConfirmDialog
        open={deleting}
        onClose={() => {
          setDeleting(false);
          remove.reset();
        }}
        onConfirm={() => remove.mutate()}
        title={`Delete ${role?.name ?? 'role'}?`}
        body="Roles that are still assigned cannot be deleted. Reassign those members first."
        confirmLabel="Delete role"
        busy={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : null}
      />
    </>
  );
}
