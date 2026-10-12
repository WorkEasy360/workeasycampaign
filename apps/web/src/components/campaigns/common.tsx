'use client';

import type { CampaignStatus, ExecutionStatus } from '@workeasy/shared';
import { Lock, Send } from 'lucide-react';
import { forwardRef, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { RequireWorkspace } from '@/components/audience-shell';
import { Alert, Badge, EmptyState } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { EXECUTION_STATUS, STATUS, useCapabilities } from '@/lib/campaigns';
import { cx } from '@/lib/format';
import { errorMessage } from '@/lib/forms';
import { useCan } from '@/lib/session';

/** Campaign screens need a workspace and `campaigns.read` (a hint: the API enforces it). */
export function CampaignsPage({ children }: { children: ReactNode }) {
  const can = useCan();
  return (
    <RequireWorkspace>
      {can('campaigns.read') ? (
        <>
          <CapabilityBanner />
          {children}
        </>
      ) : (
        <EmptyState icon={<Lock className="size-8" />} title="You can’t view campaigns">
          Your role in this workspace does not include access to campaigns. Ask a workspace admin if you need it.
        </EmptyState>
      )}
    </RequireWorkspace>
  );
}

/**
 * Architecture §6: while sending is not available, every campaign screen says so; send controls stay visible but
 * disabled with the server's reason. In test mode the banner says that nothing leaves the system; live mode has none.
 */
export function CapabilityBanner() {
  const caps = useCapabilities();
  if (!caps.data) return null;
  if (caps.data.deliveryMode === 'disabled') {
    return (
      <div className="mb-6">
        <Alert tone="info" title="Sending is not available yet">
          You can prepare and review campaigns. Scheduling and sending become available when delivery is enabled for your organization.
        </Alert>
      </div>
    );
  }
  // Live delivery: emails reach real inboxes; there is nothing to warn about (never claim a test mode that is not).
  if (caps.data.deliveryMode === 'live') return null;
  return (
    <div className="mb-6">
      <Alert tone="warning" title="Test delivery mode">
        Campaigns run end to end, but no email leaves the system: messages are accepted by a test delivery service.
      </Alert>
    </div>
  );
}

export function StatusBadge({ status }: { status: CampaignStatus }) {
  const s = STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function ExecutionBadge({ status }: { status: ExecutionStatus }) {
  const s = EXECUTION_STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** Safe error message plus the request id (for support), never internal details. */
/** A failed load or action, with the server's request id (for support) and, for loads, a retry. */
export function ErrorAlert({ error, title, onRetry }: { error: unknown; title?: string; onRetry?: () => void }) {
  const requestId = error instanceof ApiError ? error.requestId : undefined;
  return (
    <Alert tone="danger" title={title}>
      {errorMessage(error)}
      {requestId && <span className="mt-1 block text-xs">Reference: {requestId}</span>}
      {onRetry && (
        <button type="button" onClick={onRetry} className="mt-2 block text-sm font-medium underline">
          Try again
        </button>
      )}
    </Alert>
  );
}

const control =
  'w-full rounded-control border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:bg-surface-muted aria-invalid:border-danger';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(control, 'min-h-32', className)} {...rest} />;
});

/** "12 / 200" counter announced politely; turns red past the soft limit. */
export function Counter({ value, soft, id }: { value: number; soft: number; id?: string }) {
  return (
    <span id={id} className={cx('text-xs tabular-nums', value > soft ? 'text-danger' : 'text-ink-faint')}>
      {value.toLocaleString()} / {soft.toLocaleString()}
    </span>
  );
}

export const SendIcon = () => <Send className="size-4" aria-hidden />;
