'use client';

import { loginRequest, type SessionUser } from '@workeasy/shared';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { http } from '@/lib/api';
import { useForm } from '@/lib/forms';
import { safeNext } from '@/lib/navigation';
import { useResetCache } from '@/lib/session';
import { ssoErrorMessage, type Workeasy360SignIn, workeasy360StartUrl } from '@/lib/workeasy360';

/**
 * Email and password sign-in, and "Continue with WorkEasy360" when the deployment offers it (`workeasy360`, from
 * WORKEASY360_SIGN_IN). This page never starts a WorkEasy360 sign-in by itself (integration guide §6a): it is a choice.
 */
export function LoginForm({ workeasy360 = 'off' }: { workeasy360?: Workeasy360SignIn }) {
  const router = useRouter();
  const params = useSearchParams();
  const reset = useResetCache();
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [password, setPassword] = useState('');
  const { fieldErrors, formError, submitting, submit } = useForm(loginRequest);
  const next = safeNext(params.get('next'));
  const ssoError = params.get('sso_error');
  const passwords = workeasy360 !== 'only';

  return (
    <form
      noValidate
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit({ email, password }, async (data) => {
          const { user } = await http.post<{ user: SessionUser }>('/v1/auth/login', data);
          await reset();
          router.replace(user.emailVerified ? next : `/verify-email?email=${encodeURIComponent(user.email)}`);
        });
      }}
    >
      <div>
        <h1 className="text-xl font-semibold">Sign in</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {passwords ? 'Welcome back. Enter your details to continue.' : 'Workeasy Campaign uses your WorkEasy360 account.'}
        </p>
      </div>
      {params.get('verified') && <Alert tone="success" title="Email confirmed">Sign in to set up your organization.</Alert>}
      {params.get('reset') && <Alert tone="success" title="Password updated">Sign in with your new password.</Alert>}
      {ssoError && (
        <Alert tone="danger" title="WorkEasy360 sign-in did not complete">
          {ssoErrorMessage(ssoError, params.get('reason'))}
        </Alert>
      )}
      {formError && <Alert tone="danger">{formError}</Alert>}
      {workeasy360 !== 'off' && (
        // A plain link: a full-page navigation to the API, never prefetched.
        <a
          href={workeasy360StartUrl(params.get('next') ? next : undefined)}
          className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-control border border-line bg-surface px-4 text-sm font-medium text-ink transition-colors hover:bg-surface-muted"
        >
          Continue with WorkEasy360
        </a>
      )}
      {workeasy360 === 'on' && (
        <div className="flex items-center gap-3 text-xs text-ink-faint" aria-hidden>
          <span className="h-px flex-1 bg-line" />
          or with your email
          <span className="h-px flex-1 bg-line" />
        </div>
      )}
      {passwords && (
        <>
          <Field label="Work email" errors={fieldErrors.email}>
            {(p) => <Input {...p} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />}
          </Field>
          <Field label="Password" errors={fieldErrors.password}>
            {(p) => <Input {...p} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
          <div className="flex items-center justify-end">
            <Link href="/forgot-password" className="text-sm font-medium text-accent hover:underline">
              Forgot password?
            </Link>
          </div>
          <Button type="submit" className="w-full" loading={submitting}>
            Sign in
          </Button>
          <p className="text-center text-sm text-ink-muted">
            New here?{' '}
            <Link href={`/register${params.get('next') ? `?next=${encodeURIComponent(next)}` : ''}`} className="font-medium text-accent hover:underline">
              Create an account
            </Link>
          </p>
        </>
      )}
    </form>
  );
}
