import { isSafeImageUrl, isSafeLinkUrl } from '@workeasy/shared';
import { parseFragment } from 'parse5';

/**
 * HTML block sanitizer (docs/contracts/phase-7-content-amendment.md §C, decisions C15–C16). Pure and browser-safe.
 *
 * The input is parsed by a standards-compliant HTML parser (parse5, the WHATWG algorithm browsers use), then REBUILT
 * from an allowlist: nothing from the input is copied through as markup. Text is escaped on output; attributes are
 * kept only when the element allows them and the value passes its check; `style` keeps only allowlisted properties
 * with plain values. Everything else is reported in `removed`, so callers can refuse instead of silently changing
 * what the user wrote (C16). The output is a fixed point: sanitizing it again gives the same string and removes nothing.
 */

export interface SanitizedHtml {
  html: string;
  /** Plain-text rendering (for the text/plain part). */
  text: string;
  /** What was removed, deduplicated, human-readable (e.g. `<script> element`, `onclick attribute`). Empty = nothing. */
  removed: string[];
}

export interface SanitizeOptions {
  /** Transforms text-node content before escaping (merge-field substitution at render time). Default: identity. */
  text?: (value: string) => string;
}

/** Removed together with everything inside them. */
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input', 'button', 'textarea',
  'select', 'option', 'optgroup', 'datalist', 'svg', 'math', 'template', 'noscript', 'noembed', 'noframes', 'link',
  'meta', 'base', 'title', 'head', 'canvas', 'video', 'audio', 'source', 'track', 'picture', 'dialog', 'slot', 'param',
  'map', 'area', 'xmp', 'plaintext', 'iframe', 'marquee', 'portal', 'search', 'menu',
]);

const STYLE = 'style';
const ALIGN = 'align';
/** Allowed elements and their allowed attributes. Elements not listed (and not dropped) are unwrapped: children kept. */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  p: [ALIGN, STYLE], div: [ALIGN, STYLE], span: [STYLE], br: [], hr: [STYLE],
  h1: [ALIGN, STYLE], h2: [ALIGN, STYLE], h3: [ALIGN, STYLE], h4: [ALIGN, STYLE],
  strong: [STYLE], b: [STYLE], em: [STYLE], i: [STYLE], u: [STYLE], s: [STYLE], small: [STYLE], sup: [], sub: [],
  code: [STYLE], pre: [STYLE], blockquote: [STYLE],
  ul: [STYLE], ol: [STYLE], li: [STYLE],
  a: ['href', 'title', STYLE],
  img: ['src', 'alt', 'width', 'height', STYLE],
  table: ['width', 'cellpadding', 'cellspacing', 'border', ALIGN, 'role', STYLE],
  thead: [], tbody: [], tfoot: [], tr: [STYLE],
  td: ['colspan', 'rowspan', ALIGN, 'valign', 'width', STYLE],
  th: ['colspan', 'rowspan', ALIGN, 'valign', 'width', STYLE],
};
const VOID = new Set(['br', 'hr', 'img']);
/** Block-level elements: a line break around them in the text rendering. */
const BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'pre', 'ul', 'ol', 'li', 'table', 'tr', 'hr']);

const int = (min: number, max: number) => (v: string) => /^\d{1,5}$/.test(v) && Number(v) >= min && Number(v) <= max;
const ATTR_CHECK: Readonly<Record<string, (v: string, tag: string) => boolean>> = {
  href: (v) => isSafeLinkUrl(v),
  src: (v) => isSafeImageUrl(v),
  title: (v) => v.length <= 250,
  alt: (v) => v.length <= 250,
  width: (v, tag) => (tag === 'img' ? int(1, 1200)(v) : int(1, 1200)(v) || (/^\d{1,3}%$/.test(v) && Number(v.slice(0, -1)) <= 100)),
  height: int(1, 1200),
  cellpadding: int(0, 50),
  cellspacing: int(0, 50),
  border: int(0, 5),
  colspan: int(1, 20),
  rowspan: int(1, 20),
  align: (v) => v === 'left' || v === 'center' || v === 'right',
  valign: (v) => v === 'top' || v === 'middle' || v === 'bottom',
  role: (v) => v === 'presentation',
};

/** CSS properties a `style` attribute may keep; values must be plain (see `plainCssValue`). */
const CSS_PROPS = new Set([
  'color', 'background-color', 'font-size', 'font-weight', 'font-style', 'font-family', 'text-align', 'text-decoration',
  'text-transform', 'line-height', 'letter-spacing', 'white-space', 'vertical-align', 'width', 'max-width', 'min-width',
  'height', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin', 'margin-top',
  'margin-right', 'margin-bottom', 'margin-left', 'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-color', 'border-style', 'border-width', 'border-radius', 'border-collapse', 'display',
]);
const DISPLAY = new Set(['block', 'inline', 'inline-block', 'none', 'table', 'table-row', 'table-cell']);

/**
 * A plain CSS value: letters, digits, `#`, `.`, `,`, `%`, spaces, hyphens, and quotes (font names); the only functions
 * allowed are rgb()/rgba()/hsl()/hsla() with numeric arguments. No `url(`, `expression(`, `var(`, escapes, comments,
 * `;`, `:`, `<`, `>`, `@` or `!important` can pass.
 */
function plainCssValue(prop: string, value: string): boolean {
  if (value.length === 0 || value.length > 200) return false;
  if (prop === 'display') return DISPLAY.has(value.toLowerCase());
  const withoutColors = value.replace(/\b(?:rgba?|hsla?)\(\s*[\d.\s,%]+\)/gi, 'c');
  if (!/^[a-zA-Z0-9#.,%\s'"-]+$/.test(withoutColors)) return false;
  const quotes = (withoutColors.match(/['"]/g) ?? []).length;
  if (quotes && prop !== 'font-family') return false;
  return quotes % 2 === 0;
}

/** Keeps allowlisted declarations; returns the normalized style (`prop:value;…`) and what was dropped. */
function sanitizeStyle(raw: string, removed: Set<string>): string {
  const kept: string[] = [];
  for (const decl of raw.split(';')) {
    if (!decl.trim()) continue;
    const colon = decl.indexOf(':');
    const prop = (colon < 0 ? decl : decl.slice(0, colon)).trim().toLowerCase();
    const value = colon < 0 ? '' : decl.slice(colon + 1).trim().replace(/\s+/g, ' ');
    if (colon > 0 && CSS_PROPS.has(prop) && plainCssValue(prop, value)) kept.push(`${prop}:${value}`);
    else removed.add(`style property "${prop.slice(0, 40)}"`);
  }
  return kept.join(';');
}

const escText = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
const escAttr = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

interface P5Node {
  nodeName: string;
  tagName?: string;
  value?: string;
  data?: string;
  attrs?: { name: string; value: string; prefix?: string; namespace?: string }[];
  namespaceURI?: string;
  childNodes?: P5Node[];
  content?: P5Node;
}

const HTML_NS = 'http://www.w3.org/1999/xhtml';

export function sanitizeHtml(input: string, options: SanitizeOptions = {}): SanitizedHtml {
  const transform = options.text ?? ((s: string) => s);
  const removed = new Set<string>();
  const fragment = parseFragment(input) as unknown as P5Node;
  const html: string[] = [];
  const text: string[] = [];

  const walk = (node: P5Node): void => {
    for (const child of node.childNodes ?? []) {
      if (child.nodeName === '#text') {
        const value = transform(child.value ?? '');
        html.push(escText(value));
        text.push(value);
        continue;
      }
      if (child.nodeName === '#comment') {
        removed.add('comment');
        continue;
      }
      if (child.nodeName.startsWith('#')) continue; // doctype and similar: nothing to keep
      const tag = (child.tagName ?? child.nodeName).toLowerCase();
      if (child.namespaceURI && child.namespaceURI !== HTML_NS) {
        removed.add(`<${tag}> element`);
        continue;
      }
      if (DROP_WITH_CONTENT.has(tag)) {
        removed.add(`<${tag}> element`);
        continue;
      }
      const allowed = ALLOWED[tag];
      if (!allowed) {
        removed.add(`<${tag}> element (its text is kept)`);
        walk(child);
        continue;
      }
      const attrs: string[] = [];
      for (const a of child.attrs ?? []) {
        const name = a.name.toLowerCase();
        if (a.prefix || a.namespace || !allowed.includes(name)) {
          removed.add(`${name.slice(0, 40)} attribute`);
          continue;
        }
        if (name === STYLE) {
          const style = sanitizeStyle(a.value, removed);
          if (style) attrs.push(`style="${escAttr(style)}"`);
          continue;
        }
        if (!ATTR_CHECK[name]!(a.value, tag)) {
          removed.add(name === 'href' ? `link "${a.value.slice(0, 40)}"` : name === 'src' ? `image "${a.value.slice(0, 40)}"` : `${name}="${a.value.slice(0, 20)}" attribute`);
          continue;
        }
        attrs.push(`${name}="${escAttr(a.value)}"`);
      }
      const open = `<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`;
      if (BLOCK.has(tag) || tag === 'br') text.push('\n');
      if (VOID.has(tag)) {
        html.push(open);
        if (tag === 'img') {
          const alt = child.attrs?.find((a) => a.name === 'alt')?.value;
          if (alt) text.push(`[${alt}]`);
        }
        if (tag === 'hr') text.push('----\n');
        continue;
      }
      html.push(open);
      const before = text.length;
      walk(child);
      html.push(`</${tag}>`);
      if (tag === 'a') {
        const href = attrs.find((a) => a.startsWith('href='));
        const target = child.attrs?.find((a) => a.name === 'href')?.value;
        const label = text.slice(before).join('');
        if (href && target && label.trim() !== target) text.push(` (${target})`);
      }
      if (BLOCK.has(tag)) text.push('\n');
    }
  };
  walk(fragment);
  return {
    html: html.join(''),
    text: text
      .join('')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    removed: [...removed],
  };
}
