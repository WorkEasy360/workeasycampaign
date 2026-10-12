import { EMAIL_CONTENT_V2_LIMITS, type EmailContentV2, type EmailContentV2Draft, contentTextLength, emailContentV2Schema, isSafeImageUrl, isSafeLinkUrl } from '@workeasy/shared';
import { parseTemplate } from './merge-tags.js';

/**
 * User-fixable problems of an `email.content.v2` draft (amendment §2, "schema vs readiness"). Pure; the API's
 * ChannelSpec turns them into readiness findings (`pointer` is relative to the content, e.g. "/body/blocks/2/href").
 * A content without issues always satisfies the complete `emailContentV2Schema`.
 */
export type ContentIssueCode =
  | 'SUBJECT_MISSING'
  | 'SUBJECT_TOO_LONG'
  | 'BODY_MISSING'
  | 'BODY_TOO_LONG'
  | 'MERGE_TAG_INVALID'
  | 'LINK_INVALID'
  | 'IMAGE_INVALID'
  | 'BUTTON_LABEL_MISSING';

export interface ContentIssue {
  code: ContentIssueCode;
  pointer: string;
  message: string;
}

export function contentIssues(c: EmailContentV2Draft): ContentIssue[] {
  const L = EMAIL_CONTENT_V2_LIMITS;
  const out: ContentIssue[] = [];
  const tags = (value: string, pointer: string) => {
    const e = parseTemplate(value).errors[0];
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

  let visible = false;
  c.body.blocks.forEach((b, i) => {
    const at = `/body/blocks/${i}`;
    switch (b.type) {
      case 'heading':
      case 'paragraph':
        b.runs.forEach((r, j) => {
          if (r.text.trim()) visible = true;
          tags(r.text, `${at}/runs/${j}/text`);
          link(r.href, `${at}/runs/${j}/href`);
        });
        return;
      case 'button':
        if (!b.label.trim()) out.push({ code: 'BUTTON_LABEL_MISSING', pointer: `${at}/label`, message: 'Give the button a label' });
        else visible = true;
        tags(b.label, `${at}/label`);
        link(b.href, `${at}/href`);
        return;
      case 'image':
        if (!isSafeImageUrl(b.src)) out.push({ code: 'IMAGE_INVALID', pointer: `${at}/src`, message: 'Use an image link starting with https://' });
        if (!b.alt.trim()) out.push({ code: 'IMAGE_INVALID', pointer: `${at}/alt`, message: 'Describe the image for people who cannot see it' });
        link(b.href, `${at}/href`);
        return;
      default:
        return;
    }
  });
  if (!visible) out.push({ code: 'BODY_MISSING', pointer: '/body', message: 'Write the message' });
  if (contentTextLength(c) > L.totalText) out.push({ code: 'BODY_TOO_LONG', pointer: '/body', message: `Use at most ${L.totalText.toLocaleString('en')} characters` });
  return out;
}

/**
 * The canonical stored form of a v2 draft (what versions and templates keep): subject and preheader trimmed, empty
 * text runs removed, headings and paragraphs left without text removed. Returns `null` when the content still has
 * issues; otherwise the result satisfies the complete `emailContentV2Schema` (checked here, so a violation is a bug
 * surfaced loudly rather than a stored invalid snapshot).
 */
export function canonicalContentV2(c: EmailContentV2Draft): EmailContentV2 | null {
  if (contentIssues(c).length) return null;
  const blocks = c.body.blocks.flatMap((b): EmailContentV2Draft['body']['blocks'] => {
    if (b.type !== 'heading' && b.type !== 'paragraph') return [b];
    const runs = b.runs.filter((r) => r.text.length > 0);
    return runs.some((r) => r.text.trim()) ? [{ ...b, runs }] : [];
  });
  return emailContentV2Schema.parse({ schema: 'email.content.v2', subject: c.subject.trim(), preheader: c.preheader.trim(), body: { format: 'blocks', blocks } });
}
