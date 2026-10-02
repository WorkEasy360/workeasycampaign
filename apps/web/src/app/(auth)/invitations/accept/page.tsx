'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import type { InvitationPreview } from '@workeasy/shared';
import { Building2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { Alert, Button, Spinner } from '@/components/ui';
import { http } from '@/lib/api';
import { errorMessage } from '@/lib/forms';
import { useResetCache, useSession } from '@/lib/session';

function AcceptInvitation() {
  const params = useSearchParams();
  const router = useRouter();
  const reset = useResetCache();
  const token = params.get('token') ?? '';
  const here = `/invitations/accept?token=${encodeURIComponent(token)}`;
  const session = useSession();
  const preview = useQuery({
    queryKey: ['invitation-preview', token],
    queryFn: () => http.post<InvitationPreview>('/v1/invitations/preview', { token }),
    enabled: !!token,
    retry: false,
  });
  const accept = useMutation({
    mutationFn: () => http.post<{ organizationId: string }>('/v1/invitations/accept', { token }),
    onSuccess: async ({ organizationId }) => {
      await http.put('/v1/me/context', { organizationId, workspaceId: null });
      await reset();
      router.replace('/dashboard');
    },
  });

  if (!token) return <Alert tone="danger" title="This invitation link is incomplete">Open the link from your email again.</Alert>;
  if (preview.isLoading || session.isLoading) return <Spinner />;
  if (preview.isError) return <Alert tone="danger" title="Invitation not found">{errorMessage(preview.error)}</Alert>;

  const inv = preview.data!;
  const user = session.data?.user;
  const unusable = inv.status !== 'pending';

  return (
    <div className="space-y-5">
      <div className="text-center">
        <Building2 className="mx-auto size-10 text-accent" aria-hidden />
        <h1 className="mt-3 text-xl font-semibold">Join {inv.organizationName}</h1>
        <p className="mt-1 text-sm text-ink-muted">
          This invitation is for <strong className="text-ink">{inv.email}</strong>.
        </p>
      </div>
      {unusable && <Alert tone="warning" title={`This invitation is ${inv.status}`}>Ask the person who invited you for a new invitation.</Alert>}
      {!unusable && !user && (
        <div className="grid gap-2">
          <Button onClick={() => router.push(`/login?email=${encodeURIComponent(inv.email)}&next=${encodeURIComponent(here)}`)}>Sign in to accept</Button>
          <Button variant="secondary" onClick={() => router.push(`/register?next=${encodeURIComponent(here)}`)}>
            Create an account
          </Button>
        </div>
      )}
      {!unusable && user && user.email.toLowerCase() !== inv.email.toLowerCase() && (
        <Alert tone="warning" title="You are signed in with a different email">
          You are signed in as {user.email}. Sign out and sign in as {inv.email} to accept.
        </Alert>
      )}
      {!unusable && user && user.email.toLowerCase() === inv.email.toLowerCase() && (
        <>
          {!user.emailVerified && (
            <Alert tone="warning">
              Confirm your email first. <Link href="/verify-email" className="font-medium text-accent underline">Resend the link</Link>
            </Alert>
          )}
          {accept.isError && <Alert tone="danger">{errorMessage(accept.error)}</Alert>}
          <Button className="w-full" onClick={() => accept.mutate()} loading={accept.isPending} disabled={!user.emailVerified}>
            Accept invitation
          </Button>
        </>
      )}
    </div>
  );
}

export default function AcceptInvitationPage() {
  return (
    <Suspense>
      <AcceptInvitation />
    </Suspense>
  );
}
