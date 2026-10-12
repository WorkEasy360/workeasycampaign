import { EXAMPLE_MERGE_DATA, type EmailContentV2, type EmailContentV2Draft, emailContentV2Schema } from '@workeasy/shared';
import { describe, expect, it } from 'vitest';
import { canonicalContentV2, contentIssues, parseTemplate, renderEmail, substitute, tagsIn } from './index.js';

const ctx = { unsubscribeUrl: '#unsubscribe-preview', reason: 'you subscribed to Marketing at Acme' };
const v2 = (blocks: EmailContentV2['body']['blocks'], subject = 'Hi', preheader = ''): EmailContentV2 => ({ schema: 'email.content.v2', subject, preheader, body: { format: 'blocks', blocks } });
const para = (text: string, extra: Partial<{ href: string; bold: true }> = {}) => ({ id: 'p1', type: 'paragraph' as const, runs: [{ text, ...extra }] });

describe('merge tags (amendment §3)', () => {
  it('parses names and fallbacks, tolerating inner whitespace', () => {
    expect(parseTemplate('Hi {{contact.first_name}} and {{ contact.last_name | "friend" }}!')).toEqual({
      parts: [
        { kind: 'text', value: 'Hi ' },
        { kind: 'tag', name: 'contact.first_name', fallback: null },
        { kind: 'text', value: ' and ' },
        { kind: 'tag', name: 'contact.last_name', fallback: 'friend' },
        { kind: 'text', value: '!' },
      ],
      errors: [],
    });
  });

  it.each([
    ['{{ contact.password }}', 'unknown_name'],
    ['{{ constructor }}', 'unknown_name'],
    ['{{ __proto__ }}', 'unknown_name'],
    ['{{ contact.first_name', 'malformed'],
    ['{{ contact.first_name | there }}', 'malformed'],
    ['{{ contact.first_name | "a"b" }}', 'malformed'],
    ['{{}}', 'malformed'],
    [`{{ contact.first_name | "${'x'.repeat(101)}" }}`, 'malformed'],
  ])('rejects %j (%s) and keeps the text literal', (input, reason) => {
    const p = parseTemplate(input);
    expect(p.errors[0]?.reason).toBe(reason);
    expect(substitute(p.parts, EXAMPLE_MERGE_DATA)).toBe(input);
  });

  it.each([
    ['nested braces', '{{{{ contact.first_name }}}}'],
    ['HTML-entity braces', '&#123;&#123; contact.first_name &#125;&#125;'],
    ['percent-encoded braces', '%7B%7B contact.first_name %7D%7D'],
    ['full-width braces', '｛｛ contact.first_name ｝｝'],
  ])('encoded or nested variants never resolve to a value twice or from text: %s', (_n, input) => {
    const out = substitute(parseTemplate(input).parts, { 'contact.first_name': 'ANN' });
    // At most the one real tag resolves; entity/percent/full-width forms stay literal text.
    expect((out.match(/ANN/g) ?? []).length).toBeLessThanOrEqual(input.startsWith('{{{{') ? 1 : 0);
  });

  it('substitutes once: values are never re-parsed as tags', () => {
    const parts = parseTemplate('{{ contact.first_name }}').parts;
    expect(substitute(parts, { 'contact.first_name': '{{ contact.email }}' })).toBe('{{ contact.email }}');
  });

  it('uses the value, else the fallback, else nothing', () => {
    const parts = parseTemplate('[{{ contact.first_name | "there" }}]').parts;
    expect(substitute(parts, { 'contact.first_name': 'Ann' })).toBe('[Ann]');
    expect(substitute(parts, { 'contact.first_name': '   ' })).toBe('[there]');
    expect(substitute(parseTemplate('[{{ contact.company }}]').parts, {})).toBe('[]');
    expect(tagsIn('{{ contact.email }} {{ nope }}')).toEqual(['contact.email']);
  });
});

const RENDERER_TAGS = ['!doctype', 'html', 'head', 'meta', 'title', 'body', 'div', 'table', 'tr', 'td', 'p', 'br', 'a', 'h1', 'h2', 'h3', 'strong', 'em', 'img', 'hr'];

describe('rendering is safe by construction (decision C1)', () => {
  const ATTACKS = [
    '<script>alert(1)</script>',
    '"><img src=x onerror=alert(1)>',
    "'><svg onload=alert(1)>",
    '</p><iframe src="javascript:alert(1)"></iframe>',
    '<a href="javascript:alert(1)">x</a>',
    '<style>body{display:none}</style>',
    '&lt;script&gt;',
    '{{ contact.first_name }}<b onmouseover=alert(1)>',
  ];

  it.each(ATTACKS)('text and merge values never become markup: %j', (attack) => {
    const content = v2([para(attack), { id: 'b1', type: 'button', label: attack.slice(0, 80), href: 'https://example.com' }], attack.slice(0, 200), attack.slice(0, 200));
    const r = renderEmail(content, { 'contact.first_name': attack }, ctx);
    // Every real tag in the output is one the renderer emits, with no event handler and no script URL. (Escaped
    // attacker text may still contain e.g. "onerror=" as inert characters — that is text, not an attribute.)
    const tags = [...r.html.matchAll(/<\/?([a-z0-9!]+)[^>]*>/gi)];
    for (const [tag, name] of tags) {
      expect(RENDERER_TAGS).toContain(name!.toLowerCase());
      expect(tag).not.toMatch(/\son[a-z]+\s*=|javascript:|data:|vbscript:/i);
    }
    expect(r.html).not.toMatch(/<(script|iframe|svg|img src=x|style|a href="javascript)/i);
    expect(r.html).toMatch(/&lt;|&amp;/);
  });

  it.each(['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x', 'https://ex ample.com'])(
    'unsafe URLs (bypassing the schema) are dropped, their text kept: %j',
    (href) => {
      const content = v2([para('click', { href }), { id: 'b1', type: 'button', label: 'Go', href }, { id: 'i1', type: 'image', src: href, alt: 'pic', href }]);
      const r = renderEmail(content, {}, ctx);
      expect(r.html).not.toContain(href.split(':')[0] + ':' + href.split(':')[1]?.slice(0, 5));
      expect(r.html.toLowerCase()).not.toMatch(/href="(javascript|data|vbscript)/);
      expect(r.html.toLowerCase()).not.toMatch(/src="(javascript|data|vbscript|http:)/);
      expect(r.text).toContain('click');
      expect(r.text).toContain('Go');
    },
  );

  it('numbers that reach markup are coerced even when the schema is bypassed (width, heading level)', () => {
    const hostile = v2([
      { id: 'h1', type: 'heading', level: '1><script>alert(1)</script' as never, runs: [{ text: 'T' }] },
      { id: 'i1', type: 'image', src: 'https://e.com/a.png', alt: 'A', width: '1" onerror="alert(1)' as never },
    ]);
    const r = renderEmail(hostile, {}, ctx);
    expect(r.html).not.toMatch(/<script|onerror/i);
    expect(r.html).toContain('<h2');
    expect(r.html).toContain('width="600"');
  });

  it('alt text and labels cannot break out of their attribute or element', () => {
    const r = renderEmail(v2([{ id: 'i1', type: 'image', src: 'https://e.com/a.png', alt: '" onerror="alert(1)" x="' }, { id: 'b1', type: 'button', label: '</a><script>x</script>', href: 'https://e.com' }]), {}, ctx);
    expect(r.html).toContain('alt="&quot; onerror=&quot;alert(1)&quot; x=&quot;"');
    expect(r.html).not.toMatch(/<script|sonerror="/i);
  });

  it('escapes quotes inside attribute values', () => {
    const r = renderEmail(v2([para('x', { href: 'https://example.com/?q="><script>' })]), {}, ctx);
    expect(r.html).toContain('href="https://example.com/?q=&quot;&gt;&lt;script&gt;"');
  });

  it('emits no script, form, event handler or user style anywhere', () => {
    const r = renderEmail(v2([para('a'), { id: 'b1', type: 'button', label: 'B', href: 'https://e.com' }, { id: 'i1', type: 'image', src: 'https://e.com/a.png', alt: 'A' }, { id: 'd1', type: 'divider' }, { id: 's1', type: 'spacer', height: 16 }]), {}, ctx);
    expect(r.html).not.toMatch(/<script|<form|<style|\son[a-z]+=/i);
  });

  it('subjects and preheaders are single-line (no header injection through merge values)', () => {
    const r = renderEmail(v2([para('x')], 'Hello {{ contact.first_name }}', '{{ contact.company }}'), { 'contact.first_name': 'Ann\r\nBcc: victim@example.com', 'contact.company': 'A\nB' }, ctx);
    expect(r.subject).toBe('Hello Ann Bcc: victim@example.com');
    expect(r.subject).not.toMatch(/[\r\n]/);
    expect(r.preheader).toBe('A B');
  });
});

describe('rendering output (amendment §4)', () => {
  it('renders blocks to html and a text alternative with personalization', () => {
    const content = v2(
      [
        { id: 'h1', type: 'heading', level: 1, runs: [{ text: 'Hello {{ contact.first_name | "there" }}' }] },
        { id: 'p1', type: 'paragraph', runs: [{ text: 'Read the ' }, { text: 'news', bold: true, href: 'https://example.com/n' }] },
        { id: 'b1', type: 'button', label: 'Shop now', href: 'https://example.com/shop', align: 'center' },
        { id: 'i1', type: 'image', src: 'https://cdn.example.com/a.png', alt: 'Leaf', width: 300 },
        { id: 'd1', type: 'divider' },
      ],
      'News for {{ contact.first_name }}',
    );
    const r = renderEmail(content, EXAMPLE_MERGE_DATA, ctx);
    expect(r.subject).toBe('News for Alex');
    expect(r.html).toContain('<h1');
    expect(r.html).toContain('Hello Alex');
    expect(r.html).toContain('<a href="https://example.com/n"');
    expect(r.html).toContain('<strong>news</strong>');
    expect(r.html).toContain('alt="Leaf" width="300"');
    expect(r.text).toContain('Read the news (https://example.com/n)');
    expect(r.text).toContain('Shop now: https://example.com/shop');
    expect(r.text).toContain('[Leaf]');
    expect(r.usedTags).toEqual(['contact.first_name']);
    expect(renderEmail(content, {}, ctx).html).toContain('Hello there');
  });

  it('always appends the compliance footer with the unsubscribe link (decision C7)', () => {
    const r = renderEmail(v2([para('x')]), {}, { unsubscribeUrl: 'https://u.example.com/u/abc', reason: 'you <subscribed>' });
    expect(r.html).toContain('href="https://u.example.com/u/abc"');
    expect(r.html).toContain('you &lt;subscribed&gt;');
    expect(r.text).toContain('Unsubscribe: https://u.example.com/u/abc');
    expect(() => renderEmail(v2([para('x')]), {}, { unsubscribeUrl: 'javascript:alert(1)', reason: 'r' })).toThrow();
  });

  it('v1 text renders verbatim — merge tags are not interpreted (personalization none)', () => {
    const r = renderEmail({ schema: 'email.content.v1', subject: 'Hi {{ contact.first_name }}', preheader: '', body: { format: 'text', text: 'Line <1>\nline 2\n\nPara {{ contact.first_name }}' } }, EXAMPLE_MERGE_DATA, ctx);
    expect(r.subject).toBe('Hi {{ contact.first_name }}');
    expect(r.html).toContain('Line &lt;1&gt;<br>line 2');
    expect(r.html).toContain('Para {{ contact.first_name }}');
    expect(r.usedTags).toEqual([]);
  });

  it('is deterministic', () => {
    const c = v2([para('Hello {{ contact.first_name }}')]);
    expect(renderEmail(c, EXAMPLE_MERGE_DATA, ctx)).toEqual(renderEmail(c, EXAMPLE_MERGE_DATA, ctx));
  });
});

describe('content issues and the canonical form', () => {
  const draft = (blocks: EmailContentV2Draft['body']['blocks'], subject = 'Hi'): EmailContentV2Draft => ({ schema: 'email.content.v2', subject, preheader: '', body: { format: 'blocks', blocks } });

  it('reports user-fixable problems with pointers', () => {
    const issues = contentIssues(
      draft(
        [
          { id: 'p1', type: 'paragraph', runs: [{ text: 'Hi {{ contact.pass }}', href: 'https://e.com/{{ contact.email }}' }] },
          { id: 'b1', type: 'button', label: '', href: 'example.com' },
          { id: 'i1', type: 'image', src: 'http://e.com/a.png', alt: ' ' },
        ],
        '',
      ),
    ).map((i) => `${i.code} ${i.pointer}`);
    expect(issues).toEqual([
      'SUBJECT_MISSING /subject',
      'MERGE_TAG_INVALID /body/blocks/0/runs/0/text',
      'LINK_INVALID /body/blocks/0/runs/0/href',
      'BUTTON_LABEL_MISSING /body/blocks/1/label',
      'LINK_INVALID /body/blocks/1/href',
      'IMAGE_INVALID /body/blocks/2/src',
      'IMAGE_INVALID /body/blocks/2/alt',
    ]);
    expect(contentIssues(draft([{ id: 'd1', type: 'divider' }])).map((i) => i.code)).toEqual(['BODY_MISSING']);
    // C5: an unspaced merge field in a URL is refused with the specific message.
    const tagged = contentIssues(draft([{ id: 'b1', type: 'button', label: 'Go', href: 'https://e.com/?e={{contact.email}}' }]));
    expect(tagged).toEqual([{ code: 'LINK_INVALID', pointer: '/body/blocks/0/href', message: 'Links cannot contain merge fields' }]);
  });

  it('canonical form: trims, drops empty runs and empty text blocks, and always satisfies the complete schema', () => {
    const c = canonicalContentV2(
      draft([
        { id: 'h1', type: 'heading', level: 2, runs: [{ text: '' }] },
        { id: 'p1', type: 'paragraph', runs: [{ text: '' }, { text: 'Hello' }] },
        { id: 'p2', type: 'paragraph', runs: [] },
        { id: 'd1', type: 'divider' },
      ], '  Hi  '),
    )!;
    expect(c.subject).toBe('Hi');
    expect(c.body.blocks.map((b) => b.id)).toEqual(['p1', 'd1']);
    expect(emailContentV2Schema.safeParse(c).success).toBe(true);
    expect(canonicalContentV2(draft([], ''))).toBeNull();
  });
});
