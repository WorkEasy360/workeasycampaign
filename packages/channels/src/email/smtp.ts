import nodemailer, { type Transporter } from 'nodemailer';
import type { AddressValidation, ChannelAdapter, ProviderResult, RenderedPayload, SendContext } from '../adapter.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export interface SmtpOptions {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  secure?: boolean;
  /** Per-stage timeouts (ms). Default 10 s to connect/greet, 30 s per socket inactivity. */
  connectionTimeoutMs?: number;
  socketTimeoutMs?: number;
}

/**
 * SMTP email adapter (Phase 7.7 taxonomy, docs/architecture/delivery-providers.md). Used with Mailpit locally and any
 * SMTP relay. The Message-ID is deterministic per delivery (`<idempotency key@sender domain>`), so receivers and the
 * routing table see one id per recipient however often a hand-off is retried. Classification:
 *  - reply 421 / 452 → throttled; 450 / 451 → transient; other 4xx → transient;
 *  - 535 / EAUTH → configuration; other 5xx → rejected;
 *  - DNS or connection failures before the envelope → transient;
 *  - a timeout or socket error after DATA started → unknown (the relay may have accepted it; never retried).
 */
export class SmtpEmailAdapter implements ChannelAdapter {
  readonly channel = 'email' as const;
  readonly capabilities = { html: true, tracking: { opens: true, clicks: true }, templatesRequireApproval: false };
  private readonly transport: Transporter;

  constructor(options: SmtpOptions) {
    this.transport = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure ?? false,
      auth: options.user ? { user: options.user, pass: options.pass } : undefined,
      connectionTimeout: options.connectionTimeoutMs ?? 10_000,
      greetingTimeout: options.connectionTimeoutMs ?? 10_000,
      socketTimeout: options.socketTimeoutMs ?? 30_000,
    });
  }

  validateAddress(address: string): AddressValidation {
    const normalized = address.trim().toLowerCase();
    return EMAIL_RE.test(normalized) ? { valid: true, normalized } : { valid: false, reason: 'syntax' };
  }

  async send(payload: RenderedPayload, ctx: SendContext): Promise<ProviderResult> {
    const domain = /@([^>\s]+)>?\s*$/.exec(payload.from)?.[1] ?? 'workeasy.invalid';
    const messageId = `<${ctx.idempotencyKey}@${domain}>`;
    try {
      await this.transport.sendMail({
        messageId,
        from: payload.from,
        to: payload.to,
        replyTo: payload.replyTo,
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
        headers: { ...payload.headers, 'X-Workeasy-Delivery': ctx.deliveryId },
      });
      return { ok: true, providerMessageId: messageId };
    } catch (err) {
      return classifySmtpError(err as SmtpError);
    }
  }

  verifyCallback(): boolean {
    // SMTP has no HTTP callbacks to accept; reject anything that claims to be one.
    return false;
  }

  parseCallback(): [] {
    // SMTP has no delivery callbacks; bounces arrive via the bounce mailbox processor.
    return [];
  }
}

export interface SmtpError {
  responseCode?: number;
  code?: string;
  command?: string;
  message?: string;
}

/** Maps an SMTP/nodemailer error to the outcome taxonomy (exported for tests). */
export function classifySmtpError(e: SmtpError): Extract<ProviderResult, { ok: false }> {
  const message = e.message ?? 'smtp error';
  const reply = e.responseCode;
  if (reply !== undefined) {
    const code = `SMTP_${reply}`;
    if (reply === 421 || reply === 452) return { ok: false, retryable: true, kind: 'throttled', retryAfterSeconds: 60, code, message };
    if (reply >= 400 && reply < 500) return { ok: false, retryable: true, kind: 'transient', code, message };
    if (reply === 535 || reply === 530) return { ok: false, retryable: false, kind: 'configuration', code, message };
    return { ok: false, retryable: false, kind: 'rejected', code, message };
  }
  const errCode = (e.code ?? 'UNKNOWN').toUpperCase();
  if (errCode === 'EAUTH') return { ok: false, retryable: false, kind: 'configuration', code: 'SMTP_AUTH', message };
  // After the message body started, the relay may have accepted it: unknown, never retried.
  const duringData = (e.command ?? '').toUpperCase().startsWith('DATA');
  if (duringData && ['ETIMEDOUT', 'ESOCKET', 'ECONNRESET'].includes(errCode)) return { ok: false, retryable: false, kind: 'unknown', code: `SMTP_${errCode}_AFTER_DATA`, message };
  return { ok: false, retryable: true, kind: 'transient', code: `SMTP_${errCode}`, message };
}
