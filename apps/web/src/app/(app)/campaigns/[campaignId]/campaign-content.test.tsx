import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Interaction-heavy tests: type without a timer tick per keystroke (same events, same order); the default delay made
// them CPU-bound near the 5 s budget under load.
const user = userEvent.setup({ delay: null });
import type { Permission } from '@workeasy/shared';
import { describe, expect, it, vi } from 'vitest';
import { json, mockApi, renderAudience } from '@/test/audience';
import { CAMPAIGN_MANAGER, campaignView, capabilities, execution, LIST_ID, TOPIC_ID } from '@/test/campaigns';
import { useState } from 'react';
import { RecipientsCard } from '@/components/campaigns/recipients-card';
import CampaignPage from './page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/campaigns/c1',
  useParams: () => ({ campaignId: 'c1' }),
}));

const base = {
  'GET /campaigns/capabilities': () => json(200, capabilities('test')),
  'GET /topics': () => json(200, { data: [{ id: TOPIC_ID, key: 'marketing', name: 'Marketing', kind: 'topic', status: 'active', isDefault: true }] }),
  'GET /lists': () => json(200, { data: [{ id: LIST_ID, name: 'Newsletter', status: 'active', memberCount: 10 }], nextCursor: null }),
  'GET /tags': () => json(200, { data: [] }),
};
const WITH_TEMPLATES: Permission[] = [...CAMPAIGN_MANAGER, 'templates.read', 'templates.manage'];

const designed = (blocks: unknown[], subject = 'Hi {{ contact.first_name | "there" }}') => ({ schema: 'email.content.v2' as const, subject, preheader: '', body: { format: 'blocks' as const, blocks } });
const withContent = (content: unknown, over: Record<string, unknown> = {}) =>
  campaignView({ ...over, draft: { ...campaignView().draft, messages: [{ variantKey: 'default', content: content as never }] } } as never);

describe('designed emails (content amendment)', () => {
  it('a plain-text message can be switched to a designed email; paragraphs become text blocks and Save sends v2 content', async () => {
    const calls = mockApi({
      ...base,
      'GET /campaigns/c1': () => json(200, withContent({ schema: 'email.content.v1', subject: 'Hello', preheader: '', body: { format: 'text', text: 'First para.\n\nSecond para.' } })),
      'PATCH /campaigns/c1': () => json(200, campaignView({ version: 4 })),
    });
    renderAudience(<CampaignPage />, CAMPAIGN_MANAGER);
    await user.click(await screen.findByRole('button', { name: 'Switch to a designed email' }));
    const blocks = screen.getByRole('list', { name: 'Email blocks' });
    expect(within(blocks).getAllByLabelText('Text').map((t) => (t as HTMLTextAreaElement).value)).toEqual(['First para.', 'Second para.']);
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const content = (calls.find((c) => c.method === 'PATCH')!.body as { messages: { content: { schema: string; body: { blocks: { type: string; runs: unknown[] }[] } } }[] }).messages[0]!.content;
    expect(content.schema).toBe('email.content.v2');
    expect(content.body.blocks.map((b) => [b.type, b.runs])).toEqual([
      ['paragraph', [{ text: 'First para.' }]],
      ['paragraph', [{ text: 'Second para.' }]],
    ]);
  });

  it('blocks are added, edited with light markup, reordered and removed; the PATCH carries structured runs, never markup', async () => {
    const calls = mockApi({ ...base, 'GET /campaigns/c1': () => json(200, withContent(designed([]))), 'PATCH /campaigns/c1': () => json(200, campaignView({ version: 4 })) });
    renderAudience(<CampaignPage />, CAMPAIGN_MANAGER);
    await user.click(await screen.findByRole('button', { name: 'Add text' }));
    await user.click(screen.getByRole('button', { name: 'Add button' }));
    await user.click(screen.getByLabelText('Text'));
    await user.paste('Read **this** at [our site](https://e.com/x)'); // a paste: one change event, as in a browser
    await user.click(screen.getByLabelText('Button label'));
    await user.paste('Shop');
    const link = screen.getByLabelText('Link');
    await user.clear(link);
    await user.click(link);
    await user.paste('https://e.com/shop');
    await user.click(screen.getByRole('button', { name: 'Add divider' }));
    await user.click(screen.getByRole('button', { name: 'Remove block 3' }));
    await user.click(screen.getByRole('button', { name: 'Move block 2 up' }));
    expect(within(screen.getByRole('list', { name: 'Email blocks' })).getAllByRole('listitem')[0]).toHaveTextContent('1. Button');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const blocks = (calls.find((c) => c.method === 'PATCH')!.body as { messages: { content: { body: { blocks: Record<string, unknown>[] } } }[] }).messages[0]!.content.body.blocks;
    expect(blocks.map(({ id: _id, ...b }) => b)).toEqual([
      { type: 'button', label: 'Shop', href: 'https://e.com/shop' },
      { type: 'paragraph', runs: [{ text: 'Read ' }, { text: 'this', bold: true }, { text: ' at ' }, { text: 'our site', href: 'https://e.com/x' }] },
    ]);
    expect(new Set(blocks.map((b) => b.id)).size).toBe(2);
  });

  it('"Insert personal field" inserts the merge tag at the cursor', async () => {
    mockApi({ ...base, 'GET /campaigns/c1': () => json(200, withContent(designed([], 'Hello'))) });
    renderAudience(<CampaignPage />, CAMPAIGN_MANAGER);
    const subject = await screen.findByLabelText('Subject');
    await user.click(subject);
    (subject as HTMLInputElement).setSelectionRange(5, 5);
    await user.selectOptions(screen.getByLabelText('Insert personal field into Subject'), 'contact.first_name');
    expect(subject).toHaveValue('Hello{{ contact.first_name | "there" }}');
  });

  it('the live preview renders with the example contact in a sandboxed frame; hostile text stays text', async () => {
    mockApi({ ...base, 'GET /campaigns/c1': () => json(200, withContent(designed([{ id: 'p1', type: 'paragraph', runs: [{ text: 'Hi {{ contact.first_name }} <script>alert(1)</script>' }] }]))) });
    renderAudience(<CampaignPage />, CAMPAIGN_MANAGER);
    await user.click(await screen.findByRole('tab', { name: 'Preview' }));
    const frame = screen.getByTitle('Email preview') as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('');
    const html = frame.getAttribute('srcdoc')!;
    expect(html).toContain('Hi Alex &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(screen.getByTestId('preview-subject')).toHaveTextContent('Hi Alex');
    await user.click(screen.getByRole('button', { name: 'Mobile' }));
    expect(screen.getByRole('button', { name: 'Mobile' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('a server finding about a block links to that block field', async () => {
    mockApi({
      ...base,
      'GET /campaigns/c1': () =>
        json(
          200,
          withContent(designed([{ id: 'b1', type: 'button', label: 'Go', href: 'javascript:x' }]), {
            readiness: 'not_ready',
            readinessFindings: [{ code: 'LINK_INVALID', severity: 'error', section: 'message', field: '/messages/0/content/body/blocks/0/href', message: 'Use a full link starting with https://, http:// or mailto:' }],
          }),
        ),
    });
    renderAudience(<CampaignPage />, CAMPAIGN_MANAGER);
    const finding = await screen.findByRole('link', { name: /Use a full link/ });
    expect(finding).toHaveAttribute('href', '#campaign-block-0-href');
    expect(document.getElementById('campaign-block-0-href')).toHaveValue('javascript:x');
  });

  it('applying a template posts the template and the expected version, then shows the new content', async () => {
    const applied = withContent(designed([{ id: 'h1', type: 'heading', level: 1, runs: [{ text: 'From template' }] }], 'Template subject'), { version: 4 });
    const calls = mockApi({
      ...base,
      'GET /campaigns/c1': () => json(200, withContent(designed([]))),
      'GET /templates': () => json(200, { data: [{ id: 't1', name: 'Monthly', description: '', subject: 'Template subject', blockCount: 1, version: 2, updatedAt: '2026-10-08T09:00:00.000Z' }], nextCursor: null }),
      'POST /campaigns/c1/apply-template': () => json(200, applied),
    });
    renderAudience(<CampaignPage />, WITH_TEMPLATES);
    await user.click(await screen.findByRole('button', { name: 'Use a template' }));
    await user.click(await screen.findByRole('button', { name: 'Use template Monthly' }));
    await waitFor(() => expect(screen.getByLabelText('Subject')).toHaveValue('Template subject'));
    expect(calls.find((c) => c.url.endsWith('/apply-template'))!.body).toEqual({ templateId: 't1', expectedVersion: 3 });
    expect(screen.getByLabelText('Heading text')).toHaveValue('From template');
  });

  it('template actions need their permissions and a saved draft', async () => {
    mockApi({ ...base, 'GET /campaigns/c1': () => json(200, withContent(designed([]))) });
    const { unmount } = renderAudience(<CampaignPage />, CAMPAIGN_MANAGER);
    await screen.findByLabelText('Subject');
    expect(screen.queryByRole('button', { name: 'Use a template' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save as template' })).toBeNull();
    unmount();
    renderAudience(<CampaignPage />, WITH_TEMPLATES);
    const subject = await screen.findByLabelText('Subject');
    expect(screen.getByRole('button', { name: 'Save as template' })).toBeEnabled();
    await user.type(subject, '!');
    expect(screen.getByRole('button', { name: 'Save as template' })).toBeDisabled();
    expect(screen.getByText('Save or discard your changes first.')).toBeInTheDocument();
  });
});

describe('execution recipients (row 23)', () => {
  const sending = () => campaignView({ status: 'sending', allowedActions: ['pause', 'cancel'], currentExecution: execution(), currentVersion: { id: 'v1', number: 1, createdAt: '2026-10-08T09:00:00.000Z' } });
  const page = {
    data: [
      { id: 'r1', contact: { id: 'k1', displayName: 'Ann Lee' }, status: 'sent', reasonCodes: [], updatedAt: '2026-10-08T09:00:00.000Z' },
      { id: 'r2', contact: { id: 'k2', displayName: 'Cat Co' }, status: 'skipped', reasonCodes: ['CONSENT_MISSING'], updatedAt: '2026-10-08T09:00:00.000Z' },
    ],
    nextCursor: null,
  };

  it('lists recipients by display name with status and reason; the filter is sent to the server', async () => {
    const calls = mockApi({ ...base, 'GET /campaigns/c1': () => json(200, sending()), 'GET /campaigns/c1/executions': () => json(200, { data: [], nextCursor: null }), [`GET /campaigns/c1/executions/${execution().id}/recipients`]: () => json(200, page) });
    renderAudience(<CampaignPage />, CAMPAIGN_MANAGER);
    const table = await screen.findByRole('table', { name: 'Recipients' });
    expect(within(table).getByText('Ann Lee')).toBeInTheDocument();
    expect(within(table).getByText('Cat Co')).toBeInTheDocument();
    expect(within(table).getByText('Skipped')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Show'), 'skipped');
    await waitFor(() => expect(calls.some((c) => c.url.includes('/recipients?') && c.url.includes('status=skipped'))).toBe(true));
  });

  it('is not shown without contacts.read', async () => {
    const calls = mockApi({ ...base, 'GET /campaigns/c1': () => json(200, sending()), 'GET /campaigns/c1/executions': () => json(200, { data: [], nextCursor: null }) });
    renderAudience(<CampaignPage />, CAMPAIGN_MANAGER.filter((p) => p !== 'contacts.read'));
    await screen.findByText(/Sent .* of .* planned|planned/);
    expect(screen.queryByRole('table', { name: 'Recipients' })).toBeNull();
    expect(calls.some((c) => c.url.includes('/recipients'))).toBe(false);
  });
});

describe('recipients card refresh (regression)', () => {
  it('refetches when the run moves on — a finished run never keeps showing the empty list from materialization', async () => {
    let calls = 0;
    mockApi({
      'GET /campaigns/c1/executions/e1/recipients': () => {
        calls++;
        return json(200, calls === 1 ? { data: [], nextCursor: null } : { data: [{ id: 'r1', contact: { id: 'k1', displayName: 'Ann Lee' }, status: 'sent', reasonCodes: [], updatedAt: '2026-10-08T09:00:00.000Z' }], nextCursor: null });
      },
    });
    function Harness() {
      const [progress, setProgress] = useState('materializing:2026-10-08T09:00:00.000Z');
      return (
        <>
          <button type="button" onClick={() => setProgress('completed:2026-10-08T09:00:05.000Z')}>
            finish
          </button>
          <RecipientsCard campaignId="c1" executionId="e1" live={false} progress={progress} />
        </>
      );
    }
    renderAudience(<Harness />, CAMPAIGN_MANAGER);
    expect(await screen.findByText('No recipients yet.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'finish' }));
    expect(await screen.findByText('Ann Lee')).toBeInTheDocument();
    expect(calls).toBe(2);
  });
});

describe('test send (Phase 7.3)', () => {
  it('sends the saved draft to the user’s own address and says where it went', async () => {
    const calls = mockApi({
      ...base,
      'GET /campaigns/c1': () => json(200, withContent(designed([{ id: 'p1', type: 'paragraph', runs: [{ text: 'Hi' }] }]))),
      'POST /campaigns/c1/test-send': () => json(200, { sentTo: 'sam@example.com', subject: '[Test] Hi Alex', sample: 'example' }),
    });
    renderAudience(<CampaignPage />, CAMPAIGN_MANAGER);
    await user.click(await screen.findByRole('button', { name: 'Send a test to me' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send a test to me' });
    expect(within(dialog).getByText('sam@example.com')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Send test' }));
    expect(await within(dialog).findByText('Test sent')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/test-send'))!.body).toEqual({});
  });

  it('a refusal is explained (no silent failure); without campaigns.update the action is absent', async () => {
    mockApi({
      ...base,
      'GET /campaigns/c1': () => json(200, withContent(designed([{ id: 'p1', type: 'paragraph', runs: [{ text: 'Hi' }] }]))),
      'POST /campaigns/c1/test-send': () => json(422, { error: { code: 'DELIVERY_NOT_AVAILABLE', message: 'Sending is not available yet, so test sends are not either', requestId: 'r9' } }),
    });
    const { unmount } = renderAudience(<CampaignPage />, CAMPAIGN_MANAGER);
    await user.click(await screen.findByRole('button', { name: 'Send a test to me' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send a test to me' });
    await user.click(within(dialog).getByRole('button', { name: 'Send test' }));
    expect(await within(dialog).findByText('The test was not sent')).toBeInTheDocument();
    expect(within(dialog).getByText(/not available yet/)).toBeInTheDocument();
    unmount();
    mockApi({ ...base, 'GET /campaigns/c1': () => json(200, withContent(designed([{ id: 'p1', type: 'paragraph', runs: [{ text: 'Hi' }] }]))) });
    renderAudience(<CampaignPage />, CAMPAIGN_MANAGER.filter((p) => p !== 'campaigns.update'));
    await screen.findByText('Autumn sale');
    expect(screen.queryByRole('button', { name: 'Send a test to me' })).toBeNull();
  });
});

describe('creation workflow and audience (Phase 7.4)', () => {
  it('steps show the server’s readiness per section and move focus to the section', async () => {
    mockApi({
      ...base,
      'GET /campaigns/c1': () =>
        json(
          200,
          campaignView({
            readiness: 'not_ready',
            readinessFindings: [
              { code: 'SUBJECT_MISSING', severity: 'error', section: 'message', field: '/messages/0/content/subject', message: 'Add a subject' },
              { code: 'SENDER_NOT_CONFIGURED', severity: 'warning', section: 'sender', field: '/sender/senderIdentityId', message: 'Verified sender identities arrive with delivery' },
            ],
          } as never),
        ),
    });
    renderAudience(<CampaignPage />, CAMPAIGN_MANAGER);
    const steps = await screen.findByRole('navigation', { name: 'Campaign steps' });
    expect(within(steps).getByRole('link', { name: '1. Details: done' })).toBeInTheDocument();
    expect(within(steps).getByRole('link', { name: '3. Sender: has warnings' })).toBeInTheDocument();
    expect(within(steps).getByRole('link', { name: '4. Message: needs attention' })).toBeInTheDocument();
    expect(within(steps).getByRole('link', { name: '6. Review and send: not ready yet' })).toBeInTheDocument();
    await user.click(within(steps).getByRole('link', { name: '4. Message: needs attention' }));
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Message' }));
  });

  it('sample recipients: names and eligibility only, on request; needs contacts.read', async () => {
    const calls = mockApi({
      ...base,
      'GET /campaigns/c1': () => json(200, campaignView()),
      'GET /campaigns/c1/audience-sample': () =>
        json(200, { unavailable: false, sample: [{ contactId: '55555555-5555-4555-8555-555555555555', displayName: 'Ann Lee', eligible: true, reasons: [] }, { contactId: '66666666-6666-4666-8666-666666666666', displayName: 'Bob Lee', eligible: false, reasons: ['CONSENT_MISSING'] }] }),
    });
    const { unmount } = renderAudience(<CampaignPage />, [...CAMPAIGN_MANAGER, 'contacts.read']);
    const audience = await screen.findByRole('region', { name: 'Audience' });
    expect(calls.some((c) => c.url.includes('audience-sample'))).toBe(false); // only on request
    await user.click(within(audience).getByRole('button', { name: 'Show a sample' }));
    const list = await within(audience).findByRole('list', { name: 'Sample recipients' });
    expect(within(list).getByText('Ann Lee')).toBeInTheDocument();
    expect(within(list).getByText('Can receive it')).toBeInTheDocument();
    expect(within(list).getByText('Will be skipped')).toBeInTheDocument();
    unmount();
    mockApi({ ...base, 'GET /campaigns/c1': () => json(200, campaignView()) });
    renderAudience(<CampaignPage />, CAMPAIGN_MANAGER.filter((p) => p !== 'contacts.read'));
    const region = await screen.findByRole('region', { name: 'Audience' });
    expect(within(region).queryByRole('button', { name: 'Show a sample' })).toBeNull();
  });
});
