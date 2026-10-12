import { type MessageEvent, messageEventSchema } from '@workeasy/shared';

/**
 * Reference semantics of the engagement metrics (docs/architecture/analytics-tracking.md §2.2) over message events v1.
 * Pure. This is the executable definition the future MetricsStore port (Phase 9/11) must reproduce; it is not wired
 * to any producer (nothing emits message events until real delivery and tracking exist).
 *
 * Properties (tested):
 *  - idempotent: an event id seen before is ignored (providers deliver at least once);
 *  - order-independent: metrics depend on the SET of events, not their arrival order;
 *  - per recipient: unique counts are per campaign recipient; machine opens/clicks never count as human;
 *  - a human click implies a human open (the open pixel is often blocked; clicking proves the message was opened);
 *  - only a HARD bounce makes a message undelivered; a soft bounce followed by acceptance is delivered.
 */
type RecipientState = { sent: boolean; accepted: boolean; hardBounced: boolean; softBounced: boolean; failed: boolean; complained: boolean; humanOpen: boolean; humanClick: boolean; unsubscribed: boolean };

export interface MessageMetrics {
  sent: number;
  delivered: number;
  bounced: number;
  failed: number;
  complained: number;
  unsubscribed: number;
  uniqueHumanOpens: number;
  uniqueHumanClicks: number;
  totalOpens: number;
  machineOpens: number;
  totalClicks: number;
  /** Rates: null when the denominator is zero (never an invented 0). */
  bounceRate: number | null;
  openRate: number | null;
  clickRate: number | null;
  ctor: number | null;
  unsubscribeRate: number | null;
  complaintRate: number | null;
}

export class MessageMetricsAccumulator {
  private readonly seen = new Set<string>();
  private readonly recipients = new Map<string, RecipientState>();
  private totalOpens = 0;
  private machineOpens = 0;
  private totalClicks = 0;

  /** Validates (strict contract) and applies events; returns how many were new. Invalid events throw. */
  apply(events: readonly unknown[]): number {
    let added = 0;
    for (const raw of events) {
      const e: MessageEvent = messageEventSchema.parse(raw);
      if (this.seen.has(e.eventId)) continue;
      this.seen.add(e.eventId);
      added++;
      const r = this.state(e.recipientId);
      switch (e.type) {
        case 'sent':
          r.sent = true;
          break;
        case 'delivery_accepted':
          r.accepted = true;
          break;
        case 'delivery_failed':
          if (e.permanent) r.failed = true;
          break;
        case 'bounced':
          if (e.bounce === 'hard') r.hardBounced = true;
          else r.softBounced = true;
          break;
        case 'complained':
          r.complained = true;
          break;
        case 'opened':
          this.totalOpens++;
          if (e.classification === 'human') r.humanOpen = true;
          else this.machineOpens++;
          break;
        case 'clicked':
          this.totalClicks++;
          if (e.classification === 'human') {
            r.humanClick = true;
            r.humanOpen = true;
          }
          break;
        case 'unsubscribed':
          r.unsubscribed = true;
          break;
      }
    }
    return added;
  }

  metrics(): MessageMetrics {
    let sent = 0, delivered = 0, bounced = 0, failed = 0, complained = 0, unsubscribed = 0, opens = 0, clicks = 0;
    for (const r of this.recipients.values()) {
      if (r.sent) sent++;
      if (r.hardBounced) bounced++;
      if (r.failed) failed++;
      if (r.accepted && !r.hardBounced) delivered++;
      if (r.complained) complained++;
      if (r.unsubscribed) unsubscribed++;
      if (r.humanOpen) opens++;
      if (r.humanClick) clicks++;
    }
    const rate = (n: number, d: number) => (d > 0 ? n / d : null);
    return {
      sent,
      delivered,
      bounced,
      failed,
      complained,
      unsubscribed,
      uniqueHumanOpens: opens,
      uniqueHumanClicks: clicks,
      totalOpens: this.totalOpens,
      machineOpens: this.machineOpens,
      totalClicks: this.totalClicks,
      bounceRate: rate(bounced, sent),
      openRate: rate(opens, delivered),
      clickRate: rate(clicks, delivered),
      ctor: rate(clicks, opens),
      unsubscribeRate: rate(unsubscribed, delivered),
      complaintRate: rate(complained, delivered),
    };
  }

  private state(recipientId: string): RecipientState {
    let r = this.recipients.get(recipientId);
    if (!r) {
      r = { sent: false, accepted: false, hardBounced: false, softBounced: false, failed: false, complained: false, humanOpen: false, humanClick: false, unsubscribed: false };
      this.recipients.set(recipientId, r);
    }
    return r;
  }
}
