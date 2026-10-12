import type { EmailRun } from '@workeasy/shared';

/**
 * Editor convenience: a tiny inline markup for heading/paragraph text ⇄ structured runs (the stored form).
 *   **bold**   __italic__   [link text](https://example.com)   and a backslash before \ * _ [ ] ( ) for a literal
 * Italic is `__`, never `*`, so adjacent bold and italic spans can never be ambiguous. A single underscore (merge-tag
 * names such as {{ contact.first_name }}) is plain text. Storage never contains markup — only runs — so this syntax
 * can change without a content migration. Unclosed markers are literal text (never an error while typing).
 */
export function markupToRuns(markup: string): EmailRun[] {
  const runs: EmailRun[] = [];
  parse(markup, {}, runs);
  return mergeRuns(runs);
}

export function runsToMarkup(runs: readonly EmailRun[]): string {
  return mergeRuns([...runs])
    .map((r) => {
      let s = r.href ? `[${escapeText(r.text)}](${encodeHref(r.href)})` : escapeText(r.text);
      if (r.italic) s = `__${s}__`;
      if (r.bold) s = `**${s}**`;
      return s;
    })
    .join('');
}

type Style = { bold?: true; italic?: true; href?: string };

const ESCAPABLE = '\\*_[]()';

function parse(s: string, style: Style, out: EmailRun[]): void {
  let text = '';
  const flush = () => {
    if (text) out.push({ text, ...(style.bold ? { bold: true as const } : {}), ...(style.italic ? { italic: true as const } : {}), ...(style.href ? { href: style.href } : {}) });
    text = '';
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === '\\' && i + 1 < s.length && ESCAPABLE.includes(s[i + 1]!)) {
      text += s[i + 1];
      i += 2;
      continue;
    }
    const span = s.startsWith('**', i) ? ('**' as const) : s.startsWith('__', i) ? ('__' as const) : null;
    if (span) {
      const end = findClose(s, span, i + 2);
      if (end > i + 2) {
        flush();
        parse(s.slice(i + 2, end), span === '**' ? { ...style, bold: true } : { ...style, italic: true }, out);
        i = end + 2;
        continue;
      }
    } else if (ch === '[' && !style.href) {
      const close = findClose(s, ']', i + 1);
      const m = close > i + 1 ? /^\(([^()\s]{1,2000})\)/.exec(s.slice(close + 1)) : null;
      if (m) {
        flush();
        parse(s.slice(i + 1, close), { ...style, href: m[1]! }, out);
        i = close + 1 + m[0].length;
        continue;
      }
    }
    text += ch;
    i++;
  }
  flush();
}

/** Index of the next unescaped `token` at or after `from`, or -1. */
function findClose(s: string, token: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      continue;
    }
    if (s.startsWith(token, i)) return i;
  }
  return -1;
}

/** Escapes what could start markup: backslash, `*`, brackets, and every underscore that touches another underscore. */
function escapeText(t: string): string {
  let out = '';
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    const doubleUnderscore = c === '_' && (t[i - 1] === '_' || t[i + 1] === '_');
    out += c === '\\' || c === '*' || c === '[' || c === ']' || doubleUnderscore ? `\\${c}` : c;
  }
  return out;
}

/** Characters that would end the link syntax are percent-encoded (the same URL to browsers and mail clients). */
function encodeHref(h: string): string {
  return h.replace(/[()\s]/g, (c) => (c === '(' ? '%28' : c === ')' ? '%29' : encodeURIComponent(c)));
}

/** Adjacent runs with identical formatting become one; empty runs disappear. */
function mergeRuns(runs: EmailRun[]): EmailRun[] {
  const out: EmailRun[] = [];
  for (const r of runs) {
    if (!r.text) continue;
    const prev = out.at(-1);
    if (prev && !!prev.bold === !!r.bold && !!prev.italic === !!r.italic && prev.href === r.href) prev.text += r.text;
    else out.push({ ...r });
  }
  return out;
}
