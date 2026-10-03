import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EDITOR, json, mockApi, renderAudience } from '@/test/audience';
import ImportDetailPage from './page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ importId: 'imp1' }),
  usePathname: () => '/imports/imp1',
}));

const base = {
  id: 'imp1',
  status: 'uploaded',
  fileName: 'leads.csv',
  fileSize: 2048,
  headers: ['Email', 'First', 'Notes'],
  mapping: {},
  options: {},
  totalRows: 3,
  processedRows: 0,
  counts: { created: 0, updated: 0, skipped: 0, errors: 0 },
  dryRun: null,
  failureReason: null,
  createdAt: '2026-10-03T08:00:00.000Z',
  startedAt: null,
  completedAt: null,
  version: 1,
};

const preview = {
  headers: ['Email', 'First', 'Notes'],
  rows: [['a@example.com', 'Asha', '=cmd'], ['bad', 'Ravi', ''], ['a@example.com', 'Dup', '']],
  suggestedMapping: { '0': 'email', '1': 'first_name', '2': 'ignore' },
};

describe('import detail', () => {
  it('maps columns, runs a dry run, and only then allows starting the import', async () => {
    let state: Record<string, unknown> = base;
    const calls = mockApi({
      'GET /imports/imp1': () => json(200, state),
      'GET /imports/imp1/preview': () => json(200, preview),
      'PUT /imports/imp1/mapping': () => json(200, { ...base, version: 2 }),
      'POST /imports/imp1/dry-run': () => {
        state = { ...base, status: 'validated', version: 3, dryRun: { total: 3, create: 1, update: 0, skip: 1, error: 1 } };
        return json(200, state);
      },
      'GET /imports/imp1/issues': () => json(200, { data: [{ rowNumber: 3, column: 'Email', code: 'INVALID_EMAIL', message: 'Not a valid email address', severity: 'error' }], nextCursor: null }),
      'POST /imports/imp1/start': () => json(202, { ...state, status: 'processing' }),
    });
    renderAudience(<ImportDetailPage />, EDITOR);
    expect(await screen.findByLabelText('Import Email as')).toHaveValue('email');
    expect(screen.queryByRole('button', { name: /^import \d/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Check file' }));
    expect(await screen.findByText('Will create')).toBeInTheDocument();
    expect(await screen.findByText('Not a valid email address')).toBeInTheDocument();
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body).toMatchObject({ mapping: { '0': 'email', '1': 'first_name' }, version: 1 });
    expect((put.body as { options: Record<string, unknown> }).options.consent).toBeUndefined();

    await userEvent.click(screen.getByRole('button', { name: 'Import 1 contacts' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/start'))?.headers['idempotency-key']).toMatch(/^web-/));
  });

  it('requires an identity column before checking', async () => {
    mockApi({
      'GET /imports/imp1': () => json(200, base),
      'GET /imports/imp1/preview': () => json(200, { ...preview, suggestedMapping: { '0': 'ignore', '1': 'first_name', '2': 'ignore' } }),
    });
    renderAudience(<ImportDetailPage />, EDITOR);
    expect(await screen.findByText(/map an email, phone or whatsapp column/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check file' })).toBeDisabled();
  });

  it('shows progress and offers retry after a failure', async () => {
    const calls = mockApi({
      'GET /imports/imp1': () => json(200, { ...base, status: 'failed', processedRows: 2, failureReason: 'Database unavailable', counts: { created: 2, updated: 0, skipped: 0, errors: 0 } }),
      'POST /imports/imp1/retry': () => json(202, { ...base, status: 'processing', processedRows: 2 }),
    });
    renderAudience(<ImportDetailPage />, EDITOR);
    expect(await screen.findByRole('progressbar', { name: 'Import progress' })).toHaveAttribute('aria-valuenow', '67');
    expect(screen.getByText(/Database unavailable/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/retry'))).toBe(true));
  });
});
