import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { AddressValidation, CallbackCredentials, ChannelAdapter, NormalizedEvent, ProviderResult, RenderedPayload, SendContext } from '../adapter.js';

const E164_RE = /^\+[1-9]\d{6,14}$/;
const TEMPLATE_NAME_RE = /^[a-z0-9_]{1,512}$/;
const TEMPLATE_LANGUAGE_RE = /^[a-z]{2,3}(_[A-Z]{2})?$/;
/** Graph error codes: access token invalid/expired. */
const CONFIGURATION_CODES = new Set([190]);
/** Graph error codes: rate limits (app, account, pair rate, spam rate, throughput). */
const THROTTLED_CODES = new Set([4, 80007, 130429, 131048, 131056]);
/** Graph error codes: undeliverable, re-engagement window, recipient/template problems (never retried). */
/** 131050: the recipient stopped marketing messages from this business (an opt-out; never resent). */
const REJECTED_CODES = new Set([131026, 131047, 131050, 131051]);
export const WHATSAPP_MARKETING_OPT_OUT_CODE = 131050;

export interface MetaWhatsAppOptions {
  /** System-user access token for the WhatsApp Business Account. */
  accessToken: string;
  /** The sending phone number's id at Meta (not the phone number). */
  phoneNumberId: string;
  /** Graph API version, e.g. v21.0. */
  apiVersion?: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Injected for tests (deterministic doubles); defaults to the global fetch. */
  fetch?: typeof fetch;
  now?: () => number;
}

function normalizeE164(address: string): string | null {
  const normalized = address.replace(/[\s\-()]/g, '');
  return E164_RE.test(normalized) ? normalized : null;
}

/** Constant-time string equality (lengths hidden by hashing first). */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/**
 * Meta WhatsApp Cloud API adapter (Phase 7; docs/architecture/delivery-providers.md). Marketing messages go out only
 * as approved templates (`templatesRequireApproval`). Implements the documented /messages endpoint (bearer token) and
 * signed webhooks (X-Hub-Signature-256, HMAC-SHA256 with the app secret). The Cloud API has no idempotency keys, so a
 * timeout or a connection lost mid-request is `unknown` (never retried — no duplicate). Validated against deterministic
 * doubles; live validation needs a WhatsApp Business Account (environment-dependent, reported separately).
 */
export class MetaWhatsAppAdapter implements ChannelAdapter {
  readonly channel = 'whatsapp' as const;
  readonly capabilities = { html: false, tracking: { opens: true, clicks: false }, templatesRequireApproval: true, feedbackWebhooks: true };
  /** Also the webhook path segment (/v1/webhooks/whatsapp). */
  readonly provider = 'whatsapp';
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: MetaWhatsAppOptions) {
    if (!options.accessToken || options.accessToken.length < 20) throw new Error('WhatsApp: an access token is required');
    if (!/^\d{5,20}$/.test(options.phoneNumberId ?? '')) throw new Error('WhatsApp: invalid phone number id');
    this.apiVersion = options.apiVersion ?? 'v21.0';
    if (!/^v\d{1,2}\.\d$/.test(this.apiVersion)) throw new Error('WhatsApp: invalid API version');
    this.baseUrl = (options.baseUrl ?? 'https://graph.facebook.com').replace(/\/+$/, '');
    if (!/^https:\/\//.test(this.baseUrl) && !/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(this.baseUrl)) throw new Error('WhatsApp: the API base URL must be https');
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** E.164 with '+' (the stored form); the '+' is stripped only on the wire. */
  validateAddress(address: string): AddressValidation {
    const normalized = normalizeE164(address);
    return normalized ? { valid: true, normalized } : { valid: false, reason: 'not_e164' };
  }

  async send(payload: RenderedPayload, _ctx: SendContext): Promise<ProviderResult> {
    const to = normalizeE164(payload.to);
    if (!to) return { ok: false, retryable: false, kind: 'rejected', code: 'WHATSAPP_INVALID_NUMBER', message: 'invalid number' };
    const t = payload.template;
    if (!t) return { ok: false, retryable: false, kind: 'rejected', code: 'WHATSAPP_TEMPLATE_REQUIRED', message: 'template required' };
    if (!TEMPLATE_NAME_RE.test(t.name) || !TEMPLATE_LANGUAGE_RE.test(t.language)) return { ok: false, retryable: false, kind: 'rejected', code: 'WHATSAPP_TEMPLATE_INVALID', message: 'invalid template' };
    const keys = Object.keys(t.variables ?? {});
    if (keys.some((k) => !/^[1-9]\d{0,2}$/.test(k))) return { ok: false, retryable: false, kind: 'rejected', code: 'WHATSAPP_TEMPLATE_INVALID', message: 'invalid template' };
    const parameters = keys.sort((a, b) => Number(a) - Number(b)).map((k) => ({ type: 'text', text: t.variables[k]! }));
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to.slice(1),
      type: 'template',
      template: { name: t.name, language: { code: t.language }, components: parameters.length ? [{ type: 'body', parameters }] : [] },
    };
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/${this.apiVersion}/${this.options.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.options.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch (err) {
      const e = err as { name?: string; cause?: { code?: string } };
      // Refused/unresolvable: nothing was sent. A timeout or a reset mid-request: it may have been accepted.
      const before = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(e.cause?.code ?? '');
      return before
        ? { ok: false, retryable: true, kind: 'transient', code: `WHATSAPP_${e.cause!.code}`, message: 'connection failed' }
        : { ok: false, retryable: false, kind: 'unknown', code: e.name === 'TimeoutError' ? 'WHATSAPP_TIMEOUT' : 'WHATSAPP_NETWORK', message: 'outcome unknown' };
    }
    const json = (await res.json().catch(() => null)) as { messages?: { id?: unknown }[]; error?: { code?: unknown } } | null;
    if (res.ok) {
      const id = Array.isArray(json?.messages) ? json.messages[0]?.id : undefined;
      // Accepted without an id would be a provider defect; the outcome is unknown rather than guessed.
      return typeof id === 'string' && id.length > 0 && id.length <= 256
        ? { ok: true, providerMessageId: id }
        : { ok: false, retryable: false, kind: 'unknown', code: 'WHATSAPP_NO_ID', message: 'accepted without id' };
    }
    // Graph's numeric error code; its message text may echo the number, so it is never surfaced.
    const graphCode = typeof json?.error?.code === 'number' && Number.isInteger(json.error.code) ? json.error.code : null;
    const code = graphCode !== null ? `WHATSAPP_${graphCode}` : `WHATSAPP_${res.status}`;
    if ((graphCode !== null && CONFIGURATION_CODES.has(graphCode)) || res.status === 401 || res.status === 403 || res.status === 404) {
      return { ok: false, retryable: false, kind: 'configuration', code, message: 'provider configuration' };
    }
    if ((graphCode !== null && THROTTLED_CODES.has(graphCode)) || res.status === 429) {
      const after = Number(res.headers.get('retry-after'));
      return { ok: false, retryable: true, kind: 'throttled', retryAfterSeconds: Number.isFinite(after) && after > 0 ? Math.min(after, 3600) : 60, code, message: 'throttled' };
    }
    if (graphCode !== null && (REJECTED_CODES.has(graphCode) || (graphCode >= 132000 && graphCode <= 132015))) return { ok: false, retryable: false, kind: 'rejected', code, message: 'rejected' };
    if (res.status >= 500) return { ok: false, retryable: true, kind: 'transient', code, message: 'provider error' };
    return { ok: false, retryable: false, kind: 'rejected', code, message: 'rejected' };
  }

  /** Meta signs the raw body with the app secret: X-Hub-Signature-256 = "sha256=" + hex HMAC-SHA256. Constant-time. */
  verifyCallback(rawBody: Buffer, headers: Record<string, string>, credentials: CallbackCredentials): boolean {
    const header = headers['x-hub-signature-256'];
    if (typeof header !== 'string') return false;
    const m = /^sha256=([0-9a-f]{64})$/.exec(header);
    if (!m || !credentials.signingSecret) return false;
    const expected = createHmac('sha256', credentials.signingSecret).update(rawBody).digest();
    const given = Buffer.from(m[1]!, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  /**
   * The webhook subscription handshake (GET): echoes `hub.challenge` when the mode is `subscribe` and the verify
   * token matches ours (constant-time). Only a plain token-shaped challenge is echoed (no reflected markup).
   */
  static verifySubscription(query: Record<string, string | undefined>, verifyToken: string): string | null {
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    if (query['hub.mode'] !== 'subscribe' || !verifyToken || !token || !challenge) return null;
    if (!/^[A-Za-z0-9_.-]{1,256}$/.test(challenge)) return null;
    return safeEqual(token, verifyToken) ? challenge : null;
  }

  /** Normalizes a VERIFIED webhook (status updates only). Provider message id only — the tenant comes from provider_message_routes. */
  parseCallback(body: unknown): NormalizedEvent[] {
    const b = body as { object?: unknown; entry?: unknown } | null;
    if (!b || typeof b !== 'object' || b.object !== 'whatsapp_business_account' || !Array.isArray(b.entry)) return [];
    const events: NormalizedEvent[] = [];
    for (const entry of b.entry as { changes?: unknown }[]) {
      if (!entry || !Array.isArray(entry.changes)) continue;
      for (const change of entry.changes as { field?: unknown; value?: { statuses?: unknown } }[]) {
        if (!change || change.field !== 'messages' || !Array.isArray(change.value?.statuses)) continue; // inbound `messages` ignored
        for (const s of change.value.statuses as Record<string, any>[]) {
          if (!s || typeof s.id !== 'string' || !s.id || s.id.length > 256 || typeof s.status !== 'string') continue;
          const occurredAt = new Date(Number(s.timestamp) * 1000);
          if (s.timestamp === undefined || s.timestamp === null || s.timestamp === '' || Number.isNaN(occurredAt.getTime())) continue;
          const base = { providerMessageId: s.id, occurredAt, props: { eventId: `${s.id}:${s.status.slice(0, 20)}`, provider: this.provider } as Record<string, unknown> };
          const errCode = Array.isArray(s.errors) ? Number(s.errors[0]?.code) : NaN;
          switch (s.status) {
            case 'delivered':
              events.push({ ...base, type: 'message.delivered' });
              break;
            case 'read':
              events.push({ ...base, type: 'message.opened' }); // WhatsApp read receipt
              break;
            case 'failed':
              events.push({ ...base, type: 'message.bounced', props: { ...base.props, bounce: 'hard', reason: Number.isInteger(errCode) && errCode > 0 ? `WHATSAPP_${errCode}` : 'WHATSAPP_FAILED' } });
              break;
            default:
              break; // sent, …: not engagement
          }
        }
      }
    }
    return events;
  }
}
