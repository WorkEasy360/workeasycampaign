'use client';

import { useQueryClient } from '@tanstack/react-query';
import type { CampaignAction, CampaignView, PreflightResult } from '@workeasy/shared';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Alert, Button, ConfirmDialog, Dialog, Field, Input, Select, Spinner, useToast } from '@/components/ui';
import { ApiError, http, idempotencyKey } from '@/lib/api';
import { useWorkspaceApi } from '@/lib/audience';
import { ACTION_LABEL, blockedReason, campaignKeys, inZone, isoToZoned, timeZones, viewerTimeZone, zonedToIso } from '@/lib/campaigns';
import { errorMessage } from '@/lib/forms';
import { SendIcon } from './common';
import { EstimateView, FindingsList } from './readiness-panel';

type Simple = 'unschedule' | 'pause' | 'resume' | 'cancel' | 'return_to_draft' | 'delete' | 'restore' | 'clone';

const CONFIRM: Record<Simple, { title: string; body: string; label: string; danger?: boolean }> = {
  unschedule: { title: 'Unschedule this campaign?', body: 'It returns to draft so you can edit it. The scheduled version stays in its history.', label: 'Unschedule' },
  pause: { title: 'Pause sending?', body: 'Sending stops after the current batch. You can resume later; nobody receives the message twice.', label: 'Pause' },
  resume: { title: 'Resume sending?', body: 'The campaign continues where it stopped. It is checked again first (topic, channel and sending availability).', label: 'Resume' },
  cancel: { title: 'Cancel this campaign?', body: 'Nothing more is sent. Recipients who already received it are not affected. This cannot be undone.', label: 'Cancel campaign', danger: true },
  return_to_draft: { title: 'Return to draft?', body: 'The failed run stays in the history. You can fix the problem and schedule the campaign again.', label: 'Return to draft' },
  delete: { title: 'Delete this campaign?', body: 'It moves to the deleted view and can be restored later.', label: 'Delete', danger: true },
  restore: { title: 'Restore this campaign?', body: 'It comes back with the status it had.', label: 'Restore' },
  clone: { title: 'Duplicate this campaign?', body: 'A new draft is created with the same content and audience.', label: 'Duplicate' },
};

const ENDPOINT: Record<Simple, (v: number) => { method: 'post' | 'delete'; suffix: string; body: Record<string, unknown> }> = {
  unschedule: (v) => ({ method: 'post', suffix: '/unschedule', body: { expectedVersion: v } }),
  pause: () => ({ method: 'post', suffix: '/pause', body: {} }),
  resume: () => ({ method: 'post', suffix: '/resume', body: {} }),
  cancel: (v) => ({ method: 'post', suffix: '/cancel', body: { expectedVersion: v } }),
  return_to_draft: () => ({ method: 'post', suffix: '/return-to-draft', body: {} }),
  delete: (v) => ({ method: 'delete', suffix: '', body: { expectedVersion: v } }),
  restore: () => ({ method: 'post', suffix: '/restore', body: {} }),
  clone: () => ({ method: 'post', suffix: '/clone', body: {} }),
};

const ORDER: CampaignAction[] = ['schedule', 'send_now', 'reschedule', 'pause', 'resume', 'unschedule', 'return_to_draft', 'clone', 'restore', 'cancel', 'delete'];

/** Actions strictly from the server (allowedActions); blocked ones stay visible, disabled, with the server's reason. */
export function LifecycleActions({ campaign }: { campaign: CampaignView }) {
  const qc = useQueryClient();
  const toast = useToast();
  const router = useRouter();
  const { workspaceId, path } = useWorkspaceApi();
  const [confirm, setConfirm] = useState<Simple | null>(null);
  const [schedule, setSchedule] = useState<'schedule' | 'send_now' | null>(null);
  const [reschedule, setReschedule] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = new Map(campaign.blockedActions.map((b) => [b.action, blockedReason(b.reason)]));
  const shown = ORDER.filter((a) => campaign.allowedActions.includes(a) || ((a === 'schedule' || a === 'send_now') && blocked.has(a)));
  const refresh = async (next?: CampaignView) => {
    if (next) qc.setQueryData(campaignKeys.one(workspaceId!, campaign.id), next);
    await qc.invalidateQueries({ queryKey: campaignKeys.all(workspaceId!) });
  };
  const run = async (a: Simple) => {
    setBusy(true);
    setError(null);
    try {
      const e = ENDPOINT[a](campaign.version);
      const next = e.method === 'delete'
        ? await http.delete<CampaignView>(path(`/campaigns/${campaign.id}`), e.body)
        : await http.post<CampaignView>(path(`/campaigns/${campaign.id}${e.suffix}`), e.body, a === 'clone' ? { 'idempotency-key': idempotencyKey() } : undefined);
      setConfirm(null);
      if (a === 'clone') {
        await refresh();
        toast('success', 'Draft copy created');
        router.push(`/campaigns/${next.id}`);
        return;
      }
      await refresh(next);
      toast('success', `${ACTION_LABEL[a]} — done`);
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'version_conflict' ? 'The campaign changed in the meantime. Close this dialog to see the latest state, then try again.' : errorMessage(err));
      if (err instanceof ApiError && err.code === 'version_conflict') await refresh();
    } finally {
      setBusy(false);
    }
  };

  if (!shown.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {shown.map((a) => {
        const reason = blocked.get(a);
        const disabled = !campaign.allowedActions.includes(a);
        const variant = a === 'schedule' || a === 'send_now' ? 'primary' : a === 'cancel' || a === 'delete' ? 'danger' : 'secondary';
        return (
          <span key={a} className="inline-flex flex-col">
            <Button
              size="sm"
              variant={variant}
              disabled={disabled}
              aria-describedby={reason ? `blocked-${a}` : undefined}
              icon={a === 'schedule' || a === 'send_now' ? <SendIcon /> : undefined}
              onClick={() => {
                setError(null);
                if (a === 'schedule' || a === 'send_now') setSchedule(a);
                else if (a === 'reschedule') setReschedule(true);
                else setConfirm(a as Simple);
              }}
            >
              {ACTION_LABEL[a]}
            </Button>
            {disabled && reason && (
              <span id={`blocked-${a}`} className="mt-1 max-w-56 text-xs text-ink-muted">
                {reason}
              </span>
            )}
          </span>
        );
      })}
      {confirm && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={() => void run(confirm)}
          title={CONFIRM[confirm].title}
          body={CONFIRM[confirm].body}
          confirmLabel={CONFIRM[confirm].label}
          busy={busy}
          error={error}
        />
      )}
      {schedule && <ScheduleDialog campaign={campaign} mode={schedule} onClose={() => setSchedule(null)} onDone={refresh} />}
      {reschedule && <RescheduleDialog campaign={campaign} onClose={() => setReschedule(false)} onDone={refresh} />}
    </div>
  );
}

/**
 * Schedule / send now (architecture §6): runs the pre-flight on open and shows the estimate, the send time in the
 * campaign and viewer time zones, and that the content will be locked. The server decides; errors are explained.
 */
function ScheduleDialog({ campaign, mode, onClose, onDone }: { campaign: CampaignView; mode: 'schedule' | 'send_now'; onClose: () => void; onDone: (v?: CampaignView) => Promise<void> }) {
  const { path } = useWorkspaceApi();
  const toast = useToast();
  const tz0 = campaign.draft.schedule.timezone || viewerTimeZone();
  const [tz, setTz] = useState(tz0);
  const [local, setLocal] = useState(campaign.draft.schedule.sendAt ? isoToZoned(campaign.draft.schedule.sendAt, tz0) : '');
  const [check, setCheck] = useState<PreflightResult | null>(null);
  const [checking, setChecking] = useState(true);
  const [checkError, setCheckError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [key] = useState(idempotencyKey);
  useEffect(() => {
    let live = true;
    http
      .post<PreflightResult>(path(`/campaigns/${campaign.id}/preflight`))
      .then((r) => live && setCheck(r))
      .catch((e: unknown) => live && setCheckError(e))
      .finally(() => live && setChecking(false));
    return () => {
      live = false;
    };
  }, [campaign.id, path]);
  const sendAt = mode === 'schedule' ? zonedToIso(local, tz) : null;
  const submit = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const body = mode === 'send_now' ? { mode: 'now', expectedVersion: campaign.version } : { mode: 'at', sendAt, timezone: tz, expectedVersion: campaign.version };
      const next = await http.post<CampaignView>(path(`/campaigns/${campaign.id}/schedule`), body, { 'idempotency-key': key });
      await onDone(next);
      toast('success', mode === 'send_now' ? 'Sending started' : 'Campaign scheduled');
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        setFailure(err);
        if (err.code === 'version_conflict') await onDone();
      } else setFailure(new ApiError(0, 'internal_error', errorMessage(err)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={mode === 'send_now' ? 'Send this campaign now?' : 'Schedule this campaign'}
      description="The content and audience definition are locked into a version. To change them later, unschedule first."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button icon={<SendIcon />} loading={busy} disabled={mode === 'schedule' && !sendAt} onClick={() => void submit()}>
            {mode === 'send_now' ? 'Send now' : 'Schedule'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {mode === 'schedule' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Date and time">{(p) => <Input {...p} type="datetime-local" value={local} onChange={(e) => setLocal(e.target.value)} />}</Field>
            <Field label="Time zone">
              {(p) => (
                <Select {...p} value={tz} onChange={(e) => setTz(e.target.value)}>
                  {timeZones().map((z) => (
                    <option key={z} value={z}>
                      {z}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {sendAt && (
              <p className="text-sm text-ink-muted sm:col-span-2">
                Sends {inZone(sendAt, tz)}
                {tz !== viewerTimeZone() && <> — your time: {inZone(sendAt, viewerTimeZone())}</>}
              </p>
            )}
          </div>
        )}
        <div className="rounded-control border border-line p-3" aria-live="polite">
          {checking ? <Spinner label="Checking the campaign" /> : checkError ? <Alert tone="danger">{errorMessage(checkError)}</Alert> : check && <EstimateView result={check} />}
        </div>
        {failure && <ScheduleFailure error={failure} />}
      </div>
    </Dialog>
  );
}

function ScheduleFailure({ error }: { error: ApiError }) {
  if (error.code === 'PREFLIGHT_UNAVAILABLE') {
    return (
      <Alert tone="warning" title="The audience is being prepared">
        The eligibility of this audience cannot be confirmed right now, so nothing was scheduled. Audience resolution recovery has been requested — try again in about{' '}
        {error.retryAfter ?? 30} seconds.
      </Alert>
    );
  }
  if (error.code === 'PREFLIGHT_FAILED') {
    return (
      <Alert tone="danger" title="Fix these before scheduling">
        <FindingsList findings={error.findings} />
      </Alert>
    );
  }
  if (error.code === 'version_conflict') {
    return <Alert tone="warning" title="Changed by someone else">The campaign changed while this dialog was open. Close it to see the latest version.</Alert>;
  }
  return (
    <Alert tone="danger">
      {error.message}
      {error.requestId && <span className="mt-1 block text-xs">Reference: {error.requestId}</span>}
    </Alert>
  );
}

function RescheduleDialog({ campaign, onClose, onDone }: { campaign: CampaignView; onClose: () => void; onDone: (v?: CampaignView) => Promise<void> }) {
  const { path } = useWorkspaceApi();
  const toast = useToast();
  const tz0 = campaign.draft.schedule.timezone || viewerTimeZone();
  const current = campaign.currentExecution?.sendAt;
  const [tz, setTz] = useState(tz0);
  const [local, setLocal] = useState(current ? isoToZoned(current, tz0) : '');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const sendAt = zonedToIso(local, tz);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Change the send time"
      description={current ? `Currently: ${inZone(current, tz0)}` : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!sendAt}
            onClick={async () => {
              setBusy(true);
              setFailure(null);
              try {
                const next = await http.post<CampaignView>(path(`/campaigns/${campaign.id}/reschedule`), { sendAt, timezone: tz, expectedVersion: campaign.version }, { 'idempotency-key': idempotencyKey() });
                await onDone(next);
                toast('success', 'Send time changed');
                onClose();
              } catch (err) {
                setFailure(err instanceof ApiError ? err : new ApiError(0, 'internal_error', errorMessage(err)));
              } finally {
                setBusy(false);
              }
            }}
          >
            Save time
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Date and time">{(p) => <Input {...p} type="datetime-local" value={local} onChange={(e) => setLocal(e.target.value)} />}</Field>
        <Field label="Time zone">
          {(p) => (
            <Select {...p} value={tz} onChange={(e) => setTz(e.target.value)}>
              {timeZones().map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {failure && (
          <div className="sm:col-span-2">
            <ScheduleFailure error={failure} />
          </div>
        )}
      </div>
    </Dialog>
  );
}
