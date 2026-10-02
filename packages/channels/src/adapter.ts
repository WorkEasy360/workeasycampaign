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
}

export type ProviderResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; retryable: boolean; code: string; message: string };

export interface NormalizedEvent {
  type: EventType;
  providerMessageId: string;
  occurredAt: Date;
  props: Record<string, unknown>;
}

export interface ChannelAdapter {
  readonly channel: Channel;
  readonly capabilities: ChannelCapabilities;
  validateAddress(address: string): AddressValidation;
  send(payload: RenderedPayload, ctx: SendContext): Promise<ProviderResult>;
  parseCallback(body: unknown, headers: Record<string, string>): NormalizedEvent[];
}
