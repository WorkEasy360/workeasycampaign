'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type {
  CampaignAction,
  CampaignCapabilities,
  CampaignCountsByStatus,
  CampaignListItem,
  CampaignStatus,
  CampaignView,
  ExecutionStatus,
  ExecutionSummary,
  FindingSection,
  VersionDetail,
  VersionSummary,
} from '@workeasy/shared';
import { http } from './api';
import { useWorkspaceApi } from './audience';

/**
 * Campaigns client (docs/architecture/phase-6-campaign-engine.md §6). The UI renders SERVER fields — status,
 * allowedActions / blockedActions, readiness findings, capabilities — and never computes lifecycle, permissions,
 * readiness or delivery capability itself.
 */
export const campaignKeys = {
  all: (ws: string) => ['campaigns', ws] as const,
  list: (ws: string, params: string) => ['campaigns', ws, 'list', params] as const,
  counts: (ws: string) => ['campaigns', ws, 'counts'] as const,
  capabilities: (ws: string) => ['campaigns', ws, 'capabilities'] as const,
  one: (ws: string, id: string) => ['campaigns', ws, 'one', id] as const,
  versions: (ws: string, id: string) => ['campaigns', ws, 'versions', id] as const,
  version: (ws: string, id: string, versionId: string) => ['campaigns', ws, 'version', id, versionId] as const,
  executions: (ws: string, id: string) => ['campaigns', ws, 'executions', id] as const,
};

type Page<T> = { data: T[]; nextCursor: string | null };

export function useCapabilities() {
  const { workspaceId, path } = useWorkspaceApi();
  return useQuery({
    queryKey: campaignKeys.capabilities(workspaceId!),
    queryFn: () => http.get<CampaignCapabilities>(path('/campaigns/capabilities')),
    enabled: !!workspaceId,
    staleTime: 5 * 60_000,
  });
}

export function useCampaignCounts() {
  const { workspaceId, path } = useWorkspaceApi();
  return useQuery({ queryKey: campaignKeys.counts(workspaceId!), queryFn: () => http.get<CampaignCountsByStatus>(path('/campaigns/counts')), enabled: !!workspaceId });
}

export function useCampaignList(params: URLSearchParams) {
  const { workspaceId, path } = useWorkspaceApi();
  const qs = params.toString();
  return useInfiniteQuery({
    queryKey: campaignKeys.list(workspaceId!, qs),
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) =>
      http.get<Page<CampaignListItem>>(path(`/campaigns?limit=25${qs ? `&${qs}` : ''}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`), signal),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!workspaceId,
  });
}

/** Statuses whose execution changes server-side without user action: poll every 5 s (architecture §6). */
const LIVE: CampaignStatus[] = ['scheduled', 'sending', 'paused'];

export function useCampaign(id: string) {
  const { workspaceId, path } = useWorkspaceApi();
  return useQuery({
    queryKey: campaignKeys.one(workspaceId!, id),
    queryFn: ({ signal }) => http.get<CampaignView>(path(`/campaigns/${id}`), signal),
    enabled: !!workspaceId && !!id,
    retry: false,
    refetchInterval: (q) => (q.state.data && LIVE.includes(q.state.data.status) ? 5_000 : false),
  });
}

export function useVersions(id: string) {
  const { workspaceId, path } = useWorkspaceApi();
  return useQuery({ queryKey: campaignKeys.versions(workspaceId!, id), queryFn: () => http.get<Page<VersionSummary>>(path(`/campaigns/${id}/versions?limit=50`)), enabled: !!workspaceId });
}

export function useVersion(id: string, versionId: string | null) {
  const { workspaceId, path } = useWorkspaceApi();
  return useQuery({
    queryKey: campaignKeys.version(workspaceId!, id, versionId ?? ''),
    queryFn: () => http.get<VersionDetail>(path(`/campaigns/${id}/versions/${versionId}`)),
    enabled: !!workspaceId && !!versionId,
  });
}

export function useExecutions(id: string, live: boolean) {
  const { workspaceId, path } = useWorkspaceApi();
  return useQuery({
    queryKey: campaignKeys.executions(workspaceId!, id),
    queryFn: () => http.get<Page<ExecutionSummary>>(path(`/campaigns/${id}/executions?limit=20`)),
    enabled: !!workspaceId,
    refetchInterval: live ? 5_000 : false,
  });
}

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export const STATUS: Record<CampaignStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  scheduled: { label: 'Scheduled', tone: 'accent' },
  sending: { label: 'Sending', tone: 'warning' },
  paused: { label: 'Paused', tone: 'warning' },
  completed: { label: 'Sent', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
};

export const EXECUTION_STATUS: Record<ExecutionStatus, { label: string; tone: Tone }> = {
  pending: { label: 'Waiting to start', tone: 'accent' },
  materializing: { label: 'Preparing recipients', tone: 'warning' },
  delivering: { label: 'Sending', tone: 'warning' },
  paused: { label: 'Paused', tone: 'warning' },
  completed: { label: 'Completed', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
};

export const ACTION_LABEL: Record<CampaignAction, string> = {
  update: 'Edit',
  schedule: 'Schedule',
  send_now: 'Send now',
  reschedule: 'Reschedule',
  unschedule: 'Unschedule',
  pause: 'Pause',
  resume: 'Resume',
  cancel: 'Cancel campaign',
  return_to_draft: 'Return to draft',
  clone: 'Duplicate',
  delete: 'Delete',
  restore: 'Restore',
};

/** Server reason codes for blocked actions (domain actions.ts) → user-facing explanation. */
export const BLOCKED_REASON: Record<string, string> = {
  PERMISSION_DENIED: 'Your role in this workspace can’t do this.',
  DELIVERY_NOT_AVAILABLE: 'Sending is not available yet.',
  READINESS_ERRORS: 'Fix the problems listed in the review first.',
};
export const blockedReason = (code: string) => BLOCKED_REASON[code] ?? 'Not possible right now.';

export const SECTION_LABEL: Record<FindingSection, string> = {
  details: 'Details',
  channel: 'Channel',
  topic: 'Topic',
  audience: 'Audience',
  sender: 'Sender',
  message: 'Message',
  schedule: 'Schedule',
  delivery: 'Delivery',
};

/** Human labels for eligibility / skip reason codes shown as counts (never per-contact data). */
export const REASON_LABEL: Record<string, string> = {
  CONSENT_MISSING: 'No consent',
  CONSENT_WITHDRAWN: 'Consent withdrawn',
  CONSENT_PENDING: 'Consent pending',
  CONSENT_EXPIRED: 'Consent expired',
  CONSENT_ADDRESS_CHANGED: 'Address changed since consent',
  SUPPRESSED: 'Do not contact',
  UNSUBSCRIBED: 'Unsubscribed',
  TOPIC_UNSUBSCRIBED: 'Unsubscribed from topic',
  TOPIC_NOT_SUBSCRIBED: 'Not subscribed to topic',
  CONTACT_DELETED: 'Contact deleted',
  NO_ADDRESS: 'No email address',
  ADDRESS_INVALID: 'Invalid address',
};
export const reasonLabel = (code: string) => REASON_LABEL[code] ?? code.replace(/_/g, ' ').toLowerCase();

/** IANA time zones supported by this browser (falls back to UTC). */
export function timeZones(): string[] {
  try {
    const zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone');
    return zones?.length ? (zones.includes('UTC') ? zones : ['UTC', ...zones]) : ['UTC'];
  } catch {
    return ['UTC'];
  }
}
export const viewerTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** An instant shown in a given IANA zone, e.g. "12 Oct 2026, 09:30 (Europe/London)". */
export function inZone(iso: string, tz: string): string {
  try {
    return `${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(new Date(iso))} (${tz})`;
  } catch {
    return new Date(iso).toISOString();
  }
}

/**
 * The UTC instant for a wall-clock "YYYY-MM-DDTHH:mm" in an IANA zone (DST-safe via two passes), as an ISO string with
 * an explicit offset — what the API requires.
 */
export function zonedToIso(local: string, tz: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number) as unknown as number[];
  const wanted = Date.UTC(y!, mo! - 1, d!, h!, mi!);
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        .formatToParts(new Date(guess))
        .map((p) => [p.type, p.value]),
    );
    const shown = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    guess += wanted - shown;
  }
  return new Date(guess).toISOString();
}

/** "YYYY-MM-DDTHH:mm" wall clock of an instant in a zone (for <input type="datetime-local">). */
export function isoToZoned(iso: string, tz: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
