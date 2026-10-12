/**
 * Campaign API v1 — request and view contracts (docs/contracts/phase-6-campaign.md §15; milestone 6.4).
 * Base path: /v1/workspaces/{workspaceId}. The workspace comes from the path and the server-side tenant context, never
 * from a body. Every request schema is strict: an unknown field is a 400, never silently ignored.
 *
 * Draft vs version: the draft on the campaign row may be incomplete (contract §4.1), so its request bounds are wider
 * than the `campaign.version.v1` limits wherever a readiness finding reports the overflow (AUDIENCE_TOO_MANY_SOURCES,
 * SUBJECT_TOO_LONG, BODY_TOO_LONG, REPLY_TO_INVALID, TIMEZONE_INVALID). Limits that no finding reports are enforced
 * here at their version value, so a ready draft always yields a valid snapshot.
 */
import { z } from 'zod';
import { smsContentDraftSchema, whatsappContentDraftSchema } from '../content-messaging.js';
import {
  audienceSelectorSchema,
  CAMPAIGN_ACTIONS,
  CAMPAIGN_DELIVERY_MODES,
  CAMPAIGN_STATUSES,
  CAMPAIGN_VERSION_REASONS,
  campaignActionSchema,
  campaignCountsSchema,
  campaignStatusSchema,
  campaignVersionSnapshotSchema,
  EMAIL_CONTENT_V1_LIMITS,
  EXECUTION_HEALTH,
  executionStatusSchema,
  readinessFindingSchema,
  recipientStatusSchema,
} from '../campaigns.js';
import { CHANNELS } from '../channels.js';
import { emailContentV2DraftSchema } from '../content.js';
import { emailContentV3DraftSchema, mergeFieldNameV2Schema } from '../content-v3.js';

const uuid = z.uuid();
const utcInstant = z.iso.datetime();
/** Optimistic concurrency token: the campaign row `version` the client last read (contract §10.1). */
const expectedVersion = z.number().int().positive();
const cursor = z.string().max(300).optional();
const limit = z.coerce.number().int().min(1).max(100).default(25);

/** Request bounds of the editable draft (see the file comment for why some exceed the v1 limits). */
export const CAMPAIGN_DRAFT_LIMITS = {
  name: 200,
  description: 1_000,
  /** Per side; > 25 is the AUDIENCE_TOO_MANY_SOURCES finding, this bound only stops unbounded payloads. */
  audienceSelectorsPerSide: 100,
  fromName: 100,
  replyTo: 320,
  /** > 200 is SUBJECT_TOO_LONG. */
  subject: 1_000,
  /** No finding exists for the preheader: enforced at the version limit. */
  preheader: EMAIL_CONTENT_V1_LIMITS.preheader,
  /** > 100,000 is BODY_TOO_LONG. Fits the 1 MiB request limit. */
  body: 200_000,
  timezone: 64,
} as const;

const name = z.string().trim().min(1, { error: 'Give the campaign a name' }).max(CAMPAIGN_DRAFT_LIMITS.name);
const description = z.string().trim().max(CAMPAIGN_DRAFT_LIMITS.description);
/** Empty → null, so "cleared" and "never set" are the same value. */
const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable();

const selectorKey = (s: z.infer<typeof audienceSelectorSchema>) => (s.type === 'list' ? `list:${s.listId}` : `tag:${s.tagId}`);
const selectorSide = z
  .array(audienceSelectorSchema)
  .max(CAMPAIGN_DRAFT_LIMITS.audienceSelectorsPerSide)
  .refine((xs) => new Set(xs.map(selectorKey)).size === xs.length, { error: 'A list or tag appears twice' });

// ─── draft value types (contract §15 `CampaignView.draft`) ──────────────────────────────────────────────────

/** Include/exclude may overlap in a draft: that is the AUDIENCE_SOURCE_CONFLICT finding, not a request error. */
export const audienceDefinitionDraftSchema = z.strictObject({ include: selectorSide, exclude: selectorSide });
export type AudienceDefinitionDraft = z.infer<typeof audienceDefinitionDraftSchema>;

export const senderDraftSchema = z.strictObject({
  senderIdentityId: uuid.nullable(),
  fromName: nullableText(CAMPAIGN_DRAFT_LIMITS.fromName),
  replyTo: nullableText(CAMPAIGN_DRAFT_LIMITS.replyTo),
});
export type SenderDraft = z.infer<typeof senderDraftSchema>;

/** `email.content.v1` while being edited: any field may still be empty (SUBJECT_MISSING, BODY_MISSING findings). */
export const emailContentDraftSchema = z.strictObject({
  schema: z.literal('email.content.v1'),
  subject: z.string().max(CAMPAIGN_DRAFT_LIMITS.subject),
  preheader: z.string().max(CAMPAIGN_DRAFT_LIMITS.preheader),
  body: z.strictObject({ format: z.literal('text'), text: z.string().max(CAMPAIGN_DRAFT_LIMITS.body) }),
});
export type EmailContentDraft = z.infer<typeof emailContentDraftSchema>;

/** Phase 6: exactly the `default` variant (A/B adds variants with a later schema). */
/** Content of the `default` message: v1 plain text, v2 blocks (content amendment C2), or v3 (Phase 7 amendment §C). */
export const messageDraftSchema = z.strictObject({
  variantKey: z.literal('default'),
  // SMS / WhatsApp (messaging amendment): their own content; the channel's spec rejects a schema of another channel.
  content: z.discriminatedUnion('schema', [emailContentDraftSchema, emailContentV2DraftSchema, emailContentV3DraftSchema, smsContentDraftSchema, whatsappContentDraftSchema]),
});
export type MessageDraft = z.infer<typeof messageDraftSchema>;

/** `sendAt` carries an explicit offset (no client-local ambiguity); the server stores the UTC instant. */
export const scheduleDraftSchema = z.strictObject({
  mode: z.enum(['now', 'at']),
  sendAt: z.iso.datetime({ offset: true }).nullable(),
  timezone: z.string().trim().min(1).max(CAMPAIGN_DRAFT_LIMITS.timezone),
});
export type ScheduleDraft = z.infer<typeof scheduleDraftSchema>;

// ─── requests (contract §15 rows 1–23) ───────────────────────────────────────────────────────────────────────

/** Row 2. `status` may repeat (`?status=draft&status=failed`). */
export const campaignListQuery = z.strictObject({
  status: z
    .union([campaignStatusSchema, z.array(campaignStatusSchema).max(CAMPAIGN_STATUSES.length)])
    .transform((v) => (Array.isArray(v) ? [...new Set(v)] : [v]))
    .optional(),
  channel: z.enum(CHANNELS).optional(),
  topicId: uuid.optional(),
  q: z.string().trim().min(2).max(100).optional(),
  deleted: z.enum(['exclude', 'only']).default('exclude'),
  limit,
  cursor,
});
export type CampaignListQuery = z.infer<typeof campaignListQuery>;

/** Row 4. Idempotency-Key header. */
export const createCampaignRequest = z.strictObject({
  name,
  channel: z.enum(CHANNELS),
  description: description.optional(),
  topicId: uuid.optional(),
});
export type CreateCampaignRequest = z.infer<typeof createCampaignRequest>;

/**
 * Row 6. Each draft field present replaces that field entirely (no deep merge), so the outcome never depends on the
 * stored value. At least one field besides `expectedVersion` is required.
 */
export const updateCampaignRequest = z
  .strictObject({
    expectedVersion,
    name: name.optional(),
    description: description.optional(),
    topicId: uuid.nullable().optional(),
    audience: audienceDefinitionDraftSchema.optional(),
    sender: senderDraftSchema.optional(),
    messages: z.array(messageDraftSchema).max(1).optional(),
    schedule: scheduleDraftSchema.optional(),
  })
  .refine((r) => Object.keys(r).some((k) => k !== 'expectedVersion'), { error: 'Nothing to change' });
export type UpdateCampaignRequest = z.infer<typeof updateCampaignRequest>;

/** Rows 7, 13, 16, 20: commands that carry only the concurrency token. */
export const campaignVersionedCommandRequest = z.strictObject({ expectedVersion });
export type CampaignVersionedCommandRequest = z.infer<typeof campaignVersionedCommandRequest>;

/** Rows 8, 14, 15, 17: commands without a body (an empty JSON object is accepted). */
export const campaignCommandRequest = z.strictObject({});

/** Row 9. Idempotency-Key header. `versionId` clones a historical version's snapshot instead of the draft. */
export const cloneCampaignRequest = z.strictObject({ versionId: uuid.optional(), name: name.optional() });
export type CloneCampaignRequest = z.infer<typeof cloneCampaignRequest>;

/** Row 11 (schedule and send-now). Idempotency-Key header + expectedVersion. */
export const scheduleCampaignRequest = z
  .strictObject({
    mode: z.enum(['now', 'at']),
    sendAt: z.iso.datetime({ offset: true }).optional(),
    timezone: z.string().trim().min(1).max(CAMPAIGN_DRAFT_LIMITS.timezone).optional(),
    expectedVersion,
  })
  .refine((r) => (r.mode === 'at' ? r.sendAt !== undefined : r.sendAt === undefined), {
    path: ['sendAt'],
    error: "sendAt is required for mode 'at' and not allowed for mode 'now'",
  });
export type ScheduleCampaignRequest = z.infer<typeof scheduleCampaignRequest>;

/** Row 12. */
export const rescheduleCampaignRequest = z.strictObject({
  sendAt: z.iso.datetime({ offset: true }),
  timezone: z.string().trim().min(1).max(CAMPAIGN_DRAFT_LIMITS.timezone).optional(),
  expectedVersion,
});
export type RescheduleCampaignRequest = z.infer<typeof rescheduleCampaignRequest>;

/** Rows 18, 21. */
export const campaignHistoryQuery = z.strictObject({ limit, cursor });
export type CampaignHistoryQuery = z.infer<typeof campaignHistoryQuery>;

/** Row 23. `reason` is an eligibility or skip reason code. */
export const campaignRecipientsQuery = z.strictObject({
  status: recipientStatusSchema.optional(),
  reason: z.string().regex(/^[A-Z][A-Z0-9_]{1,59}$/).optional(),
  limit,
  cursor,
});
export type CampaignRecipientsQuery = z.infer<typeof campaignRecipientsQuery>;

// ─── views (responses) ─────────────────────────────────────────────────────────────────────────────────────

const actor = z.strictObject({ id: uuid, displayName: z.string() }).nullable();

export const executionSummarySchema = z.strictObject({
  id: uuid,
  runNumber: z.number().int().positive(),
  status: executionStatusSchema,
  health: z.enum(EXECUTION_HEALTH),
  sendAt: utcInstant,
  startedAt: utcInstant.nullable(),
  materializedAt: utcInstant.nullable(),
  completedAt: utcInstant.nullable(),
  /** Last committed page / batch (additive, 6.11): lets the UI show that a running execution is progressing. */
  lastProgressAt: utcInstant.nullable(),
  counts: campaignCountsSchema,
  skippedByReason: z.record(z.string(), z.number().int().min(0)),
  failure: z.strictObject({ class: z.literal('configuration'), code: z.string() }).nullable(),
  /** Optional per-run sending limit (Phase 7.11): hand-offs per hour; null = no campaign limit. */
  maxPerHour: z.number().int().min(1).max(1_000_000).nullable(),
});
export type ExecutionSummary = z.infer<typeof executionSummarySchema>;

const blockedAction = z.strictObject({ action: campaignActionSchema, reason: z.string() });

/** Returned by every campaign command and by `GET …/campaigns/{id}` (contract §15). */
export const campaignViewSchema = z.strictObject({
  id: uuid,
  name: z.string(),
  description: z.string(),
  channel: z.enum(CHANNELS),
  purpose: z.literal('marketing'),
  status: campaignStatusSchema,
  version: z.number().int().positive(),
  deletedAt: utcInstant.nullable(),
  draft: z.strictObject({
    topicId: uuid.nullable(),
    audience: audienceDefinitionDraftSchema,
    sender: senderDraftSchema,
    messages: z.array(messageDraftSchema),
    schedule: scheduleDraftSchema,
  }),
  currentVersion: z.strictObject({ id: uuid, number: z.number().int().positive(), createdAt: utcInstant }).nullable(),
  currentExecution: executionSummarySchema.nullable(),
  allowedActions: z.array(z.enum(CAMPAIGN_ACTIONS)),
  blockedActions: z.array(blockedAction),
  readiness: z.enum(['ready', 'not_ready']),
  readinessFindings: z.array(readinessFindingSchema),
  createdAt: utcInstant,
  updatedAt: utcInstant,
  createdBy: actor,
});
export type CampaignView = z.infer<typeof campaignViewSchema>;

/**
 * Row 2 item. The contract names the type without listing its fields; it is the view minus the draft, the findings
 * and `blockedActions` (a list never computes pre-flight-style detail per row), keeping what a list row shows and acts on.
 */
export const campaignListItemSchema = z.strictObject({
  id: uuid,
  name: z.string(),
  channel: z.enum(CHANNELS),
  status: campaignStatusSchema,
  version: z.number().int().positive(),
  deletedAt: utcInstant.nullable(),
  topicId: uuid.nullable(),
  currentExecution: executionSummarySchema.nullable(),
  readiness: z.enum(['ready', 'not_ready']),
  allowedActions: z.array(z.enum(CAMPAIGN_ACTIONS)),
  createdAt: utcInstant,
  updatedAt: utcInstant,
});
export type CampaignListItem = z.infer<typeof campaignListItemSchema>;

/** Row 3: every status present, zero when none. */
export const campaignCountsByStatusSchema = z.strictObject(
  Object.fromEntries(CAMPAIGN_STATUSES.map((s) => [s, z.number().int().min(0)])) as Record<(typeof CAMPAIGN_STATUSES)[number], z.ZodNumber>,
);
export type CampaignCountsByStatus = z.infer<typeof campaignCountsByStatusSchema>;

/** Row 1. Enforcement never depends on this report (contract §9.3). */
export const campaignCapabilitiesSchema = z.strictObject({
  deliveryMode: z.enum(CAMPAIGN_DELIVERY_MODES),
  channels: z.array(z.strictObject({ channel: z.enum(CHANNELS), enabled: z.boolean(), sendingAvailable: z.boolean() })),
});
export type CampaignCapabilities = z.infer<typeof campaignCapabilitiesSchema>;

/** Row 18 item. */
export const versionSummarySchema = z.strictObject({
  id: uuid,
  number: z.number().int().positive(),
  reason: z.enum(CAMPAIGN_VERSION_REASONS),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: utcInstant,
  createdBy: actor,
});
export type VersionSummary = z.infer<typeof versionSummarySchema>;

/** Row 19. */
/** The snapshot as stored: `campaign.version.v1` or `.v2` (content amendment, decision C4). */
export const versionDetailSchema = versionSummarySchema.extend({ snapshot: campaignVersionSnapshotSchema });
export type VersionDetail = z.infer<typeof versionDetailSchema>;

/** Row 23 query (filters of contract §15). Keyset by recipient id. */
export const recipientListQuery = z.strictObject({
  status: recipientStatusSchema.optional(),
  /** One reason code, e.g. CONSENT_MISSING (recipients whose reasonCodes contain it). */
  reason: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor,
});
export type RecipientListQuery = z.infer<typeof recipientListQuery>;

/** Row 23 item. Shows a display name only (needs `contacts.read`); never an address. */
export const recipientListItemSchema = z.strictObject({
  id: uuid,
  contact: z.strictObject({ id: uuid, displayName: z.string() }),
  status: recipientStatusSchema,
  reasonCodes: z.array(z.string()),
  updatedAt: utcInstant,
});
export type RecipientListItem = z.infer<typeof recipientListItemSchema>;

/** `{ data, nextCursor }` page of any item schema (rows 2, 18, 21, 23). */
export const pageOf = <T extends z.ZodType>(item: T) => z.strictObject({ data: z.array(item), nextCursor: z.string().nullable() });

// ─── content preview (docs/contracts/phase-6-content-amendment.md §5) ───────────────────────────────────────────

/**
 * `POST …/campaigns/{id}/test-send` (Phase 7.3): the CURRENT draft, rendered like the preview (example profile, or one
 * contact with contacts.read), sent to the requesting user's own verified address only — never to an address in the
 * request. Subject prefixed "[Test]".
 */
export const campaignTestSendRequest = z.strictObject({ contactId: uuid.optional() });

/** Phase 7.11 (amendment §R): limit (or unlimit) a run's sending speed; takes effect at the next batch. */
export const SENDING_RATE_LIMITS = { min: 1, max: 1_000_000 } as const;
export const executionSendingRateRequest = z.strictObject({ maxPerHour: z.number().int().min(SENDING_RATE_LIMITS.min).max(SENDING_RATE_LIMITS.max).nullable() });
export type ExecutionSendingRateRequest = z.infer<typeof executionSendingRateRequest>;
export type CampaignTestSendRequest = z.infer<typeof campaignTestSendRequest>;
export const campaignTestSendSchema = z.strictObject({
  /** The requesting user's own address (shown so they know where to look). */
  sentTo: z.string(),
  subject: z.string(),
  sample: z.enum(['example', 'contact']),
});
export type CampaignTestSend = z.infer<typeof campaignTestSendSchema>;

/**
 * `GET …/campaigns/{id}/audience-sample` (Phase 7.4): a few contacts of the draft's LIVE audience (a uniform sample,
 * so different on each call) with whether each can currently receive the campaign. Display names and reason codes only —
 * never an address. Needs contacts.read. `unavailable` = degraded audience resolution (retry later).
 */
export const AUDIENCE_SAMPLE_SIZE = 5;
export const campaignAudienceSampleSchema = z.strictObject({
  unavailable: z.boolean(),
  sample: z.array(
    z.strictObject({
      contactId: uuid,
      displayName: z.string(),
      eligible: z.boolean(),
      reasons: z.array(z.string()),
    }),
  ),
});
export type CampaignAudienceSample = z.infer<typeof campaignAudienceSampleSchema>;

/** `POST …/campaigns/{id}/preview`. Without `contactId` the fixed example profile is used. */
export const campaignPreviewRequest = z.strictObject({ contactId: uuid.optional() });
export type CampaignPreviewRequest = z.infer<typeof campaignPreviewRequest>;

export const campaignPreviewSchema = z.strictObject({
  subject: z.string(),
  preheader: z.string(),
  /** Complete HTML document produced by the renderer (safe by construction; show it in a sandboxed frame). */
  html: z.string(),
  text: z.string(),
  sample: z.enum(['example', 'contact']),
  /**
   * Merge fields used by the rendered message that this contact has no value for (a fallback or nothing is shown).
   * merge_tags_v2 names (Phase 7 §C) — every v1 name is also a v2 name.
   */
  missingTags: z.array(mergeFieldNameV2Schema),
  /**
   * SMS / WhatsApp campaigns (messaging amendment): what the recipient gets. SMS: the exact text (opt-out included) and
   * its segment count. WhatsApp: the approved template's name and language and the personalized parameters — the
   * template text itself lives at Meta. Absent for email.
   */
  messaging: z
    .discriminatedUnion('channel', [
      z.strictObject({ channel: z.literal('sms'), text: z.string(), encoding: z.enum(['GSM-7', 'UCS-2']), characters: z.number().int().min(0), segments: z.number().int().min(0) }),
      z.strictObject({ channel: z.literal('whatsapp'), template: z.strictObject({ name: z.string(), language: z.string() }), parameters: z.array(z.string()) }),
    ])
    .optional(),
});
export type CampaignPreview = z.infer<typeof campaignPreviewSchema>;
