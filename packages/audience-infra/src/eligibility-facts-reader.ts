import {
  ADDRESS_KIND_FOR_CHANNEL,
  DEFAULT_PENDING_EXPIRY_DAYS,
  type EligibilityFactsBatch,
  type EligibilityFactsQuery,
  type EligibilityFactsReader,
  type StoredChannelState,
  type TenantScope,
} from '@workeasy/audience-core';
import type { Tx } from '@workeasy/db';
import { assertTenantScope } from './tenant-scope.js';

const STORED_CHANNEL_STATES: readonly StoredChannelState[] = ['none', 'pending', 'granted', 'withdrawn'];

/** Persistence value → core contract; an unknown stored value fails closed instead of being read as "no blocker". */
function storedChannelState(value: string): StoredChannelState {
  const s = STORED_CHANNEL_STATES.find((x) => x === value);
  if (!s) throw new Error(`Unknown stored consent state "${value}"`);
  return s;
}

/**
 * Eligibility facts from the Audience tables (queries moved unchanged from apps/api `EligibilityService.evaluate` and
 * `effectiveConsent`, milestone 6.2). A fixed number of queries per batch — at most seven, independent of the batch
 * size, plus one tenant-scope check per transaction — all inside the caller's RLS-scoped transaction.
 */
export class PrismaEligibilityFactsReader implements EligibilityFactsReader<Tx> {
  async load(scope: TenantScope<Tx>, q: EligibilityFactsQuery): Promise<EligibilityFactsBatch> {
    await assertTenantScope(scope);
    const { tx, workspaceId } = scope;
    const ids = q.contactIds;

    let topic: EligibilityFactsBatch['topic'] = null;
    if (q.topicId) {
      const t = await tx.topic.findUnique({ where: { id: q.topicId }, select: { status: true, kind: true } });
      // A category, an unknown id or another workspace's topic (invisible under RLS) is "not found".
      if (!t || t.kind !== 'topic') return { ...EMPTY, topic: { found: false } };
      topic = { found: true, status: t.status === 'active' ? 'active' : 'archived' };
    }

    // Raw SQL with ONE uuid[] parameter per query (Gate E, 2026-10-10): the model API sent each batch as a 500-placeholder
    // IN list and mapped every row through the query engine — the largest allocation in campaign materialization. Same
    // tables, predicates and columns as before; no workspace predicate either way: RLS scopes every statement to the
    // caller's tenant (the transaction is the caller's).
    // Ids travel as ONE comma-separated text (uuids contain no comma) and addresses as one JSON array: the driver turns a
    // JS array into a PostgreSQL array literal element by element, which allocated more than the rows themselves.
    const idList = ids.join(',');
    const contacts = await tx.$queryRaw<{ id: string; deleted: boolean; erased: boolean; subscription_type: string }[]>`
      SELECT id, deleted_at IS NOT NULL AS deleted, erased_at IS NOT NULL AS erased, subscription_type
        FROM contacts WHERE id = ANY(string_to_array(${idList}, ',')::uuid[])`;
    const kind = ADDRESS_KIND_FOR_CHANNEL[q.channel];
    const identityRows = await tx.$queryRaw<{ id: string; contact_id: string; value_normalized: string; is_primary: boolean }[]>`
      SELECT id, contact_id, value_normalized, is_primary FROM contact_identities
       WHERE contact_id = ANY(string_to_array(${idList}, ',')::uuid[]) AND kind = ${kind}`;
    const identities = identityRows.map((i) => ({ id: i.id, contactId: i.contact_id, valueNormalized: i.value_normalized, isPrimary: i.is_primary }));
    const values = identities.map((i) => i.valueNormalized);
    const suppressionRows = await tx.$queryRaw<{ contact_id: string | null; value_normalized: string | null; channel: string; reason: string }[]>`
      SELECT contact_id, value_normalized, channel, reason FROM suppressions
       WHERE lifted_at IS NULL AND channel = ANY(${[q.channel, 'all']}::text[])
         AND (contact_id = ANY(string_to_array(${idList}, ',')::uuid[]) OR (identity_kind = ${kind} AND value_normalized = ANY(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(values)}::jsonb)))))`;
    const suppressions = suppressionRows.map((r) => ({ contactId: r.contact_id, valueNormalized: r.value_normalized, channel: r.channel, reason: r.reason }));
    const states = contacts.length
      ? await tx.$queryRaw<{ contact_id: string; state: string; recorded_at: Date; subject_fingerprint: string | null }[]>`
          SELECT contact_id, state, recorded_at, subject_fingerprint FROM consent_states
           WHERE contact_id = ANY(string_to_array(${contacts.map((c) => c.id).join(',')}, ',')::uuid[]) AND channel = ${q.channel}`
      : [];
    // The policy is read only when a projection exists, as before the move (same query count).
    const policy = states.length ? await tx.consentRetentionPolicy.findUnique({ where: { workspaceId }, select: { pendingExpiryDays: true } }) : null;
    const prefs = q.topicId
      ? await tx.$queryRaw<{ contact_id: string; status: string }[]>`
          SELECT contact_id, status FROM contact_topic_preferences WHERE contact_id = ANY(string_to_array(${idList}, ',')::uuid[]) AND topic_id = ${q.topicId}::uuid`
      : [];

    return {
      topic,
      contacts: contacts.map((c) => ({ id: c.id, deleted: c.deleted, erased: c.erased, subscriptionType: c.subscription_type })),
      identities,
      suppressions,
      consentStates: states.map((s) => ({ contactId: s.contact_id, state: storedChannelState(s.state), recordedAt: s.recorded_at, subjectFingerprint: s.subject_fingerprint })),
      pendingExpiryDays: policy?.pendingExpiryDays ?? DEFAULT_PENDING_EXPIRY_DAYS,
      topicPreferences: prefs.map((p) => ({ contactId: p.contact_id, status: p.status === 'subscribed' ? 'subscribed' : 'unsubscribed' })),
    };
  }
}

const EMPTY: EligibilityFactsBatch = {
  topic: null,
  contacts: [],
  identities: [],
  suppressions: [],
  consentStates: [],
  pendingExpiryDays: DEFAULT_PENDING_EXPIRY_DAYS,
  topicPreferences: [],
};
