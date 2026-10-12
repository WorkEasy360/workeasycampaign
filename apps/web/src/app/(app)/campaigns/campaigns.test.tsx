import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { json, mockApi, renderAudience } from '@/test/audience';
import { CAMPAIGN_EDITOR, CAMPAIGN_VIEWER, campaignView, capabilities, counts, listItem, TOPIC_ID } from '@/test/campaigns';
import CampaignsPage from './page';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  usePathname: () => '/campaigns',
  useParams: () => ({}),
}));

const topics = { data: [{ id: TOPIC_ID, key: 'marketing', name: 'Marketing', kind: 'topic', status: 'active', isDefault: true }] };

describe('campaign list (6.11)', () => {
  beforeEach(() => push.mockReset());

  it('lists campaigns with server status, topic and tab counts; test-mode banner explains nothing leaves the system', async () => {
    mockApi({
      'GET /campaigns': () => json(200, { data: [listItem(), listItem({ id: 'c2', name: 'Launch', status: 'completed' })], nextCursor: null }),
      'GET /campaigns/counts': () => json(200, counts),
      'GET /campaigns/capabilities': () => json(200, capabilities('test')),
      'GET /topics': () => json(200, topics),
    });
    renderAudience(<CampaignsPage />, CAMPAIGN_EDITOR);
    const table = await screen.findByRole('table', { name: 'Campaigns' });
    expect(within(table).getByRole('link', { name: 'Autumn sale' })).toHaveAttribute('href', '/campaigns/c1');
    expect(within(table).getByText('Sent')).toBeInTheDocument(); // completed → "Sent" badge
    expect(await within(table).findAllByText('Marketing')).toHaveLength(2);
    expect(await screen.findByText('Test delivery mode')).toBeInTheDocument();
    const tabs = screen.getByRole('navigation', { name: 'Campaign status' });
    expect(within(tabs).getByRole('button', { name: /Sending\s*2/ })).toBeInTheDocument(); // sending + paused
    expect(within(tabs).getByRole('button', { name: /All\s*9/ })).toHaveAttribute('aria-current', 'page');
  });

  it('tabs, channel and search are sent to the API as filters (search debounced, ≥ 2 characters)', async () => {
    const calls = mockApi({ 'GET /campaigns/counts': () => json(200, counts) });
    renderAudience(<CampaignsPage />, CAMPAIGN_EDITOR);
    await screen.findByText('No campaigns yet');
    await userEvent.click(screen.getByRole('button', { name: /^Sending/ }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('status=sending&status=paused'))).toBe(true));
    await userEvent.selectOptions(screen.getByLabelText('Channel'), 'email');
    await userEvent.type(screen.getByLabelText('Search campaigns'), 'au', { delay: null });
    await waitFor(() => expect(calls.some((c) => c.url.includes('q=au') && c.url.includes('channel=email'))).toBe(true), { timeout: 2000 });
    expect(await screen.findByText('No campaigns match')).toBeInTheDocument();
  });

  it('disabled delivery: the banner says sending is not available yet', async () => {
    mockApi({ 'GET /campaigns/capabilities': () => json(200, capabilities('disabled')) });
    renderAudience(<CampaignsPage />, CAMPAIGN_EDITOR);
    expect(await screen.findByText('Sending is not available yet')).toBeInTheDocument();
  });

  it('live delivery: no banner — the page never claims a test mode while real email is sent', async () => {
    const calls = mockApi({ 'GET /campaigns/capabilities': () => json(200, capabilities('live')), 'GET /campaigns/counts': () => json(200, counts) });
    renderAudience(<CampaignsPage />, CAMPAIGN_EDITOR);
    await screen.findByText('No campaigns yet');
    // Absence must not be vacuous: the capabilities answer has been served and rendered.
    await waitFor(() => expect(calls.some((c) => c.url.includes('/campaigns/capabilities'))).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('Test delivery mode')).toBeNull();
    expect(screen.queryByText('Sending is not available yet')).toBeNull();
  });

  it('create: validates with the shared schema, sends an Idempotency-Key and the default topic, opens the draft; SMS/WhatsApp unavailable', async () => {
    const calls = mockApi({
      'GET /campaigns/capabilities': () => json(200, capabilities('test')),
      'GET /topics': () => json(200, topics),
      'POST /campaigns': () => json(201, campaignView({ id: 'new1' })),
    });
    renderAudience(<CampaignsPage />, CAMPAIGN_EDITOR);
    await userEvent.click(await screen.findByRole('button', { name: 'New campaign' }));
    const dialog = await screen.findByRole('dialog', { name: 'New campaign' });
    expect(within(dialog).getByRole('option', { name: /SMS — not configured/ })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create draft' }));
    expect(calls.some((c) => c.method === 'POST')).toBe(false); // empty name rejected client-side
    await waitFor(() => expect(within(dialog).getByRole('alert')).toBeInTheDocument());
    await userEvent.type(within(dialog).getByLabelText('Campaign name'), 'Spring', { delay: null });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/campaigns/new1'));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({ name: 'Spring', channel: 'email', topicId: TOPIC_ID });
    expect(post.headers['idempotency-key']).toMatch(/^web-/);
  });

  it('viewer: no create controls (the API enforces it anyway)', async () => {
    mockApi({});
    renderAudience(<CampaignsPage />, CAMPAIGN_VIEWER);
    expect(await screen.findByText('No campaigns yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New campaign' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create your first campaign' })).not.toBeInTheDocument();
  });

  it('without campaigns.read: an explanation instead of data, and no request for campaigns', async () => {
    const calls = mockApi({});
    renderAudience(<CampaignsPage />, ['contacts.read']);
    expect(await screen.findByText('You can’t view campaigns')).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('/campaigns'))).toBe(false);
  });

  it('error state (e.g. the API denies access) shows the safe server message and the request id', async () => {
    mockApi({ 'GET /campaigns': () => json(403, { error: { code: 'forbidden', message: 'You do not have permission to do this.', requestId: 'req-123' } }) });
    renderAudience(<CampaignsPage />, CAMPAIGN_EDITOR);
    expect(await screen.findByText('Campaigns could not be loaded')).toBeInTheDocument();
    expect(screen.getByText('Reference: req-123')).toBeInTheDocument();
  });
});
