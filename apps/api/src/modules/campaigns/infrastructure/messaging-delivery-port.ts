import type { AddressLookup, AudienceProfiles } from '@workeasy/audience-core';
import type { ChannelAdapter, ProviderResult } from '@workeasy/channels';
import { renderSms, renderWhatsAppVariables } from '@workeasy/content';
import type { Database, Tx } from '@workeasy/db';
import { messageDraftSchema, type SmsContentV1, type WhatsAppContentV1 } from '@workeasy/shared';
import type { CampaignDeliveryPort, DeliveryItem, TestSendItem } from '../application/delivery.js';
import { contactPersonalization } from '../application/personalization.js';
import { readVersionSnapshot } from '../domain/version.js';

/**
 * SMS / WhatsApp delivery (messaging amendment, 2026-10-09). Same shape as the email port: per recipient, after
 * Checkpoint B and outside any lock — read the frozen v4 content, get the number through the Audience Address Lookup
 * port (E.164), personalize through the Audience Profiles port, hand off to the provider adapter with the recipient id as
 * idempotency key, and record the provider route so signed status webhooks resolve the tenant (never from a payload).
 * The number and the rendered text exist only in memory for the hand-off.
 */
export class MessagingDeliveryPort implements CampaignDeliveryPort {
  /** Neither Twilio nor Meta deduplicates by our key: an interrupted hand-off is `unknown`, never resent. */
  readonly idempotentSend = false;
  private readonly cache = new Map<string, SmsContentV1 | WhatsAppContentV1>();

  constructor(
    private readonly db: Database,
    private readonly adapter: ChannelAdapter & { provider?: string },
    private readonly profiles: AudienceProfiles<Tx>,
    private readonly addresses: AddressLookup<Tx>,
    private readonly opts: { mode: 'test' | 'live' },
  ) {}

  get mode(): 'test' | 'live' {
    return this.opts.mode;
  }

  async deliver(item: DeliveryItem): Promise<ProviderResult> {
    const fail = (kind: 'configuration' | 'rejected', code: string): ProviderResult => ({ ok: false, retryable: false, kind, code, message: code });
    if (item.channel !== this.adapter.channel) return fail('configuration', 'CHANNEL_MISMATCH');
    const tenant = { orgId: item.orgId, workspaceId: item.workspaceId, userId: null };
    const prepared = await this.db.withTenant(tenant, async (tx) => {
      const content = await this.content(tx, item.executionId);
      if (!content) return { error: fail('configuration', 'VERSION_UNREADABLE') };
      const rec = await tx.campaignRecipient.findUnique({ where: { id: item.recipientId }, select: { contactId: true } });
      const [address] = await this.addresses.lookup({ tx, orgId: item.orgId, workspaceId: item.workspaceId }, [item.addressIdentityId]);
      const kind = item.channel === 'sms' ? 'phone' : 'whatsapp';
      if (!rec || !address || address.kind !== kind) return { error: fail('rejected', 'ADDRESS_GONE') };
      const data = await contactPersonalization(this.profiles, { tx, orgId: item.orgId, workspaceId: item.workspaceId }, rec.contactId, content);
      if (!data) return { error: fail('rejected', 'CONTACT_GONE') };
      return { error: null, content, to: address.value, data };
    });
    if (prepared.error) return prepared.error;
    const { content, to, data } = prepared;
    const result = await this.adapter.send(
      content.schema === 'sms.content.v1'
        ? { to, from: '', text: renderSms(content, data) }
        : { to, from: '', text: '', template: { name: content.template.name, language: content.template.language, variables: renderWhatsAppVariables(content, data) } },
      { orgId: item.orgId, deliveryId: item.recipientId, idempotencyKey: item.idempotencyKey },
    );
    if (result.ok) {
      await this.db.withTenant(tenant, (tx) =>
        tx.$executeRaw`INSERT INTO provider_message_routes (provider, provider_message_id, org_id, workspace_id, delivery_id)
                       VALUES (${this.adapter.provider ?? item.channel}, ${result.providerMessageId}, ${item.orgId}::uuid, ${item.workspaceId}::uuid, ${item.recipientId}::uuid)
                       ON CONFLICT (provider, provider_message_id) DO NOTHING`,
      );
    }
    return result;
  }

  /** Test sends are email-only (users have a verified email, not a verified phone number). */
  async sendTest(_item: TestSendItem): Promise<ProviderResult> {
    return { ok: false, retryable: false, kind: 'configuration', code: 'TEST_SEND_EMAIL_ONLY', message: 'TEST_SEND_EMAIL_ONLY' };
  }

  private async content(tx: Tx, executionId: string): Promise<SmsContentV1 | WhatsAppContentV1 | null> {
    const hit = this.cache.get(executionId);
    if (hit) return hit;
    const e = await tx.campaignExecution.findUnique({ where: { id: executionId }, select: { versionId: true } });
    const v = e ? await tx.campaignVersion.findUnique({ where: { id: e.versionId }, select: { snapshot: true } }) : null;
    if (!v) return null;
    const msg = messageDraftSchema.safeParse(readVersionSnapshot(v.snapshot).messages[0]);
    if (!msg.success) return null;
    const c = msg.data.content;
    if (c.schema !== 'sms.content.v1' && c.schema !== 'whatsapp.content.v1') return null;
    const content = c as SmsContentV1 | WhatsAppContentV1;
    if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(executionId, content);
    return content;
  }
}

/**
 * Routes each hand-off to its channel's port (messaging amendment). Used only when SMS or WhatsApp is configured;
 * otherwise the email port is wired directly (unchanged behaviour). A channel without a port fails as `configuration`
 * (the run waits; nothing is lost) — availability checks normally prevent that.
 */
export class ChannelDeliveryRouter implements CampaignDeliveryPort {
  constructor(
    private readonly ports: Partial<Record<DeliveryItem['channel'], CampaignDeliveryPort>>,
    private readonly opts: { mode: 'test' | 'live' },
  ) {}

  get mode(): 'test' | 'live' {
    return this.opts.mode;
  }

  /** Only when every wired port deduplicates by key (otherwise an interrupted hand-off must become `unknown`). */
  get idempotentSend(): boolean {
    return Object.values(this.ports).every((p) => p!.idempotentSend);
  }

  deliver(item: DeliveryItem): Promise<ProviderResult> {
    const port = this.ports[item.channel];
    if (!port) return Promise.resolve({ ok: false, retryable: false, kind: 'configuration', code: 'CHANNEL_NOT_CONFIGURED', message: 'CHANNEL_NOT_CONFIGURED' });
    return port.deliver(item);
  }

  sendTest(item: TestSendItem): Promise<ProviderResult> {
    const email = this.ports.email;
    if (!email) return Promise.resolve({ ok: false, retryable: false, kind: 'configuration', code: 'CHANNEL_NOT_CONFIGURED', message: 'CHANNEL_NOT_CONFIGURED' });
    return email.sendTest(item);
  }
}
