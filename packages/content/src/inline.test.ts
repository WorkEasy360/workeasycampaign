import type { EmailRun } from '@workeasy/shared';
import { describe, expect, it } from 'vitest';
import { markupToRuns, runsToMarkup } from './inline.js';

describe('inline markup ⇄ runs (editor convenience; storage is runs)', () => {
  it('parses bold, italic, links and nesting', () => {
    expect(markupToRuns('Hi **there** and __you__, read [the news](https://e.com/a_b?x=1) or **[shop](https://e.com/s)**.')).toEqual([
      { text: 'Hi ' },
      { text: 'there', bold: true },
      { text: ' and ' },
      { text: 'you', italic: true },
      { text: ', read ' },
      { text: 'the news', href: 'https://e.com/a_b?x=1' },
      { text: ' or ' },
      { text: 'shop', bold: true, href: 'https://e.com/s' },
      { text: '.' },
    ]);
  });

  it('merge tags and underscores are plain text', () => {
    expect(markupToRuns('Hi {{ contact.first_name | "there" }} snake_case_word')).toEqual([{ text: 'Hi {{ contact.first_name | "there" }} snake_case_word' }]);
  });

  it.each(['2 * 3 = 6', 'a ** b', '[not a link]', '[x](no space allowed)', '**unclosed', '*', '[', 'ends with \\'])('unclosed or invalid markup stays literal: %j', (s) => {
    expect(markupToRuns(s).map((r) => r.text).join('')).toBe(s);
    expect(markupToRuns(s).every((r) => !r.href)).toBe(true);
  });

  const CASES: EmailRun[][] = [
    [{ text: 'plain' }],
    [{ text: 'a*b**c[d]e\\f(g)' }],
    [{ text: 'x', bold: true }, { text: 'y', italic: true }, { text: 'z', bold: true, italic: true }],
    [{ text: 'link [with] *stars*', href: 'https://e.com/(paren)?q=a b' }],
    [{ text: '{{ contact.first_name }}', bold: true }, { text: ' ok' }],
    [{ text: 'line one\nline two' }],
  ];

  it.each(CASES)('round-trips runs → markup → runs: %j', (...runs) => {
    const back = markupToRuns(runsToMarkup(runs));
    // Parentheses and whitespace in URLs are percent-encoded by design (the same URL to browsers and mail clients).
    const expected = runs.map((r) => (r.href ? { ...r, href: r.href.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\s/g, '%20') } : r));
    expect(back).toEqual(expected);
  });

  it('merges adjacent runs with the same formatting and drops empty ones', () => {
    expect(markupToRuns('**a****b**')).toEqual([{ text: 'ab', bold: true }]);
    expect(markupToRuns('**x**__y__')).toEqual([{ text: 'x', bold: true }, { text: 'y', italic: true }]);
    expect(runsToMarkup([{ text: 'a' }, { text: '' }, { text: 'b' }])).toBe('ab');
  });
});
