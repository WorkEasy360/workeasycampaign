import type { MessageEvent } from '@workeasy/shared';

/**
 * Tracking ports (docs/architecture/analytics-tracking.md §3). Provider feedback is ingested by DeliveryWebhooksService
 * (Phase 7.9, §6); this port remains the contract for FIRST-PARTY tracking, which is not built: there is no producer
 * (no provider callbacks, no pixel or redirect endpoint) and no real implementation. The only binding is
 * `DisabledMessageEventIngest`, which accepts nothing — so nothing can be recorded, and analytics keep reporting
 * engagement as `tracking_not_enabled`.
 *
 * The real implementations arrive with delivery (Phase 8, DeliveryEventIngest via ChannelAdapter.verifyCallback) and
 * tracking (Phase 9, TrackingEventIngest via signed tokens). Both must: resolve the tenant from the routing table, never
 * the payload; validate `messageEventSchema`; deduplicate on `eventId`; and follow MessageMetricsAccumulator semantics.
 */
export const MESSAGE_EVENT_INGEST = Symbol('MESSAGE_EVENT_INGEST');

export type IngestOutcome = { accepted: number; duplicates: number } | { accepted: 0; disabled: true; reason: 'tracking_not_enabled' };

export interface MessageEventIngest {
  readonly enabled: boolean;
  ingest(events: readonly MessageEvent[]): Promise<IngestOutcome>;
}

/** Maps a safe href to its tracked redirect (Phase 9). The renderer stays pure: a policy is passed in, never imported. */
export interface LinkPolicy {
  wrap(href: string, ctx: { recipientId: string; linkIndex: number }): string;
}

/** The only policy today: links are emitted exactly as written. */
export const UNTRACKED_LINKS: LinkPolicy = { wrap: (href) => href };

export class DisabledMessageEventIngest implements MessageEventIngest {
  readonly enabled = false;
  async ingest(): Promise<IngestOutcome> {
    return { accepted: 0, disabled: true, reason: 'tracking_not_enabled' };
  }
}
