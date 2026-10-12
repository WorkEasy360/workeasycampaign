/**
 * AI content assistance — contract only (docs/architecture/ai-billing-readiness.md §1). Nothing calls a model in this
 * phase. The contract fixes the safety rules any future implementation must keep:
 *  - input is ids and the draft content the user can already edit (no contact data, never other tenants' content);
 *  - output is a SUGGESTION in the existing content shapes (subject text, or email.content.v2 draft blocks) — it is
 *    never applied automatically; the user applies it, and it then goes through the normal draft update, readiness,
 *    rendering and permission rules (an AI suggestion can never bypass content validation or authorization);
 *  - merge tags in suggestions are subject to the same allowlist (MERGE_TAG_INVALID otherwise).
 */
import { z } from 'zod';
import { emailContentV2DraftSchema } from './content.js';

export const AI_ASSIST_KINDS = ['subject', 'preheader', 'rewrite', 'tone', 'spam_risk'] as const;
export type AiAssistKind = (typeof AI_ASSIST_KINDS)[number];

export const aiAssistRequest = z.strictObject({
  kind: z.enum(AI_ASSIST_KINDS),
  campaignId: z.uuid(),
  /** Only for `tone`. */
  tone: z.enum(['friendly', 'formal', 'concise', 'enthusiastic']).optional(),
  /** Up to 5 alternatives. */
  count: z.number().int().min(1).max(5).default(3),
});
export type AiAssistRequest = z.infer<typeof aiAssistRequest>;

export const aiSuggestionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), field: z.enum(['subject', 'preheader']), value: z.string().min(1).max(200) }),
  z.strictObject({ kind: z.literal('content'), content: emailContentV2DraftSchema }),
  z.strictObject({ kind: z.literal('advice'), code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), message: z.string().min(1).max(500) }),
]);
export type AiSuggestion = z.infer<typeof aiSuggestionSchema>;

export const aiAssistResponse = z.strictObject({
  available: z.boolean(),
  /** Why no suggestions were produced (e.g. 'ai_not_enabled'). */
  reason: z.string().max(64).nullable(),
  suggestions: z.array(aiSuggestionSchema).max(5),
});
export type AiAssistResponse = z.infer<typeof aiAssistResponse>;
