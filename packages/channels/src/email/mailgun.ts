import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AddressValidation, CallbackCredentials, ChannelAdapter, NormalizedEvent, ProviderResult, RenderedPayload, SendContext } from '../adapter.js';

/** A DNS name: labels of letters, digits and hyphens (no path, no traversal, no URL syntax). */
const DOMAIN_RE = /^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** Webhooks older than this are refused (replay window). Deduplication by event id happens at ingestion. */
export const MAILGUN_WEBHOOK_MAX_AGE_SECONDS = 15 * 60;

export interface MailgunOptions {
  apiKey: string;
  /**
   * Fallback sending domain at Mailgun. Each message normally goes through its sender's own verified domain
   * (`SendContext.senderDomain`); without either, the send is refused as a configuration failure.
   */
  domain?: string;
  /** https://api.mailgun.net (US) or https://api.eu.mailgun.net (EU). */
  baseUrl?: string;
  timeoutMs?: number;
  /** Injected for tests (deterministic doubles); defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Clock for the replay window (tests). */
  now?: () => number;
  /**
   * Open and click tracking, requested explicitly on every message (o:tracking-opens / o:tracking-clicks) so the
   * domain's dashboard setting cannot silently change what the counts mean. Default: off.
   */
  tracking?: { opens: boolean; clicks: boolean };
}

/**
 * Mailgun HTTP adapter (Phase 7.7; docs/architecture/delivery-providers.md). Implements the provider's documented
 * messages API and signed webhooks. Mailgun has no idempotency keys, so `send` reports a timeout or a connection lost
 * mid-request as `unknown` (never retried — no duplicate); only failures before the request was sent are `transient`.
 * Validated against deterministic doubles and recorded payload shapes; live validation needs a Mailgun account
 * (environment-dependent, reported separately).
 */
export class MailgunEmailAdapter implements ChannelAdapter {
  readonly channel = 'email' as const;
  readonly capabilities = { html: true, tracking: { opens: true, clicks: true }, templatesRequireApproval: false, feedbackWebhooks: true };
  readonly provider = 'mailgun';
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: MailgunOptions) {
    if (options.domain !== undefined && !DOMAIN_RE.test(options.domain)) throw new Error('Mailgun: invalid sending domain');
    if (!options.apiKey || options.apiKey.length < 10) throw new Error('Mailgun: an API key is required');
    this.baseUrl = (options.baseUrl ?? 'https://api.mailgun.net').replace(/\/+$/, '');
    if (!/^https:\/\//.test(this.baseUrl) && !/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(this.baseUrl)) throw new Error('Mailgun: the API base URL must be https');
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  validateAddress(address: string): AddressValidation {
    const normalized = address.trim().toLowerCase();
    return EMAIL_RE.test(normalized) ? { valid: true, normalized } : { valid: false, reason: 'syntax' };
  }

  async send(payload: RenderedPayload, ctx: SendContext): Promise<ProviderResult> {
    const domain = ctx.senderDomain ?? this.options.domain;
    if (!domain || !DOMAIN_RE.test(domain)) return { ok: false, retryable: false, kind: 'configuration', code: 'MAILGUN_NO_DOMAIN', message: 'no sending domain' };
    const form = new FormData();
    form.set('from', payload.from);
    form.set('to', payload.to);
    if (payload.subject !== undefined) form.set('subject', payload.subject);
    form.set('text', payload.text);
    if (payload.html) form.set('html', payload.html);
    if (payload.replyTo) form.set('h:Reply-To', payload.replyTo);
    form.set('o:tracking-opens', this.options.tracking?.opens ? 'yes' : 'no');
    form.set('o:tracking-clicks', this.options.tracking?.clicks ? 'yes' : 'no');
    for (const [name, value] of Object.entries(payload.headers ?? {})) {
      if (/^[A-Za-z0-9-]{1,64}$/.test(name) && !/[\r\n]/.test(value)) form.set(`h:${name}`, value);
    }
    form.set('h:X-Workeasy-Delivery', ctx.deliveryId);
    form.set('v:workeasy-delivery', ctx.deliveryId); // echoed in webhooks
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v3/${encodeURIComponent(domain)}/messages`, {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`api:${this.options.apiKey}`).toString('base64')}` },
        body: form,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch (err) {
      const e = err as { name?: string; cause?: { code?: string } };
      // Refused or unresolvable before any byte was sent; ECONNRESET is ambiguous (mid-request) and stays unknown.
      const before = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(e.cause?.code ?? '');
      // Refused/unresolvable: nothing was sent. A timeout or a reset mid-request: it may have been accepted.
      return before
        ? { ok: false, retryable: true, kind: 'transient', code: `MAILGUN_${e.cause!.code}`, message: 'connection failed' }
        : { ok: false, retryable: false, kind: 'unknown', code: e.name === 'TimeoutError' ? 'MAILGUN_TIMEOUT' : 'MAILGUN_NETWORK', message: 'outcome unknown' };
    }
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { id?: string } | null;
      const id = body?.id?.replace(/^<|>$/g, '');
      // Accepted without an id would be a provider defect; the outcome is unknown rather than guessed.
      return id ? { ok: true, providerMessageId: id } : { ok: false, retryable: false, kind: 'unknown', code: 'MAILGUN_NO_ID', message: 'accepted without id' };
    }
    const code = `MAILGUN_${res.status}`;
    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after'));
      return { ok: false, retryable: true, kind: 'throttled', retryAfterSeconds: Number.isFinite(after) && after > 0 ? Math.min(after, 3600) : 60, code, message: 'throttled' };
    }
    if (res.status === 401 || res.status === 403 || res.status === 404) return { ok: false, retryable: false, kind: 'configuration', code, message: 'provider configuration' };
    if (res.status >= 500) return { ok: false, retryable: true, kind: 'transient', code, message: 'provider error' };
    return { ok: false, retryable: false, kind: 'rejected', code, message: 'rejected' };
  }

  /**
   * Mailgun signs `timestamp + token` with the webhook signing key (HMAC-SHA256, hex). Verified over the raw body
   * before anything else; constant-time comparison; stale timestamps refused (replay window).
   */
  verifyCallback(rawBody: Buffer, _headers: Record<string, string>, credentials: CallbackCredentials): boolean {
    let body: { signature?: { timestamp?: unknown; token?: unknown; signature?: unknown } };
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return false;
    }
    const s = body?.signature;
    if (typeof s?.timestamp !== 'string' || typeof s.token !== 'string' || typeof s.signature !== 'string') return false;
    if (!/^\d{1,12}$/.test(s.timestamp) || !/^[0-9a-f]{64}$/.test(s.signature) || s.token.length > 200) return false;
    const age = this.now() / 1000 - Number(s.timestamp);
    if (age > MAILGUN_WEBHOOK_MAX_AGE_SECONDS || age < -300) return false;
    if (!credentials.signingSecret) return false;
    const expected = createHmac('sha256', credentials.signingSecret).update(s.timestamp + s.token).digest();
    const given = Buffer.from(s.signature, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  /** Normalizes a VERIFIED webhook. Provider message id only — the tenant comes from provider_message_routes. */
  parseCallback(body: unknown): NormalizedEvent[] {
    const d = (body as { 'event-data'?: Record<string, any> } | null)?.['event-data'];
    if (!d || typeof d.event !== 'string') return [];
    const providerMessageId = String(d.message?.headers?.['message-id'] ?? '').replace(/^<|>$/g, '');
    const occurredAt = new Date(Number(d.timestamp) * 1000);
    if (!providerMessageId || Number.isNaN(occurredAt.getTime())) return [];
    const eventId = typeof d.id === 'string' ? d.id.slice(0, 120) : null;
    const status = Number(d['delivery-status']?.code);
    const reason = Number.isFinite(status) && status > 0 ? `SMTP_${status}` : String(d.reason ?? 'unknown').slice(0, 40);
    const base = { providerMessageId, occurredAt, props: { eventId, provider: this.provider } as Record<string, unknown> };
    switch (d.event) {
      case 'delivered':
        return [{ ...base, type: 'message.delivered' }];
      case 'failed':
        return d.severity === 'permanent'
          ? [{ ...base, type: 'message.bounced', props: { ...base.props, bounce: 'hard', reason } }]
          : [{ ...base, type: 'message.deferred', props: { ...base.props, reason } }];
      case 'complained':
        return [{ ...base, type: 'message.complained' }];
      case 'unsubscribed':
        return [{ ...base, type: 'message.unsubscribed' }];
      case 'opened':
        return [{ ...base, type: 'message.opened' }];
      case 'clicked':
        return [{ ...base, type: 'message.clicked' }];
      default:
        return []; // accepted, stored, …: not engagement
    }
  }
}
