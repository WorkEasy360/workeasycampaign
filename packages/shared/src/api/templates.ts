/**
 * Email templates API (docs/contracts/phase-6-content-amendment.md §6, rows T1–T7). Base path
 * /v1/workspaces/{workspaceId}. Strict bodies: an unknown field is a 400.
 */
import { z } from 'zod';
import { emailContentV2DraftSchema, emailContentV2Schema } from '../content.js';
import { emailContentV3DraftSchema, emailContentV3Schema } from '../content-v3.js';

/** Template content: email.content.v2 or v3 (Phase 7 amendment §C), at the draft level on write. */
const contentDraft = z.discriminatedUnion('schema', [emailContentV2DraftSchema, emailContentV3DraftSchema]);
const contentStored = z.discriminatedUnion('schema', [emailContentV2Schema, emailContentV3Schema]);

const uuid = z.uuid();
const utcInstant = z.iso.datetime();

export const TEMPLATE_LIMITS = { name: 120, description: 500, category: 60 } as const;

const name = z.string().trim().min(1).max(TEMPLATE_LIMITS.name);
const description = z.string().trim().max(TEMPLATE_LIMITS.description);
/** Free-text category (7.1, additive); null clears it. */
const category = z.string().trim().min(1).max(TEMPLATE_LIMITS.category).nullable();

/** T1 query. */
export const templateListQuery = z.strictObject({
  q: z.string().trim().min(1).max(100).optional(),
  /** Case-insensitive exact category (7.1, additive). */
  category: z.string().trim().min(1).max(TEMPLATE_LIMITS.category).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(300).optional(),
});
export type TemplateListQuery = z.infer<typeof templateListQuery>;

/**
 * T2 / T7: from content, or "save as template" from a campaign's (v2) draft. Exactly one source. Content is accepted at
 * the draft level (shape strict → 400); incomplete or invalid values (empty subject, bad link, unknown merge field) are
 * a 422 with one field error per problem, and what is stored is the canonical complete form.
 */
export const createTemplateRequest = z.union([
  z.strictObject({ name, description: description.optional(), category: category.optional(), content: contentDraft }),
  z.strictObject({ name, description: description.optional(), category: category.optional(), fromCampaignId: uuid }),
  /** Clone (2026-10-08, additive): a copy of another live template of this workspace, under a new name. */
  z.strictObject({ name, description: description.optional(), category: category.optional(), fromTemplateId: uuid }),
]);
export type CreateTemplateRequest = z.infer<typeof createTemplateRequest>;

/** T4: optimistic locking by `expectedVersion`. */
export const updateTemplateRequest = z
  .strictObject({
    expectedVersion: z.number().int().positive(),
    name: name.optional(),
    description: description.optional(),
    category: category.optional(),
    content: contentDraft.optional(),
  })
  .refine((r) => r.name !== undefined || r.description !== undefined || r.category !== undefined || r.content !== undefined, { error: 'Nothing to change' });
export type UpdateTemplateRequest = z.infer<typeof updateTemplateRequest>;

/** T6: copy a template's content into a draft campaign. */
export const applyTemplateRequest = z.strictObject({ templateId: uuid, expectedVersion: z.number().int().positive() });
export type ApplyTemplateRequest = z.infer<typeof applyTemplateRequest>;

const actor = z.strictObject({ id: uuid, displayName: z.string() }).nullable();

/** T1 item: no content (list stays small). */
export const templateListItemSchema = z.strictObject({
  id: uuid,
  name: z.string(),
  description: z.string(),
  category: z.string().nullable(),
  subject: z.string(),
  blockCount: z.number().int().min(0),
  version: z.number().int().positive(),
  updatedAt: utcInstant,
});
export type TemplateListItem = z.infer<typeof templateListItemSchema>;

/** T2–T4 view. */
export const templateViewSchema = z.strictObject({
  id: uuid,
  name: z.string(),
  description: z.string(),
  category: z.string().nullable(),
  content: contentStored,
  version: z.number().int().positive(),
  createdAt: utcInstant,
  updatedAt: utcInstant,
  createdBy: actor,
});
export type TemplateView = z.infer<typeof templateViewSchema>;

/**
 * Version history (7.1). Every create, update and restore records the template's state after the change, keyed by the
 * template's version; rows are immutable. `imported` = the state that existed before history was recorded.
 */
export const TEMPLATE_VERSION_CHANGES = ['created', 'updated', 'restored', 'imported'] as const;
export type TemplateVersionChange = (typeof TEMPLATE_VERSION_CHANGES)[number];

export const templateVersionListQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(300).optional(),
});
export type TemplateVersionListQuery = z.infer<typeof templateVersionListQuery>;

export const templateVersionListItemSchema = z.strictObject({
  version: z.number().int().positive(),
  change: z.enum(TEMPLATE_VERSION_CHANGES),
  restoredFromVersion: z.number().int().positive().nullable(),
  name: z.string(),
  subject: z.string(),
  createdAt: utcInstant,
  createdBy: actor,
});
export type TemplateVersionListItem = z.infer<typeof templateVersionListItemSchema>;

export const templateVersionViewSchema = templateVersionListItemSchema.extend({
  description: z.string(),
  category: z.string().nullable(),
  content: contentStored,
});
export type TemplateVersionView = z.infer<typeof templateVersionViewSchema>;

/**
 * Restore = a NEW version whose description, category and content are copied from `version`. The name is kept (names
 * are unique among live templates; restoring an old name could collide).
 */
export const restoreTemplateRequest = z.strictObject({ version: z.number().int().positive(), expectedVersion: z.number().int().positive() });
export type RestoreTemplateRequest = z.infer<typeof restoreTemplateRequest>;

/** Distinct categories of live templates, for the filter. */
export const templateCategoriesSchema = z.strictObject({ data: z.array(z.string()) });
export type TemplateCategories = z.infer<typeof templateCategoriesSchema>;
