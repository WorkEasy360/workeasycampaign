import { Inject, Injectable } from '@nestjs/common';
import type { ConsentRecorder } from '@workeasy/audience-core';
import type { Database } from '@workeasy/db';
import { Errors } from '../../../common/errors.js';
import type { AppConfig } from '../../../config/env.js';
import { APP_CONFIG, CONSENT_RECORDER, DATABASE } from '../../../infrastructure/providers.js';
import { readVersionSnapshot } from '../domain/version.js';
import { recordEngagementEvent } from './engagement.js';
import { verifyUnsubscribeToken } from './unsubscribe.js';

export interface UnsubscribeInfo {
  organization: string;
  workspace: string;
  /** The campaign has a topic: the contact can leave just that topic, or all marketing email. */
  topicScoped: boolean;
}

/**
 * Public unsubscribe (Phase 7.8; campaign amendment §U). The signed token is the only authority; the tenant comes from
 * it (never from the request), everything is read inside that tenant (RLS), and the consent change is recorded by
 * Audience through the ConsentRecorder port with actor `contact`. GET never changes anything (link scanners and
 * prefetchers follow GETs); POST unsubscribes and is idempotent. An invalid token, or a recipient that no longer
 * exists, is a plain 404 — nothing to probe.
 */
@Injectable()
export class UnsubscribeService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CONSENT_RECORDER) private readonly consent: ConsentRecorder,
  ) {}

  async info(token: string): Promise<UnsubscribeInfo> {
    const r = await this.resolve(token);
    return { organization: r.organization, workspace: r.workspace, topicScoped: !!r.topicId };
  }

  async unsubscribe(token: string, scope: 'topic' | 'all', meta: { source: 'unsubscribe_link' | 'list_unsubscribe'; correlationId: string; ipAddress: string | null; userAgent: string | null }) {
    const r = await this.resolve(token);
    const topicId = scope === 'topic' ? r.topicId : null;
    const result = await this.consent.recordUnsubscribe(
      { orgId: r.orgId, workspaceId: r.workspaceId },
      {
        contactId: r.contactId,
        channel: 'email',
        topicId,
        source: meta.source,
        evidence: { campaignId: r.campaignId, executionId: r.executionId, recipientId: r.recipientId },
        correlationId: meta.correlationId,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
    );
    // Campaign attribution for analytics (Phase 7.10): one unsubscribe per recipient, whatever the scope or repeats.
    if (!result.contactGone) {
      await this.db.withTenant({ orgId: r.orgId, workspaceId: r.workspaceId, userId: null }, (tx) =>
        recordEngagementEvent(tx, { orgId: r.orgId, workspaceId: r.workspaceId }, {
          executionId: r.executionId,
          recipientId: r.recipientId,
          type: 'unsubscribed',
          detail: { via: meta.source },
          provider: 'workeasy',
          providerEventId: `unsubscribe:${r.recipientId}`,
          occurredAt: new Date(),
        }),
      );
    }
    return { unsubscribed: true, scope: topicId ? ('topic' as const) : ('all' as const), changed: result.changed };
  }

  private async resolve(token: string) {
    const claims = verifyUnsubscribeToken(this.config.unsubscribeKeys.all, token);
    if (!claims) throw Errors.notFound('Unsubscribe link');
    const found = await this.db.withTenant({ orgId: claims.orgId, workspaceId: claims.workspaceId, userId: null }, async (tx) => {
      const rec = await tx.campaignRecipient.findUnique({ where: { id: claims.recipientId }, select: { id: true, contactId: true, executionId: true } });
      if (!rec) return null;
      const exe = await tx.campaignExecution.findUnique({ where: { id: rec.executionId }, select: { campaignId: true, versionId: true } });
      const version = exe ? await tx.campaignVersion.findUnique({ where: { id: exe.versionId }, select: { snapshot: true } }) : null;
      const [ws, org] = await Promise.all([
        tx.workspace.findUnique({ where: { id: claims.workspaceId }, select: { name: true } }),
        tx.organization.findUnique({ where: { id: claims.orgId }, select: { name: true } }),
      ]);
      if (!exe || !version || !ws || !org) return null;
      const topicId = readVersionSnapshot(version.snapshot).topic.topicIds[0] ?? null;
      return { contactId: rec.contactId, executionId: rec.executionId, campaignId: exe.campaignId, topicId, workspace: ws.name, organization: org.name };
    });
    if (!found) throw Errors.notFound('Unsubscribe link');
    return { ...claims, ...found };
  }
}
