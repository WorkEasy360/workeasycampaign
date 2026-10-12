import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EDITOR, json, mockApi, renderAudience, VIEWER } from '@/test/audience';
import CustomFieldsPage from './fields/page';
import ListsPage from './lists/page';
import TopicsPage from './topics/page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/audience',
}));

const field = (over: Record<string, unknown>) => ({
  id: 'f1',
  key: 'city',
  label: 'City',
  description: '',
  type: 'text',
  required: false,
  options: [],
  validation: {},
  position: 0,
  status: 'active',
  keyLocked: false,
  version: 1,
  ...over,
});

describe('custom fields page', () => {
  it('derives the key from the label and validates with the shared schema before calling the API', async () => {
    const calls = mockApi({ 'POST /custom-fields': () => json(201, field({ id: 'f2', key: 'customer_since', label: 'Customer since' })) });
    renderAudience(<CustomFieldsPage />, EDITOR);
    await userEvent.click(await screen.findByRole('button', { name: 'Add a field' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create field' }));
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await userEvent.type(within(dialog).getByLabelText('Label'), 'Customer since', { delay: null });
    expect(within(dialog).getByLabelText('Key')).toHaveValue('customer_since');
    await userEvent.selectOptions(within(dialog).getByLabelText('Type'), 'date');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create field' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ key: 'customer_since', label: 'Customer since', type: 'date' }));
  });

  it('locks key and type once a field holds data, and offers archive instead of delete', async () => {
    mockApi({ 'GET /custom-fields': () => json(200, { data: [field({ keyLocked: true })] }) });
    renderAudience(<CustomFieldsPage />, EDITOR);
    const row = (await screen.findByText('City')).closest('tr')!;
    expect(within(row).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Archive' })).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Key')).toBeDisabled();
    expect(within(dialog).getByLabelText('Type')).toBeDisabled();
  });

  it('shows fields read-only to someone without custom_fields.manage', async () => {
    mockApi({ 'GET /custom-fields': () => json(200, { data: [field({})] }) });
    renderAudience(<CustomFieldsPage />, VIEWER);
    await screen.findByText('City');
    expect(screen.queryByRole('button', { name: /new field/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });
});

describe('lists page', () => {
  it('creates a list and hides management from viewers', async () => {
    const calls = mockApi({ 'POST /lists': () => json(201, {}) });
    const { unmount } = renderAudience(<ListsPage />, EDITOR);
    await userEvent.click(await screen.findByRole('button', { name: 'New list' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Expo visitors', { delay: null });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create list' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'Expo visitors', description: '' }));
    unmount();
    renderAudience(<ListsPage />, VIEWER);
    await screen.findByText('No lists yet');
    expect(screen.queryByRole('button', { name: /list/i })).not.toBeInTheDocument();
  });
});

describe('topics page', () => {
  it('groups topics under categories and never offers to archive the default topic', async () => {
    mockApi({
      'GET /topics': () =>
        json(200, {
          data: [
            { id: 'cat', key: 'news', name: 'News', description: '', kind: 'category', parentId: null, status: 'active', isDefault: false, subscriberCount: 0, version: 1 },
            { id: 't1', key: 'marketing', name: 'Marketing', description: '', kind: 'topic', parentId: null, status: 'active', isDefault: true, subscriberCount: 4, version: 1 },
            { id: 't2', key: 'launches', name: 'Launches', description: '', kind: 'topic', parentId: 'cat', status: 'active', isDefault: false, subscriberCount: 1, version: 1 },
          ],
        }),
    });
    renderAudience(<TopicsPage />, EDITOR);
    const news = await screen.findByRole('region', { name: 'News' });
    expect(within(news).getByText('Launches')).toBeInTheDocument();
    const def = screen.getByText('Marketing').closest('li')!;
    expect(within(def).getByText('Default')).toBeInTheDocument();
    expect(within(def).queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
    expect(within(screen.getByText('Launches').closest('li')!).getByRole('button', { name: 'Archive' })).toBeInTheDocument();
  });
});
