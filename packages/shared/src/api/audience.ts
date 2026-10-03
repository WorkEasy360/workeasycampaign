import { z } from 'zod';
import { CHANNELS, type Channel } from '../channels.js';
import type { EligibilityRequest, EligibilityResponse, EligibilityResult, IneligibilityReason } from '../eligibility.js';

// ─── enums ──────────────────────────────────────────────────────────────────────────────────────────────────

export const SUBSCRIPTION_TYPES = ['marketing', 'non_marketing', 'unsubscribed'] as const;
export type SubscriptionType = (typeof SUBSCRIPTION_TYPES)[number];
export const IDENTITY_KINDS = ['email', 'phone', 'whatsapp', 'external'] as const;
export type IdentityKind = (typeof IDENTITY_KINDS)[number];
export const CUSTOM_FIELD_TYPES = [
  'text', 'long_text', 'number', 'decimal', 'boolean', 'date', 'datetime', 'email', 'phone', 'url', 'single_select', 'multi_select',
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];
export const CONSENT_ACTIONS = ['subscribed', 'unsubscribed', 'pending', 'confirmed', 'revoked'] as const;
export type ConsentAction = (typeof CONSENT_ACTIONS)[number];
export const LAWFUL_BASES = ['consent', 'contract', 'legal_obligation', 'vital_interests', 'public_task', 'legitimate_interests'] as const;
export type LawfulBasis = (typeof LAWFUL_BASES)[number];
/** Sources an administrator may cite when recording consent on a contact's behalf. */
export const ADMIN_CONSENT_SOURCES = ['admin', 'form', 'import', 'api', 'paper', 'verbal'] as const;
export const SUPPRESSION_CHANNELS = ['email', 'sms', 'whatsapp', 'all'] as const;
export type SuppressionChannel = (typeof SUPPRESSION_CHANNELS)[number];
export const SUPPRESSION_REASONS = ['manual', 'hard_bounce', 'complaint', 'compliance', 'unsubscribe_request', 'invalid_address'] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];
/** Reasons a person may choose; bounce/complaint come from delivery events (Phase 9). */
export const MANUAL_SUPPRESSION_REASONS = ['manual', 'compliance', 'unsubscribe_request', 'invalid_address'] as const;
export const TAG_COLORS = ['slate', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'indigo', 'violet', 'pink'] as const;

const uuid = z.uuid();
const optText = (max: number) => z.string().trim().max(max).optional();
const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();
const countryCode = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, { error: 'Use a two-letter country code' });
const machineKey = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{1,39}$/, { error: 'Use 2–40 lowercase letters, digits or underscores, starting with a letter' });
const name = z.string().trim().min(1, { error: 'Enter a name' }).max(100);
const version = z.number().int().positive();
const ianaTimezone = z.string().trim().max(64).regex(/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/, { error: 'Use an IANA time zone' });
const locale = z.string().trim().max(35).regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, { error: 'Use a language tag such as en or en-IN' });

/** Custom-field values are validated server-side against the field definitions; here only the envelope. */
const customFieldValues = z.record(z.string().max(40), z.unknown()).refine((o) => Object.keys(o).length <= 200, {
  error: 'Too many custom fields',
});

// ─── contacts ───────────────────────────────────────────────────────────────────────────────────────────────

export const contactListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  listId: uuid.optional(),
  tagId: uuid.optional(),
  topicId: uuid.optional(),
  subscriptionType: z.enum(SUBSCRIPTION_TYPES).optional(),
  suppressed: z.enum(['true', 'false']).optional(),
  consentChannel: z.enum(CHANNELS).optional(),
  consentState: z.enum(['granted', 'pending', 'withdrawn', 'none']).optional(),
  deleted: z.enum(['exclude', 'only']).default('exclude'),
  sort: z.enum(['created', 'updated']).default('created'),
  order: z.enum(['desc', 'asc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(300).optional(),
});
export type ContactListQuery = z.infer<typeof contactListQuery>;
export type ContactFilter = Omit<ContactListQuery, 'limit' | 'cursor' | 'sort' | 'order'>;

export const createContactRequest = z
  .object({
    firstName: optText(100),
    lastName: optText(100),
    company: optText(200),
    email: z.string().trim().max(254).optional(),
    phone: z.string().trim().max(40).optional(),
    defaultCountry: countryCode.optional(),
    timezone: ianaTimezone.optional(),
    locale: locale.optional(),
    subscriptionType: z.enum(['marketing', 'non_marketing']).default('marketing'),
    customFields: customFieldValues.default({}),
    listIds: z.array(uuid).max(50).default([]),
    tagIds: z.array(uuid).max(50).default([]),
  })
  .refine((v) => !!(v.email || v.phone), { error: 'Enter an email address or a phone number', path: ['email'] });
export type CreateContactRequest = z.infer<typeof createContactRequest>;

export const updateContactRequest = z.object({
  firstName: nullableText(100),
  lastName: nullableText(100),
  company: nullableText(200),
  timezone: ianaTimezone.nullable().optional(),
  locale: locale.nullable().optional(),
  /** Partial: keys present are set; a null value clears the field. */
  customFields: customFieldValues.optional(),
  version,
});

export const addIdentityRequest = z.object({
  kind: z.enum(IDENTITY_KINDS),
  value: z.string().trim().min(1).max(254),
  provider: z.string().trim().max(60).regex(/^[a-z0-9][a-z0-9:_-]*$/).optional(),
  defaultCountry: countryCode.optional(),
});

export const changeSubscriptionRequest = z.object({
  subscriptionType: z.enum(SUBSCRIPTION_TYPES),
  version,
});

export const recordConsentRequest = z.object({
  channel: z.enum(CHANNELS),
  action: z.enum(CONSENT_ACTIONS),
  lawfulBasis: z.enum(LAWFUL_BASES).optional(),
  source: z.enum(ADMIN_CONSENT_SOURCES),
  /** When it happened (e.g. the date on a paper form). May be in the past, never in the future. */
  occurredAt: z.iso
    .datetime({ offset: true })
    .refine((v) => Date.parse(v) <= Date.now() + 5 * 60_000, { error: 'The date cannot be in the future' })
    .refine((v) => Date.parse(v) >= Date.parse('2000-01-01T00:00:00Z'), { error: 'Enter a realistic date' })
    .optional(),
  consentTextVersion: optText(100),
  formId: optText(100),
  formVersion: optText(50),
  /** What proves this: a note, a document or ticket reference. Required for grants recorded by staff. */
  evidenceNote: optText(1000),
  evidenceReference: optText(300),
});
export type RecordConsentRequest = z.infer<typeof recordConsentRequest>;

export const topicPreferenceRequest = z.object({
  status: z.enum(['subscribed', 'unsubscribed']),
  evidenceNote: optText(1000),
});

export const bulkActionRequest = z.object({
  action: z.enum(['add_to_list', 'remove_from_list', 'tag', 'untag', 'suppress', 'unsubscribe', 'delete']),
  selection: z.union([
    z.object({ contactIds: z.array(uuid).min(1).max(1000) }),
    z.object({ filter: contactListQuery.omit({ limit: true, cursor: true, sort: true, order: true }) }),
  ]),
  listId: uuid.optional(),
  tagId: uuid.optional(),
  channel: z.enum(SUPPRESSION_CHANNELS).optional(),
  reason: z.enum(MANUAL_SUPPRESSION_REASONS).optional(),
  note: optText(500),
});
export type BulkActionRequest = z.infer<typeof bulkActionRequest>;

// ─── lists, tags, topics ────────────────────────────────────────────────────────────────────────────────────

export const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'archived', 'all']).default('active'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(300).optional(),
});
export const createListRequest = z.object({ name, description: z.string().trim().max(500).default('') });
export const updateListRequest = z.object({ name: name.optional(), description: z.string().trim().max(500).optional(), version });
export const membersRequest = z.object({ contactIds: z.array(uuid).min(1).max(1000) });

export const createTagRequest = z.object({
  name: z.string().trim().min(1, { error: 'Enter a name' }).max(50),
  color: z.enum(TAG_COLORS).default('slate'),
  description: z.string().trim().max(300).default(''),
});
export const updateTagRequest = z.object({
  name: z.string().trim().min(1).max(50).optional(),
  color: z.enum(TAG_COLORS).optional(),
  description: z.string().trim().max(300).optional(),
  version,
});

export const createTopicRequest = z.object({
  name,
  key: machineKey.optional(),
  kind: z.enum(['topic', 'category']).default('topic'),
  description: z.string().trim().max(500).default(''),
  parentId: uuid.nullable().optional(),
});
export const updateTopicRequest = z.object({
  name: name.optional(),
  description: z.string().trim().max(500).optional(),
  parentId: uuid.nullable().optional(),
  version,
});

// ─── custom fields ──────────────────────────────────────────────────────────────────────────────────────────

const fieldOption = z.object({ key: machineKey, label: z.string().trim().min(1).max(100), archived: z.boolean().default(false) });
const fieldValidation = z
  .object({
    maxLength: z.number().int().min(1).max(10_000).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .refine((v) => v.min === undefined || v.max === undefined || v.min <= v.max, { error: 'Minimum must not exceed maximum' });

export const createCustomFieldRequest = z.object({
  key: machineKey,
  label: z.string().trim().min(1, { error: 'Enter a label' }).max(100),
  type: z.enum(CUSTOM_FIELD_TYPES),
  description: z.string().trim().max(300).default(''),
  required: z.boolean().default(false),
  options: z.array(fieldOption).max(200).default([]),
  validation: fieldValidation.default({}),
});
export type CreateCustomFieldRequest = z.infer<typeof createCustomFieldRequest>;
export const updateCustomFieldRequest = z.object({
  key: machineKey.optional(),
  label: z.string().trim().min(1).max(100).optional(),
  type: z.enum(CUSTOM_FIELD_TYPES).optional(),
  description: z.string().trim().max(300).optional(),
  required: z.boolean().optional(),
  options: z.array(fieldOption).max(200).optional(),
  validation: fieldValidation.optional(),
  version,
});
export const reorderCustomFieldsRequest = z.object({ fieldIds: z.array(uuid).min(1).max(200) });

// ─── suppression, consent policy, eligibility ───────────────────────────────────────────────────────────────

export const createSuppressionRequest = z
  .object({
    channel: z.enum(SUPPRESSION_CHANNELS),
    reason: z.enum(MANUAL_SUPPRESSION_REASONS),
    note: z.string().trim().max(500).default(''),
    contactId: uuid.optional(),
    identityKind: z.enum(['email', 'phone', 'whatsapp']).optional(),
    value: z.string().trim().max(254).optional(),
    defaultCountry: countryCode.optional(),
  })
  .refine((v) => (v.contactId ? !v.value : !!(v.value && v.identityKind)), {
    error: 'Choose a contact, or enter an address and its type',
    path: ['value'],
  });
export const liftSuppressionRequest = z.object({ reason: z.string().trim().min(3, { error: 'Explain why' }).max(500) });
export const suppressionQuery = z.object({
  status: z.enum(['active', 'lifted', 'all']).default('active'),
  contactId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(300).optional(),
});

export const retentionPolicyRequest = z.object({
  retainAfterWithdrawalDays: z.number().int().min(0).max(36_500).nullable(),
  retainAfterErasureDays: z.number().int().min(0).max(36_500).nullable(),
  pendingExpiryDays: z.number().int().min(1).max(365),
  version: z.number().int().positive().optional(),
});

export const eligibilityCheckRequest = z.object({
  contactIds: z.array(uuid).min(1).max(100),
  channel: z.enum(CHANNELS),
  purpose: z.enum(['marketing', 'transactional']).default('marketing'),
  topicId: uuid.optional(),
});

// ─── imports ────────────────────────────────────────────────────────────────────────────────────────────────

export const IMPORT_TARGETS = ['email', 'phone', 'whatsapp', 'first_name', 'last_name', 'company', 'timezone', 'locale'] as const;
/** `cf:<key>` targets a custom field; `ignore` skips the column. */
export const importTarget = z.union([z.enum(IMPORT_TARGETS), z.literal('ignore'), z.string().regex(/^cf:[a-z][a-z0-9_]{1,39}$/)]);
export const IMPORT_MODES = ['create_or_update', 'create_only', 'update_only'] as const;

export const importMappingRequest = z.object({
  /** Column index (as string) → target. */
  mapping: z.record(z.string().regex(/^\d{1,3}$/), importTarget),
  options: z.object({
    mode: z.enum(IMPORT_MODES).default('create_or_update'),
    defaultCountry: countryCode.optional(),
    /** When true an empty cell clears the existing value on update; by default empty cells are ignored. */
    blankClears: z.boolean().default(false),
    subscriptionType: z.enum(['marketing', 'non_marketing']).optional(),
    listIds: z.array(uuid).max(20).default([]),
    tagIds: z.array(uuid).max(20).default([]),
    topicIds: z.array(uuid).max(20).default([]),
    consent: z
      .object({
        channel: z.enum(CHANNELS),
        lawfulBasis: z.enum(LAWFUL_BASES),
        evidenceNote: z.string().trim().min(3, { error: 'Describe how consent was collected' }).max(1000),
      })
      .optional(),
  }),
  version,
});
export type ImportMappingRequest = z.infer<typeof importMappingRequest>;
export type ImportOptions = ImportMappingRequest['options'];

// ─── views ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface ContactSummary {
  id: string;
  firstName: string | null;
  lastName: string | null;
  displayName: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  subscriptionType: SubscriptionType;
  suppressed: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ContactPage {
  data: ContactSummary[];
  nextCursor: string | null;
  /** Search matched more contacts than the search cap; ask the user to refine. */
  searchTruncated: boolean;
}

export interface IdentityView {
  id: string;
  kind: IdentityKind;
  provider: string;
  value: string;
  isPrimary: boolean;
  createdAt: string;
}

export interface ConsentStateView {
  channel: Channel;
  /** `expired`: a pending (double opt-in) request older than the workspace's pending-expiry period. Derived, not stored. */
  state: 'granted' | 'pending' | 'expired' | 'withdrawn' | 'none';
  changedBy: 'contact' | 'user' | 'system' | null;
  lawfulBasis: LawfulBasis | null;
  changedAt: string | null;
  /**
   * Whether the state was recorded for the contact's CURRENT primary address of this channel. Consent given for
   * another address does not count (CONSENT_ADDRESS_CHANGED). Null when there is no state.
   */
  appliesToPrimaryAddress: boolean | null;
}

export interface TopicPreferenceView {
  topic: { id: string; key: string; name: string; status: 'active' | 'archived' };
  status: 'subscribed' | 'unsubscribed';
  changedBy: 'contact' | 'user' | 'system';
  changedAt: string;
}

export interface SuppressionView {
  id: string;
  channel: SuppressionChannel;
  target: { type: 'contact'; contactId: string; displayName: string | null } | { type: 'address'; kind: string; value: string };
  reason: SuppressionReason;
  source: string;
  note: string;
  createdAt: string;
  createdBy: string | null;
  liftedAt: string | null;
  liftReason: string | null;
}

export interface ContactDetail extends ContactSummary {
  timezone: string | null;
  locale: string | null;
  source: string;
  unsubscribedBy: 'contact' | 'user' | 'system' | null;
  subscriptionChangedAt: string;
  erased: boolean;
  identities: IdentityView[];
  customFields: Record<string, unknown>;
  lists: { id: string; name: string }[];
  tags: { id: string; name: string; color: string }[];
  topics: TopicPreferenceView[];
  consent: ConsentStateView[];
  suppressions: SuppressionView[];
  version: number;
}

export interface ConsentEventView {
  id: string;
  scope: { type: 'channel'; channel: Channel } | { type: 'topic'; topicId: string; topicName: string | null };
  action: string;
  previousState: string;
  newState: string;
  lawfulBasis: string | null;
  source: string;
  actor: { type: string; id: string | null };
  occurredAt: string;
  recordedAt: string;
  ipAddress: string | null;
  evidence: Record<string, unknown>;
}

export interface TimelineEntry {
  id: string;
  type: string;
  occurredAt: string;
  actor: { type: string; id: string | null };
  data: Record<string, unknown>;
}

export interface ListView {
  id: string;
  name: string;
  description: string;
  status: 'active' | 'archived';
  memberCount: number;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface TagView {
  id: string;
  name: string;
  color: string;
  description: string;
  contactCount: number;
  version: number;
}

export interface TopicView {
  id: string;
  key: string;
  name: string;
  description: string;
  kind: 'topic' | 'category';
  parentId: string | null;
  status: 'active' | 'archived';
  isDefault: boolean;
  subscriberCount: number;
  version: number;
}

export interface CustomFieldView {
  id: string;
  key: string;
  label: string;
  description: string;
  type: CustomFieldType;
  required: boolean;
  options: { key: string; label: string; archived: boolean }[];
  validation: { maxLength?: number; min?: number; max?: number };
  position: number;
  status: 'active' | 'archived';
  keyLocked: boolean;
  version: number;
}

export interface RetentionPolicyView {
  retainAfterWithdrawalDays: number | null;
  retainAfterErasureDays: number | null;
  pendingExpiryDays: number;
  isDefault: boolean;
  version: number | null;
}

export interface BulkActionResult {
  matched: number;
  affected: number;
  skipped: number;
  /** Selections by filter are capped; this tells the UI if more contacts matched than were processed. */
  truncated: boolean;
}

export type ImportStatus = 'uploaded' | 'validated' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface ImportSummaryCounts {
  total: number;
  create: number;
  update: number;
  skip: number;
  error: number;
}

export interface ImportView {
  id: string;
  status: ImportStatus;
  fileName: string;
  fileSize: number;
  headers: string[];
  mapping: Record<string, string>;
  options: Partial<ImportOptions>;
  totalRows: number | null;
  processedRows: number;
  counts: { created: number; updated: number; skipped: number; errors: number };
  dryRun: ImportSummaryCounts | null;
  failureReason: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  version: number;
}

export interface ImportPreview {
  headers: string[];
  rows: string[][];
  suggestedMapping: Record<string, string>;
}

export interface ImportIssueView {
  rowNumber: number;
  column: string | null;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

export type { EligibilityRequest, EligibilityResponse, EligibilityResult, IneligibilityReason };
