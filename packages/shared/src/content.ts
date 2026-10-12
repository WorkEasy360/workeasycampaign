/**
 * `email.content.v2` — structured email content (docs/contracts/phase-6-content-amendment.md §2). Contracts only:
 * merge-tag interpretation and rendering live in @workeasy/content; readiness findings in the API's ChannelSpec.
 *
 * No raw HTML exists anywhere in this shape (decision C1): HTML is produced only by the renderer, from these blocks.
 * One factory builds two strictness levels of the same shape:
 *  - `complete` — what versions and templates store: non-empty text, valid URLs;
 *  - `draft`    — what a draft may hold while being edited: text may be empty and URLs not yet valid (readiness
 *                 reports them as findings with JSON pointers instead of rejecting the save).
 */
import { z } from 'zod';

/** WHATWG URL (global in browsers and Node); this package compiles without DOM or Node type libraries. */
declare const URL: new (input: string) => { protocol: string; hostname: string };

export const EMAIL_CONTENT_V2_LIMITS = {
  subject: 200,
  preheader: 200,
  blocks: 100,
  runsPerHeading: 50,
  runsPerParagraph: 200,
  runText: 2_000,
  buttonLabel: 80,
  imageAlt: 250,
  url: 2_000,
  /** Subject + preheader + every run and label — the same bound as v1's body. */
  totalText: 100_000,
} as const;

export const BLOCK_TYPES = ['heading', 'paragraph', 'button', 'image', 'divider', 'spacer'] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];
export const SPACER_HEIGHTS = [8, 16, 24, 32, 48, 64] as const;

/** Link targets: https, http or mailto; no whitespace or control characters; a host for http(s). */
export function isSafeLinkUrl(value: string): boolean {
  return isUrl(value, ['https:', 'http:', 'mailto:']);
}

/** Image sources: https only (no mixed content). */
export function isSafeImageUrl(value: string): boolean {
  return isUrl(value, ['https:']);
}

function isUrl(value: string, protocols: string[]): boolean {
  if (value.length === 0 || value.length > EMAIL_CONTENT_V2_LIMITS.url) return false;
  if (/[\s\u0000-\u001f\u007f-\u009f]/.test(value)) return false;
  // Decision C5: merge fields are never allowed in URLs. Raw braces are not valid in a URL anyway (RFC 3986 requires
  // %7B/%7D), but the WHATWG parser accepts them — so `{{contact.email}}` would otherwise pass.
  if (/[{}]/.test(value)) return false;
  let u: { protocol: string; hostname: string };
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (!protocols.includes(u.protocol)) return false;
  if (u.protocol === 'mailto:') return /^mailto:[^@\s]+@[^@\s]+$/i.test(value.split('?')[0]!);
  // The parsed href must start with what was written (rejects "https:example.com"-style forms URL() normalizes).
  return u.hostname.length > 0 && value.toLowerCase().startsWith(`${u.protocol}//`);
}

const blockId = z.string().regex(/^[a-z0-9]{1,16}$/);
const align = z.enum(['left', 'center']).optional();

function shapes(level: 'complete' | 'draft') {
  const L = EMAIL_CONTENT_V2_LIMITS;
  const complete = level === 'complete';
  const text = (max: number) => (complete ? z.string().min(1).max(max) : z.string().max(max));
  const link = complete ? z.string().max(L.url).refine(isSafeLinkUrl, 'Must be an https, http or mailto link') : z.string().max(L.url);
  const image = complete ? z.string().max(L.url).refine(isSafeImageUrl, 'Images must use https') : z.string().max(L.url);

  const run = z.strictObject({ text: text(L.runText), bold: z.literal(true).optional(), italic: z.literal(true).optional(), href: link.optional() });
  const runs = (max: number) => z.array(run).min(complete ? 1 : 0).max(max);

  const block = z.discriminatedUnion('type', [
    z.strictObject({ id: blockId, type: z.literal('heading'), level: z.union([z.literal(1), z.literal(2), z.literal(3)]), runs: runs(L.runsPerHeading) }),
    z.strictObject({ id: blockId, type: z.literal('paragraph'), runs: runs(L.runsPerParagraph), align }),
    z.strictObject({ id: blockId, type: z.literal('button'), label: text(L.buttonLabel), href: link, align }),
    z.strictObject({
      id: blockId,
      type: z.literal('image'),
      src: image,
      alt: text(L.imageAlt),
      width: z.number().int().min(16).max(600).optional(),
      href: link.optional(),
    }),
    z.strictObject({ id: blockId, type: z.literal('divider') }),
    z.strictObject({ id: blockId, type: z.literal('spacer'), height: z.union([z.literal(8), z.literal(16), z.literal(24), z.literal(32), z.literal(48), z.literal(64)]) }),
  ]);

  const content = z
    .strictObject({
      schema: z.literal('email.content.v2'),
      subject: text(L.subject),
      preheader: z.string().max(L.preheader),
      body: z.strictObject({ format: z.literal('blocks'), blocks: z.array(block).min(complete ? 1 : 0).max(L.blocks) }),
    })
    .superRefine((c, ctx) => {
      const seen = new Set<string>();
      c.body.blocks.forEach((b, i) => {
        if (seen.has(b.id)) ctx.addIssue({ code: 'custom', path: ['body', 'blocks', i, 'id'], message: 'Block ids must be unique' });
        seen.add(b.id);
      });
      if (contentTextLength(c) > L.totalText) ctx.addIssue({ code: 'custom', path: ['body'], message: `At most ${L.totalText} characters of text` });
    });
  return { run, block, content };
}

const COMPLETE = shapes('complete');
const DRAFT = shapes('draft');

/** `email.content.v2` as stored in versions and templates. */
export const emailContentV2Schema = COMPLETE.content;
export type EmailContentV2 = z.infer<typeof emailContentV2Schema>;
export type EmailBlock = z.infer<typeof COMPLETE.block>;
export type EmailRun = z.infer<typeof COMPLETE.run>;

/** `email.content.v2` while being edited (same shape; empty text and unfinished URLs allowed). */
export const emailContentV2DraftSchema = DRAFT.content;
export type EmailContentV2Draft = z.infer<typeof emailContentV2DraftSchema>;

/** The v2 block schemas per strictness level; `email.content.v3` reuses them unchanged as its leaf blocks. */
export const emailBlockV2Schema = COMPLETE.block;
export const emailBlockV2DraftSchema = DRAFT.block;

/** Characters of user text in a v2 content (subject, preheader, runs, labels, alt texts). */
export function contentTextLength(c: { subject: string; preheader: string; body: { blocks: readonly unknown[] } }): number {
  let n = c.subject.length + c.preheader.length;
  for (const raw of c.body.blocks) {
    const b = raw as { runs?: { text: string }[]; label?: string; alt?: string };
    for (const r of b.runs ?? []) n += r.text.length;
    n += (b.label ?? '').length + (b.alt ?? '').length;
  }
  return n;
}

// ─── merge tags (amendment §3) ──────────────────────────────────────────────────────────────────────────────────

/** The closed allowlist of `merge_tags_v1`. */
export const MERGE_TAG_NAMES = ['contact.first_name', 'contact.last_name', 'contact.company', 'contact.email'] as const;
export type MergeTagName = (typeof MERGE_TAG_NAMES)[number];
export const mergeTagNameSchema = z.enum(MERGE_TAG_NAMES);
export const MERGE_TAG_FALLBACK_MAX = 100;

/** Values for one recipient (or the example profile). Missing / null = no value (the fallback applies). */
const mergeValue = z.string().max(320).nullable().optional();
export const mergeDataSchema = z.strictObject({
  'contact.first_name': mergeValue,
  'contact.last_name': mergeValue,
  'contact.company': mergeValue,
  'contact.email': mergeValue,
});
export type MergeData = Partial<Record<MergeTagName, string | null>>;

/** The fixed example profile used by previews without a contact (amendment §5). */
export const EXAMPLE_MERGE_DATA: Readonly<Record<MergeTagName, string>> = Object.freeze({
  'contact.first_name': 'Alex',
  'contact.last_name': 'Example',
  'contact.company': 'Example Co',
  'contact.email': 'alex@example.com',
});
