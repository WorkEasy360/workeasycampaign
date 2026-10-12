import { createHash } from 'node:crypto';
import { canonicalContentV2, canonicalContentV3, canonicalSms, canonicalWhatsApp } from '@workeasy/content';
import {
  type AudienceSelector,
  type CampaignVersionSnapshot,
  type CampaignVersionSnapshotV2,
  type CampaignVersionSnapshotV3,
  type CampaignVersionSnapshotV4,
  campaignVersionSnapshotV4Schema,
  smsContentDraftSchema,
  whatsappContentDraftSchema,
  campaignVersionSnapshotV1Schema,
  campaignVersionSnapshotV2Schema,
  campaignVersionSnapshotV3Schema,
  type EmailContentV1,
  type EmailContentV2,
  type EmailContentV3,
  emailContentV2DraftSchema,
  emailContentV3DraftSchema,
} from '@workeasy/shared';
import type { CampaignDraft } from './draft.js';

/**
 * CampaignVersion — the immutable snapshot of a committed draft (contract §4). Created only by `schedule` / send-now.
 * Immutability is layered: this module deep-freezes snapshots; the repository has no update path (6.5+); the database
 * grants INSERT only and rejects UPDATE with a trigger (6.5).
 *
 * Schemas (docs/contracts/phase-6-content-amendment.md, C3/C4): new versions are `campaign.version.v2`; stored v1
 * versions are never rewritten — wire views return them as stored, the domain reads them upcast to v2.
 * Phase 7 amendment §C (C17): a version whose content is `email.content.v3` is `campaign.version.v3`; v1/v2 content is
 * still versioned as v2, exactly as before.
 */

/** What the domain works with: v1 is read upcast to v2; v3 exists only for v3 content. */
export type CurrentVersionSnapshot = CampaignVersionSnapshotV2 | CampaignVersionSnapshotV3 | CampaignVersionSnapshotV4;

export class VersionError extends Error {
  constructor(readonly code: 'DRAFT_NOT_READY' | 'SNAPSHOT_INVALID' | 'SCHEMA_UNSUPPORTED', message: string) {
    super(message);
    this.name = 'VersionError';
  }
}

/** Schema id of NEW versions with v1/v2 content (v3 content → `campaign.version.v3`). */
export const VERSION_SCHEMA = 'campaign.version.v2' as const;
const PERSONALIZATION = { 'email.content.v1': 'none', 'email.content.v2': 'merge_tags_v1', 'email.content.v3': 'merge_tags_v2' } as const;

/**
 * Builds a v2 snapshot from a draft. The caller has already established that the draft has no readiness errors.
 * The content keeps its own schema: v1 text (trimmed; personalization 'none') or the canonical v2 blocks
 * (personalization 'merge_tags_v1').
 */
export function buildVersionSnapshot(draft: CampaignDraft, scheduleAt: { mode: 'now' | 'at'; sendAt: string | null; timezone: string }): CurrentVersionSnapshot {
  if (draft.channel !== 'email') return buildMessagingSnapshot(draft, scheduleAt);
  if (!draft.topicId) throw new VersionError('DRAFT_NOT_READY', 'A topic is required');
  if (draft.audience.include.length === 0) throw new VersionError('DRAFT_NOT_READY', 'An audience is required');
  const message = draft.messages.find((m) => m.variantKey === 'default');
  const content = canonicalContent(message?.content);
  if (scheduleAt.mode === 'at' && !scheduleAt.sendAt) throw new VersionError('DRAFT_NOT_READY', 'A send time is required');

  const snapshot = {
    schema: content.schema === 'email.content.v3' ? 'campaign.version.v3' : VERSION_SCHEMA,
    channel: 'email',
    purpose: 'marketing',
    topic: { topicIds: [draft.topicId], policy: 'block_unsubscribed' },
    audience: {
      include: draft.audience.include.map(copySelector),
      exclude: draft.audience.exclude.map(copySelector),
    },
    sender: {
      senderIdentityId: draft.sender.senderIdentityId,
      fromName: draft.sender.fromName ? stripControl(draft.sender.fromName).trim() || null : null,
      replyTo: draft.sender.replyTo ? draft.sender.replyTo.trim().toLowerCase() : null,
    },
    messages: [{ variantKey: 'default', content }],
    tracking: { opens: false, clicks: false },
    compliance: { unsubscribeLink: 'required', listUnsubscribeHeader: 'required' },
    personalization: { mode: PERSONALIZATION[content.schema] },
    schedule: { mode: scheduleAt.mode, sendAt: scheduleAt.mode === 'now' ? null : new Date(scheduleAt.sendAt!).toISOString(), timezone: scheduleAt.timezone },
    abTest: null,
  } as CurrentVersionSnapshot;
  return deepFreeze(snapshot);
}

/** SMS / WhatsApp: `campaign.version.v4` (messaging amendment); email never comes here. */
function buildMessagingSnapshot(draft: CampaignDraft, scheduleAt: { mode: 'now' | 'at'; sendAt: string | null; timezone: string }): CurrentVersionSnapshot {
  if (!draft.topicId) throw new VersionError('DRAFT_NOT_READY', 'A topic is required');
  if (draft.audience.include.length === 0) throw new VersionError('DRAFT_NOT_READY', 'An audience is required');
  if (scheduleAt.mode === 'at' && !scheduleAt.sendAt) throw new VersionError('DRAFT_NOT_READY', 'A send time is required');
  const raw = draft.messages.find((m) => m.variantKey === 'default')?.content;
  let content;
  if (draft.channel === 'sms') {
    const parsed = smsContentDraftSchema.safeParse(raw);
    content = parsed.success ? canonicalSms(parsed.data) : null;
  } else {
    const parsed = whatsappContentDraftSchema.safeParse(raw);
    content = parsed.success ? canonicalWhatsApp(parsed.data) : null;
  }
  if (!content) throw new VersionError('DRAFT_NOT_READY', 'The message is incomplete');
  const snapshot: CampaignVersionSnapshotV4 = {
    schema: 'campaign.version.v4',
    channel: draft.channel as 'sms' | 'whatsapp',
    purpose: 'marketing',
    topic: { topicIds: [draft.topicId], policy: 'block_unsubscribed' },
    audience: { include: draft.audience.include.map(copySelector), exclude: draft.audience.exclude.map(copySelector) },
    sender: { senderIdentityId: null, fromName: null, replyTo: null },
    messages: [{ variantKey: 'default', content }],
    tracking: { opens: false, clicks: false },
    compliance: { optOut: draft.channel === 'sms' ? 'sms_stop_instruction' : 'whatsapp_template' },
    personalization: { mode: 'merge_tags_v2' },
    schedule: { mode: scheduleAt.mode, sendAt: scheduleAt.mode === 'now' ? null : new Date(scheduleAt.sendAt!).toISOString(), timezone: scheduleAt.timezone },
    abTest: null,
  };
  return deepFreeze(snapshot) as CurrentVersionSnapshot;
}

/** The single stored representation of a draft's content; DRAFT_NOT_READY when it is incomplete. */
function canonicalContent(raw: unknown): EmailContentV1 | EmailContentV2 | EmailContentV3 {
  if ((raw as { schema?: unknown } | null)?.schema === 'email.content.v3') {
    const parsed = emailContentV3DraftSchema.safeParse(raw);
    const c = parsed.success ? canonicalContentV3(parsed.data) : null;
    if (!c) throw new VersionError('DRAFT_NOT_READY', 'The message is incomplete');
    return c;
  }
  if ((raw as { schema?: unknown } | null)?.schema === 'email.content.v2') {
    const parsed = emailContentV2DraftSchema.safeParse(raw);
    const c = parsed.success ? canonicalContentV2(parsed.data) : null;
    if (!c) throw new VersionError('DRAFT_NOT_READY', 'The message is incomplete');
    return c;
  }
  const c = raw as Partial<EmailContentV1> | undefined;
  if (!c?.subject?.trim() || !c.body?.text?.trim()) throw new VersionError('DRAFT_NOT_READY', 'The message is incomplete');
  // Canonical body = the trimmed text readiness validated (BODY_MISSING / BODY_TOO_LONG): one representation.
  return { schema: 'email.content.v1', subject: c.subject.trim(), preheader: (c.preheader ?? '').trim(), body: { format: 'text', text: c.body.text.trim() } };
}

/** Canonical JSON: object keys sorted at every level, no whitespace. Stable across key insertion order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`;
}

/** SHA-256 (hex) of the canonical JSON of the snapshot as stored — `content_hash`, re-verifiable at any time. */
export const contentHash = (snapshot: CampaignVersionSnapshot): string => createHash('sha256').update(canonicalJson(snapshot)).digest('hex');

/** Reads a stored snapshot AS STORED, validated against its own schema id. Wire views return this (C4). */
export function readStoredSnapshot(raw: unknown): CampaignVersionSnapshot {
  const schema = (raw as { schema?: unknown } | null)?.schema;
  const validate = VALIDATORS[String(schema)];
  if (!validate) throw new VersionError('SCHEMA_UNSUPPORTED', `Unknown version schema ${String(schema)}`);
  validate(raw);
  return deepFreeze(structuredClone(raw as CampaignVersionSnapshot));
}

/**
 * Reads a stored snapshot for the domain, upcast to the latest schema (contract §4.1: `v1 → v2 → …`). v1 → v2
 * changes only the id: v1 content is valid in v2 and its personalization ('none') is v2's rule for v1 text.
 */
export function readVersionSnapshot(raw: unknown): CurrentVersionSnapshot {
  const stored = readStoredSnapshot(raw);
  if (stored.schema === 'campaign.version.v2' || stored.schema === 'campaign.version.v3' || stored.schema === 'campaign.version.v4') return stored;
  return deepFreeze({ ...structuredClone(stored), schema: 'campaign.version.v2' } as CampaignVersionSnapshotV2);
}

const VALIDATORS: Record<string, (raw: unknown) => void> = {
  'campaign.version.v1': (raw) => assertSnapshot(campaignVersionSnapshotV1Schema as SafeParser, 'campaign.version.v1', raw),
  'campaign.version.v2': (raw) => assertSnapshot(campaignVersionSnapshotV2Schema as SafeParser, 'campaign.version.v2', raw),
  'campaign.version.v3': (raw) => assertSnapshot(campaignVersionSnapshotV3Schema as SafeParser, 'campaign.version.v3', raw),
  'campaign.version.v4': (raw) => assertSnapshot(campaignVersionSnapshotV4Schema as SafeParser, 'campaign.version.v4', raw),
};

type SafeParser = { safeParse(raw: unknown): { success: true } | { success: false; error: { issues: { code: string; path: PropertyKey[]; keys?: string[] }[] } } };

/** Structural check against the shared Zod schema of the id (one definition for the API, database layer and readers). */
function assertSnapshot(schema: SafeParser, id: string, raw: unknown): void {
  const result = schema.safeParse(raw);
  if (result.success) return;
  const issue = result.error.issues[0]!;
  const what =
    issue.code === 'unrecognized_keys' && issue.path.length === 0
      ? `unexpected fields (${(issue.keys ?? []).join(',')})`
      : issue.path.length > 0
        ? issue.path.join('.')
        : 'not an object';
  throw new VersionError('SNAPSHOT_INVALID', `Invalid ${id}: ${what}`);
}

/** Write-side validation of a new snapshot (contract §4.1: validated on write AND read). */
export function assertSnapshotV2(raw: unknown): asserts raw is CampaignVersionSnapshotV2 {
  assertSnapshot(campaignVersionSnapshotV2Schema as SafeParser, 'campaign.version.v2', raw);
}

/** Write-side validation of any NEW snapshot, against the schema of its own id (v2 or v3). */
export function assertNewSnapshot(raw: CurrentVersionSnapshot): void {
  if (raw.schema === 'campaign.version.v4') assertSnapshot(campaignVersionSnapshotV4Schema as SafeParser, 'campaign.version.v4', raw);
  else if (raw.schema === 'campaign.version.v3') assertSnapshot(campaignVersionSnapshotV3Schema as SafeParser, 'campaign.version.v3', raw);
  else assertSnapshotV2(raw);
}

/** Exact v1 shape (historical versions; tests). */
export function assertSnapshotV1(raw: unknown): void {
  assertSnapshot(campaignVersionSnapshotV1Schema as SafeParser, 'campaign.version.v1', raw);
}

function copySelector(s: AudienceSelector): AudienceSelector {
  return s.type === 'list' ? { type: 'list', listId: s.listId } : { type: 'tag', tagId: s.tagId };
}

const stripControl = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, '');

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
