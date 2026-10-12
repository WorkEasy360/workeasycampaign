import {
  type EmailBlock,
  type EmailContentV1,
  type EmailContentV2,
  type EmailContentV3,
  type EmailRun,
  isSafeImageUrl,
  isSafeLinkUrl,
  type MergeDataV2,
} from '@workeasy/shared';
import { evaluateCondition, type ConditionLike } from './conditions.js';
import { parseTemplate, parseTemplateV2, type TemplatePart, tagValue, tagValueV2, type TemplatePartV2 } from './merge-tags.js';
import { sanitizeHtml } from './sanitize-html.js';

/**
 * Email rendering (docs/contracts/phase-6-content-amendment.md §4). Pure: the same function serves the web preview,
 * the API preview and (Phase 8) delivery, so what a user previews is what a recipient gets.
 *
 * Safety by construction (decision C1): the only markup is the fixed layout below. Every piece of user text and every
 * merge value is escaped; every URL is re-checked against the allowlist here (defence in depth behind the schema) and
 * dropped — keeping its text — when it fails. No script, style-with-input, event handler or form is ever emitted.
 */

export interface RenderContext {
  /** Real unsubscribe link (delivery) or a `#…` placeholder (preview). */
  unsubscribeUrl: string;
  /** Why the recipient gets this email, e.g. "you subscribed to Marketing at Acme". Plain text. */
  reason: string;
}

export interface RenderedEmail {
  subject: string;
  preheader: string;
  html: string;
  text: string;
  /**
   * Merge fields present in the RENDERED content (deduplicated, first-use order): for v3, only the branch a condition
   * selected counts, plus the fields the conditions themselves read.
   */
  usedTags: string[];
}

/** Content whose text is still being edited may be rendered too (preview of a draft); shape is the v2 draft shape. */
type AnyContent =
  | EmailContentV1
  | EmailContentV2
  | EmailContentV3
  | (Omit<EmailContentV2, 'body' | 'schema'> & { schema: 'email.content.v2' | 'email.content.v3'; body: { format: 'blocks'; blocks: readonly unknown[] } });

export function renderEmail(content: AnyContent, data: MergeDataV2, ctx: RenderContext): RenderedEmail {
  if (!(ctx.unsubscribeUrl.startsWith('#') || isSafeLinkUrl(ctx.unsubscribeUrl))) throw new TypeError('unsubscribeUrl must be a safe link or a #placeholder');
  const used: string[] = [];
  const use = (name: string) => {
    if (!used.includes(name)) used.push(name);
  };
  // v1 is rendered verbatim (personalization 'none'); v2 interprets merge_tags_v1; v3 interprets merge_tags_v2.
  const fill = (s: string): string => {
    if (content.schema === 'email.content.v1') return s;
    let out = '';
    if (content.schema === 'email.content.v2') {
      for (const p of parseTemplate(s).parts) {
        if (p.kind === 'tag') use(p.name);
        out += p.kind === 'text' ? p.value : tagValue(p as Extract<TemplatePart, { kind: 'tag' }>, data);
      }
      return out;
    }
    for (const p of parseTemplateV2(s).parts) {
      if (p.kind === 'tag') use(p.name);
      out += p.kind === 'text' ? p.value : tagValueV2(p as Extract<TemplatePartV2, { kind: 'tag' }>, data);
    }
    return out;
  };

  const subject = oneLine(fill(content.subject));
  const preheader = oneLine(fill(content.preheader));
  const html: string[] = [];
  const text: string[] = [];

  if (content.schema === 'email.content.v1') {
    for (const para of content.body.text.split(/\n\s*\n/)) {
      if (!para.trim()) continue;
      html.push(`<p style="${P}">${esc(para.trim()).replace(/\n/g, '<br>')}</p>`);
      text.push(para.trim());
    }
  } else if (content.schema === 'email.content.v2') {
    for (const raw of content.body.blocks) renderBlock(raw as EmailBlock, fill, html, text);
  } else {
    for (const raw of content.body.blocks) {
      const b = raw as { type: string; when?: ConditionLike; then?: unknown[]; else?: unknown[] };
      if (b.type === 'conditional') {
        for (const r of b.when?.rules ?? []) if (r.field) use(r.field);
        const branch = b.when && evaluateCondition(b.when, data) ? b.then : b.else;
        for (const leaf of branch ?? []) renderLeafV3(leaf, fill, html, text);
      } else renderLeafV3(raw, fill, html, text);
    }
  }

  const footerText = `You are receiving this email because ${ctx.reason}.`;
  html.push(
    `<p style="${FOOT}">${esc(footerText)}<br><a href="${esc(ctx.unsubscribeUrl)}" style="color:#6b7280;text-decoration:underline">Unsubscribe</a></p>`,
  );
  text.push('--', footerText, `Unsubscribe: ${ctx.unsubscribeUrl}`);

  return {
    subject,
    preheader,
    html: layout(esc(subject), esc(preheader), html.join('\n')),
    text: text.join('\n\n'),
    usedTags: used,
  };
}

/** A v3 leaf: the v2 blocks unchanged, plus `html` — always re-sanitized here (C16, defence in depth). */
function renderLeafV3(raw: unknown, fill: (s: string) => string, html: string[], text: string[]): void {
  const b = raw as { type: string; html?: string };
  if (b.type !== 'html') return renderBlock(raw as EmailBlock, fill, html, text);
  const out = sanitizeHtml(b.html ?? '', { text: fill });
  if (!out.html.trim()) return;
  html.push(`<div style="${P}">${out.html}</div>`);
  if (out.text) text.push(out.text);
}

function renderBlock(b: EmailBlock, fill: (s: string) => string, html: string[], text: string[]): void {
  switch (b.type) {
    case 'heading': {
      const r = runs(b.runs, fill);
      if (!r.text.trim()) return;
      const level = b.level === 1 || b.level === 3 ? b.level : 2; // never trust a value into a tag name
      html.push(`<h${level} style="${H[level]}">${r.html}</h${level}>`);
      text.push(r.text);
      return;
    }
    case 'paragraph': {
      const r = runs(b.runs, fill);
      if (!r.text.trim()) return;
      html.push(`<p style="${P}${b.align === 'center' ? 'text-align:center;' : ''}">${r.html}</p>`);
      text.push(r.text);
      return;
    }
    case 'button': {
      const label = fill(b.label);
      if (!label.trim()) return;
      const align = b.align === 'center' ? 'center' : 'left';
      if (isSafeLinkUrl(b.href)) {
        html.push(
          `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${align}" style="margin:8px 0 16px"><tr><td style="border-radius:6px;background:#1d4ed8">` +
            `<a href="${esc(b.href)}" style="display:inline-block;padding:12px 20px;font:600 15px/1.2 Arial,sans-serif;color:#ffffff;text-decoration:none">${esc(label)}</a></td></tr></table>`,
        );
        text.push(`${label}: ${b.href}`);
      } else {
        html.push(`<p style="${P}">${esc(label)}</p>`);
        text.push(label);
      }
      return;
    }
    case 'image': {
      if (!isSafeImageUrl(b.src)) {
        if (b.alt) text.push(`[${b.alt}]`);
        return;
      }
      const n = Math.trunc(Number(b.width));
      const width = Number.isFinite(n) && n >= 16 ? Math.min(600, n) : 600; // a number, always (defence in depth)
      const img = `<img src="${esc(b.src)}" alt="${esc(b.alt)}" width="${width}" style="display:block;max-width:100%;height:auto;border:0" />`;
      html.push(`<div style="margin:0 0 16px">${b.href && isSafeLinkUrl(b.href) ? `<a href="${esc(b.href)}">${img}</a>` : img}</div>`);
      text.push(`[${b.alt}]${b.href && isSafeLinkUrl(b.href) ? ` (${b.href})` : ''}`);
      return;
    }
    case 'divider':
      html.push('<hr style="border:0;border-top:1px solid #e5e7eb;margin:24px 0" />');
      text.push('----');
      return;
    case 'spacer':
      html.push(`<div style="height:${Number(b.height) || 16}px;line-height:${Number(b.height) || 16}px">&nbsp;</div>`);
      return;
  }
}

function runs(rs: readonly EmailRun[], fill: (s: string) => string): { html: string; text: string } {
  let html = '';
  let text = '';
  for (const r of rs) {
    const value = fill(r.text);
    if (!value) continue;
    let h = esc(value).replace(/\n/g, '<br>');
    if (r.bold) h = `<strong>${h}</strong>`;
    if (r.italic) h = `<em>${h}</em>`;
    if (r.href && isSafeLinkUrl(r.href)) {
      h = `<a href="${esc(r.href)}" style="color:#1d4ed8;text-decoration:underline">${h}</a>`;
      text += value === r.href ? value : `${value} (${r.href})`;
    } else text += value;
    html += h;
  }
  return { html, text };
}

const P = 'margin:0 0 16px;font:16px/1.5 Arial,sans-serif;color:#111827;';
const H: Record<1 | 2 | 3, string> = {
  1: 'margin:0 0 16px;font:700 28px/1.25 Arial,sans-serif;color:#111827;',
  2: 'margin:0 0 12px;font:700 22px/1.3 Arial,sans-serif;color:#111827;',
  3: 'margin:0 0 8px;font:700 18px/1.35 Arial,sans-serif;color:#111827;',
};
const FOOT = 'margin:32px 0 0;font:12px/1.5 Arial,sans-serif;color:#6b7280;';

function layout(subject: string, preheader: string, body: string): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${subject}</title></head>`,
    '<body style="margin:0;padding:0;background:#f3f4f6">',
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${preheader}</div>`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6"><tr><td align="center" style="padding:24px 12px">',
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:8px"><tr><td style="padding:32px">',
    body,
    '</td></tr></table></td></tr></table></body></html>',
  ].join('\n');
}

/** HTML-escapes text and attribute values (both quote kinds). */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Subjects and preheaders are single-line (header injection: no CR/LF ever reaches a header). */
const oneLine = (s: string) => s.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim();
