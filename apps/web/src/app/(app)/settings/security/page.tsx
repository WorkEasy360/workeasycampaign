'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { changePasswordRequest, type Page, PASSWORD_MIN_LENGTH, type SecurityEventView, type SessionSummary } from '@workeasy/shared';
import { Laptop } from 'lucide-react';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Field, Input, Spinner, Table, Td, Th, useToast } from '@/components/ui';
import { http } from '@/lib/api';
import { dateTime, describeUserAgent, humanizeAction, relativeTime } from '@/lib/format';
import { errorMessage, useForm } from '@/lib/forms';
import { keys } from '@/lib/session';

export default function SecurityPage() {
  return (
    <div className="grid gap-6">
      <PasswordCard />
      <SessionsCard />
      <SecurityLogCard />
    </div>
  );
}

function PasswordCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const [values, setValues] = useState({ currentPassword: '', newPassword: '' });
  const { fieldErrors, formError, submitting, submit } = useForm(changePasswordRequest);
  return (
    <Card title="Password" description="Changing your password signs you out on every other device.">
      <form
        noValidate
        className="grid max-w-md gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(values, async (data) => {
            const r = await http.post<{ otherSessionsSignedOut: number }>('/v1/me/password', data);
            setValues({ currentPassword: '', newPassword: '' });
            void qc.invalidateQueries({ queryKey: keys.sessions });
            toast('success', r.otherSessionsSignedOut ? `Password changed. ${r.otherSessionsSignedOut} other session(s) signed out.` : 'Password changed.');
          });
        }}
      >
        {formError && <Alert tone="danger">{formError}</Alert>}
        <Field label="Current password" errors={fieldErrors.currentPassword}>
          {(p) => <Input {...p} type="password" autoComplete="current-password" value={values.currentPassword} onChange={(e) => setValues((v) => ({ ...v, currentPassword: e.target.value }))} />}
        </Field>
        <Field label="New password" hint={`At least ${PASSWORD_MIN_LENGTH} characters.`} errors={fieldErrors.newPassword}>
          {(p) => <Input {...p} type="password" autoComplete="new-password" value={values.newPassword} onChange={(e) => setValues((v) => ({ ...v, newPassword: e.target.value }))} />}
        </Field>
        <div>
          <Button type="submit" loading={submitting}>
            Change password
          </Button>
        </div>
      </form>
    </Card>
  );
}

function SessionsCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const sessions = useQuery({ queryKey: keys.sessions, queryFn: () => http.get<{ data: SessionSummary[] }>('/v1/me/sessions') });
  const invalidate = () => qc.invalidateQueries({ queryKey: keys.sessions });
  const revoke = useMutation({
    mutationFn: (id: string) => http.delete(`/v1/me/sessions/${id}`),
    onSuccess: () => {
      toast('success', 'Session signed out');
      void invalidate();
    },
    onError: (e) => toast('danger', errorMessage(e)),
  });
  const revokeOthers = useMutation({
    mutationFn: () => http.post<{ revoked: number }>('/v1/me/sessions/revoke-others'),
    onSuccess: (r) => {
      toast('success', `${r.revoked} session(s) signed out`);
      void invalidate();
    },
  });
  const others = sessions.data?.data.filter((s) => !s.current).length ?? 0;
  return (
    <Card
      title="Where you are signed in"
      description="Sign out any device you do not recognise, then change your password."
      actions={
        others > 0 && (
          <Button variant="secondary" size="sm" loading={revokeOthers.isPending} onClick={() => revokeOthers.mutate()}>
            Sign out all other sessions
          </Button>
        )
      }
    >
      {sessions.isLoading ? (
        <Spinner />
      ) : (
        <ul className="divide-y divide-line">
          {sessions.data?.data.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 py-3">
              <Laptop className="size-5 text-ink-faint" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {describeUserAgent(s.userAgent)} {s.current && <Badge tone="success">This device</Badge>}
                </p>
                <p className="text-xs text-ink-muted">
                  {s.ipAddress ?? 'Unknown IP'} · last active {relativeTime(s.lastSeenAt)} · signed in {dateTime(s.createdAt)}
                </p>
              </div>
              {!s.current && (
                <Button size="sm" variant="ghost" onClick={() => revoke.mutate(s.id)}>
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function SecurityLogCard() {
  const log = useInfiniteQuery({
    queryKey: keys.securityEvents,
    initialPageParam: '' as string,
    queryFn: ({ pageParam }) => http.get<Page<SecurityEventView>>(`/v1/me/security-events?limit=20${pageParam ? `&cursor=${pageParam}` : ''}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = log.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <Card title="Recent security activity" description="Sign-ins, password changes and session changes on your account.">
      {log.isLoading ? (
        <Spinner />
      ) : (
        <>
          <Table label="Security activity">
            <thead>
              <tr>
                <Th>Event</Th>
                <Th>When</Th>
                <Th>IP address</Th>
                <Th>Device</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <Td>{humanizeAction(e.type.replace(/^auth\./, ''))}</Td>
                  <Td className="text-ink-muted">{dateTime(e.occurredAt)}</Td>
                  <Td className="font-mono text-xs">{e.ipAddress ?? '—'}</Td>
                  <Td className="text-ink-muted">{describeUserAgent(e.userAgent)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {log.hasNextPage && (
            <div className="mt-4 text-center">
              <Button variant="secondary" size="sm" loading={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
