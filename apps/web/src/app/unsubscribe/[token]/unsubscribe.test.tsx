import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { json, mockApi, renderAudience } from '@/test/audience';
import UnsubscribePage from './page';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/unsubscribe/t', useParams: () => ({ token: 'u1.tok.mac' }) }));

/** Public unsubscribe page (Phase 7.8): opening changes nothing; a button confirms; invalid links explain themselves. */
describe('unsubscribe page', () => {
  const info = { organization: 'Acme', workspace: 'Main', topicScoped: true };
  // The API paths of this page are not workspace-scoped: match them absolutely.
  const routes = (post?: () => Response) => {
    const calls: { method: string; url: string; body: unknown }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      if (url.endsWith('/v1/auth/csrf')) return json(200, { csrfToken: 't' });
      if (url.endsWith('/v1/unsubscribe/u1.tok.mac') && method === 'GET') return json(200, info);
      if (url.endsWith('/v1/unsubscribe/u1.tok.mac') && method === 'POST' && post) return post();
      return json(404, { error: { code: 'not_found', message: 'Unsubscribe link not found', requestId: 'r' } });
    });
    return calls;
  };

  it('shows the choice without changing anything; confirming the topic unsubscribe posts it and confirms', async () => {
    const calls = routes(() => json(200, { unsubscribed: true, scope: 'topic', changed: true }));
    renderAudience(<UnsubscribePage />, []);
    expect(await screen.findByRole('heading', { name: 'Unsubscribe' })).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/unsubscribe/'))).toBe(false); // opening changes nothing
    await userEvent.click(screen.getByRole('button', { name: 'Unsubscribe from emails like this one' }));
    expect(await screen.findByRole('heading', { name: 'You are unsubscribed' })).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST' && c.url.includes('/unsubscribe/'))!.body).toEqual({ scope: 'topic' });
  });

  it('“all marketing email” sends scope all', async () => {
    const calls = routes(() => json(200, { unsubscribed: true, scope: 'all', changed: true }));
    renderAudience(<UnsubscribePage />, []);
    await userEvent.click(await screen.findByRole('button', { name: 'Unsubscribe from all marketing email' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url.includes('/unsubscribe/'))!.body).toEqual({ scope: 'all' }));
    expect(await screen.findByText(/no longer send you marketing email/)).toBeInTheDocument();
  });

  it('an invalid link says so (no raw error, no retry loop)', async () => {
    mockApi({});
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json(404, { error: { code: 'not_found', message: 'Unsubscribe link not found', requestId: 'r' } }));
    renderAudience(<UnsubscribePage />, []);
    expect(await screen.findByRole('heading', { name: 'This link is not valid' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('a failed submit keeps the choice available and explains it', async () => {
    routes(() => json(429, { error: { code: 'rate_limited', message: 'Too many requests', requestId: 'r' } }));
    renderAudience(<UnsubscribePage />, []);
    await userEvent.click(await screen.findByRole('button', { name: 'Unsubscribe from emails like this one' }));
    expect(await screen.findByText(/Your choice was not saved/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unsubscribe from emails like this one' })).toBeEnabled();
  });
});
