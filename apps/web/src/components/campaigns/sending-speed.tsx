'use client';

import { useQueryClient } from '@tanstack/react-query';
import { type ExecutionSummary, SENDING_RATE_LIMITS } from '@workeasy/shared';
import { type FormEvent, useState } from 'react';
import { Button, Field, Input, useToast } from '@/components/ui';
import { http } from '@/lib/api';
import { useWorkspaceApi } from '@/lib/audience';
import { campaignKeys } from '@/lib/campaigns';
import { errorMessage } from '@/lib/forms';
import { useCan } from '@/lib/session';

const LIVE = ['pending', 'materializing', 'delivering', 'paused'];

/**
 * A run's sending speed (Phase 7.11): an optional limit of messages per hour, changeable until the run finishes; it
 * applies from the next batch. Provider and workspace limits apply as well (the slowest wins). Needs campaigns.send.
 */
export function SendingSpeed({ campaignId, execution }: { campaignId: string; execution: ExecutionSummary }) {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const { workspaceId, path } = useWorkspaceApi();
  const [value, setValue] = useState(execution.maxPerHour ? String(execution.maxPerHour) : '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const live = LIVE.includes(execution.status);
  const current = execution.maxPerHour ? `At most ${execution.maxPerHour.toLocaleString()} per hour` : 'No campaign limit';
  if (!live || !can('campaigns.send')) {
    return execution.maxPerHour ? <p className="text-xs text-ink-muted">Sending speed: {current.toLowerCase()}.</p> : null;
  }
  const save = async (maxPerHour: number | null) => {
    setBusy(true);
    setError(null);
    try {
      await http.put<ExecutionSummary>(path(`/campaigns/${campaignId}/executions/${execution.id}/sending-rate`), { maxPerHour });
      await qc.invalidateQueries({ queryKey: campaignKeys.all(workspaceId!) });
      toast('success', maxPerHour ? 'Sending speed limited' : 'Sending speed limit removed');
      if (!maxPerHour) setValue('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    const n = Number(value);
    if (!Number.isInteger(n) || n < SENDING_RATE_LIMITS.min || n > SENDING_RATE_LIMITS.max) {
      setError(`Enter a whole number from ${SENDING_RATE_LIMITS.min} to ${SENDING_RATE_LIMITS.max.toLocaleString()}`);
      return;
    }
    void save(n);
  };
  return (
    <form onSubmit={submit} className="space-y-2 rounded-control border border-line p-3" aria-label="Sending speed">
      <p className="text-sm">
        <span className="font-medium">Sending speed:</span> {current}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-44">
          <Field label="Messages per hour" errors={error ? [error] : undefined} hint="Applies from the next batch.">
            {(p) => <Input {...p} inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value.replace(/[^\d]/g, ''))} />}
          </Field>
        </div>
        <Button type="submit" size="sm" loading={busy}>
          Set limit
        </Button>
        {execution.maxPerHour && (
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void save(null)}>
            Remove limit
          </Button>
        )}
      </div>
    </form>
  );
}
