import type { ProviderResult } from '@workeasy/channels';
import type { Channel } from '@workeasy/shared';

/**
 * Campaign delivery port (contract §9.1, §10.3). The execution hands one recipient at a time to it AFTER Checkpoint B,
 * outside any database transaction, with the recipient id as idempotency key. Phase 6.9 wires only the test
 * implementation (`NullDeliveryPort`, CAMPAIGN_DELIVERY_MODE=test); the Phase 8 implementation renders the version's
 * content and calls a `ChannelAdapter`. Inputs carry ids only — never an address, name or content.
 */
export interface CampaignDeliveryPort {
  /**
   * `test`: no real recipient is reached (the null port, or the provider port against a test double). `live`: real
   * delivery — refused by configuration until the production gates pass (delivery-mode.ts).
   */
  readonly mode: 'test' | 'live';
  /** True when a repeat with the same idempotency key is deduplicated by the receiver (contract §10.3). */
  readonly idempotentSend: boolean;
  deliver(item: DeliveryItem): Promise<ProviderResult>;
  /**
   * Test send (Phase 7.3): an already rendered message to ONE address — the requesting user's own verified email,
   * resolved by the caller from the identity record, never from a request. Not a campaign delivery: no recipient row,
   * no execution, no suppression or consent semantics (the recipient is the sender's own team member).
   */
  sendTest(item: TestSendItem): Promise<ProviderResult>;
}

export interface TestSendItem {
  orgId: string;
  workspaceId: string;
  campaignId: string;
  /** The requesting user (audit and provider metadata). */
  userId: string;
  /** The draft's sender identity: a real provider sends the test from it (it must be on a verified domain). */
  senderIdentityId: string | null;
  to: string;
  subject: string;
  preheader: string;
  html: string;
  text: string;
  /** Unique per test send. */
  idempotencyKey: string;
}

export interface DeliveryItem {
  /** The frozen version's channel (routes the hand-off to that channel's provider). */
  channel: Channel;
  orgId: string;
  workspaceId: string;
  executionId: string;
  recipientId: string;
  /** From Checkpoint B (fresh), never from materialization. */
  addressIdentityId: string;
  /** = recipientId (contract §10.3). */
  idempotencyKey: string;
}

export const CAMPAIGN_DELIVERY_PORT = Symbol('CAMPAIGN_DELIVERY_PORT');
