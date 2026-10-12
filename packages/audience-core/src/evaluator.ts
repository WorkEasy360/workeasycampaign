import type { Channel, EligibilityResponse, EligibilityResult, MessagePurpose, TopicPolicy } from '@workeasy/shared';
import { type ChannelState, effectiveChannelState } from './consent-state.js';
import { evaluateEligibility } from './eligibility.js';
import { consentFingerprint } from './fingerprint.js';
import type { EligibilityFactsBatch, EligibilityFactsReader, TenantScope } from './ports.js';

/** An unknown topic (or a category, or another workspace's topic) is a bad request, not a per-contact reason. */
export class EligibilityTopicNotFoundError extends Error {
  readonly code = 'TOPIC_NOT_FOUND';
  constructor() {
    super('No such topic in this workspace');
    this.name = 'EligibilityTopicNotFoundError';
  }
}

/**
 * In-process batch limit (decision D, docs/eligibility.md §v1.1), set by the 6.3.10 benchmark with realistic facts:
 * 100 ids p95 114 ms, 500 ids p95 191 ms (passes p95 < 250 ms), 1,000 ids p95 316 ms (fails) — so the largest passing
 * size, 500. A 1,000-id snapshot page is evaluated in two sub-batches (evaluateInBatches) with identical results. The
 * HTTP limit (100) is separate and never derived from this.
 */
export const ELIGIBILITY_BATCH_LIMIT = 500;
/** Most ids `evaluateInBatches` accepts: one audience snapshot page. */
export const ELIGIBILITY_PAGE_LIMIT = 1_000;

/** More distinct ids than the limit in one call: a programming error, never a partial answer. */
export class EligibilityBatchTooLargeError extends Error {
  readonly code = 'ELIGIBILITY_BATCH_TOO_LARGE';
  constructor(size: number, limit = ELIGIBILITY_BATCH_LIMIT) {
    super(`Eligibility evaluates at most ${limit} contacts per call (got ${size}); split into batches`);
    this.name = 'EligibilityBatchTooLargeError';
  }
}

export interface EligibilityEvaluationRequest {
  contactIds: string[];
  channel: Channel;
  purpose: MessagePurpose;
  topicId?: string;
  /** Eligibility v1.1. Omitted ⇒ v1 behaviour. */
  topicPolicy?: TopicPolicy;
}

/**
 * Eligibility contract v1 (docs/eligibility.md): loads facts for a batch through the port, derives effective consent
 * (pending expiry, address binding by fingerprint) and applies the one rule set. Behaviour moved unchanged from
 * apps/api `EligibilityService.evaluate` (milestone 6.2). Contacts of other workspaces are never evaluated: they are
 * absent from the facts (RLS) and reported in `notFound`.
 */
export class EligibilityEvaluator<TTx = unknown> {
  constructor(
    private readonly reader: EligibilityFactsReader<TTx>,
    private readonly fingerprintSecret: string,
    private readonly clock: () => Date = () => new Date(),
    options: { batchLimit?: number } = {},
  ) {
    // Benchmark seam (decision D): may only be set between 1 and one snapshot page; production uses the default.
    this.batchLimit = Math.max(1, Math.min(options.batchLimit ?? ELIGIBILITY_BATCH_LIMIT, ELIGIBILITY_PAGE_LIMIT));
  }

  private readonly batchLimit: number;

  /**
   * Evaluates up to ELIGIBILITY_PAGE_LIMIT ids (one snapshot page) as consecutive batches of the batch limit in
   * the caller's transaction (decision D). Every contact is evaluated exactly as by `evaluate`; only the number of calls
   * differs, so the result set is identical whatever the batch size.
   */
  async evaluateInBatches(scope: TenantScope<TTx>, req: EligibilityEvaluationRequest): Promise<EligibilityResponse> {
    const ids = [...new Set(req.contactIds)];
    if (ids.length > ELIGIBILITY_PAGE_LIMIT) throw new EligibilityBatchTooLargeError(ids.length, ELIGIBILITY_PAGE_LIMIT);
    const out: EligibilityResponse = { results: [], notFound: [] };
    for (let i = 0; i < ids.length || i === 0; i += this.batchLimit) {
      const r = await this.evaluate(scope, { ...req, contactIds: ids.slice(i, i + this.batchLimit) });
      out.results.push(...r.results);
      out.notFound.push(...r.notFound);
    }
    return out;
  }

  async evaluate(scope: TenantScope<TTx>, req: EligibilityEvaluationRequest): Promise<EligibilityResponse> {
    const ids = [...new Set(req.contactIds)];
    if (ids.length > this.batchLimit) throw new EligibilityBatchTooLargeError(ids.length, this.batchLimit);
    const topicId = req.topicId ?? null;
    const facts = await this.reader.load(scope, { contactIds: ids, channel: req.channel, topicId });
    if (topicId && !facts.topic?.found) throw new EligibilityTopicNotFoundError();
    const topic = facts.topic?.found ? facts.topic : null;

    const primary = new Map(facts.identities.filter((i) => i.isPrimary).map((i) => [i.contactId, i]));
    const consent = this.effectiveConsent(facts, req.channel, primary);

    // Indexed once per batch (Gate E, 2026-10-10): the per-contact scans of every identity, suppression and preference
    // were O(batch²) work and allocation. Same facts, same order within each contact.
    const addressesOf = new Map<string, string[]>();
    for (const i of facts.identities) {
      const list = addressesOf.get(i.contactId);
      if (list) list.push(i.valueNormalized);
      else addressesOf.set(i.contactId, [i.valueNormalized]);
    }
    const suppressionsByContact = new Map<string, number[]>();
    const suppressionsByValue = new Map<string, number[]>();
    facts.suppressions.forEach((s, k) => {
      for (const [map, key] of [[suppressionsByContact, s.contactId], [suppressionsByValue, s.valueNormalized]] as const) {
        if (!key) continue;
        const list = map.get(key);
        if (list) list.push(k);
        else map.set(key, [k]);
      }
    });
    const preferenceOf = new Map<string, 'subscribed' | 'unsubscribed'>();
    for (const p of facts.topicPreferences) if (!preferenceOf.has(p.contactId)) preferenceOf.set(p.contactId, p.status);
    const NO_ADDRESSES: string[] = [];

    const results: EligibilityResult[] = facts.contacts.map((c) => {
      const addresses = addressesOf.get(c.id) ?? NO_ADDRESSES;
      // Suppressions of the contact or of one of its addresses, in fact order, each once (as the former filter).
      const own = suppressionsByContact.get(c.id);
      let applicable: { channel: string; reason: string }[] = [];
      if (own || addresses.some((a) => suppressionsByValue.has(a))) {
        const hits = new Set<number>(own);
        for (const a of addresses) for (const k of suppressionsByValue.get(a) ?? []) hits.add(k);
        applicable = [...hits].sort((x, y) => x - y).map((k) => ({ channel: facts.suppressions[k]!.channel, reason: facts.suppressions[k]!.reason }));
      }
      const r = evaluateEligibility(
        {
          contact: { id: c.id, deleted: c.deleted, erased: c.erased, subscriptionType: c.subscriptionType },
          addresses,
          suppressions: applicable,
          consent: { state: consent.get(c.id)?.state ?? 'none', forCurrentAddress: consent.get(c.id)?.forCurrentAddress ?? true },
          topic:
            topicId && topic
              ? { status: topic.status, preference: preferenceOf.get(c.id) ?? 'none' }
              : undefined,
        },
        { channel: req.channel, purpose: req.purpose, topicId, ...(req.topicPolicy ? { topicPolicy: req.topicPolicy } : {}) },
      );
      return {
        contactId: c.id,
        channel: req.channel,
        purpose: req.purpose,
        topicId,
        ...r,
        addressIdentityId: c.erased ? null : (primary.get(c.id)?.id ?? null),
      };
    });
    const found = new Set(facts.contacts.map((c) => c.id));
    return { results, notFound: ids.filter((id) => !found.has(id)) };
  }

  /**
   * Effective consent per contact for the channel: pending past its expiry is `expired`, and `forCurrentAddress` says
   * whether the state was recorded for the contact's current primary address (docs/consent.md §Address binding).
   */
  private effectiveConsent(facts: EligibilityFactsBatch, channel: Channel, primary: Map<string, { valueNormalized: string }>) {
    const out = new Map<string, { state: ChannelState; forCurrentAddress: boolean }>();
    const now = this.clock();
    for (const s of facts.consentStates) {
      const address = primary.get(s.contactId)?.valueNormalized;
      out.set(s.contactId, {
        state: effectiveChannelState(s.state, s.recordedAt, facts.pendingExpiryDays, now),
        // No primary address → nothing to compare (NO_ADDRESS reports that); otherwise the fingerprints must match.
        forCurrentAddress: address === undefined || (s.subjectFingerprint !== null && s.subjectFingerprint === consentFingerprint(this.fingerprintSecret, channel, address)),
      });
    }
    return out;
  }
}
