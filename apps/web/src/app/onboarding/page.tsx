'use client';

import { createOrganizationRequest } from '@workeasy/shared';
import { Building2, LayoutGrid } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Logo } from '@/components/brand';
import { Alert, Button, Field, Input, Select, Spinner } from '@/components/ui';
import { http, idempotencyKey } from '@/lib/api';
import { useForm } from '@/lib/forms';
import { useResetCache, useSession } from '@/lib/session';

const TIMEZONES = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC'];

export default function OnboardingPage() {
  const router = useRouter();
  const reset = useResetCache();
  const session = useSession();
  const detectedTz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);
  const [values, setValues] = useState({ name: '', workspaceName: 'Main workspace', timezone: detectedTz });
  // One key per onboarding attempt: a double-click or network retry cannot create two organizations.
  const [key] = useState(idempotencyKey);
  const { fieldErrors, formError, submitting, submit } = useForm(createOrganizationRequest);

  useEffect(() => {
    if (session.data && !session.data.user) router.replace('/login?next=/onboarding');
    else if (session.data?.user && !session.data.user.emailVerified) router.replace('/verify-email');
  }, [session.data, router]);

  if (!session.data?.user?.emailVerified) return <Spinner />;

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-12">
      <div className="mb-8">
        <Logo />
      </div>
      <form
        noValidate
        className="w-full max-w-lg space-y-6 rounded-card border border-line bg-surface p-6 shadow-sm sm:p-8"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(
            { name: values.name, workspace: { name: values.workspaceName, timezone: values.timezone } },
            async (data) => {
              const created = await http.post<{ organization: { id: string }; workspace: { id: string } }>('/v1/organizations', data, {
                'idempotency-key': key,
              });
              await http.put('/v1/me/context', { organizationId: created.organization.id, workspaceId: created.workspace.id });
              await reset();
              router.replace('/dashboard');
            },
          );
        }}
      >
        <div>
          <p className="text-sm font-medium text-accent">Step 1 of 1</p>
          <h1 className="mt-1 text-xl font-semibold">Set up your organization</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Your organization holds your team and settings. Workspaces keep contacts, campaigns and reports separate — for example one per brand or
            region. You can add more later.
          </p>
        </div>
        {formError && <Alert tone="danger">{formError}</Alert>}
        <fieldset className="space-y-4">
          <legend className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <Building2 className="size-4 text-ink-faint" aria-hidden /> Organization
          </legend>
          <Field label="Organization name" hint="Usually your company name." errors={fieldErrors.name ?? fieldErrors.slug}>
            {(p) => <Input {...p} value={values.name} onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))} autoFocus placeholder="Acme Inc." />}
          </Field>
        </fieldset>
        <fieldset className="space-y-4">
          <legend className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <LayoutGrid className="size-4 text-ink-faint" aria-hidden /> First workspace
          </legend>
          <Field label="Workspace name" errors={fieldErrors['workspace.name']}>
            {(p) => <Input {...p} value={values.workspaceName} onChange={(e) => setValues((v) => ({ ...v, workspaceName: e.target.value }))} />}
          </Field>
          <Field label="Time zone" hint="Used for scheduling and reports. Detected from your browser." errors={fieldErrors['workspace.timezone']}>
            {(p) => (
              <Select {...p} value={values.timezone} onChange={(e) => setValues((v) => ({ ...v, timezone: e.target.value }))}>
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz.replaceAll('_', ' ')}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </fieldset>
        <Button type="submit" className="w-full" loading={submitting}>
          Create organization
        </Button>
      </form>
    </main>
  );
}
