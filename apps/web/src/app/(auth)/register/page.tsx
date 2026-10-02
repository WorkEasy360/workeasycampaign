'use client';

import { PASSWORD_MIN_LENGTH, registerRequest } from '@workeasy/shared';
import { MailCheck } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { http } from '@/lib/api';
import { useForm } from '@/lib/forms';

function RegisterForm() {
  const params = useSearchParams();
  const [values, setValues] = useState({ displayName: '', email: '', password: '' });
  const [sentTo, setSentTo] = useState<string | null>(null);
  const { fieldErrors, formError, submitting, submit } = useForm(registerRequest);
  const set = (k: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement>) => setValues((v) => ({ ...v, [k]: e.target.value }));

  if (sentTo) {
    // Same screen whether or not the email was already registered (no account enumeration).
    return (
      <div className="space-y-4 text-center">
        <MailCheck className="mx-auto size-10 text-accent" aria-hidden />
        <h1 className="text-xl font-semibold">Check your inbox</h1>
        <p className="text-sm text-ink-muted">
          We sent a link to <strong className="text-ink">{sentTo}</strong>. Open it to confirm your email, then sign in.
        </p>
        <Link href={`/login?email=${encodeURIComponent(sentTo)}`} className="inline-block text-sm font-medium text-accent hover:underline">
          Go to sign in
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
        void submit(values, async (data) => {
          await http.post('/v1/auth/register', data);
          setSentTo(data.email);
        });
      }}
    >
      <div>
        <h1 className="text-xl font-semibold">Create your account</h1>
        <p className="mt-1 text-sm text-ink-muted">It takes a minute. You will set up your organization next.</p>
      </div>
      {formError && <Alert tone="danger">{formError}</Alert>}
      <Field label="Your name" errors={fieldErrors.displayName}>
        {(p) => <Input {...p} autoComplete="name" value={values.displayName} onChange={set('displayName')} autoFocus />}
      </Field>
      <Field label="Work email" errors={fieldErrors.email}>
        {(p) => <Input {...p} type="email" autoComplete="email" value={values.email} onChange={set('email')} />}
      </Field>
      <Field label="Password" hint={`At least ${PASSWORD_MIN_LENGTH} characters. A short phrase is easy to remember and hard to guess.`} errors={fieldErrors.password}>
        {(p) => <Input {...p} type="password" autoComplete="new-password" value={values.password} onChange={set('password')} />}
      </Field>
      <Button type="submit" className="w-full" loading={submitting}>
        Create account
      </Button>
      <p className="text-center text-sm text-ink-muted">
        Already have an account?{' '}
        <Link href={`/login${params.get('next') ? `?next=${encodeURIComponent(params.get('next')!)}` : ''}`} className="font-medium text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}

export default function RegisterPage() {
  return (
    <Suspense>
      <RegisterForm />
    </Suspense>
  );
}
