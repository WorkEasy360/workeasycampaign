import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { contactSummary, EDITOR, json, mockApi, renderAudience, VIEWER } from '@/test/audience';
import ContactDetailPage from './page';

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace }),
  useParams: () => ({ contactId: 'c1' }),
  usePathname: () => '/contacts/c1',
}));

const detail = {
  ...contactSummary('c1', 'Asha'),
  timezone: null,
  locale: null,
  source: 'admin',
  unsubscribedBy: null,
  subscriptionChangedAt: '2026-10-01T10:00:00.000Z',
  erased: false,
  identities: [{ id: 'i1', kind: 'email', provider: '', value: 'asha@example.com', isPrimary: true, createdAt: '2026-10-01T10:00:00.000Z' }],
  customFields: {},
  lists: [],
  tags: [],
  topics: [],
  consent: [
    { channel: 'email', state: 'none', changedBy: null, lawfulBasis: null, changedAt: null },
    { channel: 'sms', state: 'none', changedBy: null, lawfulBasis: null, changedAt: null },
    { channel: 'whatsapp', state: 'none', changedBy: null, lawfulBasis: null, changedAt: null },
  ],
  suppressions: [],
  version: 3,
};

const notEligible = {
  results: [
    {
      contactId: 'c1',
      eligible: false,
      reasons: [{ code: 'CONSENT_MISSING', message: 'No email consent has been recorded' }],
    },
  ],
};

function api(extra: Parameters<typeof mockApi>[0] = {}) {
  return mockApi({
    'GET /contacts/c1': () => json(200, detail),
    'POST /eligibility/check': () => json(200, notEligible),
    ...extra,
  });
}

describe('contact detail', () => {
  it('explains why a contact cannot be messaged, using the eligibility reason codes', async () => {
    api();
    renderAudience(<ContactDetailPage />, EDITOR);
    expect(await screen.findByText('Not eligible')).toBeInTheDocument();
    expect(screen.getByText('No email consent has been recorded')).toBeInTheDocument();
    expect(screen.getByText('CONSENT_MISSING')).toBeInTheDocument();
  });

  it('records consent with evidence through the consent endpoint', async () => {
    const calls = api({ 'POST /contacts/c1/consent': () => json(200, { changed: true }) });
    renderAudience(<ContactDetailPage />, EDITOR);
    await screen.findByText('Not eligible');
    await userEvent.click(screen.getAllByRole('button', { name: 'Record change' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: /record email consent/i });
    await userEvent.type(within(dialog).getByLabelText('Evidence'), 'Signed sheet at expo');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/contacts/c1/consent'))).toBeTruthy());
    expect(calls.find((c) => c.url.endsWith('/contacts/c1/consent') && c.method === 'POST')!.body).toEqual({
      channel: 'email',
      action: 'subscribed',
      source: 'paper',
      lawfulBasis: 'consent',
      evidenceNote: 'Signed sheet at expo',
    });
  });

  it('requires typing ERASE before erasing personal data', async () => {
    const calls = api({ 'POST /contacts/c1/erase': () => json(200, { erased: true }) });
    renderAudience(<ContactDetailPage />, EDITOR);
    await userEvent.click(await screen.findByRole('button', { name: 'Erase personal data' }));
    const dialog = await screen.findByRole('dialog', { name: /permanently erase/i });
    const confirm = within(dialog).getByRole('button', { name: 'Erase permanently' });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/type "ERASE"/i), 'ERASE');
    await userEvent.click(confirm);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/contacts'));
    expect(calls.find((c) => c.url.endsWith('/erase'))!.body).toEqual({ confirm: 'ERASE' });
  });

  it('is read-only for a viewer', async () => {
    api();
    renderAudience(<ContactDetailPage />, VIEWER);
    await screen.findByText('Not eligible');
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record change' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Suppress' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Erase personal data' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('First name')).toBeDisabled();
  });

  it('sends the version with profile edits and explains a conflict', async () => {
    const calls = api({
      'PATCH /contacts/c1': () => json(409, { error: { code: 'version_conflict', message: 'Changed by someone else', requestId: 'r' } }),
    });
    renderAudience(<ContactDetailPage />, EDITOR);
    const first = await screen.findByLabelText('First name');
    await userEvent.clear(first);
    await userEvent.type(first, 'Asha R');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/someone else changed this contact/i)).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PATCH')!.body).toMatchObject({ firstName: 'Asha R', version: 3 });
  });

  it('shows a not-found message for a contact outside this workspace', async () => {
    mockApi({ 'GET /contacts/c1': () => json(404, { error: { code: 'not_found', message: 'Contact not found', requestId: 'r' } }) });
    renderAudience(<ContactDetailPage />, EDITOR);
    expect(await screen.findByText('Contact not available')).toBeInTheDocument();
    expect(screen.getByText(/Contact not found/)).toBeInTheDocument();
  });
});
