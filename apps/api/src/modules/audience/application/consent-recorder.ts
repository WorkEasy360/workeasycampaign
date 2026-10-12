import { Inject, Injectable } from '@nestjs/common';
import type { ConsentRecorder } from '@workeasy/audience-core';
import type { Database } from '@workeasy/db';
import type { AppConfig } from '../../../config/env.js';
import { APP_CONFIG, DATABASE } from '../../../infrastructure/providers.js';
import { inTenantAsSystem } from '../../tenancy/application/tenant-tx.js';
import { recordChannelConsent, recordTopicPreference } from './consent.service.js';

/**
 * Audience's implementation of the ConsentRecorder port (Phase 7.8): a contact's own unsubscribe (link or one-click
 * List-Unsubscribe), recorded with actor `contact` through the same consent rules and immutable history as every other
 * consent change. Campaigns verify the link and call this; they never write consent themselves.
 */
@Injectable()
export class AudienceConsentRecorder implements ConsentRecorder {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async recordUnsubscribe(tenant: { orgId: string; workspaceId: string }, input: Parameters<ConsentRecorder['recordUnsubscribe']>[1]) {
    return inTenantAsSystem(this.db, tenant, { source: input.source, correlationId: input.correlationId, ipAddress: input.ipAddress, userAgent: input.userAgent }, async (uow) => {
      const contact = await uow.tx.contact.findUnique({ where: { id: input.contactId }, select: { deletedAt: true, erasedAt: true } });
      if (!contact || contact.deletedAt || contact.erasedAt) return { changed: false, contactGone: true };
      const actor = { type: 'contact' as const, id: input.contactId };
      const evidence = { ...input.evidence, recordedVia: input.source };
      if (input.topicId) {
        const r = await recordTopicPreference(uow, tenant.orgId, tenant.workspaceId, input.contactId, input.topicId, 'unsubscribed', {
          source: input.source,
          actor,
          evidence,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
        });
        return { changed: !!r };
      }
      const r = await recordChannelConsent(uow, this.config.fingerprintSecret, tenant.orgId, tenant.workspaceId, input.contactId, {
        channel: input.channel,
        action: 'unsubscribed',
        source: input.source,
        actor,
        evidence,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      });
      return { changed: !!r };
    });
  }

  async recordProviderOptIn(tenant: { orgId: string; workspaceId: string }, input: Parameters<ConsentRecorder['recordProviderOptIn']>[1]) {
    return inTenantAsSystem(this.db, tenant, { source: input.source, correlationId: input.correlationId, ipAddress: null, userAgent: null }, async (uow) => {
      const contact = await uow.tx.contact.findUnique({ where: { id: input.contactId }, select: { deletedAt: true, erasedAt: true } });
      if (!contact || contact.deletedAt || contact.erasedAt) return { changed: false };
      // Only a withdrawal the contact made through the route this opt-in reverses (see the port).
      const state = await uow.tx.consentState.findUnique({ where: { contactId_channel: { contactId: input.contactId, channel: input.channel } } });
      if (!state || state.state !== 'withdrawn' || state.changedBy !== 'contact') return { changed: false };
      const last = await uow.tx.consentEvent.findUnique({ where: { id: state.lastEventId }, select: { source: true } });
      if (last?.source !== input.reverses) return { changed: false };
      const phone = await uow.tx.contactIdentity.findFirst({ where: { contactId: input.contactId, kind: 'phone', isPrimary: true }, select: { id: true } });
      if (!phone) return { changed: false };
      const r = await recordChannelConsent(uow, this.config.fingerprintSecret, tenant.orgId, tenant.workspaceId, input.contactId, {
        channel: input.channel,
        action: 'subscribed',
        source: input.source,
        actor: { type: 'contact', id: input.contactId },
        evidence: { ...input.evidence, recordedVia: input.source, reverses: input.reverses },
        ipAddress: null,
        userAgent: null,
      });
      return { changed: !!r };
    });
  }
}
