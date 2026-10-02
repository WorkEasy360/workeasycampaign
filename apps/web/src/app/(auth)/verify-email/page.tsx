'use client';

import { resendVerificationRequest } from '@workeasy/shared';
import { CheckCircle2, MailCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Alert, Button, Field, Input, Spinner } from '@/components/ui';
import { http } from '@/lib/api';
import { errorMessage, useForm } from '@/lib/forms';
import { useResetCache, useSession } from '@/lib/session';

function ConfirmToken({ token }: { token: string }) {
  const router = useRouter();
  const reset = useResetCache();
  const session = useSession();
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');
  const [error, setError] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    http
      .post('/v1/auth/verify-email', { token })
      .then(async () => {
        setState('done');
        await reset();
      })
      .catch((err) => {
        setState('failed');
        setError(errorMessage(err));
      });
  }, [token, reset]);

  if (state === 'working') return <Spinner label="Confirming your email" />;
  if (state === 'failed') {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">We could not confirm your email</h1>
        <Alert tone="danger">{error}</Alert>
        <ResendForm />
      </div>
    );
  }
  const signedIn = !!session.data?.user;
  return (
    <div className="space-y-4 text-center">
      <CheckCircle2 className="mx-auto size-10 text-success" aria-hidden />
      <h1 className="text-xl font-semibold">Email confirmed</h1>
      <p className="text-sm text-ink-muted">{signedIn ? 'Next, set up your organization.' : 'Sign in to set up your organization.'}</p>
      <Button className="w-full" onClick={() => router.replace(signedIn ? '/onboarding' : '/login?verified=1')}>
        {signedIn ? 'Continue' : 'Sign in'}
      </Button>
    </div>
  );
}

function ResendForm({ initialEmail = '' }: { initialEmail?: string }) {
  const [email, setEmail] = useState(initialEmail);
  const [sent, setSent] = useState(false);
  const { fieldErrors, formError, submitting, submit } = useForm(resendVerificationRequest);
  return (
    <form
      noValidate
      className="space-y-3 text-left"
      onSubmit={(e) => {
        e.preventDefault();
        void submit({ email }, async (data) => {
          await http.post('/v1/auth/resend-verification', data);
          setSent(true);
        });
      }}
    >
      {sent && <Alert tone="success">If that address needs confirming, a new link is on its way.</Alert>}
      {formError && <Alert tone="danger">{formError}</Alert>}
      <Field label="Email" errors={fieldErrors.email}>
        {(p) => <Input {...p} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
      </Field>
      <Button type="submit" variant="secondary" className="w-full" loading={submitting}>
        Send a new link
      </Button>
    </form>
  );
}

function VerifyEmail() {
  const params = useSearchParams();
  const session = useSession();
  const token = params.get('token');
  if (token) return <ConfirmToken token={token} />;
  if (session.isLoading) return <Spinner />;
  const email = params.get('email') ?? session.data?.user?.email ?? '';
  return (
    <div className="space-y-5">
      <div className="text-center">
        <MailCheck className="mx-auto size-10 text-accent" aria-hidden />
        <h1 className="mt-3 text-xl font-semibold">Confirm your email</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Open the link we sent{email ? <> to <strong className="text-ink">{email}</strong></> : ''}. It expires in 24 hours.
        </p>
      </div>
      <ResendForm initialEmail={email} />
      <p className="text-center text-sm">
        <Link href="/login" className="font-medium text-accent hover:underline">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmail />
    </Suspense>
  );
}
