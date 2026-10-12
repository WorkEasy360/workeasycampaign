import { Inject, Injectable } from '@nestjs/common';
import { type EligibilityEvaluator, EligibilityTopicNotFoundError } from '@workeasy/audience-core';
import { tenantScopeFor } from '@workeasy/audience-infra';
import { type Database, isUniqueViolation, type Tx } from '@workeasy/db';
import type { Channel, EligibilityResponse, MessagePurpose, SuppressionView, TopicPolicy } from '@workeasy/shared';
import { Errors } from '../../../common/errors.js';
import { cursorScope, decodeCursor, encodeCursor } from '../../../common/pagination.js';
import type { TenantRequestContext } from '../../../common/request-context.js';
import { DATABASE, ELIGIBILITY_EVALUATOR } from '../../../infrastructure/providers.js';
import { inTenant, type TenantUnitOfWork } from '../../tenancy/application/tenant-tx.js';
import { displayName, normalizeIdentity } from '../domain/normalization.js';
import { requireLiveContact, suppressionView } from './audience-support.js';

export const suppressionKey = (channel: string, target: { contactId: string } | { kind: string; value: string }) =>
  'contactId' in target ? `contact:${target.contactId}:${channel}` : `value:${target.kind}:${target.value}:${channel}`;

/** Adds a suppression (or reports the existing active one). Shared by the API, bulk actions and imports. */
export async function addSuppression(
  uow: TenantUnitOfWork,
  orgId: string,
  workspaceId: string,
  input: { channel: string; reason: string; source: string; note: string; userId: string | null; target: { contactId: string } | { kind: string; value: string } },
): Promise<{ id: string; created: boolean }> {
  const activeKey = suppressionKey(input.channel, input.target);
  const existing = await uow.tx.suppression.findFirst({ where: { activeKey }, select: { id: true } });
  if (existing) return { id: existing.id, created: false };
  const s = await uow.tx.suppression.create({
    data: {
      orgId,
      workspaceId,
      channel: input.channel,
      ...('contactId' in input.target ? { contactId: input.target.contactId } : { identityKind: input.target.kind, valueNormalized: input.target.value }),
      reason: input.reason,
      source: input.source,
      note: input.note,
      activeKey,
      createdByUserId: input.userId,
    },
  });
  const contactId = 'contactId' in input.target ? input.target.contactId : null;
  await uow.event('suppression.added', s.id, { channel: input.channel, reason: input.reason, contactId, targetType: contactId ? 'contact' : 'address' });
  return { id: s.id, created: true };
}

@Injectable()
export class SuppressionService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(ctx: TenantRequestContext, q: { status: 'active' | 'lifted' | 'all'; contactId?: string; limit: number; cursor?: string }) {
    return inTenant(this.db, ctx, async ({ tx }) => {
      const scope = cursorScope(ctx.access, 'suppressions', { ...q });
      const c = decodeCursor(q.cursor, scope);
      const rows = await tx.suppression.findMany({
        where: {
          ...(q.status === 'active' ? { liftedAt: null } : q.status === 'lifted' ? { liftedAt: { not: null } } : {}),
          ...(q.contactId ? { contactId: q.contactId } : {}),
          ...(c ? { OR: [{ createdAt: { lt: new Date(c.t) } }, { createdAt: new Date(c.t), id: { lt: c.id } }] } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
        include: { contact: { select: { firstName: true, lastName: true, identities: { where: { isPrimary: true }, select: { kind: true, value: true } } } } },
      });
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      return {
        data: page.map((s) =>
          suppressionView(
            s,
            s.contact
              ? displayName(s.contact, s.contact.identities.find((i) => i.kind === 'email')?.value ?? null, s.contact.identities.find((i) => i.kind === 'phone')?.value ?? null)
              : null,
          ),
        ),
        nextCursor: rows.length > q.limit && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }, scope) : null,
      };
    });
  }

  async create(
    ctx: TenantRequestContext,
    input: { channel: string; reason: string; note: string; contactId?: string; identityKind?: 'email' | 'phone' | 'whatsapp'; value?: string; defaultCountry?: string },
  ): Promise<SuppressionView> {
    let target: { contactId: string } | { kind: string; value: string };
    if (input.contactId) target = { contactId: input.contactId };
    else {
      const n = normalizeIdentity(input.identityKind!, input.value!, input.defaultCountry);
      if (!n.ok) throw Errors.validation({ value: [n.message] });
      target = { kind: input.identityKind!, value: n.normalized };
    }
    try {
      return await inTenant(this.db, ctx, async (uow) => {
        if ('contactId' in target) await requireLiveContact(uow.tx, target.contactId, { allowDeleted: true });
        const r = await addSuppression(uow, ctx.access.orgId, ctx.access.workspaceId!, {
          channel: input.channel,
          reason: input.reason,
          source: 'admin',
          note: input.note,
          userId: ctx.principal.userId,
          target,
        });
        if (!r.created) throw Errors.conflict('This is already suppressed for that channel');
        await uow.audit({ action: 'suppression.added', targetType: 'suppression', targetId: r.id, metadata: { channel: input.channel, reason: input.reason, target: 'contactId' in target ? 'contact' : 'address' } });
        return suppressionView(await uow.tx.suppression.findUniqueOrThrow({ where: { id: r.id } }));
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw Errors.conflict('This is already suppressed for that channel');
      throw err;
    }
  }

  async lift(ctx: TenantRequestContext, suppressionId: string, reason: string): Promise<SuppressionView> {
    return inTenant(this.db, ctx, async ({ tx, event, audit }) => {
      const s = await tx.suppression.findUnique({ where: { id: suppressionId } });
      if (!s) throw Errors.notFound('Suppression');
      if (s.liftedAt) throw Errors.precondition('This suppression was already lifted');
      await tx.suppression.update({ where: { id: suppressionId }, data: { liftedAt: new Date(), liftedByUserId: ctx.principal.userId, liftReason: reason, activeKey: null } });
      await event('suppression.lifted', suppressionId, { contactId: s.contactId });
      await audit({ action: 'suppression.lifted', targetType: 'suppression', targetId: suppressionId, metadata: { reason, originalReason: s.reason, channel: s.channel } });
      return suppressionView(await tx.suppression.findUniqueOrThrow({ where: { id: suppressionId } }));
    });
  }
}

/**
 * The single eligibility entry point (docs/eligibility.md). Rules and fact loading live in the Audience read-side
 * packages (@workeasy/audience-core rules + port, @workeasy/audience-infra adapter, milestone 6.2); this service keeps
 * the frozen v1 API — HTTP `check` and `evaluate(tx, workspaceId, …)` — and maps an unknown topic to the same validation error as before.
 */
@Injectable()
export class EligibilityService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ELIGIBILITY_EVALUATOR) private readonly evaluator: EligibilityEvaluator<Tx>,
  ) {}

  async check(ctx: TenantRequestContext, req: { contactIds: string[]; channel: Channel; purpose: MessagePurpose; topicId?: string; topicPolicy?: TopicPolicy }): Promise<EligibilityResponse> {
    return inTenant(this.db, ctx, ({ tx }) => this.evaluate(tx, ctx.access.workspaceId!, req));
  }

  /**
   * Service contract for later senders (docs/eligibility.md): call with a transaction already scoped to the
   * workspace (RLS), so contacts of other workspaces are simply not found. A workspace id that does not match the
   * transaction's tenant is refused (TenantScopeMismatchError) before anything is read.
   */
  async evaluate(tx: Tx, workspaceId: string, req: { contactIds: string[]; channel: Channel; purpose: MessagePurpose; topicId?: string; topicPolicy?: TopicPolicy }): Promise<EligibilityResponse> {
    try {
      return await this.evaluator.evaluate(await tenantScopeFor(tx, workspaceId), req);
    } catch (err) {
      // An unknown topic (or one of another workspace — invisible under RLS) is a bad request, not a per-contact reason.
      if (err instanceof EligibilityTopicNotFoundError) throw Errors.validation({ topicId: ['No such topic in this workspace'] });
      throw err;
    }
  }
}
