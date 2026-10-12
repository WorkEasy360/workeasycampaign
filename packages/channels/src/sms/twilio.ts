import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AddressValidation, CallbackCredentials, ChannelAdapter, NormalizedEvent, ProviderResult, RenderedPayload, SendContext } from '../adapter.js';

const E164_RE = /^\+[1-9]\d{6,14}$/;
const ACCOUNT_SID_RE = /^AC[0-9a-f]{32}$/;
const MESSAGING_SERVICE_SID_RE = /^MG[0-9a-f]{32}$/;
/** Twilio error codes that mean this recipient can never receive this message (STOP, invalid, not mobile). */
const RECIPIENT_REJECTED = new Set([21610, 21211, 21614]);
/** Twilio's default opt-out / opt-in / help keywords (a reply consisting of exactly one of them). */
const OPT_OUT_KEYWORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT']);
const OPT_IN_KEYWORDS = new Set(['START', 'YES', 'UNSTOP']);
const HELP_KEYWORDS = new Set(['HELP', 'INFO']);

export interface TwilioOptions {
  /** Account SID (AC + 32 hex). */
  accountSid: string;
  /** Auth token: a secret; also the key Twilio signs status callbacks with. */
  authToken: string;
  /** Sender number in E.164. Exactly one of `from` / `messagingServiceSid` is required. */
  from?: string;
  /** Messaging Service SID (MG + 32 hex); Twilio picks the sender from the service's pool. */
  messagingServiceSid?: string;
  /** The exact public URL Twilio posts status callbacks to; also the URL the callback signature covers. */
  statusCallbackUrl?: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Injected for tests (deterministic doubles); defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Clock for callback timestamps (Twilio status callbacks carry none). */
  now?: () => number;
}

function normalizeE164(address: string): string | null {
  const normalized = address.replace(/[\s\-()]/g, '');
  return E164_RE.test(normalized) ? normalized : null;
}

function isSafeUrl(url: string): boolean {
  return /^https:\/\/[^\s]+$/.test(url) || /^http:\/\/127\.0\.0\.1(:\d+)?(\/[^\s]*)?$/.test(url);
}

/**
 * Twilio Programmable Messaging adapter (Phase 7; docs/architecture/delivery-providers.md). Implements the documented
 * Messages API (form-encoded, basic auth) and signed status callbacks (X-Twilio-Signature, HMAC-SHA1). Twilio has no
 * idempotency keys for messages, so a timeout or a connection lost mid-request is `unknown` (never retried — no
 * duplicate); only failures before the request was sent are `transient`. Validated against deterministic doubles;
 * live validation needs a Twilio account (environment-dependent, reported separately).
 */
export class TwilioSmsAdapter implements ChannelAdapter {
  readonly channel = 'sms' as const;
  readonly capabilities = { html: false, tracking: { opens: false, clicks: false }, templatesRequireApproval: false, feedbackWebhooks: true, maxBodyLength: 1600 };
  readonly provider = 'twilio';
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: TwilioOptions) {
    if (!ACCOUNT_SID_RE.test(options.accountSid ?? '')) throw new Error('Twilio: invalid account SID');
    if (!options.authToken || options.authToken.length < 16) throw new Error('Twilio: an auth token is required');
    const hasFrom = options.from !== undefined;
    const hasService = options.messagingServiceSid !== undefined;
    if (hasFrom === hasService) throw new Error('Twilio: exactly one of from / messagingServiceSid is required');
    if (hasFrom && !E164_RE.test(options.from!)) throw new Error('Twilio: the from number must be E.164');
    if (hasService && !MESSAGING_SERVICE_SID_RE.test(options.messagingServiceSid!)) throw new Error('Twilio: invalid messaging service SID');
    if (options.statusCallbackUrl !== undefined && !isSafeUrl(options.statusCallbackUrl)) throw new Error('Twilio: the status callback URL must be https');
    this.baseUrl = (options.baseUrl ?? 'https://api.twilio.com').replace(/\/+$/, '');
    if (!/^https:\/\//.test(this.baseUrl) && !/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(this.baseUrl)) throw new Error('Twilio: the API base URL must be https');
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  validateAddress(address: string): AddressValidation {
    const normalized = normalizeE164(address);
    return normalized ? { valid: true, normalized } : { valid: false, reason: 'not_e164' };
  }

  async send(payload: RenderedPayload, _ctx: SendContext): Promise<ProviderResult> {
    const to = normalizeE164(payload.to);
    if (!to) return { ok: false, retryable: false, kind: 'rejected', code: 'TWILIO_INVALID_NUMBER', message: 'invalid number' };
    const form = new URLSearchParams();
    form.set('To', to);
    if (this.options.messagingServiceSid) form.set('MessagingServiceSid', this.options.messagingServiceSid);
    else form.set('From', this.options.from!);
    form.set('Body', payload.text);
    if (this.options.statusCallbackUrl) form.set('StatusCallback', this.options.statusCallbackUrl);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/2010-04-01/Accounts/${this.options.accountSid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.options.accountSid}:${this.options.authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch (err) {
      const e = err as { name?: string; cause?: { code?: string } };
      // Refused/unresolvable: nothing was sent. A timeout or a reset mid-request: it may have been accepted.
      const before = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(e.cause?.code ?? '');
      return before
        ? { ok: false, retryable: true, kind: 'transient', code: `TWILIO_${e.cause!.code}`, message: 'connection failed' }
        : { ok: false, retryable: false, kind: 'unknown', code: e.name === 'TimeoutError' ? 'TWILIO_TIMEOUT' : 'TWILIO_NETWORK', message: 'outcome unknown' };
    }
    const body = (await res.json().catch(() => null)) as { sid?: unknown; code?: unknown } | null;
    if (res.ok) {
      const sid = typeof body?.sid === 'string' && body.sid.length > 0 && body.sid.length <= 64 ? body.sid : null;
      // Accepted without an id would be a provider defect; the outcome is unknown rather than guessed.
      return sid ? { ok: true, providerMessageId: sid } : { ok: false, retryable: false, kind: 'unknown', code: 'TWILIO_NO_ID', message: 'accepted without id' };
    }
    // Twilio's numeric error code; its `message` text may echo the number, so it is never surfaced.
    const providerCode = typeof body?.code === 'number' && Number.isInteger(body.code) ? body.code : null;
    const code = providerCode !== null ? `TWILIO_${providerCode}` : `TWILIO_${res.status}`;
    if (res.status === 429 || providerCode === 20429) {
      const after = Number(res.headers.get('retry-after'));
      return { ok: false, retryable: true, kind: 'throttled', retryAfterSeconds: Number.isFinite(after) && after > 0 ? Math.min(after, 3600) : 60, code, message: 'throttled' };
    }
    if (providerCode === 20003 || res.status === 401 || res.status === 403 || res.status === 404) return { ok: false, retryable: false, kind: 'configuration', code, message: 'provider configuration' };
    if (providerCode !== null && RECIPIENT_REJECTED.has(providerCode)) return { ok: false, retryable: false, kind: 'rejected', code, message: 'rejected' };
    if (res.status >= 500) return { ok: false, retryable: true, kind: 'transient', code, message: 'provider error' };
    return { ok: false, retryable: false, kind: 'rejected', code, message: 'rejected' };
  }

  /**
   * Twilio signs `url + Σ(key + value)` over the POST params sorted by key with the auth token (HMAC-SHA1, base64)
   * in X-Twilio-Signature. The URL is the configured status callback URL (the exact string Twilio called), never one
   * derived from the request. Constant-time comparison. Twilio callbacks carry no timestamp; replays are absorbed by
   * the event-id deduplication at ingestion.
   */
  verifyCallback(rawBody: Buffer, headers: Record<string, string>, credentials: CallbackCredentials): boolean {
    const url = this.options.statusCallbackUrl;
    const header = headers['x-twilio-signature'];
    if (!url || typeof header !== 'string' || !/^[A-Za-z0-9+/]{27}=$/.test(header)) return false;
    if (!credentials.signingSecret) return false;
    let params: URLSearchParams;
    try {
      params = new URLSearchParams(rawBody.toString('utf8'));
    } catch {
      return false;
    }
    const entries = [...params.entries()].sort(([ka, va], [kb, vb]) => (ka < kb ? -1 : ka > kb ? 1 : va < vb ? -1 : va > vb ? 1 : 0));
    const data = url + entries.map(([k, v]) => k + v).join('');
    const expected = createHmac('sha1', credentials.signingSecret).update(data, 'utf8').digest();
    const given = Buffer.from(header, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  /**
   * A VERIFIED inbound message (a reply to the SMS number), or null for anything else (status callbacks carry
   * MessageStatus; inbound messages carry From and Body). The intent follows Twilio's own keyword handling: the
   * OptOutType parameter when Advanced Opt-Out is on, otherwise Twilio's default keywords — the whole message, trimmed,
   * case-insensitive. Only the sender's number and the message id are returned; the text itself is not kept.
   */
  parseInbound(body: unknown): { from: string; messageSid: string; intent: 'opt_out' | 'opt_in' | 'help' | 'other' } | null {
    const fields = body instanceof URLSearchParams ? Object.fromEntries(body.entries()) : body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    if (!fields || fields.MessageStatus !== undefined) return null;
    const sid = fields.MessageSid ?? fields.SmsSid;
    if (typeof sid !== 'string' || !sid || sid.length > 64 || typeof fields.From !== 'string' || typeof fields.Body !== 'string') return null;
    const from = normalizeE164(fields.From);
    if (!from) return null;
    const type = typeof fields.OptOutType === 'string' ? fields.OptOutType.toUpperCase() : '';
    const word = fields.Body.trim().toUpperCase();
    const intent =
      type === 'STOP' || OPT_OUT_KEYWORDS.has(word) ? 'opt_out' : type === 'START' || OPT_IN_KEYWORDS.has(word) ? 'opt_in' : type === 'HELP' || HELP_KEYWORDS.has(word) ? 'help' : 'other';
    return { from, messageSid: sid, intent };
  }

  /** Normalizes a VERIFIED status callback. Provider message id only — the tenant comes from provider_message_routes. */
  parseCallback(body: unknown): NormalizedEvent[] {
    let fields: Record<string, unknown>;
    if (body instanceof URLSearchParams) fields = Object.fromEntries(body.entries());
    else if (body && typeof body === 'object' && !Array.isArray(body)) fields = body as Record<string, unknown>;
    else return [];
    const sid = fields.MessageSid;
    const status = fields.MessageStatus;
    if (typeof sid !== 'string' || !sid || sid.length > 64 || typeof status !== 'string') return [];
    const errorCode = typeof fields.ErrorCode === 'string' && /^\d{1,6}$/.test(fields.ErrorCode) ? fields.ErrorCode : null;
    const base = { providerMessageId: sid, occurredAt: new Date(this.now()), props: { eventId: `${sid}:${status.slice(0, 20)}`, provider: this.provider } as Record<string, unknown> };
    switch (status) {
      case 'delivered':
        return [{ ...base, type: 'message.delivered' }];
      case 'undelivered':
      case 'failed':
        return [{ ...base, type: 'message.bounced', props: { ...base.props, bounce: 'hard', reason: errorCode ? `TWILIO_${errorCode}` : 'TWILIO_FAILED' } }];
      default:
        return []; // queued, accepted, sending, sent, …: not engagement
    }
  }
}
