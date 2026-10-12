import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { contactSummary, EDITOR, json, mockApi, renderAudience, VIEWER } from '@/test/audience';
import ContactsPage from './page';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/contacts',
}));

const LIST = { id: '22222222-2222-4222-8222-222222222222', name: 'Newsletter', description: '', status: 'active', memberCount: 0, createdAt: '', updatedAt: '', version: 1 };

function api(extra: Parameters<typeof mockApi>[0] = {}) {
  return mockApi({
    'GET /contacts': () => json(200, { data: [contactSummary('c1', 'Asha'), contactSummary('c2', 'Ravi', { suppressed: true })], nextCursor: null, searchTruncated: false }),
    'GET /contacts/count': () => json(200, { count: 2 }),
    'GET /lists': () => json(200, { data: [LIST], nextCursor: null }),
    ...extra,
  });
}

describe('contacts page', () => {
  it('lists contacts from the API with their status', async () => {
    api();
    renderAudience(<ContactsPage />, EDITOR);
    const table = await screen.findByRole('table', { name: 'Contacts' });
    expect(within(table).getByText('Asha')).toBeInTheDocument();
    expect(within(table).getByText('asha@example.com')).toBeInTheDocument();
    expect(within(table).getByText('Do not contact')).toBeInTheDocument();
  });

  it('sends filters to the API as query parameters', async () => {
    const calls = api();
    renderAudience(<ContactsPage />, EDITOR);
    await screen.findByText('Asha');
    await userEvent.selectOptions(screen.getByLabelText('Filter by subscription'), 'marketing');
    await waitFor(() => expect(calls.some((c) => c.url.includes('/contacts?') && c.url.includes('subscriptionType=marketing'))).toBe(true));
  });

  it('debounces search and ignores single characters', async () => {
    const calls = api();
    renderAudience(<ContactsPage />, EDITOR);
    await screen.findByText('Asha');
    await userEvent.type(screen.getByPlaceholderText('Search name, email or phone'), 'a', { delay: null });
    await new Promise((r) => setTimeout(r, 400));
    expect(calls.some((c) => c.url.includes('q='))).toBe(false);
    await userEvent.type(screen.getByPlaceholderText('Search name, email or phone'), 'sh', { delay: null });
    await waitFor(() => expect(calls.some((c) => c.url.includes('q=ash'))).toBe(true));
  });

  it('runs a bulk action on the selected contacts with an idempotency key', async () => {
    const calls = api({ 'POST /contacts/bulk': () => json(200, { matched: 1, affected: 1, skipped: 0, truncated: false }) });
    renderAudience(<ContactsPage />, EDITOR);
    await userEvent.click(await screen.findByLabelText('Select Asha'));
    const bar = screen.getByRole('region', { name: 'Bulk actions' });
    await userEvent.selectOptions(within(bar).getByLabelText('Bulk action'), 'add_to_list');
    const dialog = await screen.findByRole('dialog');
    await userEvent.selectOptions(within(dialog).getByLabelText('List'), LIST.id);
    await userEvent.click(within(dialog).getByRole('button', { name: /add to list/i }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/contacts/bulk'))).toBeTruthy());
    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/contacts/bulk'))!;
    expect(post.body).toEqual({ action: 'add_to_list', selection: { contactIds: ['c1'] }, listId: LIST.id });
    expect(post.headers['idempotency-key']).toMatch(/^web-/);
  });

  it('hides create, import and bulk actions from a viewer', async () => {
    api();
    renderAudience(<ContactsPage />, VIEWER);
    await screen.findByText('Asha');
    expect(screen.queryByRole('button', { name: /new contact/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /import/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Select Asha'));
    expect(screen.queryByRole('region', { name: 'Bulk actions' })).not.toBeInTheDocument();
  });

  it('shows server field errors in the create dialog', async () => {
    api({
      'POST /contacts': () =>
        json(409, { error: { code: 'conflict', message: 'Another contact already uses this email', fields: { email: ['Already used by another contact'] }, requestId: 'r' } }),
    });
    renderAudience(<ContactsPage />, EDITOR);
    await userEvent.click(await screen.findByRole('button', { name: /new contact/i }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Email'), 'asha@example.com', { delay: null });
    await userEvent.click(within(dialog).getByRole('button', { name: /create/i }));
    expect(await within(dialog).findByText('Already used by another contact')).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});
