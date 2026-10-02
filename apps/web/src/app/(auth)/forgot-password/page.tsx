'use client';

import { forgotPasswordRequest } from '@workeasy/shared';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { http } from '@/lib/api';
import { useForm } from '@/lib/forms';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const { fieldErrors, formError, submitting, submit } = useForm(forgotPasswordRequest);

  return (
    <form
      noValidate
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit({ email }, async (data) => {
          await http.post('/v1/auth/forgot-password', data);
          setSent(true);
        });
      }}
    >
      <div>
        <h1 className="text-xl font-semibold">Reset your password</h1>
        <p className="mt-1 text-sm text-ink-muted">Enter your email and we will send you a link to choose a new password.</p>
      </div>
      {sent ? (
        <Alert tone="success" title="Check your inbox">
          If an account exists for {email}, a reset link is on its way. It works once and expires in 1 hour.
        </Alert>
      ) : (
        <>
          {formError && <Alert tone="danger">{formError}</Alert>}
          <Field label="Email" errors={fieldErrors.email}>
            {(p) => <Input {...p} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />}
          </Field>
          <Button type="submit" className="w-full" loading={submitting}>
            Send reset link
          </Button>
        </>
      )}
      <p className="text-center text-sm">
        <Link href="/login" className="font-medium text-accent hover:underline">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
