import type { Channel, EventType } from '@workeasy/shared';

/**
 * The only channel-specific contract in the platform (architecture §7).
 * Eligibility, scheduling, throttling, tracking and analytics live outside adapters.
 */
export interface ChannelCapabilities {
  html: boolean;
  tracking: { opens: boolean; clicks: boolean };
  templatesRequireApproval: boolean;
  maxBodyLength?: number;
  /** The provider reports delivery outcomes (delivered, bounces, complaints) through signed webhooks (Phase 7.9). */
  feedbackWebhooks?: boolean;
}

export type AddressValidation = { valid: true; normalized: string } | { valid: false; reason: string };

export interface RenderedPayload {
  to: string;
  from: string;
  replyTo?: string;
  subject?: string;
  html?: string;
  text: string;
  headers?: Record<string, string>;
  /** Provider template reference (e.g. an approved WhatsApp template) and its variables. */
  template?: { name: string; language: string; variables: Record<string, string> };
}

export interface SendContext {
  orgId: string;
  deliveryId: string;
  /** Idempotency key passed to providers that support it. */
  idempotencyKey: string;
  /**
   * The verified sending domain the message is sent from (Phase 7, live delivery). Providers that sign per domain
   * (Mailgun: /v3/<domain>/messages, DKIM) send through it; each customer domain is a domain of the provider account.
   */
  senderDomain?: string;
}

/**
 * Why a submission did not succeed (Phase 7.7 outcome taxonomy, docs/architecture/delivery-providers.md). Provider
 * states never leave the adapter; callers act on these only:
 *  - `transient`     — failed before the provider could have accepted it (connection refused, 5xx): safe to retry;
 *  - `throttled`     — the provider asked us to slow down (429, SMTP 421/452): retry after `retryAfterSeconds`;
 *  - `rejected`      — the provider refused this message/recipient for good (400, SMTP 5xx): never retried;
 *  - `configuration` — credentials, domain or account problem (401/403/404): every send would fail; stop and alert;
 *  - `unknown`       — the request may have reached the provider (timeout, connection reset after sending): the
 *                      outcome is unknown and, without provider-side idempotency, it is NEVER retried (no duplicate).
 */
export type ProviderFailureKind = 'transient' | 'throttled' | 'rejected' | 'configuration' | 'unknown';

/** `message` is diagnostic text from the provider: never stored or logged (it may echo an address). Use `code`. */
export type ProviderResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; retryable: boolean; code: string; message: string; kind?: ProviderFailureKind; retryAfterSeconds?: number };

/** The kind of a failure, for results built before the taxonomy (retryable ⇒ transient, else rejected). */
export function failureKind(r: Extract<ProviderResult, { ok: false }>): ProviderFailureKind {
  return r.kind ?? (r.retryable ? 'transient' : 'rejected');
}

export interface NormalizedEvent {
  type: EventType;
  providerMessageId: string;
  occurredAt: Date;
  props: Record<string, unknown>;
}

/** Provider credentials needed to verify an inbound callback (resolved from our config, never from the request). */
export interface CallbackCredentials {
  signingSecret: string;
}

export interface ChannelAdapter {
  readonly channel: Channel;
  readonly capabilities: ChannelCapabilities;
  validateAddress(address: string): AddressValidation;
  send(payload: RenderedPayload, ctx: SendContext): Promise<ProviderResult>;
  /**
   * Verify a provider callback's authenticity over the RAW request body before anything is parsed.
   * Must use a constant-time comparison and reject stale timestamps where the provider signs them.
   * Callbacks that fail verification are dropped and logged; they never reach parseCallback.
   */
  verifyCallback(rawBody: Buffer, headers: Record<string, string>, credentials: CallbackCredentials): boolean;
  /**
   * Normalize a verified callback. The returned events carry the PROVIDER's message id only; the owning tenant is
   * resolved from provider_message_routes (db.system.resolveProviderMessage), never from payload fields.
   */
  parseCallback(body: unknown, headers: Record<string, string>): NormalizedEvent[];
}
