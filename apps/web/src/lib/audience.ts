'use client';

import { useQuery } from '@tanstack/react-query';
import type { CustomFieldView, ImportStatus, ListView, TagView, TopicView } from '@workeasy/shared';
import { http } from './api';
import { useAppContext } from './session';

/** All audience data is workspace-scoped: every call goes through /v1/workspaces/{current}/… */
export function useWorkspaceApi() {
  const { workspaceId } = useAppContext();
  const base = `/v1/workspaces/${workspaceId}`;
  return { workspaceId, path: (p: string) => `${base}${p}` };
}

export const audienceKeys = {
  contacts: (ws: string, params: string) => ['contacts', ws, params] as const,
  contactCount: (ws: string, params: string) => ['contact-count', ws, params] as const,
  contact: (ws: string, id: string) => ['contact', ws, id] as const,
  contactAll: (ws: string) => ['contact', ws] as const,
  timeline: (ws: string, id: string) => ['timeline', ws, id] as const,
  consentHistory: (ws: string, id: string) => ['consent-history', ws, id] as const,
  lists: (ws: string) => ['lists', ws] as const,
  tags: (ws: string) => ['tags', ws] as const,
  topics: (ws: string) => ['topics', ws] as const,
  fields: (ws: string) => ['custom-fields', ws] as const,
  suppressions: (ws: string, status: string) => ['suppressions', ws, status] as const,
  retention: (ws: string) => ['retention', ws] as const,
  imports: (ws: string) => ['imports', ws] as const,
  importOne: (ws: string, id: string) => ['import', ws, id] as const,
};

export function useLists() {
  const { workspaceId, path } = useWorkspaceApi();
  return useQuery({
    queryKey: audienceKeys.lists(workspaceId!),
    queryFn: () => http.get<{ data: ListView[]; nextCursor: string | null }>(path('/lists?status=all&limit=100')),
    enabled: !!workspaceId,
  });
}

export function useTags() {
  const { workspaceId, path } = useWorkspaceApi();
  return useQuery({ queryKey: audienceKeys.tags(workspaceId!), queryFn: () => http.get<{ data: TagView[] }>(path('/tags')), enabled: !!workspaceId });
}

export function useTopics() {
  const { workspaceId, path } = useWorkspaceApi();
  return useQuery({ queryKey: audienceKeys.topics(workspaceId!), queryFn: () => http.get<{ data: TopicView[] }>(path('/topics')), enabled: !!workspaceId });
}

export function useCustomFields(enabled = true) {
  const { workspaceId, path } = useWorkspaceApi();
  return useQuery({
    queryKey: audienceKeys.fields(workspaceId!),
    queryFn: () => http.get<{ data: CustomFieldView[] }>(path('/custom-fields')),
    enabled: !!workspaceId && enabled,
  });
}

export const SUBSCRIPTION_LABEL = { marketing: 'Marketing', non_marketing: 'Non-marketing', unsubscribed: 'Unsubscribed' } as const;
export const CHANNEL_LABEL = { email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp', all: 'All channels' } as const;
export const TAG_SWATCH: Record<string, string> = {
  slate: 'bg-slate-400',
  red: 'bg-red-500',
  orange: 'bg-orange-500',
  amber: 'bg-amber-500',
  green: 'bg-green-600',
  teal: 'bg-teal-500',
  blue: 'bg-blue-500',
  indigo: 'bg-indigo-500',
  violet: 'bg-violet-500',
  pink: 'bg-pink-500',
};

export const IMPORT_STATUS: Record<ImportStatus, { label: string; tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' }> = {
  uploaded: { label: 'Needs mapping', tone: 'neutral' },
  validated: { label: 'Ready to import', tone: 'accent' },
  processing: { label: 'Importing', tone: 'warning' },
  completed: { label: 'Completed', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};
