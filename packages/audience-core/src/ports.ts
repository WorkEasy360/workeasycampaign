import type { AudienceDefinitionV1, AudienceSelector, Channel, MergeData } from '@workeasy/shared';
import type { StoredChannelState } from './consent-state.js';

/**
 * Ports of the Audience read side (docs/contracts/phase-5-audience.md §9.4, §9.8). Implemented ONLY by
 * `@workeasy/audience-infra` (the Audience context's adapters) and injected by the API / worker composition roots.
 * Consumers (Campaigns, worker jobs) depend on these interfaces, never on Audience tables or the implementations.
 *
 * Every method takes a TenantScope: a transaction already bound to one org + workspace (RLS). Adapters assert that the
 * scope matches the transaction's tenant, so a caller can never read another workspace through a mislabelled scope.
 * `TTx` is the transaction handle type; core never inspects it.
 */
export interface TenantScope<TTx = unknown> {
  tx: TTx;
  orgId: string;
  workspaceId: string;
}

// ─── Eligibility facts ─────────────────────────────────────────────────────────────────────────────────────────

export interface EligibilityFactsQuery {
  /** Unique contact ids (the evaluator de-duplicates). */
  contactIds: string[];
  channel: Channel;
  topicId: string | null;
}

/**
 * Raw facts for a batch of contacts, loaded in a fixed number of queries (never one query per contact). Ids and
 * normalized values only; the rules that interpret them live in core (EligibilityEvaluator, evaluateEligibility).
 */
export interface EligibilityFactsBatch {
  /** null when no topic was requested; `found: false` for an unknown topic, a category, or another workspace's topic. */
  topic: { found: true; status: 'active' | 'archived' } | { found: false } | null;
  /** Contacts of the scope's workspace among the requested ids (others are simply absent). */
  contacts: { id: string; deleted: boolean; erased: boolean; subscriptionType: string }[];
  /** Identities of the channel's address kind for those contacts. */
  identities: { id: string; contactId: string; valueNormalized: string; isPrimary: boolean }[];
  /** Active (not lifted) suppressions for the channel or `all`, by contact or by one of those identities' values. */
  suppressions: { contactId: string | null; valueNormalized: string | null; channel: string; reason: string }[];
  /** Stored channel-consent projections for the channel. */
  consentStates: { contactId: string; state: StoredChannelState; recordedAt: Date | null; subjectFingerprint: string | null }[];
  /** The workspace's pending-consent expiry (policy or default). */
  pendingExpiryDays: number;
  /** Topic preferences for the requested topic (empty when no topic was requested). */
  topicPreferences: { contactId: string; status: 'subscribed' | 'unsubscribed' }[];
}

export interface EligibilityFactsReader<TTx = unknown> {
  load(scope: TenantScope<TTx>, query: EligibilityFactsQuery): Promise<EligibilityFactsBatch>;
}

// ─── Audience Resolution v1 (§9.3–9.5) — port only; the snapshot adapter arrives with milestone 6.3 (Gate 2) ───

export type AudienceSourceStatus = 'ok' | 'archived' | 'not_found';

export interface AudienceValidation {
  valid: boolean;
  sources: { role: 'include' | 'exclude'; selector: AudienceSelector; status: AudienceSourceStatus }[];
  errors: { code: string; selector?: AudienceSelector; message: string }[];
}

export interface AudienceCount {
  count: number;
  capped: boolean;
  countedAt: string;
}

export interface AudienceSnapshotRef {
  snapshotId: string;
  /** Caller's idempotency key (Campaigns: the execution id). */
  captureKey: string;
  /** T0. */
  capturedAt: string;
  size: number;
  /** sha-256 of the canonical definition (definitionHash). */
  definitionHash: string;
}

export interface AudienceSnapshotPage {
  /** Ascending, unique, length ≤ limit. */
  contactIds: string[];
  /** null ⇔ no more members. */
  cursor: string | null;
}

export type SnapshotReleaseReason = 'materialized' | 'cancelled' | 'failed' | 'orphan_sweep';

/** Result of one releaseByKey call (decision A). */
export interface AudienceReleaseResult {
  /** A snapshot with this key exists in the workspace and is released (by this call or earlier). */
  released: boolean;
  /** Member purge incomplete (purged_at IS NULL): call releaseByKey again in a NEW transaction. */
  membersRemaining: boolean;
}
export type SnapshotOwner = { kind: 'campaign_execution'; id: string };

export interface AudienceResolution<TTx = unknown> {
  /** Do all sources exist (and are they usable) in this workspace? Read-only. */
  validate(scope: TenantScope<TTx>, def: AudienceDefinitionV1): Promise<AudienceValidation>;
  /** Live, exact member count up to `cap` (default and maximum CAPTURE_LIMIT) — editing and pre-flight only. */
  count(scope: TenantScope<TTx>, def: AudienceDefinitionV1, opts?: { cap?: number }): Promise<AudienceCount>;
  /** Single-statement capture at T0. Idempotent per captureKey: a repeat returns the existing snapshot. */
  capture(scope: TenantScope<TTx>, def: AudienceDefinitionV1, captureKey: string, owner: SnapshotOwner): Promise<AudienceSnapshotRef>;
  /** Ascending pages over an immutable snapshot; deterministic; 1–1,000 per page (default 1,000). */
  page(scope: TenantScope<TTx>, snapshotId: string, opts: { cursor: string | null; limit?: number }): Promise<AudienceSnapshotPage>;
  /**
   * Releases by key (first reason kept) and purges at most 10,000 members per call; sets purged_at in the transaction
   * that observes none remaining. Idempotent and serialized by the snapshot row lock. No snapshot for the key →
   * { released: false, membersRemaining: false }. Afterwards page() and capture(key) → AUDIENCE_SNAPSHOT_NOT_FOUND.
   */
  releaseByKey(scope: TenantScope<TTx>, captureKey: string, reason: SnapshotReleaseReason): Promise<AudienceReleaseResult>;
  /** Unreleased snapshots of an owner kind captured before `olderThan` — for the owner's recovery sweep. Ids only. */
  listUnreleased(
    scope: TenantScope<TTx>,
    ownerKind: SnapshotOwner['kind'],
    olderThan: Date,
    limit: number,
  ): Promise<{ snapshotId: string; captureKey: string; ownerId: string; capturedAt: string; size: number }[]>;
  /** Released snapshots whose member purge is incomplete, oldest release first — for purge recovery. Ids only. */
  listReleasedUnpurged(
    scope: TenantScope<TTx>,
    ownerKind: SnapshotOwner['kind'],
    limit: number,
  ): Promise<{ snapshotId: string; captureKey: string; ownerId: string; releasedAt: string }[]>;
}

// ─── Audience Resolution v1.1 (additive, approved 2026-10-07; Audience contract §9.9) ─────────────────────────

/** Upper bound of one sample (Campaign pre-flight estimates eligibility on ≤ 2,000 members). */
export const AUDIENCE_SAMPLE_LIMIT = 2_000;

export interface AudienceSampleOptions {
  /** 0–AUDIENCE_SAMPLE_LIMIT. The sample has min(size, audience) members. */
  size: number;
  /** Tests only: the same seed (−1…1) over the same data yields the same sample. Omit for fresh randomness. */
  seed?: number;
}

export interface AudienceSample {
  /**
   * A UNIFORM random sample of the live audience (without replacement): every member is equally likely and every
   * subset of the returned size equally likely. Contact ids only (no personal data), ascending. Never stored.
   */
  contactIds: string[];
  /** Exact live audience size, capped at the capture limit (same semantics as `count`). */
  audienceSize: number;
  capped: boolean;
  sampledAt: string;
}

/** Whether a topic can be used by a campaign in this workspace. Unavailable = absent here (also: another workspace's), archived, or a category. */
export type AudienceTopicStatus = { available: true } | { available: false; reason: 'not_found' | 'archived' | 'category' };

/**
 * Audience Resolution v1.1 = v1 + two read-only operations. v1 operations and their semantics are unchanged; an
 * implementation of v1.1 is a v1 implementation.
 */
export interface AudienceResolutionV1_1<TTx = unknown> extends AudienceResolution<TTx> {
  /**
   * Uniform sample of the LIVE audience (same membership and liveness rules as `count`; no snapshot, no write). Same
   * validation and errors as `count` (AUDIENCE_DEFINITION_INVALID, AUDIENCE_SOURCE_NOT_FOUND). Size and sample come
   * from one consistent read.
   */
  sample(scope: TenantScope<TTx>, def: AudienceDefinitionV1, opts: AudienceSampleOptions): Promise<AudienceSample>;
  /** Status of one topic of the scope's workspace. Ids that are not UUIDs, or not visible here, are `not_found`. */
  topicStatus(scope: TenantScope<TTx>, topicId: string): Promise<AudienceTopicStatus>;
}

/**
 * Audience Resolution v1.2 (approved 2026-10-07; Audience contract §9.10) = v1.1 + a BOUNDED sample for interactive
 * callers. The bitmap path is unchanged; when the workspace's count bitmap is not valid, the exact query runs under a
 * hard time budget, and if it cannot finish inside it the answer is "temporarily unavailable" — never an unbounded
 * query, never an estimate made up from partial data.
 */
export interface AudienceSampleWithinOptions extends AudienceSampleOptions {
  /** Statement budget for the exact path (bitmap not valid), 100–10,000 ms. */
  exactBudgetMs: number;
}
export type AudienceSampleOutcome =
  | { available: true; sample: AudienceSample }
  /** The bitmap is not valid and the exact query did not finish within the budget. Nothing was read partially. */
  | { available: false; reason: 'exact_budget_exceeded' };

export interface AudienceResolutionV1_2<TTx = unknown> extends AudienceResolutionV1_1<TTx> {
  /** `sample` with a bounded exact path. Same validation and errors as `sample`. Leaves the caller's transaction usable. */
  sampleWithin(scope: TenantScope<TTx>, def: AudienceDefinitionV1, opts: AudienceSampleWithinOptions): Promise<AudienceSampleOutcome>;
}

/**
 * Audience Resolution recovery (v1.2): ask the Audience context to make fast resolution available again for a
 * workspace. Idempotent and deduplicated per workspace (one rebuild at a time across processes); never blocks on the
 * rebuild itself. Callers learn nothing about how resolution is made fast.
 */
export type AudienceRecoveryStatus = 'ready' | 'rebuilding' | 'requested';
export interface AudienceResolutionRecovery {
  requestRecovery(workspace: { orgId: string; workspaceId: string }): Promise<{ status: AudienceRecoveryStatus }>;
}

// ─── Address Lookup v1 (E-4) — port only; the adapter arrives with delivery (Phase 8) ──────────────────────────

export interface AddressLookup<TTx = unknown> {
  /**
   * The send-to address for identity ids returned by eligibility (`addressIdentityId`). Ids of other workspaces, or
   * of erased contacts, are absent from the result. Used immediately before delivery, never stored by the caller.
   */
  lookup(scope: TenantScope<TTx>, identityIds: string[]): Promise<{ identityId: string; kind: 'email' | 'phone' | 'whatsapp'; value: string }[]>;
}

// ─── Audience Profiles v1 (2026-10-08; content amendment C9, campaign contract row 23) ───────────────────────────

/** Most contact ids one call accepts (keeps each call one bounded set of queries). */
export const AUDIENCE_PROFILES_BATCH_LIMIT = 1_000;

export interface AudienceProfiles<TTx = unknown> {
  /**
   * Merge-tag values (`merge_tags_v1` allowlist only: first name, last name, company, primary email) for these
   * contacts. Contacts of other workspaces (RLS), deleted or erased contacts are ABSENT from the result. A field the
   * contact has no value for is null. Used for rendering/preview immediately; never stored by the caller.
   */
  mergeData(scope: TenantScope<TTx>, contactIds: string[]): Promise<Map<string, MergeData>>;
  /**
   * A human display name per contact for operational lists (e.g. campaign recipients): "First Last", else the
   * company, else "Unnamed contact"; erased contacts are "Erased contact" and deleted ones "Deleted contact". NEVER an
   * address or other identity value. Contacts of other workspaces are absent.
   */
  displayNames(scope: TenantScope<TTx>, contactIds: string[]): Promise<Map<string, string>>;
  /**
   * Personalization values for `merge_tags_v2` (Phase 7 content amendment §C, C14; additive): the `mergeData` fields
   * plus the requested custom fields, keyed `contact.custom.<key>`, formatted as text by Audience (booleans Yes/No,
   * dates YYYY-MM-DD, option LABELS, multi-select labels joined with ", ", at most 1,000 characters). An unknown key
   * or a contact without a value gives null. Same visibility rules as `mergeData` (absent = not visible). At most
   * `AUDIENCE_PROFILES_CUSTOM_KEYS_LIMIT` keys.
   */
  mergeDataV2(scope: TenantScope<TTx>, contactIds: string[], customKeys: string[]): Promise<Map<string, Record<string, string | null>>>;
  /** The workspace's custom fields usable for personalization (definition order), archived ones flagged. */
  personalizationFields(scope: TenantScope<TTx>): Promise<PersonalizationField[]>;
}

/**
 * A contact's own unsubscribe, recorded by Audience (Phase 7.8; additive). Campaigns verify the unsubscribe link and
 * call this; Audience owns consent and its immutable history. Recorded with actor `contact`.
 *  - `topicId` set → unsubscribe from that topic only; null → withdraw the channel (no marketing on it at all).
 *  - Idempotent: already unsubscribed → `{ changed: false }`. A contact that is gone (deleted, erased, other tenant)
 *    → `{ changed: false, contactGone: true }` (nothing to record; never an error for a link click).
 */
export interface ConsentRecorder {
  recordUnsubscribe(
    tenant: { orgId: string; workspaceId: string },
    input: {
      contactId: string;
      channel: 'email' | 'sms' | 'whatsapp';
      topicId: string | null;
      /**
       * `provider_unsubscribe`: the email provider's own unsubscribe link or header (Phase 7.9 webhooks).
       * `sms_stop`: the contact replied STOP to the SMS number; `whatsapp_opt_out`: WhatsApp reported that the contact
       * stopped marketing messages from the business (messaging amendment §4).
       */
      source: 'unsubscribe_link' | 'list_unsubscribe' | 'provider_unsubscribe' | 'sms_stop' | 'whatsapp_opt_out';
      /** Ids only (campaign, execution, recipient) — kept as evidence. */
      evidence: Record<string, string>;
      correlationId: string;
      ipAddress: string | null;
      userAgent: string | null;
    },
  ): Promise<{ changed: boolean; contactGone?: boolean }>;
  /**
   * The contact undid their own provider opt-out (messaging amendment §4): an SMS START reply after STOP. Changes
   * consent back to granted ONLY when the contact's current state for the channel is a withdrawal the contact made with
   * `reverses` as its source; any other state (never consented, withdrawn by staff or through another route) is left as
   * it is. Idempotent.
   */
  recordProviderOptIn(
    tenant: { orgId: string; workspaceId: string },
    input: { contactId: string; channel: 'sms'; source: 'sms_start'; reverses: 'sms_stop'; evidence: Record<string, string>; correlationId: string },
  ): Promise<{ changed: boolean }>;
}

/**
 * Suppressions caused by delivery feedback (Phase 7.9; additive). A provider reported a hard bounce or a complaint for
 * the address a campaign used: Audience suppresses that ADDRESS for the channel (it survives the contact being deleted
 * and re-created). Idempotent: an existing active suppression → `created: false`.
 */
export interface DeliverySuppressions {
  suppressAddress(
    tenant: { orgId: string; workspaceId: string },
    input: { addressIdentityId: string; channel: 'email'; reason: 'hard_bounce' | 'complaint'; correlationId: string; note: string },
  ): Promise<{ created: boolean; addressGone?: boolean }>;
}

/**
 * Audience-owned usage gauges (Phase 7.13; meters contacts.active and storage.bytes): counted inside the caller's
 * tenant transaction (RLS) by the owner of the tables. Counts only.
 */
export interface AudienceUsage<TTx = unknown> {
  /** Live contacts (not deleted, not erased) of the workspace. */
  activeContacts(scope: { tx: TTx; orgId: string; workspaceId: string }): Promise<number>;
  /** Bytes of stored import files of the workspace. */
  storedImportBytes(scope: { tx: TTx; orgId: string; workspaceId: string }): Promise<number>;
}

export interface PersonalizationField {
  key: string;
  label: string;
  type: string;
  archived: boolean;
}

/** Custom-field keys per `mergeDataV2` call (a message can use at most this many distinct custom fields). */
export const AUDIENCE_PROFILES_CUSTOM_KEYS_LIMIT = 50;
