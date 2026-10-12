'use client';

import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, MailX } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Spinner } from '@/components/ui';
import { ApiError, http } from '@/lib/api';
import { errorMessage } from '@/lib/forms';

interface Info {
  organization: string;
  workspace: string;
  topicScoped: boolean;
}

/**
 * Public unsubscribe page (Phase 7.8; campaign amendment §U) for email recipients — not for users of the product, so no
 * sign-in, navigation or product marketing. Opening it changes nothing (link scanners open links too); the person
 * confirms with a button. The signed link is the only authority; the server decides everything.
 */
export default function UnsubscribePage() {
  const { token } = useParams<{ token: string }>();
  const path = `/v1/unsubscribe/${encodeURIComponent(token)}`;
  const info = useQuery({ queryKey: ['unsubscribe', token], queryFn: ({ signal }) => http.get<Info>(path, signal), retry: false });
  const [done, setDone] = useState<'topic' | 'all' | null>(null);
  const [busy, setBusy] = useState<'topic' | 'all' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (scope: 'topic' | 'all') => {
    setBusy(scope);
    setError(null);
    try {
      const r = await http.post<{ scope: 'topic' | 'all' }>(path, { scope });
      setDone(r.scope);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-md rounded-card border border-line bg-surface p-6 shadow-sm sm:p-8">
        {info.isLoading ? (
          <Spinner label="Checking your link" />
        ) : info.isError ? (
          <div className="space-y-3 text-center">
            <MailX className="mx-auto size-10 text-ink-faint" aria-hidden />
            <h1 className="text-xl font-semibold">
              {info.error instanceof ApiError && info.error.status === 404 ? 'This link is not valid' : 'This page could not be loaded'}
            </h1>
            <p className="text-sm text-ink-muted">
              {info.error instanceof ApiError && info.error.status === 404
                ? 'It may have been copied incompletely. Use the unsubscribe link in the email again.'
                : 'Please try again in a moment.'}
            </p>
            {!(info.error instanceof ApiError && info.error.status === 404) && (
              <Button variant="secondary" onClick={() => void info.refetch()}>
                Try again
              </Button>
            )}
          </div>
        ) : done ? (
          <div className="space-y-3 text-center" role="status">
            <CheckCircle2 className="mx-auto size-10 text-success" aria-hidden />
            <h1 className="text-xl font-semibold">You are unsubscribed</h1>
            <p className="text-sm text-ink-muted">
              {done === 'topic'
                ? `${info.data!.organization} will no longer send you emails about this topic.`
                : `${info.data!.organization} will no longer send you marketing email.`}{' '}
              It can take a few minutes to take effect for emails already on their way.
            </p>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="space-y-2">
              <h1 className="text-xl font-semibold">Unsubscribe</h1>
              <p className="text-sm text-ink-muted">
                Choose which emails from <strong className="text-ink">{info.data!.organization}</strong> you no longer want to receive.
              </p>
            </div>
            {error && <Alert tone="danger">Your choice was not saved: {error}</Alert>}
            <div className="flex flex-col gap-3">
              {info.data!.topicScoped && (
                <Button loading={busy === 'topic'} disabled={busy !== null} onClick={() => void submit('topic')}>
                  Unsubscribe from emails like this one
                </Button>
              )}
              <Button variant={info.data!.topicScoped ? 'secondary' : 'primary'} loading={busy === 'all'} disabled={busy !== null} onClick={() => void submit('all')}>
                Unsubscribe from all marketing email
              </Button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
