'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createInvitationRequest,
  type InvitationView,
  type OrganizationMemberView,
  type Page,
  type RoleView,
  type WorkspaceMemberView,
  type WorkspaceView,
} from '@workeasy/shared';
import { MailPlus, Trash2, UserPlus, Users } from 'lucide-react';
import { useState } from 'react';
import { Alert, Avatar, Badge, Button, Card, ConfirmDialog, Dialog, EmptyState, Field, Input, Select, Spinner, Table, Td, Th, useToast } from '@/components/ui';
import { http, idempotencyKey } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { errorMessage, useForm } from '@/lib/forms';
import { keys, useAppContext, useCan } from '@/lib/session';

function useRoles(orgId: string) {
  return useQuery({ queryKey: keys.roles(orgId), queryFn: () => http.get<{ data: RoleView[] }>(`/v1/organizations/${orgId}/roles`) });
}

export default function MembersPage() {
  const ctx = useAppContext();
  const can = useCan();
  const [inviting, setInviting] = useState(false);
  return (
    <div className="grid gap-6">
      <Card
        title="Organization members"
        description="Everyone who belongs to this organization and their organization role."
        actions={can('members.invite') && <Button icon={<MailPlus className="size-4" />} onClick={() => setInviting(true)}>Invite people</Button>}
      >
        <OrganizationMembers />
      </Card>
      {can('members.read') && (
        <Card title="Invitations" description="Pending invitations expire after 7 days.">
          <Invitations />
        </Card>
      )}
      {ctx.workspaceId && can('workspace_members.read') && (
        <Card title={`Members of ${ctx.workspace!.name}`} description="Who can work in the current workspace, and with which role.">
          <WorkspaceMembers workspaceId={ctx.workspaceId} />
        </Card>
      )}
      <InviteDialog open={inviting} onClose={() => setInviting(false)} />
    </div>
  );
}

function OrganizationMembers() {
  const ctx = useAppContext();
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const roles = useRoles(ctx.orgId);
  const [removing, setRemoving] = useState<OrganizationMemberView | null>(null);
  const members = useInfiniteQuery({
    queryKey: keys.members(ctx.orgId),
    initialPageParam: '' as string,
    queryFn: ({ pageParam }) => http.get<Page<OrganizationMemberView>>(`/v1/organizations/${ctx.orgId}/members?limit=50${pageParam ? `&cursor=${pageParam}` : ''}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const update = useMutation({
    mutationFn: ({ m, body }: { m: OrganizationMemberView; body: Record<string, unknown> }) =>
      http.patch(`/v1/organizations/${ctx.orgId}/members/${m.userId}`, { ...body, version: m.version }),
    onSuccess: () => {
      toast('success', 'Member updated');
      void qc.invalidateQueries({ queryKey: keys.members(ctx.orgId) });
    },
    onError: (err) => toast('danger', errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: (m: OrganizationMemberView) => http.delete(`/v1/organizations/${ctx.orgId}/members/${m.userId}`),
    onSuccess: () => {
      setRemoving(null);
      toast('success', 'Member removed');
      void qc.invalidateQueries({ queryKey: keys.members(ctx.orgId) });
    },
  });

  if (members.isLoading) return <Spinner />;
  if (members.isError) return <Alert tone="danger">{errorMessage(members.error)}</Alert>;
  const rows = members.data?.pages.flatMap((p) => p.data) ?? [];
  const orgRoles = roles.data?.data.filter((r) => r.scope === 'organization') ?? [];
  const manage = can('members.manage');

  return (
    <>
      <Table label="Organization members">
        <thead>
          <tr>
            <Th>Person</Th>
            <Th>Role</Th>
            <Th>Status</Th>
            <Th>Workspaces</Th>
            <Th className="text-right">
              <span className="sr-only">Actions</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => {
            const self = m.userId === ctx.user.id;
            return (
              <tr key={m.userId}>
                <Td>
                  <div className="flex items-center gap-3">
                    <Avatar name={m.displayName} size="sm" />
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {m.displayName} {self && <span className="text-ink-faint">(you)</span>}
                      </p>
                      <p className="truncate text-xs text-ink-muted">{m.email}</p>
                    </div>
                  </div>
                </Td>
                <Td>
                  {manage && !self ? (
                    <Select
                      aria-label={`Role for ${m.displayName}`}
                      value={m.role.id}
                      className="h-8 w-40"
                      onChange={(e) => update.mutate({ m, body: { roleId: e.target.value } })}
                    >
                      {orgRoles.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    m.role.name
                  )}
                </Td>
                <Td>{m.status === 'active' ? <Badge tone="success">Active</Badge> : <Badge tone="warning">Suspended</Badge>}</Td>
                <Td className="text-ink-muted">{m.workspaceCount}</Td>
                <Td className="text-right">
                  {manage && !self && (
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" onClick={() => update.mutate({ m, body: { status: m.status === 'active' ? 'suspended' : 'active' } })}>
                        {m.status === 'active' ? 'Suspend' : 'Reactivate'}
                      </Button>
                      <Button size="sm" variant="ghost" aria-label={`Remove ${m.displayName}`} onClick={() => setRemoving(m)}>
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  )}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
      {members.hasNextPage && (
        <div className="mt-4 text-center">
          <Button variant="secondary" size="sm" loading={members.isFetchingNextPage} onClick={() => void members.fetchNextPage()}>
            Load more
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={!!removing}
        onClose={() => {
          setRemoving(null);
          remove.reset();
        }}
        onConfirm={() => removing && remove.mutate(removing)}
        title={`Remove ${removing?.displayName ?? ''}?`}
        body="They lose access to this organization and all of its workspaces immediately. You can invite them again later."
        confirmLabel="Remove member"
        busy={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : null}
      />
    </>
  );
}

function Invitations() {
  const ctx = useAppContext();
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: keys.invitations(ctx.orgId), queryFn: () => http.get<{ data: InvitationView[] }>(`/v1/organizations/${ctx.orgId}/invitations`) });
  const act = useMutation({
    mutationFn: ({ inv, kind }: { inv: InvitationView; kind: 'resend' | 'revoke' }) =>
      kind === 'resend' ? http.post(`/v1/organizations/${ctx.orgId}/invitations/${inv.id}/resend`) : http.delete(`/v1/organizations/${ctx.orgId}/invitations/${inv.id}`),
    onSuccess: (_d, v) => {
      toast('success', v.kind === 'resend' ? `New invitation sent to ${v.inv.email}` : 'Invitation revoked');
      void qc.invalidateQueries({ queryKey: keys.invitations(ctx.orgId) });
    },
    onError: (err) => toast('danger', errorMessage(err)),
  });
  if (list.isLoading) return <Spinner />;
  const rows = list.data?.data ?? [];
  if (!rows.length) return <EmptyState icon={<MailPlus className="size-6" />} title="No invitations yet">Invite teammates and choose their role before they join.</EmptyState>;
  const tone = { pending: 'accent', accepted: 'success', revoked: 'neutral', expired: 'warning' } as const;
  return (
    <Table label="Invitations">
      <thead>
        <tr>
          <Th>Email</Th>
          <Th>Role</Th>
          <Th>Status</Th>
          <Th>Sent</Th>
          <Th className="text-right">
            <span className="sr-only">Actions</span>
          </Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((inv) => (
          <tr key={inv.id}>
            <Td>
              <p className="font-medium">{inv.email}</p>
              {inv.workspaces.length > 0 && <p className="text-xs text-ink-muted">{inv.workspaces.map((w) => `${w.name} (${w.role.name})`).join(', ')}</p>}
            </Td>
            <Td>{inv.organizationRole.name}</Td>
            <Td>
              <Badge tone={tone[inv.status]}>{inv.status}</Badge>
            </Td>
            <Td className="text-ink-muted">{relativeTime(inv.createdAt)}</Td>
            <Td className="text-right">
              {can('members.invite') && (inv.status === 'pending' || inv.status === 'expired') && (
                <div className="flex justify-end gap-1">
                  {inv.status === 'pending' && (
                    <Button size="sm" variant="ghost" onClick={() => act.mutate({ inv, kind: 'resend' })}>
                      Resend
                    </Button>
                  )}
                  {inv.status === 'pending' && (
                    <Button size="sm" variant="ghost" onClick={() => act.mutate({ inv, kind: 'revoke' })}>
                      Revoke
                    </Button>
                  )}
                </div>
              )}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function InviteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ctx = useAppContext();
  const qc = useQueryClient();
  const toast = useToast();
  const roles = useRoles(ctx.orgId);
  const workspaces = useQuery({
    queryKey: keys.workspaces(ctx.orgId),
    queryFn: () => http.get<{ data: WorkspaceView[] }>(`/v1/organizations/${ctx.orgId}/workspaces`),
    enabled: open,
  });
  const orgRoles = roles.data?.data.filter((r) => r.scope === 'organization') ?? [];
  const wsRoles = roles.data?.data.filter((r) => r.scope === 'workspace') ?? [];
  const memberRole = orgRoles.find((r) => r.key === 'member');
  const [email, setEmail] = useState('');
  const [orgRoleId, setOrgRoleId] = useState('');
  const [grants, setGrants] = useState<Record<string, string>>({});
  const [key, setKey] = useState(idempotencyKey);
  const { fieldErrors, formError, submitting, submit } = useForm(createInvitationRequest);
  const effectiveOrgRole = orgRoleId || memberRole?.id || '';
  const chosenRole = orgRoles.find((r) => r.id === effectiveOrgRole);
  const needsWorkspaces = !chosenRole?.permissions.includes('workspaces.access_all');

  function close() {
    setEmail('');
    setGrants({});
    setOrgRoleId('');
    setKey(idempotencyKey());
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Invite someone"
      description="They will get an email with a link that works for 7 days."
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button
            loading={submitting}
            icon={<UserPlus className="size-4" />}
            onClick={() =>
              void submit(
                {
                  email,
                  organizationRoleId: effectiveOrgRole,
                  workspaces: needsWorkspaces ? Object.entries(grants).filter(([, r]) => r).map(([workspaceId, roleId]) => ({ workspaceId, roleId })) : [],
                },
                async (data) => {
                  await http.post(`/v1/organizations/${ctx.orgId}/invitations`, data, { 'idempotency-key': key });
                  await qc.invalidateQueries({ queryKey: keys.invitations(ctx.orgId) });
                  toast('success', `Invitation sent to ${data.email}`);
                  close();
                },
              )
            }
          >
            Send invitation
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {formError && <Alert tone="danger">{formError}</Alert>}
        <Field label="Email address" errors={fieldErrors.email}>
          {(p) => <Input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus placeholder="name@company.com" />}
        </Field>
        <Field label="Organization role" hint={chosenRole?.description} errors={fieldErrors.organizationRoleId}>
          {(p) => (
            <Select {...p} value={effectiveOrgRole} onChange={(e) => setOrgRoleId(e.target.value)}>
              {orgRoles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {needsWorkspaces ? (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Workspace access</legend>
            <p className="text-xs text-ink-muted">Members only see the workspaces you give them here.</p>
            {(workspaces.data?.data ?? [])
              .filter((w) => w.status === 'active')
              .map((w) => (
                <div key={w.id} className="flex items-center justify-between gap-3 rounded-control border border-line px-3 py-2">
                  <span className="text-sm">{w.name}</span>
                  <Select aria-label={`Role in ${w.name}`} className="h-8 w-44" value={grants[w.id] ?? ''} onChange={(e) => setGrants((g) => ({ ...g, [w.id]: e.target.value }))}>
                    <option value="">No access</option>
                    {wsRoles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </Select>
                </div>
              ))}
            {fieldErrors.workspaces && <p className="text-xs text-danger">{fieldErrors.workspaces.join(' ')}</p>}
          </fieldset>
        ) : (
          <Alert tone="info">{chosenRole?.name}s can administer every workspace in the organization.</Alert>
        )}
      </div>
    </Dialog>
  );
}

function WorkspaceMembers({ workspaceId }: { workspaceId: string }) {
  const ctx = useAppContext();
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const roles = useRoles(ctx.orgId);
  const wsRoles = roles.data?.data.filter((r) => r.scope === 'workspace') ?? [];
  const list = useQuery({ queryKey: keys.workspaceMembers(workspaceId), queryFn: () => http.get<{ data: WorkspaceMemberView[] }>(`/v1/workspaces/${workspaceId}/members`) });
  const orgMembers = useQuery({
    queryKey: [...keys.members(ctx.orgId), 'all-for-picker'],
    queryFn: () => http.get<Page<OrganizationMemberView>>(`/v1/organizations/${ctx.orgId}/members?limit=100`),
    enabled: can('workspace_members.manage') && can('members.read'),
  });
  const [adding, setAdding] = useState({ userId: '', roleId: '' });
  const invalidate = () => qc.invalidateQueries({ queryKey: keys.workspaceMembers(workspaceId) });
  const put = useMutation({
    mutationFn: ({ userId, roleId }: { userId: string; roleId: string }) => http.put(`/v1/workspaces/${workspaceId}/members/${userId}`, { roleId }),
    onSuccess: () => {
      toast('success', 'Workspace access updated');
      setAdding({ userId: '', roleId: '' });
      void invalidate();
    },
    onError: (err) => toast('danger', errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: (userId: string) => http.delete(`/v1/workspaces/${workspaceId}/members/${userId}`),
    onSuccess: () => {
      toast('success', 'Removed from workspace');
      void invalidate();
    },
    onError: (err) => toast('danger', errorMessage(err)),
  });

  if (list.isLoading) return <Spinner />;
  const rows = list.data?.data ?? [];
  const manage = can('workspace_members.manage');
  const candidates = (orgMembers.data?.data ?? []).filter((m) => m.status === 'active' && !rows.some((r) => r.userId === m.userId));

  return (
    <div className="space-y-4">
      {rows.length === 0 ? (
        <EmptyState icon={<Users className="size-6" />} title="Nobody here yet" />
      ) : (
        <Table label="Workspace members">
          <thead>
            <tr>
              <Th>Person</Th>
              <Th>Role</Th>
              <Th>Access</Th>
              <Th className="text-right">
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.userId}>
                <Td>
                  <p className="font-medium">{m.displayName}</p>
                  <p className="text-xs text-ink-muted">{m.email}</p>
                </Td>
                <Td>
                  {manage && m.access === 'explicit' ? (
                    <Select aria-label={`Workspace role for ${m.displayName}`} className="h-8 w-40" value={m.role.id} onChange={(e) => put.mutate({ userId: m.userId, roleId: e.target.value })}>
                      {wsRoles.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    m.role.name
                  )}
                </Td>
                <Td>{m.access === 'organization' ? <Badge tone="accent">Organization-wide</Badge> : <Badge>Workspace</Badge>}</Td>
                <Td className="text-right">
                  {manage && m.access === 'explicit' && m.userId !== ctx.user.id && (
                    <Button size="sm" variant="ghost" onClick={() => remove.mutate(m.userId)}>
                      Remove
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {manage && candidates.length > 0 && (
        <div className="flex flex-wrap items-end gap-2 rounded-control bg-surface-muted p-3">
          <Field label="Add organization member">
            {(p) => (
              <Select {...p} className="w-56" value={adding.userId} onChange={(e) => setAdding((a) => ({ ...a, userId: e.target.value }))}>
                <option value="">Choose a person</option>
                {candidates.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.displayName} ({m.email})
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Role">
            {(p) => (
              <Select {...p} className="w-44" value={adding.roleId} onChange={(e) => setAdding((a) => ({ ...a, roleId: e.target.value }))}>
                <option value="">Choose a role</option>
                {wsRoles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button disabled={!adding.userId || !adding.roleId} loading={put.isPending} onClick={() => put.mutate(adding)}>
            Add
          </Button>
        </div>
      )}
    </div>
  );
}
