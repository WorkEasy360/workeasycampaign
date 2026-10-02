import nodemailer, { type Transporter } from 'nodemailer';
import type { AddressValidation, ChannelAdapter, ProviderResult, RenderedPayload, SendContext } from '../adapter.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** SMTP email adapter. Used with Mailpit locally; production providers (SES, Postmark…) get their own adapters. */
export class SmtpEmailAdapter implements ChannelAdapter {
  readonly channel = 'email' as const;
  readonly capabilities = { html: true, tracking: { opens: true, clicks: true }, templatesRequireApproval: false };
  private readonly transport: Transporter;

  constructor(options: { host: string; port: number; user?: string; pass?: string; secure?: boolean }) {
    this.transport = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure ?? false,
      auth: options.user ? { user: options.user, pass: options.pass } : undefined,
    });
  }

  validateAddress(address: string): AddressValidation {
    const normalized = address.trim().toLowerCase();
    return EMAIL_RE.test(normalized) ? { valid: true, normalized } : { valid: false, reason: 'syntax' };
  }

  async send(payload: RenderedPayload, ctx: SendContext): Promise<ProviderResult> {
    try {
      const info = await this.transport.sendMail({
        from: payload.from,
        to: payload.to,
        replyTo: payload.replyTo,
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
        headers: { ...payload.headers, 'X-Workeasy-Delivery': ctx.deliveryId },
      });
      return { ok: true, providerMessageId: info.messageId };
    } catch (err) {
      const e = err as { responseCode?: number; code?: string; message: string };
      // 4xx SMTP replies and connection errors are transient; 5xx replies are permanent.
      const retryable = e.responseCode === undefined || e.responseCode < 500;
      return { ok: false, retryable, code: String(e.responseCode ?? e.code ?? 'unknown'), message: e.message };
    }
  }

  parseCallback(): [] {
    // SMTP has no delivery callbacks; bounces arrive via the bounce mailbox processor.
    return [];
  }
}
