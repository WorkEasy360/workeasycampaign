import { mergeFieldsUsedMessaging, renderSms, renderWhatsAppVariables, smsSegments } from '@workeasy/content';
import { channelSpec } from '../domain/channels.js';
import { Inject, Injectable } from '@nestjs/common';
import type { AudienceProfiles } from '@workeasy/audience-core';
import { renderEmail } from '@workeasy/content';
import type { Database, Tx } from '@workeasy/db';
import { type CampaignPreview, type CampaignPreviewRequest, messageDraftSchema } from '@workeasy/shared';
import { AppError, Errors } from '../../../common/errors.js';
import type { TenantRequestContext } from '../../../common/request-context.js';
import { AUDIENCE_PROFILES, DATABASE } from '../../../infrastructure/providers.js';
import { inTenant } from '../../tenancy/application/tenant-tx.js';
import { campaignNotFound } from './campaign-errors.js';
import { draftOf } from './campaign-views.js';
import { CampaignsService } from './campaigns.service.js';
import { contactPersonalization, examplePersonalization } from './personalization.js';

/** Placeholder link in previews: real unsubscribe links are issued by delivery (Phase 8). */
export const PREVIEW_UNSUBSCRIBE_URL = '#unsubscribe-preview';
const PREVIEW_REASON = 'you subscribed to emails from this sender';

/**
 * Content preview (docs/contracts/phase-6-content-amendment.md §5). Renders the CURRENT draft (readiness errors
 * included — preview never requires a ready draft) with the pure renderer the web app also uses. Read-only.
 *
 * With a contact: merge values come from the Audience Profiles port (RLS-scoped; another workspace's, a deleted or an
 * erased contact is "not found"), which needs `contacts.read` in addition to `campaigns.read` (the response contains
 * that contact's field values). Nothing about the contact is logged, audited or put into events.
 */
@Injectable()
export class PreviewService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIENCE_PROFILES) private readonly profiles: AudienceProfiles<Tx>,
    private readonly campaigns: CampaignsService,
  ) {}

  async preview(ctx: TenantRequestContext, campaignId: string, req: CampaignPreviewRequest): Promise<CampaignPreview> {
    if (req.contactId) await this.campaigns.requirePermissions(ctx, new Set(['contacts.read']), 'preview');
    return inTenant(this.db, ctx, async ({ tx }) => {
      const row = await tx.campaign.findUnique({ where: { id: campaignId } });
      if (!row) throw campaignNotFound();
      const draft = draftOf(row);
      const message = messageDraftSchema.safeParse(draft.messages.find((m) => m.variantKey === 'default'));
      if (!message.success) throw new AppError('validation_failed', 422, 'This campaign has no message to preview yet');

      // merge_tags_v2 for v3 / SMS / WhatsApp content: custom fields through the Audience port, tenant names; v1/v2 unchanged.
      const scope = { tx, orgId: ctx.access.orgId, workspaceId: ctx.access.workspaceId! };
      const content = message.data.content;
      const data = req.contactId ? await contactPersonalization(this.profiles, scope, req.contactId, content) : await examplePersonalization(this.profiles, scope, content);
      if (!data) throw Errors.notFound('Contact');
      const sample = req.contactId ? ('contact' as const) : ('example' as const);
      if (content.schema === 'sms.content.v1' || content.schema === 'whatsapp.content.v1') {
        if (content.schema !== channelSpec(draft.channel).contentSchema) throw new AppError('validation_failed', 422, 'This campaign has no message to preview yet');
        const used = mergeFieldsUsedMessaging(content);
        const missingTags = used.filter((t) => !data[t]?.trim()) as CampaignPreview['missingTags'];
        if (content.schema === 'sms.content.v1') {
          const text = renderSms({ schema: 'sms.content.v1', text: content.text.trim() || ' ' }, data);
          return { subject: '', preheader: '', html: '', text, sample, missingTags, messaging: { channel: 'sms' as const, text, ...smsSegments(text) } };
        }
        const parameters = Object.values(renderWhatsAppVariables({ schema: 'whatsapp.content.v1', template: { name: content.template.name || 'template', language: content.template.language || 'en', parameters: content.template.parameters } }, data));
        const text = `WhatsApp template "${content.template.name}" (${content.template.language})`;
        return { subject: '', preheader: '', html: '', text, sample, missingTags, messaging: { channel: 'whatsapp' as const, template: { name: content.template.name, language: content.template.language }, parameters } };
      }
      if (draft.channel !== 'email') throw new AppError('validation_failed', 422, 'This campaign has no message to preview yet');
      const r = renderEmail(content, data, { unsubscribeUrl: PREVIEW_UNSUBSCRIBE_URL, reason: PREVIEW_REASON });
      return {
        subject: r.subject,
        preheader: r.preheader,
        html: r.html,
        text: r.text,
        sample: req.contactId ? 'contact' : 'example',
        missingTags: r.usedTags.filter((t) => !data[t]?.trim()),
      };
    });
  }
}
