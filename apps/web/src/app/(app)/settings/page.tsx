'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type OrganizationView, updateProfileRequest, type WorkspaceView } from '@workeasy/shared';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, ConfirmDialog, Field, Input, Select, Spinner, useToast } from '@/components/ui';
import { http } from '@/lib/api';
import { errorMessage, useForm } from '@/lib/forms';
import { keys, useAppContext, useCan, useResetCache } from '@/lib/session';

const TIMEZONES = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC'];

export default function GeneralSettingsPage() {
  const ctx = useAppContext();
  const can = useCan();
  return (
    <div className="grid gap-6">
      <ProfileCard />
      <OrganizationCard />
      {ctx.workspaceId && <WorkspaceCard workspaceId={ctx.workspaceId} editable={can('workspace.update')} />}
      <DangerZone />
    </div>
  );
}

function ProfileCard() {
  const ctx = useAppContext();
  const qc = useQueryClient();
  const toast = useToast();
  const [displayName, setDisplayName] = useState(ctx.user.displayName);
  const { fieldErrors, formError, submitting, submit } = useForm(updateProfileRequest);
  return (
    <Card title="Your profile" description="How teammates see you.">
      <form
        noValidate
        className="grid max-w-md gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit({ displayName }, async (data) => {
            await http.patch('/v1/me', data);
            await qc.invalidateQueries();
            toast('success', 'Profile updated');
          });
        }}
      >
        {formError && <Alert tone="danger">{formError}</Alert>}
        <Field label="Name" errors={fieldErrors.displayName}>
          {(p) => <Input {...p} value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="name" />}
        </Field>
        <Field label="Email" hint="Your sign-in address cannot be changed yet.">
          {(p) => <Input {...p} value={ctx.user.email} disabled />}
        </Field>
        <div>
          <Button type="submit" loading={submitting} disabled={displayName === ctx.user.displayName}>
            Save profile
          </Button>
        </div>
      </form>
    </Card>
  );
}

function OrganizationCard() {
  const ctx = useAppContext();
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const org = useQuery({ queryKey: ['organization', ctx.orgId], queryFn: () => http.get<OrganizationView>(`/v1/organizations/${ctx.orgId}`) });
  const [name, setName] = useState('');
  useEffect(() => {
    if (org.data) setName(org.data.name);
  }, [org.data]);
  const save = useMutation({
    mutationFn: () => http.patch(`/v1/organizations/${ctx.orgId}`, { name, version: org.data!.version }),
    onSuccess: async () => {
      await qc.invalidateQueries();
      toast('success', 'Organization renamed');
    },
  });
  if (!org.data) return <Spinner />;
  return (
    <Card title="Organization" description={`Your role: ${org.data.role.name}`}>
      <form
        className="grid max-w-md gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {save.isError && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
        <Field label="Organization name" hint={!can('org.update') ? 'Only owners and admins can rename the organization.' : undefined}>
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} disabled={!can('org.update')} />}
        </Field>
        {can('org.update') && (
          <div>
            <Button type="submit" loading={save.isPending} disabled={!name.trim() || name === org.data.name}>
              Save
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}

function WorkspaceCard({ workspaceId, editable }: { workspaceId: string; editable: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const ws = useQuery({ queryKey: ['workspace', workspaceId], queryFn: () => http.get<{ workspace: WorkspaceView }>(`/v1/workspaces/${workspaceId}`) });
  const [values, setValues] = useState({ name: '', timezone: 'UTC' });
  useEffect(() => {
    if (ws.data) setValues({ name: ws.data.workspace.name, timezone: ws.data.workspace.timezone });
  }, [ws.data]);
  const save = useMutation({
    mutationFn: () => http.patch(`/v1/workspaces/${workspaceId}`, { ...values, version: ws.data!.workspace.version }),
    onSuccess: async () => {
      await qc.invalidateQueries();
      toast('success', 'Workspace updated');
    },
  });
  if (!ws.data) return <Spinner />;
  const archived = ws.data.workspace.status === 'archived';
  return (
    <Card title="Workspace" description={archived ? 'This workspace is archived and read-only.' : 'Settings for the workspace you are in.'}>
      <form
        className="grid max-w-md gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {save.isError && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
        <Field label="Workspace name">{(p) => <Input {...p} value={values.name} disabled={!editable || archived} onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))} />}</Field>
        <Field label="Time zone" hint="Used for scheduling and reports in this workspace.">
          {(p) => (
            <Select {...p} value={values.timezone} disabled={!editable || archived} onChange={(e) => setValues((v) => ({ ...v, timezone: e.target.value }))}>
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz.replaceAll('_', ' ')}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {editable && !archived && (
          <div>
            <Button type="submit" loading={save.isPending}>
              Save workspace
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}

function DangerZone() {
  const ctx = useAppContext();
  const can = useCan();
  const router = useRouter();
  const reset = useResetCache();
  const [confirm, setConfirm] = useState<'leave' | 'delete' | null>(null);
  const act = useMutation({
    mutationFn: async (kind: 'leave' | 'delete') =>
      kind === 'leave'
        ? http.post(`/v1/organizations/${ctx.orgId}/leave`)
        : http.delete(`/v1/organizations/${ctx.orgId}`, { confirmName: ctx.organization!.name }),
    onSuccess: async () => {
      setConfirm(null);
      await reset();
      router.replace('/organizations');
    },
  });
  return (
    <Card title="Danger zone">
      <div className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-medium">Leave organization</p>
            <p className="text-ink-muted">You will lose access to all of its workspaces. An organization always keeps at least one owner.</p>
          </div>
          <Button variant="secondary" onClick={() => setConfirm('leave')}>
            Leave
          </Button>
        </div>
        {can('org.delete') && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <div>
              <p className="font-medium text-danger">Delete organization</p>
              <p className="text-ink-muted">Everyone loses access immediately. This cannot be undone from the app.</p>
            </div>
            <Button variant="danger" onClick={() => setConfirm('delete')}>
              Delete organization
            </Button>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => {
          setConfirm(null);
          act.reset();
        }}
        onConfirm={() => confirm && act.mutate(confirm)}
        title={confirm === 'delete' ? `Delete ${ctx.organization!.name}?` : `Leave ${ctx.organization!.name}?`}
        body={confirm === 'delete' ? 'All members lose access to every workspace in this organization.' : 'You will need a new invitation to come back.'}
        confirmLabel={confirm === 'delete' ? 'Delete organization' : 'Leave organization'}
        confirmText={confirm === 'delete' ? ctx.organization!.name : undefined}
        busy={act.isPending}
        error={act.isError ? errorMessage(act.error) : null}
      />
    </Card>
  );
}
