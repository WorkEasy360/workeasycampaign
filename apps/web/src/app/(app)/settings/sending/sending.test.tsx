import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Permission } from '@workeasy/shared';
import { describe, expect, it, vi } from 'vitest';
import { json, mockApi, renderAudience } from '@/test/audience';
import { CAMPAIGN_MANAGER } from '@/test/campaigns';
import SendingPage from './page';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/settings/sending', useParams: () => ({}) }));

/** Sending domains (Phase 7.8b): records to publish, server checks shown as they are, verification on request. */
const MANAGER: Permission[] = [...CAMPAIGN_MANAGER, 'deliverability.manage'];
const domain = (over: Record<string, unknown> = {}) => ({
  id: '77777777-7777-4777-8777-777777777777',
  domain: 'mail.acme.com',
  status: 'pending',
  checks: null,
  checkedAt: null,
  verifiedAt: null,
  records: [
    { purpose: 'ownership', type: 'TXT', host: '_workeasy.mail.acme.com', value: 'workeasy-verification=tok' },
    { purpose: 'spf', type: 'TXT', host: 'mail.acme.com', value: 'v=spf1 include:mailgun.org ~all' },
    { purpose: 'dkim', type: 'TXT or CNAME', host: 'mx._domainkey.mail.acme.com', value: 'The DKIM record your email provider shows for this domain' },
    { purpose: 'dmarc', type: 'TXT', host: '_dmarc.mail.acme.com', value: 'v=DMARC1; p=none' },
  ],
  identityCount: 0,
  version: 1,
  createdAt: '2026-10-09T09:00:00.000Z',
  ...over,
});

describe('sending domains page', () => {
  it('shows the DNS records to publish; "Check DNS now" shows the server’s per-record result', async () => {
    let current = domain();
    const calls = mockApi({
      'GET /sending-domains': () => json(200, { data: [current] }),
      'GET /sender-identities': () => json(200, { data: [] }),
      [`POST /sending-domains/${current.id}/verify`]: () => {
        current = domain({ status: 'failed', checkedAt: '2026-10-09T10:00:00.000Z', checks: { ownership: 'pass', spf: 'pass', dkim: 'missing', dmarc: 'error' } });
        return json(200, current);
      },
    });
    renderAudience(<SendingPage />, MANAGER);
    const table = await screen.findByRole('table', { name: 'DNS records for mail.acme.com' });
    expect(within(table).getByText('_workeasy.mail.acme.com')).toBeInTheDocument();
    expect(screen.getByText('Not verified yet')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Check DNS now' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/verify'))).toBe(true));
    expect(await screen.findByText('Verification failed')).toBeInTheDocument();
    const t2 = screen.getByRole('table', { name: 'DNS records for mail.acme.com' });
    expect(within(t2).getAllByText('Pass')).toHaveLength(2);
    expect(within(t2).getByText('Missing')).toBeInTheDocument();
    expect(within(t2).getByText('DNS lookup failed')).toBeInTheDocument();
  });

  it('adds a domain; a server field error is shown at the field', async () => {
    const calls = mockApi({
      'GET /sending-domains': () => json(200, { data: [] }),
      'GET /sender-identities': () => json(200, { data: [] }),
      'POST /sending-domains': () => json(400, { error: { code: 'validation_failed', message: 'Invalid', fields: { domain: ['Enter a public domain you control, e.g. mail.example.com'] }, requestId: 'r' } }),
    });
    renderAudience(<SendingPage />, MANAGER);
    await userEvent.type(await screen.findByLabelText('Domain'), 'localhost', { delay: null });
    await userEvent.click(screen.getByRole('button', { name: 'Add domain' }));
    expect(await screen.findByText('Enter a public domain you control, e.g. mail.example.com')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ domain: 'localhost' });
  });

  it('without deliverability.manage the records are visible but nothing can be changed', async () => {
    mockApi({ 'GET /sending-domains': () => json(200, { data: [domain()] }), 'GET /sender-identities': () => json(200, { data: [] }) });
    renderAudience(<SendingPage />, CAMPAIGN_MANAGER);
    await screen.findByRole('table', { name: 'DNS records for mail.acme.com' });
    expect(screen.queryByRole('button', { name: 'Check DNS now' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add domain' })).toBeNull();
  });
});
