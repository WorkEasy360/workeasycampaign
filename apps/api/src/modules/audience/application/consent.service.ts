import { Inject, Injectable } from '@nestjs/common';
import type { Database, Tx } from '@workeasy/db';
import type { Channel, ConsentEventView, RecordConsentRequest, RetentionPolicyView } from '@workeasy/shared';
import { AppError, Errors } from '../../../common/errors.js';
import { decodeCursor, encodeCursor } from '../../../common/pagination.js';
import type { TenantRequestContext } from '../../../common/request-context.js';
import type { AppConfig } from '../../../config/env.js';
import { APP_CONFIG, DATABASE } from '../../../infrastructure/providers.js';
import { hmac } from '../../../infrastructure/tokens.js';
import { inTenant, type TenantUnitOfWork } from '../../tenancy/application/tenant-tx.js';
import { type ActorType, type ChannelState, changedByOf, evidenceProblems, nextChannelState, nextTopicState, type TopicState } from '../domain/consent.js';
import { CHANNEL_IDENTITY_KIND, requireLiveContact } from './audience-support.js';

/** Defaults when a workspace has no explicit policy (docs/consent.md §Retention). Proposed, configurable. */
export const DEFAULT_RETENTION = { retainAfterWithdrawalDays: 2190, retainAfterErasureDays: 2190, pendingExpiryDays: 7 } as const;

export interface ConsentInput {
  channel: Channel;
  action: RecordConsentRequest['action'];
  lawfulBasis?: string;
  source: string;
  actor: { type: ActorType; id: string | null };
  occurredAt?: Date;
  consentTextVersion?: string;
  formId?: string;
  formVersion?: string;
  evidence: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Records channel consent: validates the transition, appends the immutable evidence event and updates the
 * projection in the caller's transaction. Shared by the consent API, imports and (later) forms/preference center.
 * Returns null when the request is a no-op (already in that state), throws on a refused transition.
 */
export async function recordChannelConsent(uow: TenantUnitOfWork, fingerprintSecret: string, orgId: string, workspaceId: string, contactId: string, input: ConsentInput) {
  const { tx } = uow;
  const current = await tx.consentState.findUnique({ where: { contactId_channel: { contactId, channel: input.channel } } });
  const t = nextChannelState((current?.state ?? 'none') as ChannelState, (current?.changedBy ?? null) as never, input.action, input.actor.type);
  if (!t.ok) {
    if (t.code === 'NO_CHANGE') return null;
    throw new AppError('precondition_failed', 422, t.message, { action: [t.code] });
  }
  const address = await tx.contactIdentity.findFirst({
    where: { contactId, kind: CHANNEL_IDENTITY_KIND[input.channel], isPrimary: true },
    select: { valueNormalized: true },
  });
  if (!address && (t.newState === 'granted' || t.newState === 'pending')) {
    throw new AppError('precondition_failed', 422, `Add ${input.channel === 'email' ? 'an email address' : 'a phone number'} before recording ${input.channel} consent`, {
      channel: ['NO_ADDRESS'],
    });
  }
  const now = new Date();
  const ev = await tx.consentEvent.create({
    data: {
      orgId,
      workspaceId,
      contactId,
      channel: input.channel,
      action: input.action,
      previousState: current?.state ?? 'none',
      newState: t.newState,
      lawfulBasis: input.lawfulBasis ?? null,
      source: input.source,
      actorType: input.actor.type,
      actorId: input.actor.id,
      subjectFingerprint: address ? fingerprint(fingerprintSecret, input.channel, address.valueNormalized) : null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      consentTextVersion: input.consentTextVersion ?? null,
      formId: input.formId ?? null,
      formVersion: input.formVersion ?? null,
      evidence: input.evidence as object,
      correlationId: uow.origin.correlationId,
      occurredAt: input.occurredAt ?? now,
    },
  });
  const projection = {
    state: t.newState,
    changedBy: changedByOf(input.actor.type),
    lawfulBasis: input.lawfulBasis ?? current?.lawfulBasis ?? null,
    lastEventId: ev.id,
    changedAt: input.occurredAt ?? now,
  };
  if (current) await tx.consentState.update({ where: { contactId_channel: { contactId, channel: input.channel } }, data: projection });
  else await tx.consentState.create({ data: { orgId, workspaceId, contactId, channel: input.channel, ...projection } });
  await uow.event('consent.recorded', contactId, { channel: input.channel, action: input.action, newState: t.newState, consentEventId: ev.id });
  return { eventId: ev.id, newState: t.newState };
}

/** Topic preference change: same evidence log (topic-scoped event) + preference projection. */
export async function recordTopicPreference(
  uow: TenantUnitOfWork,
  orgId: string,
  workspaceId: string,
  contactId: string,
  topicId: string,
  status: 'subscribed' | 'unsubscribed',
  input: { source: string; actor: { type: ActorType; id: string | null }; evidence: Record<string, unknown>; ipAddress?: string | null; userAgent?: string | null },
) {
  const { tx } = uow;
  const topic = await tx.topic.findUnique({ where: { id: topicId } });
  if (!topic || topic.kind !== 'topic') throw Errors.notFound('Topic');
  if (status === 'subscribed' && topic.status !== 'active') throw Errors.precondition('This topic is archived');
  const current = await tx.contactTopicPreference.findUnique({ where: { contactId_topicId: { contactId, topicId } } });
  const t = nextTopicState((current?.status ?? 'none') as TopicState, (current?.changedBy ?? null) as never, status, input.actor.type);
  if (!t.ok) {
    if (t.code === 'NO_CHANGE') return null;
    throw new AppError('precondition_failed', 422, t.message, { status: [t.code] });
  }
  const now = new Date();
  const ev = await tx.consentEvent.create({
    data: {
      orgId,
      workspaceId,
      contactId,
      topicId,
      action: status,
      previousState: current?.status ?? 'none',
      newState: t.newState,
      source: input.source,
      actorType: input.actor.type,
      actorId: input.actor.id,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      evidence: input.evidence as object,
      correlationId: uow.origin.correlationId,
      occurredAt: now,
    },
  });
  const projection = { status: t.newState, changedBy: changedByOf(input.actor.type), lastEventId: ev.id, changedAt: now };
  if (current) await tx.contactTopicPreference.update({ where: { contactId_topicId: { contactId, topicId } }, data: projection });
  else await tx.contactTopicPreference.create({ data: { orgId, workspaceId, contactId, topicId, ...projection } });
  await uow.event(status === 'subscribed' ? 'contact.topic_subscribed' : 'contact.topic_unsubscribed', contactId, { topicId, consentEventId: ev.id });
  return { eventId: ev.id };
}

/** Keyed hash of a channel address: identifies the subject of evidence without storing the address itself. */
export function fingerprint(secret: string, channel: string, valueNormalized: string): string {
  return hmac(secret, 'consent-subject', channel, valueNormalized);
}

@Injectable()
export class ConsentService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async record(ctx: TenantRequestContext, contactId: string, input: RecordConsentRequest) {
    const problems = evidenceProblems(input.action, 'user', input.lawfulBasis, input.evidenceNote, input.evidenceReference);
    if (problems.length) throw Errors.validation({ evidence: problems });
    return inTenant(this.db, ctx, async (uow) => {
      await requireLiveContact(uow.tx, contactId);
      const r = await recordChannelConsent(uow, this.config.fingerprintSecret, ctx.access.orgId, ctx.access.workspaceId!, contactId, {
        channel: input.channel,
        action: input.action,
        lawfulBasis: input.lawfulBasis,
        source: input.source,
        actor: { type: 'user', id: ctx.principal.userId },
        occurredAt: input.occurredAt ? new Date(input.occurredAt) : undefined,
        consentTextVersion: input.consentTextVersion,
        formId: input.formId,
        formVersion: input.formVersion,
        evidence: {
          ...(input.evidenceNote ? { note: input.evidenceNote } : {}),
          ...(input.evidenceReference ? { reference: input.evidenceReference } : {}),
          recordedVia: 'admin_ui',
          requestId: ctx.meta.requestId,
        },
        ipAddress: null, // the staff member's IP is not the contact's; kept in the audit log instead
        userAgent: null,
      });
      if (!r) return { changed: false };
      await uow.audit({ action: 'consent.recorded_by_staff', targetType: 'contact', targetId: contactId, metadata: { channel: input.channel, action: input.action, consentEventId: r.eventId } });
      return { changed: true, newState: r.newState, consentEventId: r.eventId };
    });
  }

  async setTopic(ctx: TenantRequestContext, contactId: string, topicId: string, status: 'subscribed' | 'unsubscribed', note?: string) {
    return inTenant(this.db, ctx, async (uow) => {
      await requireLiveContact(uow.tx, contactId);
      const r = await recordTopicPreference(uow, ctx.access.orgId, ctx.access.workspaceId!, contactId, topicId, status, {
        source: 'admin',
        actor: { type: 'user', id: ctx.principal.userId },
        evidence: { ...(note ? { note } : {}), recordedVia: 'admin_ui', requestId: ctx.meta.requestId },
      });
      return { changed: !!r };
    });
  }

  async history(ctx: TenantRequestContext, contactId: string, limit: number, cursor?: string) {
    return inTenant(this.db, ctx, async ({ tx }) => {
      await requireLiveContact(tx, contactId, { allowDeleted: true });
      const c = decodeCursor(cursor);
      const rows = await tx.consentEvent.findMany({
        where: { contactId, ...(c ? { OR: [{ occurredAt: { lt: new Date(c.t) } }, { occurredAt: new Date(c.t), id: { lt: c.id } }] } : {}) },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });
      const topicIds = [...new Set(rows.map((r) => r.topicId).filter((x): x is string => !!x))];
      const topics = topicIds.length ? await tx.topic.findMany({ where: { id: { in: topicIds } }, select: { id: true, name: true } }) : [];
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        data: page.map(
          (e): ConsentEventView => ({
            id: e.id,
            scope: e.channel
              ? { type: 'channel', channel: e.channel as Channel }
              : { type: 'topic', topicId: e.topicId!, topicName: topics.find((t) => t.id === e.topicId)?.name ?? null },
            action: e.action,
            previousState: e.previousState,
            newState: e.newState,
            lawfulBasis: e.lawfulBasis,
            source: e.source,
            actor: { type: e.actorType, id: e.actorId },
            occurredAt: e.occurredAt.toISOString(),
            recordedAt: e.recordedAt.toISOString(),
            ipAddress: e.ipAddress,
            evidence: e.evidence as Record<string, unknown>,
          }),
        ),
        nextCursor: rows.length > limit && last ? encodeCursor({ t: last.occurredAt.toISOString(), id: last.id }) : null,
      };
    });
  }

  async getPolicy(ctx: TenantRequestContext): Promise<RetentionPolicyView> {
    return inTenant(this.db, ctx, async ({ tx }) => this.policyView(tx, ctx.access.workspaceId!));
  }

  async setPolicy(ctx: TenantRequestContext, input: { retainAfterWithdrawalDays: number | null; retainAfterErasureDays: number | null; pendingExpiryDays: number; version?: number }) {
    return inTenant(this.db, ctx, async ({ tx, audit }) => {
      const workspaceId = ctx.access.workspaceId!;
      const existing = await tx.consentRetentionPolicy.findUnique({ where: { workspaceId } });
      const data = {
        retainAfterWithdrawalDays: input.retainAfterWithdrawalDays,
        retainAfterErasureDays: input.retainAfterErasureDays,
        pendingExpiryDays: input.pendingExpiryDays,
        updatedByUserId: ctx.principal.userId,
        updatedAt: new Date(),
      };
      if (existing) {
        const r = await tx.consentRetentionPolicy.updateMany({ where: { workspaceId, version: input.version ?? existing.version }, data: { ...data, version: { increment: 1 } } });
        if (r.count !== 1) throw Errors.versionConflict();
      } else {
        await tx.consentRetentionPolicy.create({ data: { orgId: ctx.access.orgId, workspaceId, ...data } });
      }
      await audit({
        action: 'consent.retention_policy_updated',
        targetType: 'workspace',
        targetId: workspaceId,
        metadata: { from: existing ? { w: existing.retainAfterWithdrawalDays, e: existing.retainAfterErasureDays, p: existing.pendingExpiryDays } : 'default', to: { w: data.retainAfterWithdrawalDays, e: data.retainAfterErasureDays, p: data.pendingExpiryDays } },
      });
      return this.policyView(tx, workspaceId);
    });
  }

  /** Runs the retention purge for this workspace now (the scheduled job calls the same function). */
  async purge(ctx: TenantRequestContext): Promise<{ deleted: number }> {
    return inTenant(this.db, ctx, async ({ tx, audit }) => {
      const rows = await tx.$queryRaw<{ n: number }[]>`SELECT app.purge_consent_evidence(${ctx.access.workspaceId!}::uuid) AS n`;
      const deleted = rows[0]?.n ?? 0;
      await audit({ action: 'consent.retention_purged', targetType: 'workspace', targetId: ctx.access.workspaceId, metadata: { deleted } });
      return { deleted };
    });
  }

  private async policyView(tx: Tx, workspaceId: string): Promise<RetentionPolicyView> {
    const p = await tx.consentRetentionPolicy.findUnique({ where: { workspaceId } });
    return p
      ? { retainAfterWithdrawalDays: p.retainAfterWithdrawalDays, retainAfterErasureDays: p.retainAfterErasureDays, pendingExpiryDays: p.pendingExpiryDays, isDefault: false, version: p.version }
      : { ...DEFAULT_RETENTION, isDefault: true, version: null };
  }
}
