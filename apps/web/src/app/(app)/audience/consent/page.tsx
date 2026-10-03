'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type RetentionPolicyView, retentionPolicyRequest } from '@workeasy/shared';
import { useEffect, useState } from 'react';
import { AudiencePage } from '@/components/audience-shell';
import { Alert, Badge, Button, Card, ConfirmDialog, Field, Input, PageHeader, Spinner, useToast } from '@/components/ui';
import { http } from '@/lib/api';
import { audienceKeys, useWorkspaceApi } from '@/lib/audience';
import { errorMessage, useForm } from '@/lib/forms';
import { useCan } from '@/lib/session';

type Draft = { withdrawalForever: boolean; withdrawal: string; erasureForever: boolean; erasure: string; pending: string };

function ConsentInner() {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const { workspaceId, path } = useWorkspaceApi();
  const policy = useQuery({ queryKey: audienceKeys.retention(workspaceId!), queryFn: () => http.get<RetentionPolicyView>(path('/consent/retention-policy')) });
  const form = useForm(retentionPolicyRequest);
  const [d, setD] = useState<Draft | null>(null);
  const [purging, setPurging] = useState(false);
  useEffect(() => {
    const p = policy.data;
    if (p)
      setD({
        withdrawalForever: p.retainAfterWithdrawalDays === null,
        withdrawal: String(p.retainAfterWithdrawalDays ?? 2190),
        erasureForever: p.retainAfterErasureDays === null,
        erasure: String(p.retainAfterErasureDays ?? 2190),
        pending: String(p.pendingExpiryDays),
      });
  }, [policy.data]);
  const purge = useMutation({
    mutationFn: () => http.post<{ deleted: number }>(path('/consent/retention-purge')),
    onSuccess: (r) => {
      setPurging(false);
      toast('success', r.deleted ? `Purged ${r.deleted} expired evidence records` : 'Nothing has passed its retention period');
    },
  });
  const manage = can('consent.manage');

  if (policy.isLoading || !d) return policy.isError ? <Alert tone="danger">{errorMessage(policy.error)}</Alert> : <Spinner />;
  const p = policy.data!;

  return (
    <>
      <PageHeader
        title="Consent"
        description="Consent evidence is append-only: it is never edited, and it is kept after a contact is deleted so you can prove past consent. Here you decide how long."
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card
          title="Evidence retention"
          description={p.isDefault ? 'Using the default policy. Check it with your legal advisor.' : undefined}
          actions={p.isDefault ? <Badge>Default</Badge> : undefined}
        >
          {form.formError && (
            <div className="mb-4">
              <Alert tone="danger">{form.formError}</Alert>
            </div>
          )}
          <form
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              void form.submit(
                {
                  retainAfterWithdrawalDays: d.withdrawalForever ? null : Number(d.withdrawal),
                  retainAfterErasureDays: d.erasureForever ? null : Number(d.erasure),
                  pendingExpiryDays: Number(d.pending),
                  ...(p.version ? { version: p.version } : {}),
                },
                async (data) => {
                  await http.put(path('/consent/retention-policy'), data);
                  toast('success', 'Retention policy saved');
                  await qc.invalidateQueries({ queryKey: audienceKeys.retention(workspaceId!) });
                },
              );
            }}
          >
            <RetentionRow
              label="After consent is withdrawn"
              hint="How long the history of a contact who withdrew consent is kept."
              forever={d.withdrawalForever}
              days={d.withdrawal}
              disabled={!manage}
              errors={form.fieldErrors.retainAfterWithdrawalDays}
              onChange={(forever, days) => setD({ ...d, withdrawalForever: forever, withdrawal: days })}
            />
            <RetentionRow
              label="After a contact is erased"
              hint="Evidence is kept in pseudonymous form after erasure."
              forever={d.erasureForever}
              days={d.erasure}
              disabled={!manage}
              errors={form.fieldErrors.retainAfterErasureDays}
              onChange={(forever, days) => setD({ ...d, erasureForever: forever, erasure: days })}
            />
            <Field label="Unconfirmed requests expire after (days)" hint="Pending double opt-in requests older than this no longer count." errors={form.fieldErrors.pendingExpiryDays}>
              {(fp) => <Input {...fp} type="number" min={1} max={365} disabled={!manage} value={d.pending} onChange={(e) => setD({ ...d, pending: e.target.value })} />}
            </Field>
            {manage && (
              <Button type="submit" loading={form.submitting}>
                Save policy
              </Button>
            )}
          </form>
        </Card>
        {manage && (
          <Card title="Purge expired evidence" description="Runs the policy now. Only evidence older than the retention period is deleted; it cannot be undone.">
            <Button variant="danger" onClick={() => setPurging(true)}>
              Purge expired evidence
            </Button>
          </Card>
        )}
      </div>
      <ConfirmDialog
        open={purging}
        onClose={() => setPurging(false)}
        onConfirm={() => purge.mutate()}
        title="Purge expired consent evidence?"
        body="Evidence past its retention period is permanently deleted and recorded in the audit log."
        confirmLabel="Purge"
        confirmText="PURGE"
        busy={purge.isPending}
        error={purge.isError ? errorMessage(purge.error) : null}
      />
    </>
  );
}

function RetentionRow({
  label,
  hint,
  forever,
  days,
  disabled,
  errors,
  onChange,
}: {
  label: string;
  hint: string;
  forever: boolean;
  days: string;
  disabled: boolean;
  errors?: string[];
  onChange: (forever: boolean, days: string) => void;
}) {
  const name = label.replace(/\W+/g, '-').toLowerCase();
  return (
    <fieldset>
      <legend className="text-sm font-medium">{label}</legend>
      <p className="mb-2 text-xs text-ink-muted">{hint}</p>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="radio" name={name} disabled={disabled} checked={!forever} onChange={() => onChange(false, days)} />
          Keep for
          <Input aria-label={`${label}: days`} type="number" min={0} max={36500} className="w-24" disabled={disabled || forever} value={days} onChange={(e) => onChange(false, e.target.value)} />
          days
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name={name} disabled={disabled} checked={forever} onChange={() => onChange(true, days)} />
          Keep indefinitely
        </label>
      </div>
      {errors?.length ? <p className="mt-1 text-xs text-danger">{errors.join(' ')}</p> : null}
    </fieldset>
  );
}

export default function ConsentPage() {
  return (
    <AudiencePage>
      <ConsentInner />
    </AudiencePage>
  );
}
