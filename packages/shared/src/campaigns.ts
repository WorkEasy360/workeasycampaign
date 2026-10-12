/**
 * Campaign contract v1 — wire-level values, Zod schemas and types (docs/contracts/phase-6-campaign.md; milestone 6.4).
 * Contracts only: the transition rules, readiness checks and version building are server-side policy in
 * apps/api/src/modules/campaigns/domain. The API returns `allowedActions` / `blockedActions` per campaign; the UI never
 * computes transitions. Request and view contracts live in ./api/campaigns.ts.
 *
 * Every type that crosses a boundary is `z.infer` of its schema, so the wire contract and the TypeScript type cannot
 * drift apart.
 */
import { z } from 'zod';
import { smsContentV1Schema, whatsappContentV1Schema } from './content-messaging.js';
import { CHANNELS } from './channels.js';
import { emailContentV2Schema } from './content.js';
import { emailContentV3Schema } from './content-v3.js';

const uuid = z.uuid();
/** A UTC instant as produced by `Date.prototype.toISOString()` (server time, never client time). */
const utcInstant = z.iso.datetime();

// ─── lifecycle values ─────────────────────────────────────────────────────────────────────────────────────────

/** Authoritative campaign lifecycle (contract §2.1). Readiness is NOT a lifecycle state. */
export const CAMPAIGN_STATUSES = ['draft', 'scheduled', 'sending', 'paused', 'completed', 'cancelled', 'failed'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
export const campaignStatusSchema = z.enum(CAMPAIGN_STATUSES);

/** User-facing commands (contract §2.5). */
export const CAMPAIGN_ACTIONS = [
  'update',
  'schedule',
  'send_now',
  'reschedule',
  'unschedule',
  'pause',
  'resume',
  'cancel',
  'return_to_draft',
  'clone',
  'delete',
  'restore',
] as const;
export type CampaignAction = (typeof CAMPAIGN_ACTIONS)[number];
export const campaignActionSchema = z.enum(CAMPAIGN_ACTIONS);

/** Execution of one version (contract §5.1). */
export const EXECUTION_STATUSES = ['pending', 'materializing', 'delivering', 'paused', 'completed', 'cancelled', 'failed'] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];
export const executionStatusSchema = z.enum(EXECUTION_STATUSES);

/** Phase a paused execution returns to (contract §5.1 `paused_phase`). */
export const EXECUTION_PHASES = ['materializing', 'delivering'] as const;
export type ExecutionPhase = (typeof EXECUTION_PHASES)[number];

/** Execution health (contract §11: infrastructure failures never fail an execution by themselves). */
export const EXECUTION_HEALTH = ['ok', 'retrying', 'stalled'] as const;
export type ExecutionHealth = (typeof EXECUTION_HEALTH)[number];

/** Recipient of one execution (contract §7.1). Phase 6 writes pending, skipped, cancelled (and sent via the test port). */
export const RECIPIENT_STATUSES = [
  'pending',
  'skipped',
  'queued',
  'sending',
  'sent',
  'failed',
  'skipped_at_send',
  'unknown',
  'cancelled',
] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];
export const recipientStatusSchema = z.enum(RECIPIENT_STATUSES);

/** Why a version was created (contract §4.2; `submitted_for_approval` is reserved for §13, added with its behaviour). */
export const CAMPAIGN_VERSION_REASONS = ['scheduled', 'sent_now'] as const;
export type CampaignVersionReason = (typeof CAMPAIGN_VERSION_REASONS)[number];

/** Delivery capability (contract §9.3). `live` is added with Phase 8 (Gate 4) — additively. */
export const CAMPAIGN_DELIVERY_MODES = ['disabled', 'test', 'live'] as const;
export type CampaignDeliveryMode = (typeof CAMPAIGN_DELIVERY_MODES)[number];

/** Only failure class that changes campaign state (contract §11). */
export const CAMPAIGN_FAILURE_CLASSES = ['configuration'] as const;

// ─── readiness and pre-flight (contract §3) ─────────────────────────────────────────────────────────────────

export const FINDING_SEVERITIES = ['error', 'warning', 'info'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
export const FINDING_SECTIONS = ['details', 'topic', 'audience', 'sender', 'message', 'schedule', 'channel', 'delivery'] as const;
export type FindingSection = (typeof FINDING_SECTIONS)[number];

/** Stable codes (contract §3.2). Codes are added, never renamed. */
export const READINESS_FINDING_CODES = [
  'NAME_MISSING',
  'CHANNEL_NOT_AVAILABLE',
  'TOPIC_MISSING',
  'TOPIC_UNAVAILABLE',
  'AUDIENCE_EMPTY_DEFINITION',
  'AUDIENCE_TOO_MANY_SOURCES',
  'AUDIENCE_SOURCE_CONFLICT',
  'AUDIENCE_SOURCE_NOT_FOUND',
  'AUDIENCE_SOURCE_ARCHIVED',
  'AUDIENCE_EMPTY',
  'AUDIENCE_TOO_LARGE',
  'NO_ELIGIBLE_RECIPIENTS',
  'LOW_ELIGIBLE_SHARE',
  // 6.7 degraded mode (2026-10-07; contract §3.3): audience size / eligibility could not be established within the
  // interactive budget (fast resolution is recovering). Error: blocks schedule until it clears; never an invented estimate.
  'ELIGIBILITY_ESTIMATE_UNAVAILABLE',
  'SENDER_NOT_CONFIGURED',
  // Phase 7.8b: the chosen sender identity is unknown/deleted, or its domain is not verified by DNS.
  'SENDER_NOT_VERIFIED',
  'REPLY_TO_INVALID',
  'SUBJECT_MISSING',
  'SUBJECT_TOO_LONG',
  'BODY_MISSING',
  'BODY_TOO_LONG',
  // Content amendment (email.content.v2, 2026-10-08): additive.
  'MERGE_TAG_INVALID',
  'LINK_INVALID',
  'IMAGE_INVALID',
  'BUTTON_LABEL_MISSING',
  // Phase 7 content amendment (email.content.v3, §C): additive.
  'HTML_UNSUPPORTED',
  'HTML_MISSING',
  'CONDITION_INVALID',
  'CONDITIONAL_EMPTY',
  'PERSONALIZATION_FIELD_UNKNOWN',
  'PERSONALIZATION_FIELD_ARCHIVED',
  'SCHEDULE_IN_PAST',
  'SCHEDULE_TOO_FAR',
  'TIMEZONE_INVALID',
  'DELIVERY_NOT_AVAILABLE',
  // SMS / WhatsApp (2026-10-09, messaging amendment): additive.
  'TEMPLATE_MISSING',
  'TEMPLATE_INVALID',
] as const;
export type ReadinessFindingCode = (typeof READINESS_FINDING_CODES)[number];

/**
 * One finding. Contract §3.1: `message` is user-facing and never contains personal data; `details` carries ids,
 * counts and selector keys only (the schema restricts values to scalars so no object can smuggle a record in).
 */
export const readinessFindingSchema = z.strictObject({
  code: z.enum(READINESS_FINDING_CODES),
  severity: z.enum(FINDING_SEVERITIES),
  section: z.enum(FINDING_SECTIONS),
  /** JSON pointer into the draft, e.g. "/messages/0/content/subject". */
  field: z.string().startsWith('/').max(200).optional(),
  message: z.string().min(1).max(500),
  details: z.record(z.string().max(60), z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
});
export type ReadinessFinding = z.infer<typeof readinessFindingSchema>;

export const campaignReadinessSchema = z.strictObject({
  readiness: z.enum(['ready', 'not_ready']),
  readinessFindings: z.array(readinessFindingSchema),
});
export type CampaignReadiness = z.infer<typeof campaignReadinessSchema>;

const sectionOutcome = z.enum(['pass', 'warning', 'error']);

/** `POST …/preflight` (contract §3.1). `estimate` is null when the audience definition is invalid. */
export const preflightResultSchema = campaignReadinessSchema.extend({
  checkedAt: utcInstant,
  sections: z.strictObject(Object.fromEntries(FINDING_SECTIONS.map((s) => [s, sectionOutcome])) as Record<FindingSection, typeof sectionOutcome>),
  estimate: z
    .strictObject({
      /** Live, exact up to the 5,000,000 capture limit; capped ⇒ AUDIENCE_TOO_LARGE. */
      audienceSize: z.number().int().min(0).max(5_000_000),
      audienceSizeCapped: z.boolean(),
      /** Eligibility evaluated on a uniform sample of at most 2,000 contacts. */
      eligibleEstimate: z.number().int().min(0),
      sampleSize: z.number().int().min(0).max(2_000),
      /** Share of the sample, 0–1, per eligibility reason code. */
      topReasons: z.array(z.strictObject({ code: z.string().max(60), share: z.number().min(0).max(1) })),
    })
    .nullable(),
});
export type PreflightResult = z.infer<typeof preflightResultSchema>;

// ─── audience definition and version snapshot (contract §4.1; Audience contract §9.3) ───────────────────────

/** Selector ids are UUIDs (Audience contract §9.5: validated before any SQL). */
export const audienceSelectorSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('list'), listId: uuid }),
  z.strictObject({ type: z.literal('tag'), tagId: uuid }),
]);
export type AudienceSelector = z.infer<typeof audienceSelectorSchema>;

/** Shape only. The rules (non-empty include, ≤ 25 per side, no conflicts) are Audience/readiness policy. */
export const audienceDefinitionV1Schema = z.strictObject({
  include: z.array(audienceSelectorSchema),
  exclude: z.array(audienceSelectorSchema),
});
export type AudienceDefinitionV1 = z.infer<typeof audienceDefinitionV1Schema>;

/** Contract §4.1 limits of `email.content.v1`. */
export const EMAIL_CONTENT_V1_LIMITS = { subject: 200, preheader: 200, body: 100_000 } as const;

export const emailContentV1Schema = z.strictObject({
  schema: z.literal('email.content.v1'),
  subject: z.string().min(1).max(EMAIL_CONTENT_V1_LIMITS.subject),
  preheader: z.string().max(EMAIL_CONTENT_V1_LIMITS.preheader),
  /** Plain text, no HTML and no rendering in v1. */
  body: z.strictObject({ format: z.literal('text'), text: z.string().min(1).max(EMAIL_CONTENT_V1_LIMITS.body) }),
});
export type EmailContentV1 = z.infer<typeof emailContentV1Schema>;

/**
 * `campaign.version.v1` — the immutable snapshot stored in `campaign_versions.snapshot`, validated on write AND read
 * (contract §4.1). Exact shape: unknown fields are rejected and no optional additions exist within v1; a shape change
 * is a new schema id with an upcaster. `replyTo` validity is a readiness rule (REPLY_TO_INVALID); here only its bound.
 */
const versionFieldsV1 = {
  schema: z.literal('campaign.version.v1'),
  channel: z.literal('email'),
  purpose: z.literal('marketing'),
  topic: z.strictObject({ topicIds: z.tuple([uuid]), policy: z.literal('block_unsubscribed') }),
  audience: z.strictObject({ include: z.array(audienceSelectorSchema).min(1), exclude: z.array(audienceSelectorSchema) }),
  sender: z.strictObject({
    senderIdentityId: uuid.nullable(),
    fromName: z.string().min(1).max(100).nullable(),
    replyTo: z.string().min(3).max(320).nullable(),
  }),
  messages: z.tuple([z.strictObject({ variantKey: z.literal('default'), content: emailContentV1Schema })]),
  tracking: z.strictObject({ opens: z.literal(false), clicks: z.literal(false) }),
  compliance: z.strictObject({ unsubscribeLink: z.literal('required'), listUnsubscribeHeader: z.literal('required') }),
  personalization: z.strictObject({ mode: z.literal('none') }),
  schedule: z.strictObject({ mode: z.enum(['now', 'at']), sendAt: utcInstant.nullable(), timezone: z.string().min(1).max(64) }),
  abTest: z.null(),
};
const sendAtRule = {
  check: (s: { schedule: { mode: 'now' | 'at'; sendAt: string | null } }) => (s.schedule.mode === 'at' ? s.schedule.sendAt !== null : s.schedule.sendAt === null),
  params: { path: ['schedule', 'sendAt'], error: "sendAt is required for mode 'at' and must be null for mode 'now'" },
};

export const campaignVersionSnapshotV1Schema = z.strictObject(versionFieldsV1).refine(sendAtRule.check, sendAtRule.params);
export type CampaignVersionSnapshotV1 = z.infer<typeof campaignVersionSnapshotV1Schema>;

/**
 * `campaign.version.v2` (docs/contracts/phase-6-content-amendment.md, decision C3): v1's exact shape except that the
 * message content is `email.content.v1` OR `email.content.v2`, and personalization is derived from it — `merge_tags_v1`
 * exactly when the content is v2 (v1 text is never interpreted). New versions are written as v2; stored v1 snapshots
 * stay v1 (decision C4).
 */
export const campaignVersionSnapshotV2Schema = z
  .strictObject({
    ...versionFieldsV1,
    schema: z.literal('campaign.version.v2'),
    messages: z.tuple([z.strictObject({ variantKey: z.literal('default'), content: z.union([emailContentV1Schema, emailContentV2Schema]) })]),
    personalization: z.strictObject({ mode: z.enum(['none', 'merge_tags_v1']) }),
  })
  .refine(sendAtRule.check, sendAtRule.params)
  .refine((s) => s.personalization.mode === (s.messages[0].content.schema === 'email.content.v2' ? 'merge_tags_v1' : 'none'), {
    path: ['personalization', 'mode'],
    error: "personalization.mode must be 'merge_tags_v1' for email.content.v2 and 'none' for email.content.v1",
  });
export type CampaignVersionSnapshotV2 = z.infer<typeof campaignVersionSnapshotV2Schema>;

/**
 * `campaign.version.v3` (docs/contracts/phase-7-content-amendment.md §C, C17): v2's shape with `email.content.v3` added
 * to the message content, and personalization `merge_tags_v2` exactly when the content is v3. New versions with v1/v2
 * content are still written as v2 (unchanged); only v3 content needs v3.
 */
const PERSONALIZATION_FOR: Record<string, string> = { 'email.content.v1': 'none', 'email.content.v2': 'merge_tags_v1', 'email.content.v3': 'merge_tags_v2' };
export const campaignVersionSnapshotV3Schema = z
  .strictObject({
    ...versionFieldsV1,
    schema: z.literal('campaign.version.v3'),
    messages: z.tuple([z.strictObject({ variantKey: z.literal('default'), content: z.union([emailContentV1Schema, emailContentV2Schema, emailContentV3Schema]) })]),
    personalization: z.strictObject({ mode: z.enum(['none', 'merge_tags_v1', 'merge_tags_v2']) }),
  })
  .refine(sendAtRule.check, sendAtRule.params)
  .refine((s) => s.personalization.mode === PERSONALIZATION_FOR[s.messages[0].content.schema], {
    path: ['personalization', 'mode'],
    error: 'personalization.mode must match the content schema (v1 none, v2 merge_tags_v1, v3 merge_tags_v2)',
  });
export type CampaignVersionSnapshotV3 = z.infer<typeof campaignVersionSnapshotV3Schema>;

/**
 * `campaign.version.v4` (messaging amendment, 2026-10-09): SMS and WhatsApp campaigns ONLY — email keeps writing v2/v3
 * (unchanged). The channel decides the content schema; the sender is the deployment's provider number (no sender
 * identity, so all sender fields are null); opt-out is the channel's (SMS: STOP instruction appended by the renderer;
 * WhatsApp: the template's own opt-out and Audience consent); personalization is merge_tags_v2.
 */
export const campaignVersionSnapshotV4Schema = z
  .strictObject({
    ...versionFieldsV1,
    schema: z.literal('campaign.version.v4'),
    channel: z.enum(['sms', 'whatsapp']),
    sender: z.strictObject({ senderIdentityId: z.null(), fromName: z.null(), replyTo: z.null() }),
    messages: z.tuple([z.strictObject({ variantKey: z.literal('default'), content: z.union([smsContentV1Schema, whatsappContentV1Schema]) })]),
    compliance: z.strictObject({ optOut: z.enum(['sms_stop_instruction', 'whatsapp_template']) }),
    personalization: z.strictObject({ mode: z.literal('merge_tags_v2') }),
  })
  .refine(sendAtRule.check, sendAtRule.params)
  .refine((s) => s.messages[0].content.schema === (s.channel === 'sms' ? 'sms.content.v1' : 'whatsapp.content.v1'), {
    path: ['messages', 0, 'content', 'schema'],
    error: 'the content schema must match the channel (sms → sms.content.v1, whatsapp → whatsapp.content.v1)',
  })
  .refine((s) => s.compliance.optOut === (s.channel === 'sms' ? 'sms_stop_instruction' : 'whatsapp_template'), {
    path: ['compliance', 'optOut'],
    error: 'the opt-out mechanism must match the channel',
  });
export type CampaignVersionSnapshotV4 = z.infer<typeof campaignVersionSnapshotV4Schema>;

/** Any stored snapshot, as stored (wire views return the stored schema id; decision C4). */
export const campaignVersionSnapshotSchema = z.union([campaignVersionSnapshotV1Schema, campaignVersionSnapshotV2Schema, campaignVersionSnapshotV3Schema, campaignVersionSnapshotV4Schema]);
export type CampaignVersionSnapshot = z.infer<typeof campaignVersionSnapshotSchema>;

// ─── campaign event contract v1 (docs/events.md §"Campaign event contract v1") ──────────────────────────────

/**
 * Payload schemas of the campaign domain events. Aggregate `campaign`. Ids, states, counts, timestamps and changed
 * field NAMES only — never names, subjects, bodies, audience members, addresses or contact ids (the schemas are
 * strict, so an extra field is rejected). Registration in the API event catalogue happens with milestone 6.10.
 */
export const campaignCountsSchema = z.strictObject({
  planned: z.number().int().min(0),
  skipped: z.number().int().min(0),
  sent: z.number().int().min(0),
  failed: z.number().int().min(0),
  cancelled: z.number().int().min(0),
  unknown: z.number().int().min(0),
});
export type CampaignCounts = z.infer<typeof campaignCountsSchema>;

const phase = z.enum(EXECUTION_PHASES);
const empty = z.strictObject({});

export const CAMPAIGN_EVENT_PAYLOAD_SCHEMAS = {
  'campaign.created': z.strictObject({
    channel: z.enum(CHANNELS),
    clonedFrom: z.strictObject({ campaignId: uuid, versionId: uuid.nullable() }).nullable(),
  }),
  /** Draft paths, e.g. "audience", "messages[0].content.subject"; restore-version adds "restoredFromVersion". */
  'campaign.updated': z.strictObject({ changes: z.array(z.string().max(100)).max(50) }),
  'campaign.deleted': empty,
  'campaign.restored': empty,
  'campaign.version_created': z.strictObject({
    versionId: uuid,
    number: z.number().int().positive(),
    reason: z.enum(CAMPAIGN_VERSION_REASONS),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    schema: z.enum(['campaign.version.v1', 'campaign.version.v2', 'campaign.version.v3', 'campaign.version.v4']),
  }),
  'campaign.scheduled': z.strictObject({ versionId: uuid, executionId: uuid, sendAt: utcInstant, mode: z.enum(['now', 'at']) }),
  'campaign.rescheduled': z.strictObject({ executionId: uuid, from: utcInstant, to: utcInstant }),
  'campaign.unscheduled': z.strictObject({ executionId: uuid, versionId: uuid }),
  /** No `asOf`: the audience capture happens after start and its time is recorded on the execution. */
  'campaign.started': z.strictObject({ executionId: uuid }),
  'campaign.audience_materialized': z.strictObject({
    executionId: uuid,
    capturedAt: utcInstant,
    audienceSize: z.number().int().min(0),
    planned: z.number().int().min(0),
    skipped: z.number().int().min(0),
    skippedByReason: z.record(z.string().max(60), z.number().int().min(0)),
  }),
  'campaign.paused': z.strictObject({ executionId: uuid, phase }),
  'campaign.resumed': z.strictObject({ executionId: uuid, phase }),
  'campaign.cancelled': z.strictObject({
    executionId: uuid.nullable(),
    stage: z.enum(['scheduled', 'materializing', 'delivering', 'paused']),
    counts: campaignCountsSchema,
  }),
  'campaign.completed': z.strictObject({ executionId: uuid, counts: campaignCountsSchema }),
  'campaign.failed': z.strictObject({ executionId: uuid, failureClass: z.enum(CAMPAIGN_FAILURE_CLASSES), failureCode: z.string().max(60) }),
  'campaign.returned_to_draft': z.strictObject({ executionId: uuid }),
} as const;

export type CampaignEventType = keyof typeof CAMPAIGN_EVENT_PAYLOAD_SCHEMAS;
export type CampaignEventPayloads = { [T in CampaignEventType]: z.infer<(typeof CAMPAIGN_EVENT_PAYLOAD_SCHEMAS)[T]> };
export const CAMPAIGN_EVENT_TYPES = Object.keys(CAMPAIGN_EVENT_PAYLOAD_SCHEMAS) as CampaignEventType[];
