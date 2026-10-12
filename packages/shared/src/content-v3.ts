/**
 * `email.content.v3` (docs/contracts/phase-7-content-amendment.md §C, decisions C11–C17). Contracts only: merge-field
 * interpretation, condition evaluation, HTML sanitizing and rendering live in @workeasy/content.
 *
 * v3 = the v2 leaf blocks, unchanged, plus:
 *  - `html` — HTML that must be a fixed point of the @workeasy/content sanitizer to be stored (C15, C16);
 *  - `conditional` — IF `when` THEN blocks ELSE blocks; leaf blocks only (no nesting), deterministic data (C11, C12).
 * Personalization is `merge_tags_v2`: the v1 names plus `contact.custom.<key>`, `workspace.name`, `organization.name`.
 */
import { z } from 'zod';
import { EMAIL_CONTENT_V2_LIMITS, MERGE_TAG_FALLBACK_MAX, MERGE_TAG_NAMES, emailBlockV2DraftSchema, emailBlockV2Schema } from './content.js';

export const EMAIL_CONTENT_V3_LIMITS = {
  ...EMAIL_CONTENT_V2_LIMITS,
  /** Characters of one HTML block (input; the sanitized form is never longer). */
  html: 50_000,
  /** Blocks per branch of a conditional. */
  branchBlocks: 20,
  /** Rules per condition. */
  rules: 5,
  ruleValue: 100,
  /** Characters of one custom-field value as personalization data (C14). */
  mergeValue: 1_000,
} as const;

// ─── merge_tags_v2 (C13) ────────────────────────────────────────────────────────────────────────────────────────

/** Audience custom-field key format (docs/contracts/phase-5-audience.md: 2–40 lowercase letters, digits, underscores). */
export const CUSTOM_FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
export const MERGE_FIELD_V2_PATTERN = /^(?:contact\.(?:first_name|last_name|company|email)|contact\.custom\.[a-z][a-z0-9_]{1,39}|workspace\.name|organization\.name)$/;
export const MERGE_FIELD_V2_FIXED = [...MERGE_TAG_NAMES, 'workspace.name', 'organization.name'] as const;
export type MergeFieldNameV2 = string;
export const mergeFieldNameV2Schema = z.string().max(60).regex(MERGE_FIELD_V2_PATTERN);
export const isMergeFieldNameV2 = (name: string): boolean => name.length <= 60 && MERGE_FIELD_V2_PATTERN.test(name);
/** `contact.custom.<key>` → `<key>`; anything else → null. */
export const customFieldKeyOf = (name: string): string | null => (name.startsWith('contact.custom.') && isMergeFieldNameV2(name) ? name.slice('contact.custom.'.length) : null);
export { MERGE_TAG_FALLBACK_MAX };

/** Personalization values of one recipient (or an example profile): name → text, or null / absent = no value. */
export const mergeDataV2Schema = z.record(mergeFieldNameV2Schema, z.string().max(EMAIL_CONTENT_V3_LIMITS.mergeValue).nullable());
export type MergeDataV2 = Readonly<Record<string, string | null | undefined>>;

/** The fixed part of the example profile used by previews without a contact (custom fields get "<label> (example)"). */
export const EXAMPLE_MERGE_DATA_V2: Readonly<Record<string, string>> = Object.freeze({
  'contact.first_name': 'Alex',
  'contact.last_name': 'Example',
  'contact.company': 'Example Co',
  'contact.email': 'alex@example.com',
  'workspace.name': 'Your workspace',
  'organization.name': 'Your organization',
});

// ─── conditions (C12) ───────────────────────────────────────────────────────────────────────────────────────────

export const CONDITION_OPS = ['is_set', 'is_not_set', 'equals', 'not_equals', 'contains', 'not_contains'] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];
export const CONDITION_OPS_WITH_VALUE: ReadonlySet<ConditionOp> = new Set(['equals', 'not_equals', 'contains', 'not_contains']);

// ─── schemas ────────────────────────────────────────────────────────────────────────────────────────────────────

const blockId = z.string().regex(/^[a-z0-9]{1,16}$/);

function shapes(level: 'complete' | 'draft') {
  const L = EMAIL_CONTENT_V3_LIMITS;
  const complete = level === 'complete';
  const v2 = complete ? emailBlockV2Schema : emailBlockV2DraftSchema;

  const rule = complete
    ? z
        .strictObject({ field: mergeFieldNameV2Schema, op: z.enum(CONDITION_OPS), value: z.string().min(1).max(L.ruleValue).optional() })
        .refine((r) => CONDITION_OPS_WITH_VALUE.has(r.op) === (r.value !== undefined && r.value.trim() !== ''), {
          path: ['value'],
          error: 'A value is required for equals/contains rules and not allowed for is_set/is_not_set',
        })
    : z.strictObject({ field: z.string().max(60), op: z.enum(CONDITION_OPS), value: z.string().max(L.ruleValue).optional() });
  const condition = z.strictObject({ match: z.enum(['all', 'any']), rules: z.array(rule).min(complete ? 1 : 0).max(L.rules) });

  const html = z.strictObject({ id: blockId, type: z.literal('html'), html: complete ? z.string().min(1).max(L.html) : z.string().max(L.html) });
  const leaf = z.discriminatedUnion('type', [...v2.options, html]);
  const conditional = z.strictObject({
    id: blockId,
    type: z.literal('conditional'),
    when: condition,
    then: z.array(leaf).max(L.branchBlocks),
    else: z.array(leaf).max(L.branchBlocks),
  });
  const block = z.discriminatedUnion('type', [...leaf.options, conditional]);

  const content = z
    .strictObject({
      schema: z.literal('email.content.v3'),
      subject: complete ? z.string().min(1).max(L.subject) : z.string().max(L.subject),
      preheader: z.string().max(L.preheader),
      body: z.strictObject({ format: z.literal('blocks'), blocks: z.array(block).min(complete ? 1 : 0).max(L.blocks) }),
    })
    .superRefine((c, ctx) => {
      const seen = new Set<string>();
      let count = 0;
      const visit = (b: { id: string }, path: (string | number)[]) => {
        count++;
        if (seen.has(b.id)) ctx.addIssue({ code: 'custom', path: [...path, 'id'], message: 'Block ids must be unique' });
        seen.add(b.id);
      };
      c.body.blocks.forEach((b, i) => {
        visit(b, ['body', 'blocks', i]);
        if (b.type === 'conditional') {
          b.then.forEach((x, j) => visit(x, ['body', 'blocks', i, 'then', j]));
          b.else.forEach((x, j) => visit(x, ['body', 'blocks', i, 'else', j]));
        }
      });
      if (count > L.blocks) ctx.addIssue({ code: 'custom', path: ['body'], message: `At most ${L.blocks} blocks, counting conditional branches` });
      if (contentV3TextLength(c) > L.totalText) ctx.addIssue({ code: 'custom', path: ['body'], message: `At most ${L.totalText} characters of text` });
    });
  return { rule, condition, html, leaf, conditional, block, content };
}

const COMPLETE = shapes('complete');
const DRAFT = shapes('draft');

/** `email.content.v3` as stored in versions and templates (HTML additionally verified by @workeasy/content). */
export const emailContentV3Schema = COMPLETE.content;
export type EmailContentV3 = z.infer<typeof emailContentV3Schema>;
export type EmailBlockV3 = z.infer<typeof COMPLETE.block>;
export type EmailLeafBlockV3 = z.infer<typeof COMPLETE.leaf>;
export type EmailConditionalBlock = z.infer<typeof COMPLETE.conditional>;
export type EmailCondition = z.infer<typeof COMPLETE.condition>;
export type EmailConditionRule = z.infer<typeof COMPLETE.rule>;

/** `email.content.v3` while being edited (empty text, unfinished URLs and rules allowed; readiness reports them). */
export const emailContentV3DraftSchema = DRAFT.content;
export type EmailContentV3Draft = z.infer<typeof emailContentV3DraftSchema>;
export type EmailBlockV3Draft = z.infer<typeof DRAFT.block>;
export type EmailLeafBlockV3Draft = z.infer<typeof DRAFT.leaf>;

/** Leaf blocks of a v3 body in document order, with the conditional they belong to (if any). */
export function* leafBlocksV3<B extends { type: string }>(blocks: readonly B[]): Generator<{ block: B; path: (string | number)[] }> {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]! as B & { then?: B[]; else?: B[] };
    if (b.type === 'conditional') {
      for (let j = 0; j < (b.then ?? []).length; j++) yield { block: b.then![j]!, path: [i, 'then', j] };
      for (let j = 0; j < (b.else ?? []).length; j++) yield { block: b.else![j]!, path: [i, 'else', j] };
    } else yield { block: b, path: [i] };
  }
}

/** Characters of user text in a v3 content (subject, preheader, runs, labels, alt texts, HTML, rule values). */
export function contentV3TextLength(c: { subject: string; preheader: string; body: { blocks: readonly unknown[] } }): number {
  let n = c.subject.length + c.preheader.length;
  for (const { block } of leafBlocksV3(c.body.blocks as { type: string }[])) {
    const b = block as { runs?: { text: string }[]; label?: string; alt?: string; html?: string };
    for (const r of b.runs ?? []) n += r.text.length;
    n += (b.label ?? '').length + (b.alt ?? '').length + (b.html ?? '').length;
  }
  for (const raw of c.body.blocks) {
    const b = raw as { type: string; when?: { rules: { value?: string }[] } };
    if (b.type === 'conditional') for (const r of b.when?.rules ?? []) n += (r.value ?? '').length;
  }
  return n;
}
