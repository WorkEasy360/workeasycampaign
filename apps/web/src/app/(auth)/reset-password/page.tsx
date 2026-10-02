'use client';

import { PASSWORD_MIN_LENGTH, resetPasswordRequest } from '@workeasy/shared';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { http } from '@/lib/api';
import { useForm } from '@/lib/forms';

function ResetForm() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const { fieldErrors, formError, submitting, submit } = useForm(resetPasswordRequest);

  if (!token) {
    return (
      <div className="space-y-4">
        <Alert tone="danger" title="This reset link is incomplete">Open the link from your email again, or request a new one.</Alert>
        <Link href="/forgot-password" className="text-sm font-medium text-accent hover:underline">
          Request a new link
        </Link>
      </div>
    );
  }

  return (
    <form
      noValidate
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (password !== confirm) return setMismatch(true);
        setMismatch(false);
        void submit({ token, password }, async (data) => {
          await http.post('/v1/auth/reset-password', data);
          router.replace('/login?reset=1');
        });
      }}
    >
      <div>
        <h1 className="text-xl font-semibold">Choose a new password</h1>
        <p className="mt-1 text-sm text-ink-muted">You will be signed out everywhere and can sign in again with the new password.</p>
      </div>
      {formError && (
        <Alert tone="danger">
          {formError}{' '}
          {fieldErrors.token || /invalid|expired/i.test(formError) ? (
            <Link href="/forgot-password" className="font-medium text-accent underline">
              Request a new link
            </Link>
          ) : null}
        </Alert>
      )}
      <Field label="New password" hint={`At least ${PASSWORD_MIN_LENGTH} characters.`} errors={fieldErrors.password}>
        {(p) => <Input {...p} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />}
      </Field>
      <Field label="Repeat new password" errors={mismatch ? ['The passwords do not match'] : undefined}>
        {(p) => <Input {...p} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
      </Field>
      <Button type="submit" className="w-full" loading={submitting}>
        Update password
      </Button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
