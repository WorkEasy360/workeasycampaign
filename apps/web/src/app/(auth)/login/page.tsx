'use client';

import { loginRequest, type SessionUser } from '@workeasy/shared';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { http } from '@/lib/api';
import { useForm } from '@/lib/forms';
import { safeNext } from '@/lib/navigation';
import { useResetCache } from '@/lib/session';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const reset = useResetCache();
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [password, setPassword] = useState('');
  const { fieldErrors, formError, submitting, submit } = useForm(loginRequest);
  const next = safeNext(params.get('next'));

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
        <p className="mt-1 text-sm text-ink-muted">Welcome back. Enter your details to continue.</p>
      </div>
      {params.get('verified') && <Alert tone="success" title="Email confirmed">Sign in to set up your organization.</Alert>}
      {params.get('reset') && <Alert tone="success" title="Password updated">Sign in with your new password.</Alert>}
      {formError && <Alert tone="danger">{formError}</Alert>}
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
    </form>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
