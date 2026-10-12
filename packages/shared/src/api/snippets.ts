/**
 * Reusable saved blocks API (Phase 7.2, docs/contracts/phase-7-content-amendment.md §S). Base path
 * /v1/workspaces/{workspaceId}. Strict bodies. A snippet is a list of `email.content.v3` blocks (conditional sections
 * included); inserting one into a message COPIES its blocks with fresh ids — messages keep no link.
 */
import { z } from 'zod';
import { EMAIL_CONTENT_V3_LIMITS, emailContentV3DraftSchema, emailContentV3Schema } from '../content-v3.js';

const uuid = z.uuid();
const utcInstant = z.iso.datetime();

export const SNIPPET_LIMITS = { name: 120, blocks: 20 } as const;
const name = z.string().trim().min(1).max(SNIPPET_LIMITS.name);

/** Blocks at the draft level on write (shape strict → 400; content problems → 422 with pointers). */
const draftBlocks = emailContentV3DraftSchema.shape.body.shape.blocks.max(SNIPPET_LIMITS.blocks);
const storedBlocks = emailContentV3Schema.shape.body.shape.blocks.max(SNIPPET_LIMITS.blocks);

export const snippetContentSchema = z.strictObject({ schema: z.literal('email.snippet.v1'), blocks: storedBlocks });
export type SnippetContent = z.infer<typeof snippetContentSchema>;

export const snippetListQuery = z.strictObject({
  q: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(300).optional(),
});
export type SnippetListQuery = z.infer<typeof snippetListQuery>;

export const createSnippetRequest = z.strictObject({ name, blocks: draftBlocks });
export type CreateSnippetRequest = z.infer<typeof createSnippetRequest>;

export const updateSnippetRequest = z
  .strictObject({ expectedVersion: z.number().int().positive(), name: name.optional(), blocks: draftBlocks.optional() })
  .refine((r) => r.name !== undefined || r.blocks !== undefined, { error: 'Nothing to change' });
export type UpdateSnippetRequest = z.infer<typeof updateSnippetRequest>;

const actor = z.strictObject({ id: uuid, displayName: z.string() }).nullable();

export const snippetListItemSchema = z.strictObject({
  id: uuid,
  name: z.string(),
  blockCount: z.number().int().min(0).max(EMAIL_CONTENT_V3_LIMITS.blocks),
  version: z.number().int().positive(),
  updatedAt: utcInstant,
});
export type SnippetListItem = z.infer<typeof snippetListItemSchema>;

export const snippetViewSchema = z.strictObject({
  id: uuid,
  name: z.string(),
  blocks: storedBlocks,
  version: z.number().int().positive(),
  createdAt: utcInstant,
  updatedAt: utcInstant,
  createdBy: actor,
});
export type SnippetView = z.infer<typeof snippetViewSchema>;
