import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Interaction-heavy tests: type without a timer tick per keystroke (same events, same order); the default delay made
// them CPU-bound near the 5 s budget under load.
const user = userEvent.setup({ delay: null });
import type { Permission } from '@workeasy/shared';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { contentFieldId } from '@/lib/content';
import { json, mockApi, renderAudience } from '@/test/audience';
import { CAMPAIGN_EDITOR } from '@/test/campaigns';
import { type MessageContent, MessageEditor } from './message-editor';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/campaigns/c1', useParams: () => ({}) }));

/** Phase 7 content amendment §C in the builder: the lossless v2 → v3 upgrade, HTML, conditions, custom fields. */
const WITH_CONTACTS: Permission[] = [...CAMPAIGN_EDITOR, 'contacts.read'];
const v2 = (): MessageContent => ({ schema: 'email.content.v2', subject: 'Hi', preheader: '', body: { format: 'blocks', blocks: [{ id: 'p1', type: 'paragraph', runs: [{ text: 'Hello' }] }] } });
const FIELDS = { data: [
  { id: 'f1', key: 'plan', label: 'Plan', type: 'single_select', status: 'active' },
  { id: 'f2', key: 'old_code', label: 'Old code', type: 'text', status: 'archived' },
] };

function Harness({ initial, onValue }: { initial: MessageContent; onValue: (v: MessageContent) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <MessageEditor
      value={value}
      disabled={false}
      errors={{}}
      onChange={(v) => {
        setValue(v);
        onValue(v);
      }}
    />
  );
}

function setup(initial = v2(), permissions = WITH_CONTACTS) {
  mockApi({ 'GET /custom-fields': () => json(200, FIELDS) });
  let last: MessageContent = initial;
  renderAudience(<Harness initial={initial} onValue={(v) => (last = v)} />, permissions);
  return { last: () => last as any };
}

describe('designed email v3 in the builder', () => {
  it('a v2 email stays v2 while only v2 features are used', async () => {
    const s = setup();
    await user.click(await screen.findByRole('button', { name: 'Add text' }));
    await user.type(screen.getAllByLabelText('Text')[1]!, 'More');
    expect(s.last().schema).toBe('email.content.v2');
  });

  it('adding an HTML block upgrades losslessly to v3; unsafe HTML is reported and "Clean HTML" removes it', async () => {
    const s = setup();
    await user.click(await screen.findByRole('button', { name: 'Add html' }));
    expect(s.last().schema).toBe('email.content.v3');
    expect(s.last().body.blocks[0]).toEqual({ id: 'p1', type: 'paragraph', runs: [{ text: 'Hello' }] }); // nothing lost
    const html = screen.getByLabelText('HTML');
    await user.click(html);
    await user.paste('<p onclick="x()">Hi</p><script>alert(1)</script>');
    const alert = await screen.findByText('Some of this HTML cannot be sent safely');
    expect(alert.closest('[role="alert"], div')!.textContent).toContain('<script> element');
    await user.click(screen.getByRole('button', { name: 'Clean HTML' }));
    expect(s.last().body.blocks[1].html).toBe('<p>Hi</p>');
    expect(screen.queryByText('Some of this HTML cannot be sent safely')).toBeNull();
  });

  it('a conditional section: rules over fields (custom ones listed, archived ones not), and two branches of blocks', async () => {
    const s = setup();
    await user.click(await screen.findByRole('button', { name: 'Add conditional section' }));
    expect(s.last().schema).toBe('email.content.v3');
    const field = await screen.findByLabelText('Rule 1 field');
    await waitFor(() => expect(within(field).getByRole('option', { name: 'Plan' })).toBeInTheDocument());
    expect(within(field).queryByRole('option', { name: 'Old code' })).toBeNull();
    await user.selectOptions(field, 'contact.custom.plan');
    await user.selectOptions(screen.getByLabelText('Rule 1 comparison'), 'equals');
    await user.type(screen.getByLabelText('Rule 1 value'), 'Pro');
    const matching = screen.getByRole('group', { name: 'Add a block to matching branch' });
    await user.click(within(matching).getByRole('button', { name: 'Add text' }));
    const cond = s.last().body.blocks[1];
    expect(cond.when).toEqual({ match: 'all', rules: [{ field: 'contact.custom.plan', op: 'equals', value: 'Pro' }] });
    expect(cond.then).toHaveLength(1);
    expect(within(matching).queryByRole('button', { name: 'Add conditional section' })).toBeNull(); // no nesting
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    expect(s.last().body.blocks[1].when.rules).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Remove rule 2' }));
    expect(s.last().body.blocks[1].when.rules).toHaveLength(1);
  });

  it('inserting a custom or sender field upgrades the email to v3', async () => {
    const s = setup();
    const insert = await screen.findByLabelText('Insert personal field into Subject');
    await waitFor(() => expect(within(insert).getByRole('option', { name: 'Plan' })).toBeInTheDocument());
    await user.selectOptions(insert, 'contact.custom.plan');
    expect(s.last().subject).toBe('Hi{{ contact.custom.plan }}');
    expect(s.last().schema).toBe('email.content.v3');
  });

  it('without contacts.read the picker offers the contact basics and sender names only (no field list request)', async () => {
    const calls = mockApi({});
    renderAudience(<Harness initial={v2()} onValue={() => undefined} />, CAMPAIGN_EDITOR.filter((p) => p !== 'contacts.read'));
    const insert = await screen.findByLabelText('Insert personal field into Subject');
    expect(within(insert).getByRole('option', { name: 'Workspace name' })).toBeInTheDocument();
    expect(within(insert).queryByRole('option', { name: 'Plan' })).toBeNull();
    expect(calls.some((c) => c.url.includes('/custom-fields'))).toBe(false);
  });

  it('the live preview renders the branch the example contact matches, with the workspace name', async () => {
    const initial: MessageContent = {
      schema: 'email.content.v3',
      subject: 'From {{ workspace.name }}',
      preheader: '',
      body: {
        format: 'blocks',
        blocks: [{ id: 'c1', type: 'conditional', when: { match: 'all', rules: [{ field: 'contact.first_name', op: 'equals', value: 'Alex' }] }, then: [{ id: 't', type: 'paragraph', runs: [{ text: 'Hi Alex' }] }], else: [{ id: 'e', type: 'paragraph', runs: [{ text: 'Hi stranger' }] }] }],
      },
    };
    setup(initial);
    await user.click(screen.getByRole('tab', { name: 'Preview' }));
    expect(await screen.findByTestId('preview-subject')).toHaveTextContent('From Main');
    const frame = screen.getByTitle('Email preview') as HTMLIFrameElement;
    expect(frame.getAttribute('srcdoc')).toContain('Hi Alex');
    expect(frame.getAttribute('srcdoc')).not.toContain('Hi stranger');
    expect(frame.getAttribute('sandbox')).toBe('');
  });

  it('readiness pointers into branches, HTML and rules map to the right controls', () => {
    expect(contentFieldId('/messages/0/content/body/blocks/2/then/1/href')).toBe('campaign-block-2-then-1-href');
    expect(contentFieldId('/messages/0/content/body/blocks/2/else/0/runs/0/text')).toBe('campaign-block-2-else-0-text');
    expect(contentFieldId('/messages/0/content/body/blocks/3/html')).toBe('campaign-block-3-html');
    expect(contentFieldId('/messages/0/content/body/blocks/1/when/rules/0/value')).toBe('campaign-block-1-when');
    expect(contentFieldId('/messages/0/content/body/blocks/0/runs/0/text')).toBe('campaign-block-0-text'); // v2 unchanged
  });
});

describe('saved blocks in the builder (Phase 7 §S)', () => {
  const WITH_TEMPLATES: Permission[] = [...WITH_CONTACTS, 'templates.read', 'templates.manage'];
  const saved = {
    id: '44444444-4444-4444-8444-444444444444',
    name: 'Footer',
    blocks: [{ id: 'p1', type: 'paragraph', runs: [{ text: 'Follow us' }] }, { id: 'x1', type: 'html', html: '<p>Social</p>' }],
    version: 1,
    createdAt: '2026-10-08T09:00:00.000Z',
    updatedAt: '2026-10-08T09:00:00.000Z',
    createdBy: null,
  };

  it('inserting a saved block copies it with fresh ids (no clash with existing ids) and upgrades to v3 when needed', async () => {
    mockApi({
      'GET /custom-fields': () => json(200, FIELDS),
      'GET /snippets': () => json(200, { data: [{ id: saved.id, name: 'Footer', blockCount: 2, version: 1, updatedAt: saved.updatedAt }], nextCursor: null }),
      [`GET /snippets/${saved.id}`]: () => json(200, saved),
    });
    let last: any;
    renderAudience(<Harness initial={v2()} onValue={(v) => (last = v)} />, WITH_TEMPLATES);
    await user.selectOptions(await screen.findByLabelText('Insert saved block'), saved.id);
    await waitFor(() => expect(last?.body.blocks).toHaveLength(3));
    expect(last.schema).toBe('email.content.v3'); // the saved block has HTML
    const ids = last.body.blocks.map((b: { id: string }) => b.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe('p1'); // the existing block keeps its id; the copies get new ones
    expect(last.body.blocks[1].runs).toEqual([{ text: 'Follow us' }]);
  });

  it('a block can be saved for reuse (name asked first); without templates.manage the action is absent', async () => {
    const calls = mockApi({ 'GET /custom-fields': () => json(200, FIELDS), 'POST /snippets': () => json(201, saved) });
    const { unmount } = renderAudience(<Harness initial={v2()} onValue={() => undefined} />, WITH_TEMPLATES);
    await user.click(await screen.findByRole('button', { name: 'Save block 1 as a reusable block' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save as a reusable block' });
    expect(within(dialog).getByRole('button', { name: 'Save block' })).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Name'), 'Greeting');
    await user.click(within(dialog).getByRole('button', { name: 'Save block' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'Greeting', blocks: [{ id: 'p1', type: 'paragraph', runs: [{ text: 'Hello' }] }] }));
    unmount();
    mockApi({ 'GET /custom-fields': () => json(200, FIELDS) });
    renderAudience(<Harness initial={v2()} onValue={() => undefined} />, WITH_CONTACTS);
    await screen.findByRole('button', { name: 'Add text' });
    expect(screen.queryByRole('button', { name: /as a reusable block/ })).toBeNull();
    expect(screen.queryByLabelText('Insert saved block')).toBeNull();
  });
});
