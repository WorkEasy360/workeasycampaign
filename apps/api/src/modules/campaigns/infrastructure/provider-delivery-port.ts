import type { AddressLookup, AudienceProfiles } from '@workeasy/audience-core';
import type { ChannelAdapter, ProviderResult } from '@workeasy/channels';
import { renderEmail } from '@workeasy/content';
import type { Database, Tx } from '@workeasy/db';
import { messageDraftSchema, type MessageDraft } from '@workeasy/shared';
import type { CampaignDeliveryPort, DeliveryItem, TestSendItem } from '../application/delivery.js';
import { contactPersonalization } from '../application/personalization.js';
import { senderIdentityState } from '../application/senders.service.js';
import { issueUnsubscribeToken, listUnsubscribeHeaders, unsubscribeLinks } from '../application/unsubscribe.js';
import { readVersionSnapshot } from '../domain/version.js';

interface ExecutionMaterial {
  campaignId: string;
  content: Extract<MessageDraft['content'], { schema: 'email.content.v1' | 'email.content.v2' | 'email.content.v3' }>;
  senderIdentityId: string | null;
  fromName: string | null;
  replyTo: string | null;
  organization: string;
}

/**
 * The production delivery port (Phase 7.7; docs/architecture/delivery-providers.md). For each recipient, AFTER Checkpoint
 * B and outside any lock, it: reads the frozen version (cached per execution); resolves the sender identity — which must
 * be on a DNS-verified domain (else a `configuration` failure: the run backs off, nothing is lost); resolves the address
 * through the Audience Address Lookup port; personalizes through the Audience Profiles port; renders with the shared
 * renderer; adds the per-recipient unsubscribe link and RFC 8058 headers; hands it to the provider adapter; and records
 * the provider message route (provider + message id → tenant + recipient) for webhooks.
 *
 * Campaigns never read Audience tables: addresses and personalization come only through ports. Rendered content and the
 * address exist only in memory for the hand-off; nothing about them is logged or stored.
 */
export class ProviderDeliveryPort implements CampaignDeliveryPort {
  /** The provider has no idempotency keys: an interrupted hand-off is `unknown`, never resent (contract §10.3). */
  readonly idempotentSend = false;
  private readonly cache = new Map<string, ExecutionMaterial>();

  constructor(
    private readonly db: Database,
    private readonly adapter: ChannelAdapter & { provider?: string },
    private readonly profiles: AudienceProfiles<Tx>,
    private readonly addresses: AddressLookup<Tx>,
    private readonly opts: { appUrl: string; unsubscribeSecret: string; mode: 'test' | 'live' },
  ) {}

  get mode(): 'test' | 'live' {
    return this.opts.mode;
  }

  private get provider(): string {
    return this.adapter.provider ?? 'smtp';
  }

  async deliver(item: DeliveryItem): Promise<ProviderResult> {
    const fail = (kind: 'configuration' | 'rejected', code: string) => ({ error: { ok: false as const, retryable: false, kind, code, message: code } });
    // An email port never carries another channel (e.g. an SMS execution resumed after its provider was unconfigured):
    // the recipients wait as a configuration problem, nothing is sent by email instead.
    if (item.channel !== 'email') return fail('configuration', 'CHANNEL_NOT_CONFIGURED').error;
    const tenant = { orgId: item.orgId, workspaceId: item.workspaceId, userId: null };
    const prepared = await this.db.withTenant(tenant, async (tx) => {
      const m = await this.material(tx, item.executionId);
      if (!m) return fail('configuration', 'VERSION_UNREADABLE');
      const sender = m.senderIdentityId ? await senderIdentityState(tx, m.senderIdentityId) : null;
      if (!sender || !sender.verified) return fail('configuration', 'SENDER_NOT_VERIFIED');
      const rec = await tx.campaignRecipient.findUnique({ where: { id: item.recipientId }, select: { contactId: true } });
      const [address] = await this.addresses.lookup({ tx, orgId: item.orgId, workspaceId: item.workspaceId }, [item.addressIdentityId]);
      if (!rec || !address || address.kind !== 'email') return fail('rejected', 'ADDRESS_GONE');
      const data = await contactPersonalization(this.profiles, { tx, orgId: item.orgId, workspaceId: item.workspaceId }, rec.contactId, m.content);
      if (!data) return fail('rejected', 'CONTACT_GONE');
      return { error: null, m, sender, to: address.value, data };
    });
    if (prepared.error) return prepared.error;

    const { m, sender, to, data } = prepared;
    const links = unsubscribeLinks(this.opts.appUrl, issueUnsubscribeToken(this.opts.unsubscribeSecret, { orgId: item.orgId, workspaceId: item.workspaceId, recipientId: item.recipientId }));
    const r = renderEmail(m.content, data, { unsubscribeUrl: links.page, reason: `you are on the mailing list of ${m.organization}` });
    const fromName = (m.fromName ?? sender.displayName).replace(/["\\\r\n]/g, '');
    const result = await this.adapter.send(
      {
        to,
        from: `"${fromName}" <${sender.email}>`,
        ...(m.replyTo ?? sender.replyTo ? { replyTo: (m.replyTo ?? sender.replyTo)! } : {}),
        subject: r.subject,
        html: r.html,
        text: r.text,
        headers: { ...listUnsubscribeHeaders(links), 'X-Workeasy-Campaign': m.campaignId },
      },
      { orgId: item.orgId, deliveryId: item.recipientId, idempotencyKey: item.idempotencyKey, senderDomain: domainOf(sender.email) },
    );
    if (result.ok) {
      // Webhooks resolve the tenant and the recipient from this route — never from payload fields.
      await this.db.withTenant(tenant, (tx) =>
        tx.$executeRaw`INSERT INTO provider_message_routes (provider, provider_message_id, org_id, workspace_id, delivery_id)
                       VALUES (${this.provider}, ${result.providerMessageId}, ${item.orgId}::uuid, ${item.workspaceId}::uuid, ${item.recipientId}::uuid)
                       ON CONFLICT (provider, provider_message_id) DO NOTHING`,
      );
    }
    return result;
  }

  /**
   * A test send goes out exactly like the campaign would: from the draft's sender identity, through its verified domain
   * (a provider refuses, or DMARC fails, mail "from" an address on a domain it does not send for). No verified sender →
   * nothing is sent (`SENDER_NOT_VERIFIED`).
   */
  async sendTest(item: TestSendItem): Promise<ProviderResult> {
    const sender = item.senderIdentityId
      ? await this.db.withTenant({ orgId: item.orgId, workspaceId: item.workspaceId, userId: null }, (tx) => senderIdentityState(tx, item.senderIdentityId!))
      : null;
    if (!sender || !sender.verified) return { ok: false, retryable: false, kind: 'configuration', code: 'SENDER_NOT_VERIFIED', message: 'SENDER_NOT_VERIFIED' };
    const fromName = sender.displayName.replace(/["\\\r\n]/g, '');
    return this.adapter.send(
      { to: item.to, from: `"${fromName}" <${sender.email}>`, ...(sender.replyTo ? { replyTo: sender.replyTo } : {}), subject: item.subject, html: item.html, text: item.text, headers: { 'X-Workeasy-Test': '1' } },
      { orgId: item.orgId, deliveryId: item.idempotencyKey, idempotencyKey: item.idempotencyKey, senderDomain: domainOf(sender.email) },
    );
  }

  /** The frozen version's material for an execution (read once per execution; versions never change). */
  private async material(tx: Tx, executionId: string): Promise<ExecutionMaterial | null> {
    const hit = this.cache.get(executionId);
    if (hit) return hit;
    const e = await tx.campaignExecution.findUnique({ where: { id: executionId }, select: { campaignId: true, versionId: true, orgId: true } });
    if (!e) return null;
    const v = await tx.campaignVersion.findUnique({ where: { id: e.versionId }, select: { snapshot: true } });
    const org = await tx.organization.findUnique({ where: { id: e.orgId }, select: { name: true } });
    if (!v || !org) return null;
    const s = readVersionSnapshot(v.snapshot);
    const msg = messageDraftSchema.safeParse(s.messages[0]);
    if (!msg.success) return null;
    const content = msg.data.content;
    if (content.schema !== 'email.content.v1' && content.schema !== 'email.content.v2' && content.schema !== 'email.content.v3') return null;
    const m: ExecutionMaterial = { campaignId: e.campaignId, content, senderIdentityId: s.sender.senderIdentityId, fromName: s.sender.fromName, replyTo: s.sender.replyTo, organization: org.name };
    if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(executionId, m);
    return m;
  }
}

/** The domain part of a sender address (the verified sending domain). */
function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}
