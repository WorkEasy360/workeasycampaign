import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Interaction-heavy tests: type without a timer tick per keystroke (same events, same order); the default delay made
// them CPU-bound near the 5 s budget under load.
const user = userEvent.setup({ delay: null });
import { describe, expect, it, vi } from 'vitest';
import { json, mockApi, renderAudience } from '@/test/audience';
import { CAMPAIGN_EDITOR, CAMPAIGN_MANAGER, CAMPAIGN_VIEWER, campaignView, capabilities, execution, LIST_ID, preflight, TOPIC_ID, unavailablePreflight } from '@/test/campaigns';
import CampaignPage from './page';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  usePathname: () => '/campaigns/c1',
  useParams: () => ({ campaignId: 'c1' }),
}));

const base = {
  'GET /campaigns/capabilities': () => json(200, capabilities('test')),
  'GET /topics': () => json(200, { data: [{ id: TOPIC_ID, key: 'marketing', name: 'Marketing', kind: 'topic', status: 'active', isDefault: true }] }),
  'GET /lists': () => json(200, { data: [{ id: LIST_ID, name: 'Newsletter', status: 'active', memberCount: 10 }], nextCursor: null }),
  'GET /tags': () => json(200, { data: [] }),
};

describe('campaign draft (6.11)', () => {
  it('shows the draft; Save sends only the changed fields with expectedVersion', async () => {
    const calls = mockApi({
      ...base,
      'GET /campaigns/c1': () => json(200, campaignView()),
      'PATCH /campaigns/c1': () => json(200, campaignView({ version: 4, draft: { ...campaignView().draft, messages: [{ variantKey: 'default', content: { schema: 'email.content.v1', subject: 'Hello there', preheader: '', body: { format: 'text', text: 'Body' } } }] } })),
    });
    renderAudience(<CampaignPage />, CAMPAIGN_MANAGER);
    const subject = await screen.findByLabelText('Subject');
    expect(subject).toHaveValue('Hello');
    expect(await screen.findByText('List · Newsletter')).toBeInTheDocument();
    await user.type(subject, ' there');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.body).toEqual({
      expectedVersion: 3,
      messages: [{ variantKey: 'default', content: { schema: 'email.content.v1', subject: 'Hello there', preheader: '', body: { format: 'text', text: 'Body' } } }],
    });
    expect(await screen.findByText('All changes saved')).toBeInTheDocument();
  });

  it('409 version_conflict keeps the local edits and offers a reload', async () => {
    mockApi({
      ...base,
      'GET /campaigns/c1': () => json(200, campaignView()),
      'PATCH /campaigns/c1': () => json(409, { error: { code: 'version_conflict', message: 'Someone else changed this in the meantime.', requestId: 'r' } }),
    });
    renderAudience(<CampaignPage />, CAMPAIGN_MANAGER);
    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'My edit');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('Changed by someone else')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('My edit');
    expect(screen.getByRole('button', { name: 'Reload latest version' })).toBeInTheDocument();
  });

  it('restoring a version refreshes the (unedited) form from the server — regression: it used to keep the old text', async () => {
    const restored = campaignView({ version: 5, draft: { ...campaignView().draft, messages: [{ variantKey: 'default', content: { schema: 'email.content.v1', subject: 'From version 1', preheader: '', body: { format: 'text', text: 'Body' } } }] } });
    const calls = mockApi({
      ...base,
      'GET /campaigns/c1': () => json(200, campaignView()),
      'GET /campaigns/c1/versions': () => json(200, { data: [{ id: 'v1', number: 1, reason: 'scheduled', contentHash: 'a'.repeat(64), createdAt: '2026-10-07T09:00:00.000Z', createdBy: { id: 'u1', displayName: 'Sam' } }], nextCursor: null }),
      'POST /campaigns/c1/versions/v1/restore': () => json(200, restored),
    });
    renderAudience(<CampaignPage />, CAMPAIGN_MANAGER);
    expect(await screen.findByLabelText('Subject')).toHaveValue('Hello');
    await user.click(await screen.findByRole('button', { name: 'Restore into draft' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Restore version #1 into the draft?' })).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(screen.getByLabelText('Subject')).toHaveValue('From version 1'));
    expect(screen.getByText('All changes saved')).toBeInTheDocument();
    expect(calls.find((c) => c.url.endsWith('/restore'))!.body).toEqual({ expectedVersion: 3 });
  });

  it('findings come from the server, grouped by section, linking to their field', async () => {
    mockApi({
      ...base,
      'GET /campaigns/c1': () =>
        json(200, campaignView({ readiness: 'not_ready', readinessFindings: [{ code: 'SUBJECT_MISSING', severity: 'error', section: 'message', field: '/messages/0/content/subject', message: 'Add a subject' }] })),
    });
    renderAudience(<CampaignPage />, CAMPAIGN_MANAGER);
    const review = await screen.findByRole('complementary', { name: 'Review' });
    expect(within(review).getByText('1 problem blocks sending')).toBeInTheDocument();
    expect(within(review).getByRole('link', { name: 'Add a subject' })).toHaveAttribute('href', '#campaign-subject');
    expect(screen.getByLabelText('Subject')).toHaveAttribute('id', 'campaign-subject');
  });

  it('full check shows the estimate; in degraded mode it says the estimate is temporarily unavailable — no number', async () => {
    let degraded = false;
    mockApi({ ...base, 'GET /campaigns/c1': () => json(200, campaignView()), 'POST /campaigns/c1/preflight': () => json(200, degraded ? unavailablePreflight() : preflight()) });
    renderAudience(<CampaignPage />, CAMPAIGN_MANAGER);
    await user.click(await screen.findByRole('button', { name: 'Run full check' }));
    expect(await screen.findByText('1,000')).toBeInTheDocument();
    expect(screen.getByText(/≈ 800/)).toBeInTheDocument();
    expect(screen.getByText('No consent')).toBeInTheDocument();
    degraded = true;
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('Eligibility estimate temporarily unavailable')).toBeInTheDocument();
    expect(screen.getByText(/Audience resolution recovery has been requested/)).toBeInTheDocument();
    expect(screen.queryByText(/≈/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Check again in \d+s/ })).toBeDisabled();
  });

  it('viewer: read-only draft, no Save, no lifecycle buttons beyond what the server allows', async () => {
    mockApi({ ...base, 'GET /campaigns/c1': () => json(200, campaignView({ allowedActions: [], blockedActions: [] })) });
    renderAudience(<CampaignPage />, CAMPAIGN_VIEWER);
    expect(await screen.findByLabelText('Subject')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Schedule' })).not.toBeInTheDocument();
    expect(screen.getByText(/read-only for you/)).toBeInTheDocument();
  });

  it('blocked actions stay visible, disabled, with the server’s reason', async () => {
    mockApi({
      ...base,
      'GET /campaigns/capabilities': () => json(200, capabilities('disabled')),
      'GET /campaigns/c1': () =>
        json(200, campaignView({ allowedActions: ['update'], blockedActions: [{ action: 'schedule', reason: 'DELIVERY_NOT_AVAILABLE' }, { action: 'send_now', reason: 'DELIVERY_NOT_AVAILABLE' }] })),
    });
    renderAudience(<CampaignPage />, CAMPAIGN_EDITOR);
    const schedule = await screen.findByRole('button', { name: 'Schedule' });
    expect(schedule).toBeDisabled();
    expect(schedule).toHaveAccessibleDescription('Sending is not available yet.');
    expect(screen.queryByText('DELIVERY_NOT_AVAILABLE')).not.toBeInTheDocument(); // codes are never shown raw
  });
});

describe('schedule (6.11)', () => {
  it('runs the check on open, shows the estimate; 409 PREFLIGHT_UNAVAILABLE explains and does not pretend it scheduled', async () => {
    const calls = mockApi({
      ...base,
      'GET /campaigns/c1': () => json(200, campaignView()),
      'POST /campaigns/c1/preflight': () => json(200, preflight()),
      'POST /campaigns/c1/schedule': () =>
        new Response(JSON.stringify({ error: { code: 'PREFLIGHT_UNAVAILABLE', message: 'The audience is being prepared. Try again shortly.', requestId: 'r', findings: unavailablePreflight().readinessFindings } }), {
          status: 409,
          headers: { 'content-type': 'application/json', 'retry-after': '30' },
        }),
    });
    renderAudience(<CampaignPage />, CAMPAIGN_MANAGER);
    await user.click(await screen.findByRole('button', { name: 'Send now' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send this campaign now?' });
    expect(await within(dialog).findByText(/≈ 800/)).toBeInTheDocument();
    expect(within(dialog).getByText(/content and audience definition are locked/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Send now' }));
    expect(await within(dialog).findByText('The audience is being prepared')).toBeInTheDocument();
    expect(within(dialog).getByText(/try again in about 30 seconds/)).toBeInTheDocument();
    const post = calls.find((c) => c.url.endsWith('/schedule'))!;
    expect(post.body).toEqual({ mode: 'now', expectedVersion: 3 });
    expect(post.headers['idempotency-key']).toMatch(/^web-/);
  });

  it('422 PREFLIGHT_FAILED lists the blocking findings; scheduling "at" sends an explicit offset and the time zone', async () => {
    const calls = mockApi({
      ...base,
      'GET /campaigns/c1': () => json(200, campaignView({ draft: { ...campaignView().draft, schedule: { mode: 'at', sendAt: '2026-12-01T09:30:00.000Z', timezone: 'Europe/London' } } })),
      'POST /campaigns/c1/preflight': () => json(200, preflight()),
      'POST /campaigns/c1/schedule': () =>
        json(422, { error: { code: 'PREFLIGHT_FAILED', message: 'Fix the problems found by the review before scheduling', requestId: 'r', findings: [{ code: 'NO_ELIGIBLE_RECIPIENTS', severity: 'error', section: 'audience', field: '/audience', message: 'No contact in this audience can currently receive this campaign' }] } }),
    });
    renderAudience(<CampaignPage />, CAMPAIGN_MANAGER);
    await user.click(await screen.findByRole('button', { name: 'Schedule' }));
    const dialog = await screen.findByRole('dialog', { name: 'Schedule this campaign' });
    expect(within(dialog).getByLabelText('Date and time')).toHaveValue('2026-12-01T09:30');
    expect(within(dialog).getByText(/Europe\/London/, { selector: 'p' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Schedule' }));
    expect(await within(dialog).findByText('No contact in this audience can currently receive this campaign')).toBeInTheDocument();
    expect(calls.find((c) => c.url.endsWith('/schedule'))!.body).toEqual({ mode: 'at', sendAt: '2026-12-01T09:30:00.000Z', timezone: 'Europe/London', expectedVersion: 3 });
  });
});

describe('running and finished campaigns (6.11)', () => {
  it('sending: server counts only, progress bar from sent/planned, skip reasons, pause/cancel from allowedActions', async () => {
    mockApi({
      ...base,
      'GET /campaigns/c1': () => json(200, campaignView({ status: 'sending', allowedActions: ['pause', 'cancel', 'clone'], currentExecution: execution(), currentVersion: { id: 'v1', number: 1, createdAt: '2026-10-08T09:00:00.000Z' } })),
    });
    renderAudience(<CampaignPage />, CAMPAIGN_MANAGER);
    expect(await screen.findByText('Sent 300 of 800 planned')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar', { name: 'Sent' });
    expect(bar).toHaveAttribute('aria-valuenow', '300');
    expect(bar).toHaveAttribute('aria-valuemax', '800');
    expect(screen.getByText('No consent')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel campaign' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();
  });

  it('stalled health is explained honestly; cancel confirms and sends expectedVersion', async () => {
    const calls = mockApi({
      ...base,
      'GET /campaigns/c1': () => json(200, campaignView({ status: 'sending', allowedActions: ['pause', 'cancel'], currentExecution: execution({ health: 'stalled' }) })),
      'POST /campaigns/c1/cancel': () => json(200, campaignView({ status: 'cancelled', allowedActions: ['clone'], currentExecution: execution({ status: 'cancelled' }) })),
    });
    renderAudience(<CampaignPage />, CAMPAIGN_MANAGER);
    expect(await screen.findByText(/delayed by a temporary system problem/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel campaign' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this campaign?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel campaign' }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/cancel'))?.body).toEqual({ expectedVersion: 3 }));
  });

  it('a failed run explains the configuration problem; return to draft is offered when allowed', async () => {
    mockApi({
      ...base,
      'GET /campaigns/c1': () =>
        json(200, campaignView({ status: 'failed', allowedActions: ['return_to_draft', 'clone'], currentExecution: execution({ status: 'failed', failure: { class: 'configuration', code: 'TOPIC_UNAVAILABLE' } }) })),
    });
    renderAudience(<CampaignPage />, CAMPAIGN_MANAGER);
    expect(await screen.findByText(/configuration problem/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Return to draft' })).toBeEnabled();
  });

  it('a deleted campaign is read-only with Restore; an unknown id shows "not available"', async () => {
    mockApi({ ...base, 'GET /campaigns/c1': () => json(200, campaignView({ deletedAt: '2026-10-07T10:00:00.000Z', allowedActions: ['restore'] })) });
    renderAudience(<CampaignPage />, CAMPAIGN_EDITOR);
    expect(await screen.findByText('This campaign is deleted')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeEnabled();
  });

  it('not found (or another workspace’s id): a safe "not available" message', async () => {
    mockApi({ ...base, 'GET /campaigns/c1': () => json(404, { error: { code: 'not_found', message: 'Campaign not found', requestId: 'req-9' } }) });
    renderAudience(<CampaignPage />, CAMPAIGN_EDITOR);
    expect(await screen.findByText('This campaign is not available')).toBeInTheDocument();
    expect(screen.getByText('Reference: req-9')).toBeInTheDocument();
  });
});

describe('SMS and WhatsApp drafts (messaging amendment)', () => {
  it('an SMS draft shows the SMS editor; no email sender picker, no email templates or test send', async () => {
    const sms = campaignView({ channel: 'sms', draft: { ...campaignView().draft, sender: { senderIdentityId: null, fromName: null, replyTo: null }, messages: [] }, readinessFindings: [] });
    mockApi({ ...base, 'GET /campaigns/capabilities': () => json(200, capabilities('test')), 'GET /campaigns/c1': () => json(200, sms) });
    renderAudience(<CampaignPage />, CAMPAIGN_MANAGER);
    expect(await screen.findByLabelText('Text message')).toBeInTheDocument();
    expect(screen.getByText(/sent from your organization’s SMS number/)).toBeInTheDocument();
    expect(screen.queryByLabelText('From name (optional)')).toBeNull();
    expect(screen.queryByRole('button', { name: /Send test/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /template/i })).toBeNull();
  });

  it('a WhatsApp draft shows the approved-template editor', async () => {
    const wa = campaignView({ channel: 'whatsapp', draft: { ...campaignView().draft, sender: { senderIdentityId: null, fromName: null, replyTo: null }, messages: [] }, readinessFindings: [] });
    mockApi({ ...base, 'GET /campaigns/capabilities': () => json(200, capabilities('test')), 'GET /campaigns/c1': () => json(200, wa) });
    renderAudience(<CampaignPage />, CAMPAIGN_MANAGER);
    expect(await screen.findByLabelText('Template name')).toBeInTheDocument();
    expect(screen.getByLabelText('Template language')).toHaveValue('en');
    expect(screen.getByText(/sent from your organization’s WhatsApp Business number/)).toBeInTheDocument();
  });
});
