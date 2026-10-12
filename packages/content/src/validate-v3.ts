import {
  CONDITION_OPS_WITH_VALUE,
  EMAIL_CONTENT_V3_LIMITS,
  type EmailContentV3,
  type EmailContentV3Draft,
  type EmailLeafBlockV3Draft,
  contentV3TextLength,
  emailContentV3Schema,
  isMergeFieldNameV2,
  isSafeImageUrl,
  isSafeLinkUrl,
} from '@workeasy/shared';
import { parseTemplateV2 } from './merge-tags.js';
import { sanitizeHtml } from './sanitize-html.js';
import type { ContentIssue } from './validate.js';

/**
 * User-fixable problems of an `email.content.v3` draft (docs/contracts/phase-7-content-amendment.md §C). Pure. Same
 * contract as v2's `contentIssues`: pointers are relative to the content, and a content without issues always
 * canonicalizes to a valid `emailContentV3Schema` value. Codes added in v3: HTML_UNSUPPORTED, HTML_MISSING,
 * CONDITION_INVALID, CONDITIONAL_EMPTY.
 */
export type ContentIssueV3 = Omit<ContentIssue, 'code'> & {
  code: ContentIssue['code'] | 'HTML_UNSUPPORTED' | 'HTML_MISSING' | 'CONDITION_INVALID' | 'CONDITIONAL_EMPTY';
};

export function contentIssuesV3(c: EmailContentV3Draft): ContentIssueV3[] {
  const L = EMAIL_CONTENT_V3_LIMITS;
  const out: ContentIssueV3[] = [];
  const tags = (value: string, pointer: string) => {
    const e = parseTemplateV2(value).errors[0];
    if (e) out.push({ code: 'MERGE_TAG_INVALID', pointer, message: e.message });
  };
  const link = (href: string | undefined, pointer: string) => {
    if (href !== undefined && !isSafeLinkUrl(href)) {
      out.push({ code: 'LINK_INVALID', pointer, message: href.includes('{{') ? 'Links cannot contain merge fields' : 'Use a full link starting with https://, http:// or mailto:' });
    }
  };

  if (!c.subject.trim()) out.push({ code: 'SUBJECT_MISSING', pointer: '/subject', message: 'Add a subject' });
  else if (c.subject.length > L.subject) out.push({ code: 'SUBJECT_TOO_LONG', pointer: '/subject', message: `Use at most ${L.subject} characters` });
  tags(c.subject, '/subject');
  tags(c.preheader, '/preheader');

  /** Returns whether the leaf shows something. */
  const leaf = (b: EmailLeafBlockV3Draft, at: string): boolean => {
    switch (b.type) {
      case 'heading':
      case 'paragraph': {
        let visible = false;
        b.runs.forEach((r, j) => {
          if (r.text.trim()) visible = true;
          tags(r.text, `${at}/runs/${j}/text`);
          link(r.href, `${at}/runs/${j}/href`);
        });
        return visible;
      }
      case 'button':
        tags(b.label, `${at}/label`);
        link(b.href, `${at}/href`);
        if (!b.label.trim()) {
          out.push({ code: 'BUTTON_LABEL_MISSING', pointer: `${at}/label`, message: 'Give the button a label' });
          return false;
        }
        return true;
      case 'image':
        if (!isSafeImageUrl(b.src)) out.push({ code: 'IMAGE_INVALID', pointer: `${at}/src`, message: 'Use an image link starting with https://' });
        if (!b.alt.trim()) out.push({ code: 'IMAGE_INVALID', pointer: `${at}/alt`, message: 'Describe the image for people who cannot see it' });
        link(b.href, `${at}/href`);
        return true;
      case 'html': {
        if (!b.html.trim()) {
          out.push({ code: 'HTML_MISSING', pointer: `${at}/html`, message: 'Add HTML, or remove this block' });
          return false;
        }
        const s = sanitizeHtml(b.html);
        if (s.removed.length) {
          const shown = s.removed.slice(0, 5).join(', ');
          out.push({
            code: 'HTML_UNSUPPORTED',
            pointer: `${at}/html`,
            message: `This HTML contains things emails cannot safely include: ${shown}${s.removed.length > 5 ? ` and ${s.removed.length - 5} more` : ''}. Use “Clean HTML” to remove them.`,
          });
        }
        tags(s.text, `${at}/html`);
        return s.text.trim() !== '' || /<img\b/.test(s.html);
      }
      default:
        return false; // divider, spacer: valid, but not content on their own
    }
  };

  let visible = false;
  c.body.blocks.forEach((b, i) => {
    const at = `/body/blocks/${i}`;
    if (b.type !== 'conditional') {
      if (leaf(b, at)) visible = true;
      return;
    }
    if (!b.when.rules.length) out.push({ code: 'CONDITION_INVALID', pointer: `${at}/when`, message: 'Add at least one rule' });
    b.when.rules.forEach((r, j) => {
      const rp = `${at}/when/rules/${j}`;
      if (!isMergeFieldNameV2(r.field)) out.push({ code: 'CONDITION_INVALID', pointer: `${rp}/field`, message: 'Choose a field' });
      const needs = CONDITION_OPS_WITH_VALUE.has(r.op);
      if (needs && !(r.value ?? '').trim()) out.push({ code: 'CONDITION_INVALID', pointer: `${rp}/value`, message: 'Enter a value to compare with' });
      if (!needs && r.value !== undefined && r.value !== '') out.push({ code: 'CONDITION_INVALID', pointer: `${rp}/value`, message: 'This rule does not use a value' });
    });
    let shows = false;
    b.then.forEach((x, j) => {
      if (leaf(x, `${at}/then/${j}`)) shows = true;
    });
    b.else.forEach((x, j) => {
      if (leaf(x, `${at}/else/${j}`)) shows = true;
    });
    if (!shows) out.push({ code: 'CONDITIONAL_EMPTY', pointer: at, message: 'Add content to at least one branch' });
    else visible = true;
  });
  if (!visible) out.push({ code: 'BODY_MISSING', pointer: '/body', message: 'Write the message' });
  if (contentV3TextLength(c) > L.totalText) out.push({ code: 'BODY_TOO_LONG', pointer: '/body', message: `Use at most ${L.totalText.toLocaleString('en')} characters` });
  return out;
}

/**
 * Every valid merge field a v3 content can read (text, labels, HTML text nodes and condition rules — all branches),
 * deduplicated in first-use order. Callers use it to ask Audience only for the custom fields actually referenced.
 */
export function mergeFieldsUsedV3(c: EmailContentV3Draft): string[] {
  const out: string[] = [];
  const add = (name: string) => {
    if (isMergeFieldNameV2(name) && !out.includes(name)) out.push(name);
  };
  const scan = (s: string) => {
    for (const p of parseTemplateV2(s).parts) if (p.kind === 'tag') add(p.name);
  };
  const leaf = (b: EmailLeafBlockV3Draft) => {
    if (b.type === 'heading' || b.type === 'paragraph') for (const r of b.runs) scan(r.text);
    else if (b.type === 'button') scan(b.label);
    else if (b.type === 'html') scan(sanitizeHtml(b.html).text);
  };
  scan(c.subject);
  scan(c.preheader);
  for (const b of c.body.blocks) {
    if (b.type !== 'conditional') {
      leaf(b);
      continue;
    }
    for (const r of b.when.rules) add(r.field);
    b.then.forEach(leaf);
    b.else.forEach(leaf);
  }
  return out;
}

/**
 * The canonical stored form of a v3 draft: subject/preheader trimmed; empty runs and text-less headings/paragraphs
 * removed (in branches too); rule values trimmed (and omitted where the op takes none); HTML in the sanitizer's
 * normalized serialization (a fixed point, C16). Returns `null` while the content has issues.
 */
export function canonicalContentV3(c: EmailContentV3Draft): EmailContentV3 | null {
  if (contentIssuesV3(c).length) return null;
  const leaves = (blocks: readonly EmailLeafBlockV3Draft[]) =>
    blocks.flatMap((b): EmailLeafBlockV3Draft[] => {
      if (b.type === 'html') return [{ ...b, html: sanitizeHtml(b.html).html }];
      if (b.type !== 'heading' && b.type !== 'paragraph') return [b];
      const runs = b.runs.filter((r) => r.text.length > 0);
      return runs.some((r) => r.text.trim()) ? [{ ...b, runs }] : [];
    });
  // Built loosely, then fully validated by the complete schema below.
  const blocks = c.body.blocks.flatMap((b): unknown[] => {
    if (b.type !== 'conditional') return leaves([b]);
    const rules = b.when.rules.map((r) => (CONDITION_OPS_WITH_VALUE.has(r.op) ? { field: r.field, op: r.op, value: (r.value ?? '').trim() } : { field: r.field, op: r.op }));
    return [{ ...b, when: { match: b.when.match, rules }, then: leaves(b.then), else: leaves(b.else) }];
  });
  return emailContentV3Schema.parse({ schema: 'email.content.v3', subject: c.subject.trim(), preheader: c.preheader.trim(), body: { format: 'blocks', blocks } });
}
