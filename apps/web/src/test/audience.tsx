import { render } from '@testing-library/react';
import type { CurrentContext, Permission } from '@workeasy/shared';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { ToastProvider } from '@/components/ui';
import { ContextProvider, Providers } from '@/lib/session';

export const WS = '11111111-1111-4111-8111-111111111111';

export const VIEWER: Permission[] = ['contacts.read', 'lists.read', 'tags.read', 'topics.read', 'consent.read', 'suppression.read'];
export const EDITOR: Permission[] = [
  ...VIEWER,
  'contacts.create',
  'contacts.update',
  'contacts.delete',
  'contacts.import',
  'lists.manage',
  'tags.manage',
  'topics.manage',
  'consent.manage',
  'custom_fields.manage',
  'suppression.manage',
];

export const json = (status: number, body: unknown) =>
  status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export interface Call {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

/**
 * Routes fetch calls by "METHOD /path-suffix" (path after /v1/workspaces/{ws}). Unmatched GETs return an empty page,
 * so pages render; unmatched writes fail loudly. Every call is recorded for assertions.
 */
export function mockApi(routes: Record<string, (call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  document.cookie = 'wk_csrf=t; path=/';
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : init?.body;
    const call = { method, url, body, headers };
    calls.push(call);
    const rel = url.replace(`/api/v1/workspaces/${WS}`, '').split('?')[0]!;
    const handler = routes[`${method} ${rel}`];
    if (handler) return handler(call);
    if (method === 'GET') return json(200, { data: [], nextCursor: null });
    return json(500, { error: { code: 'internal_error', message: `unmocked ${method} ${rel}`, requestId: 'r' } });
  });
  return calls;
}

export function renderAudience(ui: ReactNode, permissions: Permission[]) {
  const ctx: CurrentContext = {
    user: { id: 'u1', email: 'sam@example.com', displayName: 'Sam', emailVerified: true },
    organization: { id: 'o1', name: 'Acme', slug: 'acme' },
    workspace: { id: WS, name: 'Main', slug: 'main', status: 'active' },
    permissions,
  };
  return render(
    <Providers>
      <ToastProvider>
        <ContextProvider value={ctx}>{ui}</ContextProvider>
      </ToastProvider>
    </Providers>,
  );
}

export const contactSummary = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  firstName: name,
  lastName: null,
  displayName: name,
  email: `${name.toLowerCase()}@example.com`,
  phone: null,
  company: null,
  subscriptionType: 'marketing',
  suppressed: false,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  deletedAt: null,
  ...extra,
});
