import { Inject, Injectable, Optional } from '@nestjs/common';
import type { AudienceProfiles } from '@workeasy/audience-core';
import { renderEmail } from '@workeasy/content';
import type { Database, Tx } from '@workeasy/db';
import { type CampaignTestSend, type CampaignTestSendRequest, messageDraftSchema } from '@workeasy/shared';
import { v7 as uuidv7 } from 'uuid';
import { AppError, Errors } from '../../../common/errors.js';
import type { TenantRequestContext } from '../../../common/request-context.js';
import { AUDIENCE_PROFILES, DATABASE } from '../../../infrastructure/providers.js';
import { inTenant } from '../../tenancy/application/tenant-tx.js';
import { channelSpec } from '../domain/channels.js';
import { campaignNotFound } from './campaign-errors.js';
import { draftOf } from './campaign-views.js';
import { CampaignsService } from './campaigns.service.js';
import { CAMPAIGN_DELIVERY_PORT, type CampaignDeliveryPort } from './delivery.js';
import { contactPersonalization, examplePersonalization } from './personalization.js';
import { PREVIEW_UNSUBSCRIBE_URL } from './preview.service.js';

const TEST_REASON = 'this is a test send of a campaign draft';

/**
 * Test send (Phase 7.3). Renders the CURRENT draft exactly like the preview and hands it to the delivery port's
 * `sendTest` — addressed ONLY to the requesting user's own verified email from the identity record (the request
 * cannot name an address, so this is not a relay). Refused while delivery is not available, while the message still
 * has content errors, or when the user's address is not verified. Nothing about the campaign changes; the audit records
 * that a test was sent, without the address or any content.
 */
@Injectable()
export class TestSendService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIENCE_PROFILES) private readonly profiles: AudienceProfiles<Tx>,
    private readonly campaigns: CampaignsService,
    @Optional() @Inject(CAMPAIGN_DELIVERY_PORT) private readonly delivery: CampaignDeliveryPort | null,
  ) {}

  async send(ctx: TenantRequestContext, campaignId: string, req: CampaignTestSendRequest): Promise<CampaignTestSend> {
    if (req.contactId) await this.campaigns.requirePermissions(ctx, new Set(['contacts.read']), 'test_send');
    if (!this.delivery) throw new AppError('DELIVERY_NOT_AVAILABLE', 422, 'Sending is not available yet, so test sends are not either');
    const delivery = this.delivery;

    const prepared = await inTenant(this.db, ctx, async ({ tx }) => {
      const row = await tx.campaign.findUnique({ where: { id: campaignId } });
      if (!row) throw campaignNotFound();
      const draft = draftOf(row);
      const message = messageDraftSchema.safeParse(draft.messages.find((m) => m.variantKey === 'default'));
      if (draft.channel !== 'email') throw new AppError('precondition_failed', 422, 'Test sends are available for email campaigns. Try an SMS or WhatsApp campaign by sending it to a small internal list.');
      if (!message.success) throw new AppError('validation_failed', 422, 'This campaign has no email message to test yet');
      const content = message.data.content;
      if (content.schema !== 'email.content.v1' && content.schema !== 'email.content.v2' && content.schema !== 'email.content.v3') throw new AppError('validation_failed', 422, 'This campaign has no email message to test yet');
      const problems = channelSpec('email').validateContent(message.data.content, '/messages/0/content');
      if (problems.some((f) => f.severity === 'error')) {
        const fields: Record<string, string[]> = {};
        for (const f of problems) if (f.severity === 'error') (fields[f.field ?? '/messages/0/content'] ??= []).push(f.message);
        throw new AppError('validation_failed', 422, 'Finish the message before sending a test', fields);
      }
      const user = await tx.user.findUnique({ where: { id: ctx.principal.userId! }, select: { email: true, emailVerifiedAt: true } });
      if (!user?.emailVerifiedAt) throw new AppError('email_not_verified', 422, 'Verify your email address to receive test sends');
      const scope = { tx, orgId: ctx.access.orgId, workspaceId: ctx.access.workspaceId! };
      const data = req.contactId ? await contactPersonalization(this.profiles, scope, req.contactId, content) : await examplePersonalization(this.profiles, scope, content);
      if (!data) throw Errors.notFound('Contact');
      const r = renderEmail(content, data, { unsubscribeUrl: PREVIEW_UNSUBSCRIBE_URL, reason: TEST_REASON });
      return { to: user.email, senderIdentityId: draft.sender.senderIdentityId ?? null, rendered: { ...r, subject: `[Test] ${r.subject}`.slice(0, 250) } };
    });

    const result = await delivery.sendTest({
      orgId: ctx.access.orgId,
      workspaceId: ctx.access.workspaceId!,
      campaignId,
      userId: ctx.principal.userId!,
      senderIdentityId: prepared.senderIdentityId,
      to: prepared.to,
      subject: prepared.rendered.subject,
      preheader: prepared.rendered.preheader,
      html: prepared.rendered.html,
      text: prepared.rendered.text,
      idempotencyKey: uuidv7(),
    });
    await inTenant(this.db, ctx, async ({ audit }) => {
      await audit({
        action: 'campaign.test_sent',
        targetType: 'campaign',
        targetId: campaignId,
        outcome: result.ok ? 'success' : 'failure',
        metadata: { sample: req.contactId ? 'contact' : 'example', ...(result.ok ? {} : { code: result.code }) },
      });
    });
    if (!result.ok && result.code === 'SENDER_NOT_VERIFIED') throw new AppError('precondition_failed', 422, 'Choose a sender address on a verified domain before sending a test');
    if (!result.ok) throw new AppError('TEST_SEND_FAILED', 503, 'The test could not be sent right now. Try again in a moment.', undefined, { 'Retry-After': '30' });
    return { sentTo: prepared.to, subject: prepared.rendered.subject, sample: req.contactId ? 'contact' : 'example' };
  }
}
