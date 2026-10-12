import type { Channel } from '@workeasy/shared';
import { Inject, Injectable } from '@nestjs/common';
import {
  AUDIENCE_SAMPLE_LIMIT,
  type AudienceResolutionRecovery,
  type AudienceResolutionV1_2,
  definitionErrors,
  type EligibilityEvaluator,
} from '@workeasy/audience-core';
import type { AudienceProfiles } from '@workeasy/audience-core';
import type { Database, Tx } from '@workeasy/db';
import { AUDIENCE_SAMPLE_SIZE, type CampaignAudienceSample, type EligibilityResult, messageDraftSchema, type PreflightResult, type ReadinessFinding } from '@workeasy/shared';
import type { TenantRequestContext } from '../../../common/request-context.js';
import { AUDIENCE_PROFILES, AUDIENCE_RECOVERY, AUDIENCE_RESOLUTION, DATABASE, ELIGIBILITY_EVALUATOR } from '../../../infrastructure/providers.js';
import { inTenant } from '../../tenancy/application/tenant-tx.js';
import type { CampaignDraft } from '../domain/draft.js';
import { type PreflightFacts, preflightFindings, summarize } from '../domain/readiness.js';
import { campaignNotFound } from './campaign-errors.js';
import { CampaignsService } from './campaigns.service.js';
import { draftOf } from './campaign-views.js';
import { customKeysOf } from './personalization.js';
import { senderIdentityState } from './senders.service.js';

const TOP_REASONS = 5;
/** Sample ids per eligibility transaction. */
const ELIGIBILITY_SLICE = 500;
/**
 * Eligibility transactions that pre-flights may run at once in this process (of the API pool's 10 connections).
 * MEASURED (docs/audit/phase-6.7-6.8-preflight-lifecycle.md §4.3): eligibility of a uniform sample is random-IO bound
 * (≈ 1,600 uncached pages per fact table per 1,000 ids at 1M contacts) and PostgreSQL does not prefetch for one
 * statement here, so overlapping the IO of independent slices is what keeps pre-flight within its target.
 */
const ELIGIBILITY_SLOTS = 4;
/**
 * Degraded mode (contract §3.3, approved 2026-10-07): when fast resolution is not available, the exact audience query
 * may use at most this budget inside an interactive pre-flight / schedule. Past it the estimate is reported as
 * unavailable (ELIGIBILITY_ESTIMATE_UNAVAILABLE) and recovery is requested — never an unbounded query, never a 500.
 */
export const PREFLIGHT_EXACT_BUDGET_MS = 1_000;
/** What clients are told to wait before retrying (a 1M rebuild took ≈ 2 min on the benchmark host). */
export const PREFLIGHT_RETRY_AFTER_SECONDS = 30;

export interface PreflightOutcome {
  result: PreflightResult;
  findings: ReadinessFinding[];
  errors: number;
  /** True when the audience could not be resolved within the budget (degraded mode); recovery was requested. */
  audienceUnavailable: boolean;
}

/**
 * Pre-flight (milestone 6.7; contract §3): readiness plus the checks that need Audience facts — topic status, source
 * status, the exact audience size and an eligibility estimate on a UNIFORM sample of ≤ 2,000 members. Facts come only
 * from the Audience ports (Resolution v1.1 + Eligibility v1.1); the findings come from the domain engine. Read-only:
 * nothing is written, no snapshot is created, and no member id leaves this service (the result carries counts and
 * shares only). The same engine runs inside `schedule` / send-now.
 *
 * Transactions: one short read for topic, sources and the sample (one statement: size and sample agree), then the
 * sample's eligibility in slices, each in its own short read transaction, at most ELIGIBILITY_SLOTS at once across the
 * process. No transaction is held while waiting for another, so concurrent pre-flights queue but cannot starve the
 * pool. Eligibility is live by contract, so evaluating slices in separate transactions changes nothing it promises.
 */
@Injectable()
export class PreflightService {
  private readonly slots = new Slots(ELIGIBILITY_SLOTS);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIENCE_RESOLUTION) private readonly resolution: AudienceResolutionV1_2<Tx>,
    @Inject(ELIGIBILITY_EVALUATOR) private readonly eligibility: EligibilityEvaluator<Tx>,
    @Inject(AUDIENCE_RECOVERY) private readonly recovery: AudienceResolutionRecovery,
    @Inject(AUDIENCE_PROFILES) private readonly profiles: AudienceProfiles<Tx>,
    private readonly campaigns: CampaignsService,
  ) {}

  /** Row 10 (`POST …/preflight`). */
  async preflight(ctx: TenantRequestContext, campaignId: string): Promise<PreflightResult> {
    const row = await inTenant(this.db, ctx, async ({ tx }) => {
      const r = await tx.campaign.findUnique({ where: { id: campaignId } });
      if (!r) throw campaignNotFound();
      return r;
    });
    return (await this.evaluate(ctx, draftOf(row))).result;
  }

  /** Runs the full pre-flight for a draft (its own read transactions; see the class comment). */
  async evaluate(ctx: TenantRequestContext, draft: CampaignDraft): Promise<PreflightOutcome> {
    const facts: PreflightFacts = { topic: null, sources: [], audience: null, eligibility: null };
    // Structural problems (empty include, conflicts, too many sources) are readiness findings: nothing to resolve.
    const resolvable = draft.channel === 'email' && definitionErrors(draft.audience).length === 0;
    // Phase 7 §C: custom fields referenced by v3 content must exist in the workspace (Audience port).
    const parsedMessage = messageDraftSchema.safeParse(draft.messages.find((m) => m.variantKey === 'default'));
    const customKeys = parsedMessage.success && parsedMessage.data.content.schema === 'email.content.v3' ? customKeysOf(parsedMessage.data.content) : [];
    const read = await inTenant(this.db, ctx, async ({ tx }) => {
      const scope = this.scope(tx, ctx);
      const topicAvailable = draft.topicId ? (await this.resolution.topicStatus(scope, draft.topicId)).available : false;
      if (draft.sender.senderIdentityId) {
        const s = await senderIdentityState(tx, draft.sender.senderIdentityId);
        facts.sender = !s ? 'missing' : s.verified ? 'ok' : 'unverified';
      }
      if (customKeys.length) {
        const fields = new Map((await this.profiles.personalizationFields(scope)).map((x) => [x.key, x]));
        facts.personalization = customKeys.map((key) => ({ key, status: !fields.has(key) ? 'unknown' : fields.get(key)!.archived ? 'archived' : 'ok' }));
      }
      if (!resolvable) return { topicAvailable, validation: null, sample: null, unavailable: false };
      const validation = await this.resolution.validate(scope, draft.audience);
      const outcome = validation.valid
        ? await this.resolution.sampleWithin(scope, draft.audience, { size: AUDIENCE_SAMPLE_LIMIT, exactBudgetMs: PREFLIGHT_EXACT_BUDGET_MS })
        : null;
      return { topicAvailable, validation, sample: outcome?.available ? outcome.sample : null, unavailable: outcome?.available === false };
    }, { timeout: 30_000 });

    if (draft.topicId) facts.topic = read.topicAvailable ? 'ok' : 'unavailable';
    if (read.validation) facts.sources = read.validation.sources.map((s) => ({ role: s.role, selector: s.selector, status: s.status }));
    if (read.unavailable) {
      facts.audienceUnavailable = { retryAfterSeconds: PREFLIGHT_RETRY_AFTER_SECONDS };
      // Audience-owned, deduplicated, non-blocking: the next pre-flight finds fast resolution again.
      await this.recovery.requestRecovery({ orgId: ctx.access.orgId, workspaceId: ctx.access.workspaceId! });
    }

    let estimate: PreflightResult['estimate'] = null;
    if (read.sample) {
      const { contactIds, audienceSize, capped } = read.sample;
      facts.audience = { size: audienceSize, capped };
      const results = await this.eligibilityOf(ctx, contactIds, read.topicAvailable ? draft.topicId : null, draft.channel);
      const reasons = new Map<string, number>();
      let eligible = 0;
      for (const x of results) {
        if (x.eligible) eligible++;
        for (const code of new Set(x.reasons.map((reason) => reason.code))) reasons.set(code, (reasons.get(code) ?? 0) + 1);
      }
      const sampleSize = contactIds.length;
      const eligibleEstimate = sampleSize ? Math.round((eligible / sampleSize) * audienceSize) : 0;
      facts.eligibility = { estimate: eligibleEstimate, sampleSize };
      estimate = {
        audienceSize,
        audienceSizeCapped: capped,
        eligibleEstimate,
        sampleSize,
        topReasons: [...reasons]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, TOP_REASONS)
          .map(([code, n]) => ({ code, share: sampleSize ? Math.round((n / sampleSize) * 10_000) / 10_000 : 0 })),
      };
    }

    const findings = preflightFindings(draft, facts, { now: new Date(), deliveryAvailable: this.campaigns.deliveryAvailable, liveDelivery: this.campaigns.liveDelivery, channelAvailable: this.campaigns.channelAvailable(draft.channel) });
    const summary = summarize(findings);
    return {
      result: { readiness: summary.readiness, readinessFindings: summary.readinessFindings, checkedAt: new Date().toISOString(), sections: summary.sections, estimate },
      findings,
      errors: findings.filter((f) => f.severity === 'error').length,
      audienceUnavailable: read.unavailable,
    };
  }

  /**
   * Phase 7.4: a handful of contacts of the draft's live audience (uniform sample) with their eligibility — display
   * names and reason codes only (Audience Profiles port; never an address). Needs contacts.read (it shows who is in the
   * audience). Same bounded resolution as pre-flight; degraded resolution answers `unavailable`, never an error.
   */
  async audienceSample(ctx: TenantRequestContext, campaignId: string): Promise<CampaignAudienceSample> {
    await this.campaigns.requirePermissions(ctx, new Set(['contacts.read']), 'audience_sample');
    const read = await inTenant(this.db, ctx, async ({ tx }) => {
      const row = await tx.campaign.findUnique({ where: { id: campaignId } });
      if (!row) throw campaignNotFound();
      const draft = draftOf(row);
      if (definitionErrors(draft.audience).length) return { ids: [] as string[], unavailable: false, topicId: draft.topicId, channel: draft.channel };
      const scope = this.scope(tx, ctx);
      if (!(await this.resolution.validate(scope, draft.audience)).valid) return { ids: [], unavailable: false, topicId: draft.topicId, channel: draft.channel };
      const outcome = await this.resolution.sampleWithin(scope, draft.audience, { size: AUDIENCE_SAMPLE_SIZE, exactBudgetMs: PREFLIGHT_EXACT_BUDGET_MS });
      const topicAvailable = draft.topicId ? (await this.resolution.topicStatus(scope, draft.topicId)).available : false;
      return { ids: outcome.available ? outcome.sample.contactIds : [], unavailable: !outcome.available, topicId: topicAvailable ? draft.topicId : null, channel: draft.channel };
    }, { timeout: 30_000 });
    if (read.unavailable) {
      await this.recovery.requestRecovery({ orgId: ctx.access.orgId, workspaceId: ctx.access.workspaceId! });
      return { unavailable: true, sample: [] };
    }
    if (!read.ids.length) return { unavailable: false, sample: [] };
    const [results, names] = await Promise.all([
      this.eligibilityOf(ctx, read.ids, read.topicId, read.channel),
      inTenant(this.db, ctx, async ({ tx }) => this.profiles.displayNames(this.scope(tx, ctx), read.ids)),
    ]);
    const byId = new Map(results.map((r) => [r.contactId, r]));
    return {
      unavailable: false,
      sample: read.ids.map((id) => {
        const r = byId.get(id);
        return { contactId: id, displayName: names.get(id) ?? 'Unnamed contact', eligible: !!r?.eligible, reasons: [...new Set((r?.reasons ?? []).map((x) => x.code))] };
      }),
    };
  }

  /**
   * Eligibility v1.1 for the sample: channel email, purpose marketing; `block_unsubscribed` for the campaign's topic
   * when it is available (an unavailable topic is its own error finding; the estimate then reflects channel rules).
   */
  private async eligibilityOf(ctx: TenantRequestContext, contactIds: string[], topicId: string | null, channel: Channel): Promise<EligibilityResult[]> {
    const slices: string[][] = [];
    for (let i = 0; i < contactIds.length; i += ELIGIBILITY_SLICE) slices.push(contactIds.slice(i, i + ELIGIBILITY_SLICE));
    const parts = await Promise.all(
      slices.map((ids) =>
        this.slots.run(() =>
          inTenant(this.db, ctx, async ({ tx }) =>
            (await this.eligibility.evaluateInBatches(this.scope(tx, ctx), {
              contactIds: ids,
              channel,
              purpose: 'marketing',
              ...(topicId ? { topicId, topicPolicy: 'block_unsubscribed' as const } : {}),
            })).results,
          { timeout: 30_000 }),
        ),
      ),
    );
    return parts.flat();
  }

  private scope(tx: Tx, ctx: TenantRequestContext) {
    return { tx, orgId: ctx.access.orgId, workspaceId: ctx.access.workspaceId! };
  }
}

/** A counting semaphore: at most `size` tasks run at once; the rest wait in FIFO order. */
class Slots {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly size: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.size) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next(); // hand the slot over directly (active stays the same)
      else this.active--;
    }
  }
}
