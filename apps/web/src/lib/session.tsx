'use client';

import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CurrentContext, Permission, SessionUser } from '@workeasy/shared';
import { createContext, type ReactNode, useCallback, useContext, useState } from 'react';
import { ApiError, http } from './api';

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: true,
            retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

export const keys = {
  session: ['session'] as const,
  context: ['context'] as const,
  organizations: ['organizations'] as const,
  workspaces: (orgId: string) => ['workspaces', orgId] as const,
  members: (orgId: string) => ['members', orgId] as const,
  workspaceMembers: (wsId: string) => ['workspace-members', wsId] as const,
  invitations: (orgId: string) => ['invitations', orgId] as const,
  roles: (orgId: string) => ['roles', orgId] as const,
  audit: (orgId: string, filter: string) => ['audit', orgId, filter] as const,
  sessions: ['sessions'] as const,
  securityEvents: ['security-events'] as const,
  permissions: ['permissions'] as const,
};

export function useSession() {
  return useQuery({
    queryKey: keys.session,
    queryFn: () => http.get<{ user: SessionUser | null }>('/v1/auth/session'),
  });
}

export function useCurrentContext(enabled = true) {
  return useQuery({
    queryKey: keys.context,
    queryFn: () => http.get<CurrentContext>('/v1/me/context'),
    enabled,
  });
}

/** Clears every cached query (sign-in, sign-out, organization/workspace switch). */
export function useResetCache() {
  const qc = useQueryClient();
  return useCallback(() => qc.resetQueries(), [qc]);
}

const ContextCtx = createContext<CurrentContext | null>(null);
export const ContextProvider = ContextCtx.Provider;

/** Current context, or null outside the app shell / before an organization exists. */
export function useOptionalAppContext(): CurrentContext | null {
  return useContext(ContextCtx);
}

/** The current organization/workspace context. Only usable inside the authenticated app shell. */
export function useAppContext(): CurrentContext & { orgId: string; workspaceId: string | null } {
  const ctx = useContext(ContextCtx);
  if (!ctx?.organization) throw new Error('useAppContext must be used inside the app shell with an organization');
  return { ...ctx, orgId: ctx.organization.id, workspaceId: ctx.workspace?.id ?? null };
}

/**
 * UI hint only: hides or disables controls the user cannot use. The API re-checks every request, so a stale or
 * tampered hint can at worst show a control that then fails with 403.
 */
export function useCan() {
  const ctx = useContext(ContextCtx);
  return useCallback((p: Permission) => !!ctx?.permissions.includes(p), [ctx]);
}
