import { Inject, Injectable } from '@nestjs/common';
import { type Database, isUniqueViolation, type Tx } from '@workeasy/db';
import type {
  ContactDetail,
  ContactFilter,
  ContactListQuery,
  ContactPage,
  ContactSummary,
  CreateContactRequest,
  IdentityKind,
  SubscriptionType,
  TimelineEntry,
} from '@workeasy/shared';
import { AppError, Errors } from '../../../common/errors.js';
import { decodeCursor, encodeCursor } from '../../../common/pagination.js';
import type { TenantRequestContext } from '../../../common/request-context.js';
import type { AppConfig } from '../../../config/env.js';
import { APP_CONFIG, DATABASE } from '../../../infrastructure/providers.js';
import { inTenant } from '../../tenancy/application/tenant-tx.js';
import { canChangeSubscription, effectiveChannelState, type StoredChannelState } from '../domain/consent.js';
import { ADDRESS_KIND_FOR_CHANNEL } from '../domain/eligibility.js';
import { buildSearchText, displayName, normalizeIdentity } from '../domain/normalization.js';
import {
  activeSuppressionsFor,
  applyCustomFields,
  contactWhere,
  loadFieldDefinitions,
  lockFieldKeys,
  refreshSearchText,
  requireLiveContact,
  SEARCH_CAP,
  searchContactIds,
  suppressedContactIds,
  suppressionView,
  throwIfErrors,
} from './audience-support.js';
import { fingerprint, pendingExpiryDays } from './consent.service.js';

type IdentityRow = { id: string; kind: string; provider: string; value: string; valueNormalized: string; isPrimary: boolean; createdAt: Date };

function identityConflict(kind: string, contactId: string): AppError {
  return new AppError('conflict', 409, `This ${kind === 'email' ? 'email address' : 'number'} already belongs to another contact`, {
    [kind]: [`Already used by contact ${contactId}`],
  });
}

@Injectable()
export class ContactsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ─── queries ──────────────────────────────────────────────────────────────────────────────────────────────

  async list(ctx: TenantRequestContext, q: ContactListQuery): Promise<ContactPage> {
    return inTenant(this.db, ctx, async ({ tx }) => {
      const { where, searchTruncated } = await this.resolveFilter(tx, q);
      const c = decodeCursor(q.cursor);
      const field = q.sort === 'updated' ? 'updatedAt' : 'createdAt';
      const cmp = q.order === 'desc' ? 'lt' : 'gt';
      const rows = await tx.contact.findMany({
        where: c
          ? { AND: [where, { OR: [{ [field]: { [cmp]: new Date(c.t) } }, { [field]: new Date(c.t), id: { [cmp]: c.id } }] }] }
          : where,
        orderBy: [{ [field]: q.order }, { id: q.order }],
        take: q.limit + 1,
        include: { identities: { where: { isPrimary: true }, select: { kind: true, value: true } } },
      });
      const page = rows.slice(0, q.limit);
      const suppressed = await activeSuppressionsFor(tx, page.map((r) => r.id));
      const last = page.at(-1);
      return {
        data: page.map((r) => this.summary(r, r.identities, (suppressed.get(r.id) ?? []).length > 0)),
        nextCursor: rows.length > q.limit && last ? encodeCursor({ t: last[field].toISOString(), id: last.id }) : null,
        searchTruncated,
      };
    });
  }

  async count(ctx: TenantRequestContext, f: ContactFilter): Promise<{ count: number; searchTruncated: boolean }> {
    return inTenant(this.db, ctx, async ({ tx }) => {
      const { where, searchTruncated } = await this.resolveFilter(tx, f);
      return { count: await tx.contact.count({ where }), searchTruncated };
    });
  }

  /** Shared by list, count and bulk "select all matching". */
  async resolveFilter(tx: Tx, f: ContactFilter) {
    const searchIds = f.q && f.q.trim().length >= 2 ? await searchContactIds(tx, f.q.trim()) : null;
    const suppressedIds = f.suppressed ? await suppressedContactIds(tx) : null;
    return { where: contactWhere(f, searchIds, suppressedIds), searchTruncated: (searchIds?.length ?? 0) >= SEARCH_CAP };
  }

  async get(ctx: TenantRequestContext, contactId: string): Promise<ContactDetail> {
    return inTenant(this.db, ctx, (uow) => this.detail(uow.tx, contactId));
  }

  async detail(tx: Tx, contactId: string): Promise<ContactDetail> {
    const c = await tx.contact.findUnique({
      where: { id: contactId },
      include: {
        identities: { orderBy: [{ kind: 'asc' }, { isPrimary: 'desc' }, { createdAt: 'asc' }] },
        listMemberships: { include: { list: { select: { id: true, name: true, deletedAt: true } } } },
        tags: { include: { tag: { select: { id: true, name: true, color: true, deletedAt: true } } } },
        topicPreferences: { include: { topic: { select: { id: true, key: true, name: true, status: true } } }, orderBy: { changedAt: 'desc' } },
        consentStates: true,
      },
    });
    if (!c || c.erasedAt) throw Errors.notFound('Contact');
    const suppressionIds = (await activeSuppressionsFor(tx, [c.id])).get(c.id)!.map((s) => s.id);
    const suppressions = suppressionIds.length ? await tx.suppression.findMany({ where: { id: { in: suppressionIds } } }) : [];
    const primary = c.identities.filter((i) => i.isPrimary);
    const channels = ['email', 'sms', 'whatsapp'] as const;
    const expiryDays = c.consentStates.some((x) => x.state === 'pending') ? await pendingExpiryDays(tx, c.workspaceId) : 0;
    const now = new Date();
    return {
      ...this.summary(c, primary, suppressions.length > 0),
      timezone: c.timezone,
      locale: c.locale,
      source: c.source,
      unsubscribedBy: c.unsubscribedBy as ContactDetail['unsubscribedBy'],
      subscriptionChangedAt: c.subscriptionChangedAt.toISOString(),
      erased: false,
      identities: c.identities.map((i) => ({
        id: i.id,
        kind: i.kind as IdentityKind,
        provider: i.provider,
        value: i.value,
        isPrimary: i.isPrimary,
        createdAt: i.createdAt.toISOString(),
      })),
      customFields: c.customFields as Record<string, unknown>,
      lists: c.listMemberships.filter((m) => !m.list.deletedAt).map((m) => ({ id: m.list.id, name: m.list.name })),
      tags: c.tags.filter((t) => !t.tag.deletedAt).map((t) => ({ id: t.tag.id, name: t.tag.name, color: t.tag.color })),
      topics: c.topicPreferences.map((p) => ({
        topic: { id: p.topic.id, key: p.topic.key, name: p.topic.name, status: p.topic.status as 'active' | 'archived' },
        status: p.status as 'subscribed' | 'unsubscribed',
        changedBy: p.changedBy as 'contact' | 'user' | 'system',
        changedAt: p.changedAt.toISOString(),
      })),
      consent: channels.map((channel) => {
        const s = c.consentStates.find((x) => x.channel === channel);
        const address = primary.find((i) => i.kind === ADDRESS_KIND_FOR_CHANNEL[channel]);
        return {
          channel,
          state: s ? effectiveChannelState(s.state as StoredChannelState, s.recordedAt, expiryDays, now) : 'none',
          appliesToPrimaryAddress: s
            ? !address || (s.subjectFingerprint !== null && s.subjectFingerprint === fingerprint(this.config.fingerprintSecret, channel, address.valueNormalized))
            : null,
          changedBy: (s?.changedBy ?? null) as 'contact' | 'user' | 'system' | null,
          lawfulBasis: (s?.lawfulBasis ?? null) as ContactDetail['consent'][number]['lawfulBasis'],
          changedAt: s?.changedAt.toISOString() ?? null,
        };
      }),
      suppressions: suppressions.map((s) => suppressionView(s)),
      version: c.version,
    };
  }

  private summary(
    c: {
      id: string;
      firstName: string | null;
      lastName: string | null;
      company: string | null;
      subscriptionType: string;
      createdAt: Date;
      updatedAt: Date;
      deletedAt: Date | null;
    },
    primary: { kind: string; value: string }[],
    suppressed: boolean,
  ): ContactSummary {
    const email = primary.find((i) => i.kind === 'email')?.value ?? null;
    const phone = primary.find((i) => i.kind === 'phone')?.value ?? null;
    return {
      id: c.id,
      firstName: c.firstName,
      lastName: c.lastName,
      displayName: displayName(c, email, phone),
      email,
      phone,
      company: c.company,
      subscriptionType: c.subscriptionType as SubscriptionType,
      suppressed,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      deletedAt: c.deletedAt?.toISOString() ?? null,
    };
  }

  // ─── commands ─────────────────────────────────────────────────────────────────────────────────────────────

  async create(ctx: TenantRequestContext, input: CreateContactRequest): Promise<ContactDetail> {
    // Adding to lists or tags while creating needs the same permissions as doing it afterwards (finding M-3).
    const denied: Record<string, string[]> = {};
    if (input.listIds.length && !ctx.access.permissions.has('lists.manage')) denied.listIds = ['Adding contacts to lists needs the lists.manage permission'];
    if (input.tagIds.length && !ctx.access.permissions.has('tags.manage')) denied.tagIds = ['Tagging contacts needs the tags.manage permission'];
    if (Object.keys(denied).length) throw new AppError('forbidden', 403, 'You do not have permission to add lists or tags', denied);
    const identities: { kind: 'email' | 'phone'; value: string; normalized: string }[] = [];
    const errors: Record<string, string[]> = {};
    for (const kind of ['email', 'phone'] as const) {
      const raw = input[kind];
      if (!raw) continue;
      const n = normalizeIdentity(kind, raw, input.defaultCountry);
      if (n.ok) identities.push({ kind, value: n.value, normalized: n.normalized });
      else errors[kind] = [n.message];
    }
    throwIfErrors(errors);

    try {
      return await inTenant(this.db, ctx, async ({ tx, event, events }) => {
        for (const i of identities) {
          const owner = await tx.contactIdentity.findFirst({ where: { kind: i.kind, provider: '', valueNormalized: i.normalized }, select: { contactId: true } });
          if (owner) throw identityConflict(i.kind, owner.contactId);
        }
        const defs = await loadFieldDefinitions(tx);
        const cf = applyCustomFields(defs, {}, input.customFields, { checkRequired: true, defaultCountry: input.defaultCountry });
        throwIfErrors(cf.errors);
        await this.assertActive(tx, 'list', input.listIds);
        await this.assertActive(tx, 'tag', input.tagIds);

        const contact = await tx.contact.create({
          data: {
            orgId: ctx.access.orgId,
            workspaceId: ctx.access.workspaceId!,
            firstName: input.firstName || null,
            lastName: input.lastName || null,
            company: input.company || null,
            timezone: input.timezone ?? null,
            locale: input.locale ?? null,
            subscriptionType: input.subscriptionType,
            source: 'manual',
            customFields: cf.values as object,
            searchText: buildSearchText(input, identities.map((i) => ({ valueNormalized: i.normalized }))),
            createdByUserId: ctx.principal.userId,
          },
        });
        for (const i of identities) {
          const row = await tx.contactIdentity.create({
            data: { orgId: ctx.access.orgId, workspaceId: ctx.access.workspaceId!, contactId: contact.id, kind: i.kind, value: i.value, valueNormalized: i.normalized, isPrimary: true },
          });
          await event('contact.identity_added', contact.id, { identityId: row.id, kind: i.kind });
        }
        await lockFieldKeys(tx, defs, cf.usedKeys);
        if (input.listIds.length) {
          await tx.listMembership.createMany({
            data: input.listIds.map((listId) => ({ orgId: ctx.access.orgId, workspaceId: ctx.access.workspaceId!, listId, contactId: contact.id, addedByUserId: ctx.principal.userId })),
          });
          await events('list.member_added', input.listIds.map((listId) => ({ aggregateId: contact.id, payload: { listId, source: 'manual' } })));
        }
        if (input.tagIds.length) {
          await tx.contactTag.createMany({
            data: input.tagIds.map((tagId) => ({ orgId: ctx.access.orgId, workspaceId: ctx.access.workspaceId!, tagId, contactId: contact.id, taggedByUserId: ctx.principal.userId })),
          });
          await events('contact.tagged', input.tagIds.map((tagId) => ({ aggregateId: contact.id, payload: { tagId } })));
        }
        await event('contact.created', contact.id, { source: 'manual' });
        return this.detail(tx, contact.id);
      });
    } catch (err) {
      // Lost a race for the same address: same answer as the explicit check.
      if (isUniqueViolation(err)) throw Errors.conflict('This email or phone already belongs to another contact');
      throw err;
    }
  }

  async update(
    ctx: TenantRequestContext,
    contactId: string,
    input: {
      firstName?: string | null;
      lastName?: string | null;
      company?: string | null;
      timezone?: string | null;
      locale?: string | null;
      customFields?: Record<string, unknown>;
      version: number;
    },
  ): Promise<ContactDetail> {
    return inTenant(this.db, ctx, async ({ tx, event }) => {
      const c = await requireLiveContact(tx, contactId);
      const changes: string[] = [];
      const data: Record<string, unknown> = {};
      for (const k of ['firstName', 'lastName', 'company', 'timezone', 'locale'] as const) {
        if (input[k] !== undefined && input[k] !== c[k]) {
          data[k] = input[k];
          changes.push(k);
        }
      }
      let usedKeys: string[] = [];
      const defs = await loadFieldDefinitions(tx);
      if (input.customFields) {
        const cf = applyCustomFields(defs, c.customFields as Record<string, unknown>, input.customFields, { checkRequired: true });
        throwIfErrors(cf.errors);
        data.customFields = cf.values;
        usedKeys = cf.usedKeys;
        changes.push(...Object.keys(input.customFields).map((k) => `customFields.${k}`));
      }
      if (!changes.length) return this.detail(tx, contactId);
      const r = await tx.contact.updateMany({
        where: { id: contactId, version: input.version },
        data: { ...data, updatedAt: new Date(), version: { increment: 1 } },
      });
      if (r.count !== 1) throw Errors.versionConflict();
      await lockFieldKeys(tx, defs, usedKeys);
      await refreshSearchText(tx, contactId);
      await event('contact.updated', contactId, { changes });
      return this.detail(tx, contactId);
    });
  }

  async changeSubscription(ctx: TenantRequestContext, contactId: string, to: SubscriptionType, version: number): Promise<ContactDetail> {
    return inTenant(this.db, ctx, async ({ tx, event }) => {
      const c = await requireLiveContact(tx, contactId);
      const t = canChangeSubscription(c.subscriptionType, c.unsubscribedBy, to, 'user');
      if (!t.ok) {
        if (t.code === 'NO_CHANGE') return this.detail(tx, contactId);
        throw new AppError('precondition_failed', 422, t.message, { subscriptionType: [t.code] });
      }
      const r = await tx.contact.updateMany({
        where: { id: contactId, version },
        data: {
          subscriptionType: to,
          subscriptionChangedAt: new Date(),
          unsubscribedBy: to === 'unsubscribed' ? 'user' : null,
          updatedAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (r.count !== 1) throw Errors.versionConflict();
      await event('contact.subscription_changed', contactId, { from: c.subscriptionType, to, by: 'user' });
      return this.detail(tx, contactId);
    });
  }

  async softDelete(ctx: TenantRequestContext, contactId: string): Promise<void> {
    await inTenant(this.db, ctx, async ({ tx, event }) => {
      await requireLiveContact(tx, contactId);
      await tx.contact.update({ where: { id: contactId }, data: { deletedAt: new Date(), updatedAt: new Date(), version: { increment: 1 } } });
      await event('contact.deleted', contactId, {});
    });
  }

  async restore(ctx: TenantRequestContext, contactId: string): Promise<ContactDetail> {
    return inTenant(this.db, ctx, async ({ tx, event }) => {
      const c = await requireLiveContact(tx, contactId, { allowDeleted: true });
      if (!c.deletedAt) return this.detail(tx, contactId);
      await tx.contact.update({ where: { id: contactId }, data: { deletedAt: null, updatedAt: new Date(), version: { increment: 1 } } });
      await event('contact.restored', contactId, {});
      return this.detail(tx, contactId);
    });
  }

  /**
   * GDPR erasure: removes personal data permanently. The row stays as a tombstone so consent evidence (which holds
   * only a keyed fingerprint) remains referentially intact until the retention policy purges it (docs/consent.md).
   */
  async erase(ctx: TenantRequestContext, contactId: string): Promise<void> {
    await inTenant(this.db, ctx, async ({ tx, event, audit }) => {
      await requireLiveContact(tx, contactId, { allowDeleted: true });
      const removedLists = await tx.listMembership.deleteMany({ where: { contactId } });
      const removedTags = await tx.contactTag.deleteMany({ where: { contactId } });
      const removedIdentities = await tx.contactIdentity.deleteMany({ where: { contactId } });
      const now = new Date();
      await tx.contact.update({
        where: { id: contactId },
        data: {
          firstName: null,
          lastName: null,
          company: null,
          timezone: null,
          locale: null,
          customFields: {},
          searchText: '',
          deletedAt: now,
          erasedAt: now,
          updatedAt: now,
          version: { increment: 1 },
        },
      });
      await event('contact.erased', contactId, {});
      await audit({
        action: 'contact.erased',
        targetType: 'contact',
        targetId: contactId,
        metadata: { identitiesRemoved: removedIdentities.count, listMembershipsRemoved: removedLists.count, tagsRemoved: removedTags.count },
      });
    });
  }

  async addIdentity(ctx: TenantRequestContext, contactId: string, input: { kind: IdentityKind; value: string; provider?: string; defaultCountry?: string }) {
    const n = normalizeIdentity(input.kind, input.value, input.defaultCountry);
    if (!n.ok) throw Errors.validation({ value: [n.message] });
    const provider = input.kind === 'external' ? input.provider ?? '' : '';
    if (input.kind === 'external' && !provider) throw Errors.validation({ provider: ['Name the external system, e.g. crm:hubspot'] });
    try {
      return await inTenant(this.db, ctx, async ({ tx, event }) => {
        await requireLiveContact(tx, contactId);
        const owner = await tx.contactIdentity.findFirst({ where: { kind: input.kind, provider, valueNormalized: n.normalized }, select: { contactId: true } });
        if (owner) {
          if (owner.contactId === contactId) throw Errors.conflict('This contact already has that identity');
          throw identityConflict(input.kind, owner.contactId);
        }
        const hasPrimary = await tx.contactIdentity.count({ where: { contactId, kind: input.kind, isPrimary: true } });
        const row = await tx.contactIdentity.create({
          data: { orgId: ctx.access.orgId, workspaceId: ctx.access.workspaceId!, contactId, kind: input.kind, provider, value: n.value, valueNormalized: n.normalized, isPrimary: hasPrimary === 0 },
        });
        await refreshSearchText(tx, contactId);
        await this.touch(tx, contactId);
        await event('contact.identity_added', contactId, { identityId: row.id, kind: input.kind });
        return this.detail(tx, contactId);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw Errors.conflict('That identity already belongs to a contact');
      throw err;
    }
  }

  async removeIdentity(ctx: TenantRequestContext, contactId: string, identityId: string) {
    return inTenant(this.db, ctx, async ({ tx, event }) => {
      await requireLiveContact(tx, contactId);
      const all: IdentityRow[] = await tx.contactIdentity.findMany({ where: { contactId } });
      const target = all.find((i) => i.id === identityId);
      if (!target) throw Errors.notFound('Identity');
      const reachable = all.filter((i) => (i.kind === 'email' || i.kind === 'phone') && i.id !== identityId);
      if ((target.kind === 'email' || target.kind === 'phone') && reachable.length === 0) {
        throw Errors.precondition('A contact needs at least one email address or phone number. Add another before removing this one.');
      }
      await tx.contactIdentity.delete({ where: { id: identityId } });
      if (target.isPrimary) {
        const next = all.find((i) => i.kind === target.kind && i.id !== identityId);
        if (next) await tx.contactIdentity.update({ where: { id: next.id }, data: { isPrimary: true } });
      }
      await refreshSearchText(tx, contactId);
      await this.touch(tx, contactId);
      await event('contact.identity_removed', contactId, { identityId, kind: target.kind });
      return this.detail(tx, contactId);
    });
  }

  async makePrimary(ctx: TenantRequestContext, contactId: string, identityId: string) {
    return inTenant(this.db, ctx, async ({ tx, event }) => {
      await requireLiveContact(tx, contactId);
      const target = await tx.contactIdentity.findFirst({ where: { id: identityId, contactId } });
      if (!target) throw Errors.notFound('Identity');
      if (target.isPrimary) return this.detail(tx, contactId);
      await tx.contactIdentity.updateMany({ where: { contactId, kind: target.kind }, data: { isPrimary: false } });
      await tx.contactIdentity.update({ where: { id: identityId }, data: { isPrimary: true } });
      await this.touch(tx, contactId);
      // The send-to address changed: consent recorded for the previous address no longer applies (docs/consent.md).
      await event('contact.primary_identity_changed', contactId, { identityId, kind: target.kind });
      return this.detail(tx, contactId);
    });
  }

  /** Contact timeline = domain events with this contact as aggregate (no separate activity system). */
  async timeline(ctx: TenantRequestContext, contactId: string, limit: number, cursor?: string) {
    return inTenant(this.db, ctx, async ({ tx }) => {
      await requireLiveContact(tx, contactId, { allowDeleted: true });
      const c = decodeCursor(cursor);
      const rows = await tx.domainEvent.findMany({
        where: {
          aggregateType: 'contact',
          aggregateId: contactId,
          workspaceId: ctx.access.workspaceId,
          ...(c ? { OR: [{ recordedAt: { lt: new Date(c.t) } }, { recordedAt: new Date(c.t), id: { lt: c.id } }] } : {}),
        },
        orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        data: page.map(
          (e): TimelineEntry => ({
            id: e.id,
            type: e.type,
            occurredAt: e.occurredAt.toISOString(),
            actor: { type: e.actorType, id: e.actorId },
            data: e.payload as Record<string, unknown>,
          }),
        ),
        nextCursor: rows.length > limit && last ? encodeCursor({ t: last.recordedAt.toISOString(), id: last.id }) : null,
      };
    });
  }

  private async touch(tx: Tx, contactId: string) {
    await tx.contact.update({ where: { id: contactId }, data: { updatedAt: new Date(), version: { increment: 1 } } });
  }

  private async assertActive(tx: Tx, kind: 'list' | 'tag', ids: string[]) {
    if (!ids.length) return;
    const found =
      kind === 'list'
        ? await tx.contactList.count({ where: { id: { in: ids }, deletedAt: null, status: 'active' } })
        : await tx.tag.count({ where: { id: { in: ids }, deletedAt: null } });
    if (found !== new Set(ids).size) throw Errors.validation({ [`${kind}Ids`]: [`One or more ${kind}s are not available`] });
  }
}
