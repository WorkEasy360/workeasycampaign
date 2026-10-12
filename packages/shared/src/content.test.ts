import { describe, expect, it } from 'vitest';
import { campaignVersionSnapshotSchema, campaignVersionSnapshotV1Schema, campaignVersionSnapshotV2Schema } from './campaigns.js';
import { EMAIL_CONTENT_V2_LIMITS, type EmailContentV2, emailContentV2DraftSchema, emailContentV2Schema, isSafeImageUrl, isSafeLinkUrl, mergeDataSchema } from './content.js';

const content = (): EmailContentV2 => ({
  schema: 'email.content.v2',
  subject: 'Hello {{ contact.first_name | "there" }}',
  preheader: 'Autumn news',
  body: {
    format: 'blocks',
    blocks: [
      { id: 'h1', type: 'heading', level: 1, runs: [{ text: 'Autumn' }] },
      { id: 'p1', type: 'paragraph', runs: [{ text: 'Read ' }, { text: 'more', bold: true, href: 'https://example.com/a?b=1' }] },
      { id: 'b1', type: 'button', label: 'Shop', href: 'https://example.com/shop', align: 'center' },
      { id: 'i1', type: 'image', src: 'https://cdn.example.com/x.png', alt: 'A leaf', width: 300 },
      { id: 'd1', type: 'divider' },
      { id: 's1', type: 'spacer', height: 24 },
    ],
  },
});

const v1Snapshot = () => ({
  schema: 'campaign.version.v1',
  channel: 'email',
  purpose: 'marketing',
  topic: { topicIds: ['01a11850-b308-7102-9271-54fa8ea2c893'], policy: 'block_unsubscribed' },
  audience: { include: [{ type: 'list', listId: '01a11850-b308-7102-9271-54fa8ea2c894' }], exclude: [] },
  sender: { senderIdentityId: null, fromName: 'Acme', replyTo: null },
  messages: [{ variantKey: 'default', content: { schema: 'email.content.v1', subject: 'S', preheader: '', body: { format: 'text', text: 'Hi' } } }],
  tracking: { opens: false, clicks: false },
  compliance: { unsubscribeLink: 'required', listUnsubscribeHeader: 'required' },
  personalization: { mode: 'none' },
  schedule: { mode: 'now', sendAt: null, timezone: 'UTC' },
  abTest: null,
});

describe('email.content.v2 (content amendment §2)', () => {
  it('accepts a complete message with every block type', () => {
    expect(emailContentV2Schema.parse(content())).toEqual(content());
  });

  it('is strict: unknown keys, raw html and unknown block types are rejected', () => {
    const withHtml = content() as unknown as { body: { html?: string } };
    withHtml.body.html = '<b>x</b>';
    expect(emailContentV2Schema.safeParse(withHtml).success).toBe(false);
    const c = content() as unknown as { body: { blocks: unknown[] } };
    c.body.blocks.push({ id: 'x1', type: 'html', html: '<script>alert(1)</script>' });
    expect(emailContentV2Schema.safeParse(c).success).toBe(false);
    const extra = content() as unknown as { body: { blocks: Record<string, unknown>[] } };
    extra.body.blocks[0]!.onclick = 'alert(1)';
    expect(emailContentV2Schema.safeParse(extra).success).toBe(false);
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox',
    'https:example.com',
    'https://exa mple.com',
    'https://example.com/\u0000',
    ' https://example.com',
    '//example.com',
    '/relative',
    'ftp://example.com',
    'mailto:',
    // Decision C5: merge fields never inside URLs (the WHATWG parser accepts unspaced braces).
    'https://x.com/?e={{contact.email}}',
    'https://{{contact.company}}.example.com/',
    'https://x.com/{path}',
  ])('refuses the link %j in a complete message', (href) => {
    const c = content();
    (c.body.blocks[2] as { href: string }).href = href;
    expect(isSafeLinkUrl(href)).toBe(false);
    expect(emailContentV2Schema.safeParse(c).success).toBe(false);
  });

  it('accepts https, http and mailto links; images only over https', () => {
    expect(isSafeLinkUrl('https://example.com')).toBe(true);
    expect(isSafeLinkUrl('http://example.com/x')).toBe(true);
    expect(isSafeLinkUrl('mailto:hello@example.com?subject=Hi')).toBe(true);
    expect(isSafeImageUrl('https://cdn.example.com/a.png')).toBe(true);
    expect(isSafeImageUrl('http://cdn.example.com/a.png')).toBe(false);
    expect(isSafeImageUrl('data:image/png;base64,AAAA')).toBe(false);
  });

  it('requires unique block ids and bounds the total text', () => {
    const dup = content();
    dup.body.blocks[1]!.id = 'h1';
    expect(emailContentV2Schema.safeParse(dup).success).toBe(false);
    const big = content();
    big.body.blocks = Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, type: 'paragraph' as const, runs: [{ text: 'x'.repeat(EMAIL_CONTENT_V2_LIMITS.runText) }] }));
    expect(emailContentV2Schema.safeParse(big).success).toBe(false);
  });

  it('the draft level allows empty text and unfinished links, but keeps the shape strict', () => {
    const d = { schema: 'email.content.v2', subject: '', preheader: '', body: { format: 'blocks', blocks: [{ id: 'b1', type: 'button', label: '', href: 'exa' }] } };
    expect(emailContentV2DraftSchema.safeParse(d).success).toBe(true);
    expect(emailContentV2Schema.safeParse(d).success).toBe(false);
    expect(emailContentV2DraftSchema.safeParse({ ...d, body: { format: 'blocks', blocks: [{ id: 'B!', type: 'divider' }] } }).success).toBe(false);
  });

  it('merge data accepts only allowlisted names', () => {
    expect(mergeDataSchema.safeParse({ 'contact.first_name': 'Ann', 'contact.email': null }).success).toBe(true);
    expect(mergeDataSchema.safeParse({ 'contact.password': 'x' }).success).toBe(false);
  });
});

describe('campaign.version.v2 (decision C3)', () => {
  const v2 = (c: unknown, mode: string) => ({ ...v1Snapshot(), schema: 'campaign.version.v2', messages: [{ variantKey: 'default', content: c }], personalization: { mode } });

  it('holds v2 content with merge_tags_v1, or v1 content with none', () => {
    expect(campaignVersionSnapshotV2Schema.safeParse(v2(content(), 'merge_tags_v1')).success).toBe(true);
    expect(campaignVersionSnapshotV2Schema.safeParse(v2(v1Snapshot().messages[0]!.content, 'none')).success).toBe(true);
  });

  it('personalization must match the content schema', () => {
    expect(campaignVersionSnapshotV2Schema.safeParse(v2(content(), 'none')).success).toBe(false);
    expect(campaignVersionSnapshotV2Schema.safeParse(v2(v1Snapshot().messages[0]!.content, 'merge_tags_v1')).success).toBe(false);
  });

  it('v1 is unchanged: it still refuses v2 content and v2 personalization', () => {
    expect(campaignVersionSnapshotV1Schema.safeParse(v1Snapshot()).success).toBe(true);
    expect(campaignVersionSnapshotV1Schema.safeParse({ ...v1Snapshot(), messages: [{ variantKey: 'default', content: content() }] }).success).toBe(false);
    expect(campaignVersionSnapshotV1Schema.safeParse({ ...v1Snapshot(), personalization: { mode: 'merge_tags_v1' } }).success).toBe(false);
  });

  it('the stored-snapshot union reads both ids', () => {
    expect(campaignVersionSnapshotSchema.parse(v1Snapshot()).schema).toBe('campaign.version.v1');
    expect(campaignVersionSnapshotSchema.parse(v2(content(), 'merge_tags_v1')).schema).toBe('campaign.version.v2');
  });
});
