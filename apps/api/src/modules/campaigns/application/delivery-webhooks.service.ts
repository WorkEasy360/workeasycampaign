import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConsentRecorder, DeliverySuppressions } from '@workeasy/audience-core';
import { type ChannelAdapter, MetaWhatsAppAdapter, type NormalizedEvent, WHATSAPP_MARKETING_OPT_OUT_CODE } from '@workeasy/channels';
import type { Database } from '@workeasy/db';
import { Errors } from '../../../common/errors.js';
import { webhookEvents, webhookRejected } from '../../../common/metrics.js';
import type { AppConfig } from '../../../config/env.js';
import { APP_CONFIG, CONSENT_RECORDER, DATABASE, DELIVERY_ADAPTER, DELIVERY_SUPPRESSIONS, SMS_ADAPTER, WHATSAPP_ADAPTER } from '../../../infrastructure/providers.js';
import { readVersionSnapshot } from '../domain/version.js';
import { recordEngagementEvent, type StoredType } from './engagement.js';

type Adapter = ChannelAdapter & { provider?: string };
/** `inbound`: a reply to the SMS number (Twilio expects TwiML back, not JSON). */
export type WebhookOutcome = { received: number; recorded: number; duplicates: number; unrouted: number; inbound?: true };
type InboundSms = { from: string; messageSid: string; intent: 'opt_out' | 'opt_in' | 'help' | 'other' };
const isInboundCapable = (a: Adapter): a is Adapter & { parseInbound(body: unknown): InboundSms | null } =>
  typeof (a as { parseInbound?: unknown }).parseInbound === 'function';

/** Events whose Audience effects run first (suppression, consent): see the class comment. */
const SIDE_EFFECTS = new Set<StoredType>(['bounced', 'complained', 'unsubscribed']);

/** Normalized adapter event → stored type. `message.bounced` is always a hard bounce (soft ones are `deferred`). */
const STORED: Record<string, StoredType | undefined> = {
  'message.delivered': 'delivered',
  'message.deferred': 'deferred',
  'message.bounced': 'bounced',
  'message.complained': 'complained',
  'message.unsubscribed': 'unsubscribed',
  'message.opened': 'opened',
  'message.clicked': 'clicked',
};

/**
 * Delivery feedback from the email provider (Phase 7.9; docs/architecture/delivery-providers.md §6).
 *
 * 1. Only the configured provider, and only with a signing key: otherwise the endpoint does not exist (404).
 * 2. The signature is verified over the exact bytes received (adapter, constant time, replay window), then the
 *    signature token is claimed once per body: a provider retry (same token, same body) is accepted, the same token
 *    with another body is a forged replay and refused.
 * 3. The tenant and recipient come from provider_message_routes (written when the provider accepted the message) —
 *    never from the payload. An unknown message id is acknowledged and ignored (a test send, another system).
 * 4. Effects on Audience first, through its ports, all idempotent: a hard bounce or a complaint suppresses the address;
 *    a provider unsubscribe is recorded as the contact's own (topic-scoped when the campaign has a topic). Doing them
 *    before the event is recorded means a failure is retried by the provider instead of being lost behind the
 *    deduplication.
 * 5. The event is inserted once (UNIQUE provider + event id), and only a new event updates the recipient's firsts and
 *    the execution's counters, in the same transaction. Order does not matter: firsts keep the earliest time, a click
 *    implies an open, a hard bounce replaces an earlier soft one.
 * Ids only are stored: no address, no IP or user agent, no provider text.
 */
@Injectable()
export class DeliveryWebhooksService {
  private readonly log = new Logger('DeliveryWebhooks');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DELIVERY_ADAPTER) private readonly adapter: Adapter | null,
    @Inject(SMS_ADAPTER) private readonly smsAdapter: Adapter | null,
    @Inject(WHATSAPP_ADAPTER) private readonly whatsappAdapter: Adapter | null,
    @Inject(DELIVERY_SUPPRESSIONS) private readonly suppressions: DeliverySuppressions,
    @Inject(CONSENT_RECORDER) private readonly consent: ConsentRecorder,
  ) {}

  /**
   * The configured provider behind a webhook path and the secret its signatures use (messaging amendment): email
   * (Mailgun: DELIVERY_WEBHOOK_SIGNING_KEY), SMS (Twilio: the auth token), WhatsApp (Meta: the app secret). Unknown or
   * unconfigured → the endpoint does not exist.
   */
  private providerFor(provider: string): { adapter: Adapter; secret: string } | null {
    const candidates: [Adapter | null, string | null | undefined][] = [
      [this.adapter, this.config.deliveryWebhookSigningKey],
      [this.smsAdapter, this.config.smsProvider?.authToken],
      [this.whatsappAdapter, this.config.whatsappProvider?.appSecret],
    ];
    for (const [adapter, secret] of candidates) if (adapter && secret && adapter.provider === provider) return { adapter, secret };
    return null;
  }

  /** Meta's webhook subscription handshake (GET): the challenge when the verify token matches; otherwise not found. */
  verifySubscription(provider: string, query: Record<string, string | undefined>): string {
    const token = this.config.whatsappProvider?.verifyToken;
    if (provider !== 'whatsapp' || !token || !this.whatsappAdapter) throw Errors.notFound('Webhook');
    const challenge = MetaWhatsAppAdapter.verifySubscription(query, token);
    if (challenge === null) {
      webhookRejected.inc({ reason: 'signature' });
      throw Errors.forbidden('Webhook verification failed');
    }
    return challenge;
  }

  async ingest(provider: string, rawBody: Buffer | undefined, headers: Record<string, string>, correlationId: string): Promise<WebhookOutcome> {
    const found = this.providerFor(provider);
    if (!found) throw Errors.notFound('Webhook');
    const { adapter, secret: key } = found;
    if (!rawBody?.length || !adapter.verifyCallback(rawBody, headers, { signingSecret: key })) {
      webhookRejected.inc({ reason: 'signature' });
      this.log.warn(JSON.stringify({ msg: 'webhook signature rejected', provider, requestId: correlationId }));
      throw Errors.unauthenticated('Webhook signature verification failed');
    }
    let body: unknown;
    if (provider === 'twilio') {
      // Twilio posts application/x-www-form-urlencoded (verified above over the exact bytes).
      body = Object.fromEntries(new URLSearchParams(rawBody.toString('utf8')));
    } else {
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        webhookRejected.inc({ reason: 'not_json' });
        throw Errors.validation({ body: ['Not JSON'] });
      }
    }
    // Mailgun signs a token, not the body: a token is accepted once per body. Twilio and Meta sign the whole request, so
    // a replay can only repeat identical events, which the event-id deduplication absorbs.
    if (provider === 'mailgun') {
      const token = signatureToken(provider, body);
      if (!token) throw Errors.unauthenticated('Webhook signature verification failed');
      const claim = await this.db.system.claimWebhookToken(provider, sha256(token), sha256(rawBody));
      if (claim === 'forged') {
        webhookRejected.inc({ reason: 'replay' });
        this.log.warn(JSON.stringify({ msg: 'webhook token replayed with a different body', provider, requestId: correlationId }));
        throw Errors.unauthenticated('Webhook signature verification failed');
      }
    }

    // Twilio posts replies to the SMS number to the same signed URL (messaging amendment §4): STOP / START.
    if (provider === 'twilio' && isInboundCapable(adapter)) {
      const inbound = adapter.parseInbound(body);
      if (inbound) return this.inboundSms(provider, inbound, correlationId);
    }

    const events = adapter.parseCallback(body, headers);
    const out: WebhookOutcome = { received: events.length, recorded: 0, duplicates: 0, unrouted: 0 };
    for (const e of events) {
      const r = await this.one(provider, e, correlationId);
      out[r]++;
      webhookEvents.inc({ type: STORED[e.type] ?? 'other', result: r });
    }
    return out;
  }

  /**
   * A reply to the SMS number. STOP: the provider blocks the number for the whole deployment from now on, so the
   * contact's SMS consent is withdrawn — as the contact's own act — in every workspace that texted that number
   * (app.sms_opt_out_targets). START: undoes only a withdrawal made by an earlier STOP. HELP and other replies change
   * nothing (the provider answers HELP itself). Nothing of the message text is kept; the evidence is the message id.
   * Effects are idempotent, so a provider retry is harmless.
   */
  private async inboundSms(provider: string, inbound: InboundSms, correlationId: string): Promise<WebhookOutcome> {
    const out: WebhookOutcome = { received: 1, recorded: 0, duplicates: 0, unrouted: 0, inbound: true };
    const type = inbound.intent === 'opt_out' ? 'sms_stop' : inbound.intent === 'opt_in' ? 'sms_start' : 'other';
    if (type === 'other') {
      out.unrouted = 1;
      webhookEvents.inc({ type: 'inbound_other', result: 'unrouted' });
      return out;
    }
    const targets = await this.db.system.smsOptOutTargets(provider, inbound.from);
    if (!targets.length) out.unrouted = 1;
    const evidence = { provider, providerMessageId: inbound.messageSid };
    for (const t of targets) {
      const tenant = { orgId: t.orgId, workspaceId: t.workspaceId };
      const r =
        type === 'sms_stop'
          ? await this.consent.recordUnsubscribe(tenant, { contactId: t.contactId, channel: 'sms', topicId: null, source: 'sms_stop', evidence, correlationId, ipAddress: null, userAgent: null })
          : await this.consent.recordProviderOptIn(tenant, { contactId: t.contactId, channel: 'sms', source: 'sms_start', reverses: 'sms_stop', evidence, correlationId });
      if (r.changed) out.recorded++;
      else out.duplicates++;
    }
    webhookEvents.inc({ type, result: out.recorded ? 'recorded' : out.unrouted ? 'unrouted' : 'duplicates' });
    this.log.log(JSON.stringify({ msg: 'sms inbound keyword', provider, intent: type, workspaces: targets.length, changed: out.recorded, requestId: correlationId }));
    return out;
  }

  private async one(provider: string, e: NormalizedEvent, correlationId: string): Promise<'recorded' | 'duplicates' | 'unrouted'> {
    const type = STORED[e.type];
    if (!type) return 'unrouted';
    const route = await this.db.system.resolveProviderMessage(provider, e.providerMessageId);
    if (!route) return 'unrouted';
    const tenant = { orgId: route.orgId, workspaceId: route.workspaceId };
    const eventId = typeof e.props.eventId === 'string' && e.props.eventId ? e.props.eventId : `${type}:${e.providerMessageId}:${e.occurredAt.getTime()}`;

    const detail: Record<string, string> = type === 'bounced' || type === 'deferred' ? { reason: safeCode(e.props.reason) } : {};
    // Events without Audience effects (delivered, deferred, opened, clicked): one transaction — read the recipient and
    // record (deduplicated by the unique key). SMS / WhatsApp failures are recorded but never suppress the number: a
    // failed or undelivered status is often temporary (handset off, carrier), unlike an email hard bounce.
    // Exception: WhatsApp's "this person stopped marketing messages from your business" (131050) is the contact's own
    // opt-out — their WhatsApp consent is withdrawn (channel-wide), never the number suppressed.
    const whatsappOptOut = provider === 'whatsapp' && type === 'bounced' && detail.reason === `WHATSAPP_${WHATSAPP_MARKETING_OPT_OUT_CODE}`;
    if (!SIDE_EFFECTS.has(type) || (provider !== 'mailgun' && !whatsappOptOut)) {
      return this.db.withTenant({ ...tenant, userId: null }, async (tx) => {
        const rec = await tx.campaignRecipient.findUnique({ where: { id: route.deliveryId }, select: { id: true, executionId: true } });
        if (!rec) return 'unrouted' as const;
        const recorded = await recordEngagementEvent(tx, tenant, { executionId: rec.executionId, recipientId: rec.id, type, detail, provider, providerEventId: eventId, occurredAt: e.occurredAt });
        return recorded ? ('recorded' as const) : ('duplicates' as const);
      });
    }

    const target = await this.db.withTenant({ ...tenant, userId: null }, async (tx) => {
      const rec = await tx.campaignRecipient.findUnique({ where: { id: route.deliveryId }, select: { id: true, executionId: true, contactId: true, addressIdentityId: true } });
      if (!rec) return null;
      const seen = await tx.$queryRaw<{ x: number }[]>`SELECT 1 AS x FROM message_events WHERE provider = ${provider} AND provider_event_id = ${eventId}`;
      return { rec, seen: seen.length > 0 };
    });
    if (!target) return 'unrouted';
    if (target.seen) return 'duplicates';
    const { rec } = target;

    // Audience effects first (idempotent; see the class comment).
    if (provider === 'mailgun' && (type === 'bounced' || type === 'complained') && rec.addressIdentityId) {
      await this.suppressions.suppressAddress(tenant, {
        addressIdentityId: rec.addressIdentityId,
        channel: 'email',
        reason: type === 'bounced' ? 'hard_bounce' : 'complaint',
        correlationId,
        note: `${provider} ${type === 'bounced' ? 'hard bounce' : 'complaint'} (campaign execution ${rec.executionId})`,
      });
    }
    if (type === 'unsubscribed' || whatsappOptOut) {
      const topicId = whatsappOptOut ? null : await this.campaignTopic(tenant, rec.executionId);
      await this.consent.recordUnsubscribe(tenant, {
        contactId: rec.contactId,
        channel: whatsappOptOut ? 'whatsapp' : 'email',
        topicId,
        source: whatsappOptOut ? 'whatsapp_opt_out' : 'provider_unsubscribe',
        evidence: { executionId: rec.executionId, recipientId: rec.id, provider },
        correlationId,
        ipAddress: null,
        userAgent: null,
      });
    }

    return this.db.withTenant({ ...tenant, userId: null }, async (tx) => {
      const recorded = await recordEngagementEvent(tx, tenant, { executionId: rec.executionId, recipientId: rec.id, type, detail, provider, providerEventId: eventId, occurredAt: e.occurredAt });
      if (!recorded) return 'duplicates' as const;
      return 'recorded' as const;
    });
  }

  private async campaignTopic(tenant: { orgId: string; workspaceId: string }, executionId: string): Promise<string | null> {
    return this.db.withTenant({ ...tenant, userId: null }, async (tx) => {
      const exe = await tx.campaignExecution.findUnique({ where: { id: executionId }, select: { versionId: true } });
      const version = exe ? await tx.campaignVersion.findUnique({ where: { id: exe.versionId }, select: { snapshot: true } }) : null;
      return version ? (readVersionSnapshot(version.snapshot).topic.topicIds[0] ?? null) : null;
    });
  }
}

/** The provider's single-use signature token (what `claimWebhookToken` remembers). */
function signatureToken(provider: string, body: unknown): string | null {
  if (provider === 'mailgun') {
    const t = (body as { signature?: { token?: unknown } } | null)?.signature?.token;
    return typeof t === 'string' && t.length > 0 && t.length <= 200 ? t : null;
  }
  return null;
}

function sha256(v: string | Buffer): Buffer {
  return createHash('sha256').update(v).digest();
}

/** Provider reasons are kept only as short codes (e.g. SMTP_550): never free text that could echo an address. */
function safeCode(v: unknown): string {
  return typeof v === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(v) ? v : 'unknown';
}
