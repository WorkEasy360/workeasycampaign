import { MESSAGE_EVENT_TYPES, messageEventSchema } from '@workeasy/shared';
import { describe, expect, it } from 'vitest';
import { DisabledMessageEventIngest, UNTRACKED_LINKS } from '../application/tracking.js';
import { MessageMetricsAccumulator } from './message-metrics.js';

const ids = { orgId: '11111111-1111-4111-8111-111111111111', workspaceId: '22222222-2222-4222-8222-222222222222', campaignId: '33333333-3333-4333-8333-333333333333', executionId: '44444444-4444-4444-8444-444444444444' };
const R = (n: number) => `55555555-5555-4555-8555-${String(n).padStart(12, '0')}`;
let seq = 0;
const ev = (type: string, recipient: number, extra: Record<string, unknown> = {}, eventId = `evt-${++seq}-${type}`) => ({
  schema: 'message.event.v1',
  eventId,
  occurredAt: '2026-10-08T10:00:00.000Z',
  ...ids,
  recipientId: R(recipient),
  channel: 'email',
  type,
  ...extra,
});

describe('message events v1 contract (tracking architecture)', () => {
  it('covers every planned fact type', () => {
    expect([...MESSAGE_EVENT_TYPES]).toEqual(['sent', 'delivery_accepted', 'delivery_failed', 'bounced', 'complained', 'opened', 'clicked', 'unsubscribed']);
  });

  it.each([
    ['an email address', { email: 'ann@example.test' }],
    ['a subject', { subject: 'Hello' }],
    ['a URL on a click', { url: 'https://e.com/?u=ann' }],
    ['a user agent', { userAgent: 'Mozilla' }],
    ['an IP', { ip: '10.0.0.1' }],
  ])('is PII-free by construction: %s is rejected', (_n, extra) => {
    expect(messageEventSchema.safeParse(ev('opened', 1, { classification: 'human', ...extra })).success).toBe(false);
  });

  it('requires the fields of each type and a well-formed event id', () => {
    expect(messageEventSchema.safeParse(ev('bounced', 1, { bounce: 'hard', reason: 'MAILBOX_UNKNOWN' })).success).toBe(true);
    expect(messageEventSchema.safeParse(ev('bounced', 1, { reason: 'MAILBOX_UNKNOWN' })).success).toBe(false);
    expect(messageEventSchema.safeParse(ev('clicked', 1, { classification: 'human' })).success).toBe(false);
    expect(messageEventSchema.safeParse(ev('sent', 1, {}, 'bad id with spaces')).success).toBe(false);
  });
});

describe('reference metric semantics', () => {
  function campaign() {
    seq = 0;
    return [
      ...[1, 2, 3, 4].map((n) => ev('sent', n)),
      ...[1, 2, 3].map((n) => ev('delivery_accepted', n)),
      ev('bounced', 4, { bounce: 'hard', reason: 'MAILBOX_UNKNOWN' }),
      ev('opened', 1, { classification: 'human' }),
      ev('opened', 1, { classification: 'human' }),
      ev('opened', 2, { classification: 'machine' }),
      ev('clicked', 3, { classification: 'human', linkIndex: 0 }),
      ev('unsubscribed', 1),
    ];
  }

  it('computes the documented definitions (machine opens never human; a click implies an open; hard bounce = undelivered)', () => {
    const acc = new MessageMetricsAccumulator();
    acc.apply(campaign());
    expect(acc.metrics()).toEqual({
      sent: 4,
      delivered: 3,
      bounced: 1,
      failed: 0,
      complained: 0,
      unsubscribed: 1,
      uniqueHumanOpens: 2, // recipient 1 (pixel), recipient 3 (inferred from the click)
      uniqueHumanClicks: 1,
      totalOpens: 3,
      machineOpens: 1,
      totalClicks: 1,
      bounceRate: 1 / 4,
      openRate: 2 / 3,
      clickRate: 1 / 3,
      ctor: 1 / 2,
      unsubscribeRate: 1 / 3,
      complaintRate: 0,
    });
  });

  it('is idempotent: redelivered events (same eventId) change nothing', () => {
    const events = campaign();
    const acc = new MessageMetricsAccumulator();
    expect(acc.apply(events)).toBe(events.length);
    const once = acc.metrics();
    expect(acc.apply(events)).toBe(0);
    expect(acc.metrics()).toEqual(once);
  });

  it('is order-independent', () => {
    const events = campaign();
    const a = new MessageMetricsAccumulator();
    a.apply(events);
    const b = new MessageMetricsAccumulator();
    b.apply([...events].reverse());
    expect(b.metrics()).toEqual(a.metrics());
  });

  it('a soft bounce followed by acceptance is delivered; rates with no denominator are null, never 0', () => {
    const acc = new MessageMetricsAccumulator();
    expect(acc.metrics()).toMatchObject({ bounceRate: null, openRate: null, ctor: null });
    acc.apply([ev('sent', 9), ev('bounced', 9, { bounce: 'soft', reason: 'MAILBOX_FULL' }), ev('delivery_accepted', 9)]);
    expect(acc.metrics()).toMatchObject({ sent: 1, delivered: 1, bounced: 0, openRate: 0, ctor: null });
  });

  it('invalid events are refused, not counted', () => {
    const acc = new MessageMetricsAccumulator();
    expect(() => acc.apply([{ ...ev('sent', 1), email: 'x@y.z' }])).toThrow();
    expect(acc.metrics().sent).toBe(0);
  });
});

describe('tracking ports in this phase', () => {
  it('the only ingest binding is disabled: nothing can be recorded', async () => {
    const ingest = new DisabledMessageEventIngest();
    expect(ingest.enabled).toBe(false);
    expect(await ingest.ingest()).toEqual({ accepted: 0, disabled: true, reason: 'tracking_not_enabled' });
  });

  it('links are emitted exactly as written (no tracking redirect exists)', () => {
    expect(UNTRACKED_LINKS.wrap('https://e.com/a?b=1', { recipientId: R(1), linkIndex: 0 })).toBe('https://e.com/a?b=1');
  });
});
