import { type EmailContentV3Draft, emailContentV3DraftSchema, emailContentV3Schema } from '@workeasy/shared';
import { describe, expect, it } from 'vitest';
import { evaluateCondition } from './conditions.js';
import { parseTemplate, parseTemplateV2 } from './merge-tags.js';
import { renderEmail } from './render.js';
import { sanitizeHtml } from './sanitize-html.js';
import { canonicalContentV3, contentIssuesV3 } from './validate-v3.js';

/** docs/contracts/phase-7-content-amendment.md §C (C11–C17). */
const ctx = { unsubscribeUrl: 'https://example.com/u/1', reason: 'you subscribed' };
const v3 = (blocks: unknown[], subject = 'Hello {{ contact.first_name | "there" }}'): EmailContentV3Draft =>
  emailContentV3DraftSchema.parse({ schema: 'email.content.v3', subject, preheader: '', body: { format: 'blocks', blocks } });
const para = (id: string, text: string) => ({ id, type: 'paragraph', runs: [{ text }] });

/** The email body inside the renderer's fixed layout (the layout itself has a charset <meta>). */
const bodyOf = (html: string) => html.split('<td style="padding:32px">')[1]!;

/** Anything that could execute or load in a mail client or a browser preview. */
const DANGEROUS = /<script|<iframe|<object|<embed|<svg|<math|<style|<link|<meta|<form|<input|<button|<template|\son[a-z]+\s*=|javascript:|vbscript:|data:text|expression\s*\(|url\s*\(|@import|<!--|srcdoc|formaction|xlink:/i;

describe('HTML sanitizer (C15, C16)', () => {
  const XSS = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<img src="https://ok.example/a.png" onerror="alert(1)">',
    '<a href="javascript:alert(1)">x</a>',
    '<a href="JaVaScRiPt:alert(1)">x</a>',
    '<a href="java\tscript:alert(1)">x</a>',
    '<a href="&#106;avascript:alert(1)">x</a>',
    '<a href=" javascript:alert(1)">x</a>',
    '<a href="vbscript:msgbox(1)">x</a>',
    '<a href="data:text/html,<script>alert(1)</script>">x</a>',
    '<iframe src="https://evil.example"></iframe>',
    '<object data="x"></object><embed src="x">',
    '<svg onload=alert(1)><circle/></svg>',
    '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
    '<style>body{background:url(javascript:alert(1))}</style>',
    '<div style="background:url(javascript:alert(1))">x</div>',
    '<div style="width:expression(alert(1))">x</div>',
    '<div style="behavior:url(x.htc)">x</div>',
    '<div style="color:red;-moz-binding:url(x)">x</div>',
    '<p style="color:\\72 ed">x</p>',
    '<p style="color:red/**/;position:fixed">x</p>',
    '<form action="https://evil.example"><input name=a><button>go</button></form>',
    '<meta http-equiv="refresh" content="0;url=https://evil.example">',
    '<link rel="stylesheet" href="https://evil.example/x.css">',
    '<base href="https://evil.example/">',
    '<!--[if mso]><script>alert(1)</script><![endif]-->',
    '<template><script>alert(1)</script></template>',
    '<noscript><img src=x onerror=alert(1)></noscript>',
    '<a href="https://ok.example" target="_blank" rel="opener">x</a>',
    '<img src="http://insecure.example/a.png" alt="a">',
    '<img src="https://ok.example/{{contact.email}}.png" alt="a">',
    '<a href="https://ok.example/?e={{ contact.email }}">x</a>',
    '<div><p>unclosed <b>bold <i>mixed</b></i>',
    '<table><tr><td>a</td><script>alert(1)</script></tr></table>',
    '<select><option><img src=x onerror=alert(1)></option></select>',
    '<textarea><img src=x onerror=alert(1)></textarea>',
    '<xmp><img src=x onerror=alert(1)></xmp>',
    '<scr<script>ipt>alert(1)</script>',
    '"><img src=x onerror=alert(1)>',
    '<a href="https://ok.example" style="color:red" onclick="steal()">ok</a>',
  ];

  it.each(XSS)('neutralizes %s', (input) => {
    const out = sanitizeHtml(input);
    expect(out.html).not.toMatch(DANGEROUS);
    // The output reparses to itself: a fixed point that removes nothing.
    const again = sanitizeHtml(out.html);
    expect(again.html).toBe(out.html);
    expect(again.removed).toEqual([]);
  });

  it('reports what it removed (so nothing is removed silently)', () => {
    const r = sanitizeHtml('<p onclick="x()" style="color:red;position:fixed">Hi<script>1</script><!-- c --></p><a href="javascript:x">l</a>');
    expect(r.removed).toEqual(expect.arrayContaining(['onclick attribute', 'style property "position"', '<script> element', 'comment', 'link "javascript:x"']));
    expect(r.html).toBe('<p style="color:red">Hi</p><a>l</a>');
  });

  it('keeps the allowlist intact: formatting, safe links, https images, tables, plain styles', () => {
    const input =
      '<h2 align="center" style="color:#111827;font-size:22px">Title</h2><p>Text <strong>bold</strong> <em>it</em> <a href="https://example.com/x?a=1&amp;b=2" title="t">link</a> <a href="mailto:a@b.co">mail</a></p>' +
      '<ul><li>one</li></ul><table width="100%" cellpadding="4" role="presentation"><tbody><tr><td align="right" style="background-color:rgb(1, 2, 3);padding:4px 8px">c</td></tr></tbody></table>' +
      '<img src="https://cdn.example/a.png" alt="A picture" width="300"><p style="font-family:\'Helvetica Neue\', Arial">f</p>';
    const r = sanitizeHtml(input);
    expect(r.removed).toEqual([]);
    expect(r.html).toBe(input.replace(/'/g, '&#39;')); // normalization only: quotes in attribute values are escaped
  });

  it('escapes text and attributes; entities in text never become markup', () => {
    const r = sanitizeHtml('<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; "q" <a href="https://example.com" title="a&quot;b&lt;c">l</a></p>');
    expect(r.removed).toEqual([]);
    expect(r.html).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; "q" <a href="https://example.com" title="a&quot;b&lt;c">l</a></p>');
    expect(r.text).toBe('<script>alert(1)</script> & "q" l (https://example.com)');
  });

  it('unknown but harmless elements are unwrapped (text kept) and reported', () => {
    const r = sanitizeHtml('<center><font color="red">Hi</font></center>');
    expect(r.html).toBe('Hi');
    expect(r.removed).toEqual(['<center> element (its text is kept)', 'color attribute', '<font> element (its text is kept)'].filter((x) => r.removed.includes(x)));
    expect(r.removed.length).toBeGreaterThan(0);
  });

  it('plain text: block elements become lines, links show their target', () => {
    const r = sanitizeHtml('<h1>Title</h1><p>Read <a href="https://example.com">more</a></p><ul><li>a</li><li>b</li></ul>');
    expect(r.text).toBe('Title\n\nRead more (https://example.com)\n\na\n\nb');
  });
});

describe('merge_tags_v2 (C13)', () => {
  it('accepts v1 names, custom fields, workspace and organization names; rejects others', () => {
    const p = parseTemplateV2('{{ contact.first_name }} {{contact.custom.favourite_colour | "blue"}} {{ workspace.name }} {{ organization.name }}');
    expect(p.errors).toEqual([]);
    expect(p.parts.filter((x) => x.kind === 'tag').map((x) => (x as { name: string }).name)).toEqual(['contact.first_name', 'contact.custom.favourite_colour', 'workspace.name', 'organization.name']);
    for (const bad of ['{{ contact.custom.X }}', '{{ contact.custom.a }}', '{{ contact.password }}', '{{ user.email }}', '{{ contact.custom.a-b }}', '{{ contact.custom. }}', '{{ session.token }}']) {
      expect(parseTemplateV2(bad).errors.length, bad).toBe(1);
    }
  });

  it('v1 parsing is unchanged: v2-only names are errors in v1', () => {
    expect(parseTemplate('{{ workspace.name }}').errors[0]?.reason).toBe('unknown_name');
    expect(parseTemplate('{{ contact.first_name }}').errors).toEqual([]);
  });
});

describe('conditions (C12)', () => {
  const data = { 'contact.first_name': '  Alex ', 'contact.custom.plan': 'Pro Annual', 'contact.company': '' };
  it.each([
    [{ field: 'contact.first_name', op: 'is_set' }, true],
    [{ field: 'contact.company', op: 'is_set' }, false], // blank = not set
    [{ field: 'contact.last_name', op: 'is_not_set' }, true],
    [{ field: 'contact.first_name', op: 'equals', value: 'ALEX' }, true], // trimmed, case-insensitive
    [{ field: 'contact.first_name', op: 'not_equals', value: 'alex' }, false],
    [{ field: 'contact.custom.plan', op: 'contains', value: 'annual' }, true],
    [{ field: 'contact.custom.plan', op: 'not_contains', value: 'monthly' }, true],
    [{ field: 'contact.last_name', op: 'equals', value: 'x' }, false], // unset equals nothing
    [{ field: 'contact.last_name', op: 'not_equals', value: 'x' }, true],
  ] as const)('%o → %s', (rule, expected) => {
    expect(evaluateCondition({ match: 'all', rules: [rule] }, data)).toBe(expected);
  });

  it('all / any; an unknown op fails closed', () => {
    const r1 = { field: 'contact.first_name', op: 'is_set' } as const;
    const r2 = { field: 'contact.company', op: 'is_set' } as const;
    expect(evaluateCondition({ match: 'all', rules: [r1, r2] }, data)).toBe(false);
    expect(evaluateCondition({ match: 'any', rules: [r1, r2] }, data)).toBe(true);
    expect(evaluateCondition({ match: 'all', rules: [{ field: 'contact.first_name', op: 'eval' as never }] }, data)).toBe(false);
  });
});

describe('rendering v3 (C11–C16)', () => {
  const content = v3([
    { id: 'h', type: 'heading', level: 1, runs: [{ text: 'Hi {{ contact.first_name | "there" }}' }] },
    {
      id: 'c',
      type: 'conditional',
      when: { match: 'all', rules: [{ field: 'contact.custom.plan', op: 'equals', value: 'pro' }] },
      then: [para('t', 'Thanks for being Pro at {{ organization.name }}')],
      else: [para('e', 'Upgrade to Pro'), { id: 'b', type: 'button', label: 'Upgrade', href: 'https://example.com/up' }],
    },
    { id: 'x', type: 'html', html: '<p>Plan: <strong>{{ contact.custom.plan | "none" }}</strong></p>' },
  ]);

  it('renders the branch the condition selects, with merge fields in HTML text nodes', () => {
    const pro = renderEmail(content as never, { 'contact.first_name': 'Sam', 'contact.custom.plan': 'Pro', 'organization.name': 'Acme' }, ctx);
    expect(pro.text).toContain('Thanks for being Pro at Acme');
    expect(pro.text).not.toContain('Upgrade to Pro');
    expect(pro.html).toContain('Plan: <strong>Pro</strong>');
    expect(pro.subject).toBe('Hello Sam');
    expect(renderEmail(content as never, {}, ctx).subject).toBe('Hello there');
    const free = renderEmail(content as never, { 'contact.first_name': 'Sam' }, ctx);
    expect(free.text).toContain('Upgrade to Pro');
    expect(free.html).toContain('Plan: <strong>none</strong>');
    expect(free.html).not.toContain('Thanks for being Pro');
    expect(free.usedTags).toEqual(expect.arrayContaining(['contact.first_name', 'contact.custom.plan']));
    expect(free.usedTags).not.toContain('organization.name'); // only the rendered branch counts
  });

  it('merge values are text in every context: HTML text, attributes never interpreted, subject single-line', () => {
    const evil = '<img src=x onerror=alert(1)>"\'\r\nBcc: victim@example.com';
    const c = v3([para('p', '{{ contact.first_name }}'), { id: 'x', type: 'html', html: '<p><a href="https://example.com" title="{{ contact.first_name }}">{{ contact.custom.note }}</a></p>' }], 'S {{ contact.first_name }}');
    const r = renderEmail(c as never, { 'contact.first_name': evil, 'contact.custom.note': evil }, ctx);
    expect(r.html).not.toMatch(/<img src=x/);
    expect(r.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(r.html).toContain('title="{{ contact.first_name }}"'); // attributes are never interpreted
    expect(r.subject).not.toMatch(/[\r\n]/);
    expect(r.subject).toContain('Bcc: victim@example.com'); // as text on one line, never a header
  });

  it('the renderer re-sanitizes stored HTML (defence in depth)', () => {
    const tampered = { schema: 'email.content.v3', subject: 'S', preheader: '', body: { format: 'blocks', blocks: [{ id: 'x', type: 'html', html: '<p onclick="x()">a</p><script>alert(1)</script>' }] } };
    const r = renderEmail(tampered as never, {}, ctx);
    expect(bodyOf(r.html)).not.toMatch(DANGEROUS);
    expect(r.html).toContain('<p>a</p>');
  });
});

describe('validation and canonical form (C11, C12, C16)', () => {
  it('a complete v3 content canonicalizes to a valid stored value; HTML stored normalized', () => {
    const c = v3([para('p', 'Hi'), { id: 'x', type: 'html', html: '<P CLASS2="">x</P>'.replace(' CLASS2=""', '') }]);
    expect(contentIssuesV3(c)).toEqual([]);
    const canon = canonicalContentV3(c)!;
    expect(emailContentV3Schema.safeParse(canon).success).toBe(true);
    expect((canon.body.blocks[1] as { html: string }).html).toBe('<p>x</p>');
  });

  it('HTML that would lose anything is a blocking issue naming what', () => {
    const issues = contentIssuesV3(v3([para('p', 'Hi'), { id: 'x', type: 'html', html: '<p onclick="x()">a</p>' }]));
    expect(issues).toEqual([expect.objectContaining({ code: 'HTML_UNSUPPORTED', pointer: '/body/blocks/1/html', message: expect.stringContaining('onclick attribute') })]);
    expect(canonicalContentV3(v3([para('p', 'Hi'), { id: 'x', type: 'html', html: '<p onclick="x()">a</p>' }]))).toBeNull();
  });

  it('conditions: field, value presence, empty conditionals; issues inside branches carry nested pointers', () => {
    const issues = contentIssuesV3(
      v3([
        para('p', 'Hi'),
        { id: 'c', type: 'conditional', when: { match: 'all', rules: [{ field: '', op: 'equals', value: '' }, { field: 'contact.first_name', op: 'is_set', value: 'x' }] }, then: [], else: [] },
        { id: 'd', type: 'conditional', when: { match: 'any', rules: [] }, then: [{ id: 'l', type: 'button', label: 'Go', href: 'javascript:x' }], else: [] },
      ]),
    );
    expect(issues.map((i) => [i.code, i.pointer])).toEqual(
      expect.arrayContaining([
        ['CONDITION_INVALID', '/body/blocks/1/when/rules/0/field'],
        ['CONDITION_INVALID', '/body/blocks/1/when/rules/0/value'],
        ['CONDITION_INVALID', '/body/blocks/1/when/rules/1/value'],
        ['CONDITIONAL_EMPTY', '/body/blocks/1'],
        ['CONDITION_INVALID', '/body/blocks/2/when'],
        ['LINK_INVALID', '/body/blocks/2/then/0/href'],
      ]),
    );
  });

  it('nesting, too many branch blocks and duplicate ids are refused by the schema', () => {
    const nested = { id: 'c', type: 'conditional', when: { match: 'all', rules: [] }, then: [{ id: 'n', type: 'conditional', when: { match: 'all', rules: [] }, then: [], else: [] }], else: [] };
    expect(emailContentV3DraftSchema.safeParse({ schema: 'email.content.v3', subject: '', preheader: '', body: { format: 'blocks', blocks: [nested] } }).success).toBe(false);
    const many = { id: 'c', type: 'conditional', when: { match: 'all', rules: [] }, then: Array.from({ length: 21 }, (_, i) => para(`p${i}`, 'x')), else: [] };
    expect(emailContentV3DraftSchema.safeParse({ schema: 'email.content.v3', subject: '', preheader: '', body: { format: 'blocks', blocks: [many] } }).success).toBe(false);
    const dup = { id: 'c', type: 'conditional', when: { match: 'all', rules: [] }, then: [para('a', 'x')], else: [para('a', 'y')] };
    expect(emailContentV3DraftSchema.safeParse({ schema: 'email.content.v3', subject: '', preheader: '', body: { format: 'blocks', blocks: [dup] } }).success).toBe(false);
    const tooMany = { id: 'c', type: 'conditional', when: { match: 'all', rules: Array.from({ length: 6 }, () => ({ field: 'contact.first_name', op: 'is_set' })) }, then: [], else: [] };
    expect(emailContentV3DraftSchema.safeParse({ schema: 'email.content.v3', subject: '', preheader: '', body: { format: 'blocks', blocks: [tooMany] } }).success).toBe(false);
  });

  it('merge fields are never allowed in URLs (C5 kept)', () => {
    const issues = contentIssuesV3(v3([{ id: 'b', type: 'button', label: 'Go', href: 'https://example.com/{{ contact.custom.token }}' }]));
    expect(issues).toEqual([expect.objectContaining({ code: 'LINK_INVALID', message: 'Links cannot contain merge fields' })]);
  });
});
