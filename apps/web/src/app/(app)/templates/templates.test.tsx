import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Interaction-heavy tests: type without a timer tick per keystroke (same events, same order); the default delay made
// them CPU-bound near the 5 s budget under load.
const user = userEvent.setup({ delay: null });
import type { Permission } from '@workeasy/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { json, mockApi, renderAudience } from '@/test/audience';
import { CAMPAIGN_VIEWER } from '@/test/campaigns';
import TemplatePage from './[templateId]/page';
import TemplatesPage from './page';

const push = vi.fn();
const replace = vi.fn();
let params: { templateId: string } = { templateId: 'new' };
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace }),
  usePathname: () => '/templates',
  useParams: () => params,
}));

const READER: Permission[] = [...CAMPAIGN_VIEWER, 'templates.read'];
const MANAGER: Permission[] = [...READER, 'templates.manage'];
const item = { id: 't1', name: 'Monthly', description: 'Newsletter', category: 'Newsletters', subject: 'News', blockCount: 2, version: 3, updatedAt: '2026-10-08T09:00:00.000Z' };
const view = {
  id: 't1',
  name: 'Monthly',
  description: 'Newsletter',
  category: 'Newsletters',
  content: { schema: 'email.content.v2', subject: 'News', preheader: '', body: { format: 'blocks', blocks: [{ id: 'p1', type: 'paragraph', runs: [{ text: 'Hello' }] }] } },
  version: 3,
  createdAt: '2026-10-07T09:00:00.000Z',
  updatedAt: '2026-10-08T09:00:00.000Z',
  createdBy: { id: 'u1', displayName: 'Sam' },
};

beforeEach(() => {
  push.mockReset();
  replace.mockReset();
});

describe('templates list', () => {
  it('lists templates; managers can create and delete (with confirmation)', async () => {
    let deleted = false;
    const calls = mockApi({
      'GET /templates': () => json(200, { data: deleted ? [] : [item], nextCursor: null }),
      'DELETE /templates/t1': () => {
        deleted = true;
        return new Response(null, { status: 204 });
      },
    });
    renderAudience(<TemplatesPage />, MANAGER);
    const table = await screen.findByRole('table', { name: 'Templates' });
    expect(within(table).getByRole('link', { name: 'Monthly' })).toHaveAttribute('href', '/templates/t1');
    await user.click(screen.getByRole('button', { name: 'New template' }));
    expect(push).toHaveBeenCalledWith('/templates/new');
    await user.click(screen.getByRole('button', { name: 'Delete template Monthly' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Delete “Monthly”?' })).getByRole('button', { name: 'Delete template' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/templates/t1'))).toBe(true));
    expect(await screen.findByText('No templates yet')).toBeInTheDocument();
  });

  it('readers see the list without create or delete; without templates.read the page explains', async () => {
    mockApi({ 'GET /templates': () => json(200, { data: [item], nextCursor: null }) });
    const { unmount } = renderAudience(<TemplatesPage />, READER);
    await screen.findByRole('table', { name: 'Templates' });
    expect(screen.queryByRole('button', { name: 'New template' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete template/ })).toBeNull();
    unmount();
    renderAudience(<TemplatesPage />, CAMPAIGN_VIEWER);
    expect(await screen.findByText('You can’t view templates')).toBeInTheDocument();
  });
});

describe('template editor', () => {
  it('creates a template from blocks and opens it', async () => {
    params = { templateId: 'new' };
    const calls = mockApi({ 'POST /templates': () => json(201, view) });
    renderAudience(<TemplatePage />, MANAGER);
    await user.type(await screen.findByLabelText('Name'), 'Monthly');
    await user.type(screen.getByLabelText('Subject'), 'News');
    await user.click(screen.getByRole('button', { name: 'Add text' }));
    await user.type(screen.getByLabelText('Text'), 'Hello');
    await user.click(screen.getByRole('button', { name: 'Create template' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/templates/t1'));
    const body = calls.find((c) => c.method === 'POST')!.body as { name: string; content: { subject: string; body: { blocks: { runs: unknown[] }[] } } };
    expect(body.name).toBe('Monthly');
    expect(body.content.subject).toBe('News');
    expect(body.content.body.blocks[0]!.runs).toEqual([{ text: 'Hello' }]);
  });

  it('saves with the expected version and shows the server’s content problems', async () => {
    params = { templateId: 't1' };
    const calls = mockApi({
      'GET /templates/t1': () => json(200, view),
      'PATCH /templates/t1': () =>
        json(422, { error: { code: 'validation_failed', message: 'Fix the template content before saving it', fields: { 'content/body/blocks/0/runs/0/text': ['Unknown merge field "contact.secret".'] }, requestId: 'r' } }),
    });
    renderAudience(<TemplatePage />, MANAGER);
    const text = await screen.findByLabelText('Text');
    await user.type(text, ' {{{{ contact.secret }}'); // {{ types a literal {
    await user.click(screen.getByRole('button', { name: 'Save template' }));
    expect(await screen.findByText('Unknown merge field "contact.secret".')).toBeInTheDocument();
    expect((calls.find((c) => c.method === 'PATCH')!.body as { expectedVersion: number }).expectedVersion).toBe(3);
  });

  it('is read-only for readers; "new" needs templates.manage', async () => {
    params = { templateId: 't1' };
    mockApi({ 'GET /templates/t1': () => json(200, view) });
    const { unmount } = renderAudience(<TemplatePage />, READER);
    expect(await screen.findByText('This template is read-only for you.')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save template' })).toBeNull();
    unmount();
    params = { templateId: 'new' };
    renderAudience(<TemplatePage />, READER);
    expect(await screen.findByText('You can’t open this')).toBeInTheDocument();
  });
});

describe('template screens — error states', () => {
  it('a missing template shows "not found" with a way back (no raw error)', async () => {
    params = { templateId: '01a11850-b308-7102-9271-54fa8ea2c893' };
    mockApi({ 'GET /templates/01a11850-b308-7102-9271-54fa8ea2c893': () => json(404, { error: { code: 'not_found', message: 'Template not found', requestId: 'r1' } }) });
    renderAudience(<TemplatePage />, MANAGER);
    expect(await screen.findByText('Template not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to templates' })).toHaveAttribute('href', '/templates');
  });

  it('a failed list load can be retried', async () => {
    let calls = 0;
    mockApi({
      'GET /templates': () => {
        calls++;
        return calls === 1 ? json(403, { error: { code: 'forbidden', message: 'You do not have access', requestId: 'r2' } }) : json(200, { data: [item], nextCursor: null });
      },
    });
    renderAudience(<TemplatesPage />, MANAGER);
    expect(await screen.findByText('Templates could not be loaded')).toBeInTheDocument();
    expect(screen.getByText('Reference: r2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'Monthly' })).toBeInTheDocument();
  });
});

describe('template history and categories (7.1)', () => {
  const versions = [
    { version: 3, change: 'updated', restoredFromVersion: null, name: 'Monthly', subject: 'News', createdAt: '2026-10-08T09:00:00.000Z', createdBy: { id: 'u1', displayName: 'Sam' } },
    { version: 2, change: 'updated', restoredFromVersion: null, name: 'Monthly', subject: 'Older news', createdAt: '2026-10-07T12:00:00.000Z', createdBy: null },
    { version: 1, change: 'created', restoredFromVersion: null, name: 'Monthly', subject: 'First', createdAt: '2026-10-07T09:00:00.000Z', createdBy: { id: 'u1', displayName: 'Sam' } },
  ];

  it('shows the history; restoring asks for confirmation, sends the version and the expected version, and loads the result', async () => {
    params = { templateId: 't1' };
    const restored = { ...view, version: 4, content: { ...view.content, subject: 'First' } };
    let current: typeof view = view; // the server state: after the restore it returns version 4
    const calls = mockApi({
      'GET /templates/t1': () => json(200, current),
      'GET /templates/t1/versions': () => json(200, { data: versions, nextCursor: null }),
      'POST /templates/t1/restore': () => {
        current = restored;
        return json(200, restored);
      },
    });
    renderAudience(<TemplatePage />, MANAGER);
    const list = await screen.findByRole('list', { name: 'Template versions' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(list).getByText('Current')).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: 'Restore version 3' })).toBeNull(); // the current one
    await user.click(within(list).getByRole('button', { name: 'Restore version 1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Restore version 1?' });
    await user.click(within(dialog).getByRole('button', { name: 'Restore version' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ version: 1, expectedVersion: 3 }));
    expect(await screen.findByDisplayValue('First')).toBeInTheDocument();
  });

  it('a restore that lost a race explains it instead of failing silently', async () => {
    params = { templateId: 't1' };
    mockApi({
      'GET /templates/t1': () => json(200, view),
      'GET /templates/t1/versions': () => json(200, { data: versions, nextCursor: null }),
      'POST /templates/t1/restore': () => json(409, { error: { code: 'version_conflict', message: 'Changed', requestId: 'r' } }),
    });
    renderAudience(<TemplatePage />, MANAGER);
    await user.click(await screen.findByRole('button', { name: 'Restore version 2' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Restore version 2?' })).getByRole('button', { name: 'Restore version' }));
    expect(await screen.findByText(/changed by someone else/)).toBeInTheDocument();
  });

  it('readers see the history but cannot restore', async () => {
    params = { templateId: 't1' };
    mockApi({ 'GET /templates/t1': () => json(200, view), 'GET /templates/t1/versions': () => json(200, { data: versions, nextCursor: null }) });
    renderAudience(<TemplatePage />, READER);
    await screen.findByRole('list', { name: 'Template versions' });
    expect(screen.queryByRole('button', { name: /Restore version/ })).toBeNull();
  });

  it('the category is saved trimmed, and an empty category is sent as null', async () => {
    params = { templateId: 't1' };
    const calls = mockApi({ 'GET /templates/t1': () => json(200, view), 'PATCH /templates/t1': () => json(200, { ...view, version: 4, category: null }) });
    renderAudience(<TemplatePage />, MANAGER);
    const cat = await screen.findByLabelText('Category (optional)');
    expect(cat).toHaveValue('Newsletters');
    await user.clear(cat);
    await user.type(cat, '   ');
    await user.click(screen.getByRole('button', { name: 'Save template' }));
    await waitFor(() => expect((calls.find((c) => c.method === 'PATCH')?.body as { category: unknown }).category).toBeNull());
  });

  it('the list shows categories and filters by one', async () => {
    const calls = mockApi({
      'GET /templates': () => json(200, { data: [item], nextCursor: null }),
      'GET /template-categories': () => json(200, { data: ['Newsletters', 'Promotions'] }),
    });
    renderAudience(<TemplatesPage />, READER);
    const table = await screen.findByRole('table', { name: 'Templates' });
    expect(within(table).getByText('Newsletters')).toBeInTheDocument();
    await user.selectOptions(await screen.findByLabelText('Category'), 'Promotions');
    await waitFor(() => expect(calls.some((c) => c.method === 'GET' && c.url.includes('/templates?') && c.url.includes('category=Promotions'))).toBe(true));
  });
});
