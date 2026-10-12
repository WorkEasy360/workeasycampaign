import { describe, expect, it } from 'vitest';
import { engagementMetrics, type TrackingCapabilities, ZERO_COUNTS } from './engagement.js';

const ALL: TrackingCapabilities = { feedback: true, unsubscribes: true, opens: 'tracked', clicks: 'tracked' };

describe('engagement metrics (Phase 7.10)', () => {
  it('computes counts and rates with the documented denominators', () => {
    const m = engagementMetrics({ sent: 200, delivered: 180, bouncedHard: 10, bouncedSoft: 4, complained: 1, unsubscribed: 9, openedUnique: 90, clickedUnique: 18 }, ALL);
    expect(m.delivered).toEqual({ available: true, value: 180 });
    expect(m.deliveryRate).toEqual({ available: true, value: 0.9 });
    expect(m.bounced).toEqual({ available: true, value: 10 });
    expect(m.bounceRate).toEqual({ available: true, value: 0.05 });
    expect(m.deferred).toEqual({ available: true, value: 4 });
    expect(m.openRate).toEqual({ available: true, value: 0.5 });
    expect(m.clickRate).toEqual({ available: true, value: 0.1 });
    expect(m.ctor).toEqual({ available: true, value: 0.2 });
    expect(m.unsubscribeRate).toEqual({ available: true, value: 0.05 });
    expect(m.complaintRate).toEqual({ available: true, value: 1 / 180 });
  });

  it('a measured zero is zero; a zero denominator is not applicable — never 0 %', () => {
    const m = engagementMetrics({ ...ZERO_COUNTS, sent: 10, delivered: 10 }, ALL);
    expect(m.uniqueOpens).toEqual({ available: true, value: 0 });
    expect(m.openRate).toEqual({ available: true, value: 0 });
    expect(m.ctor).toEqual({ available: false, reason: 'not_applicable' });
    const none = engagementMetrics(ZERO_COUNTS, ALL);
    expect(none.deliveryRate).toEqual({ available: false, reason: 'not_applicable' });
    expect(none.openRate).toEqual({ available: false, reason: 'not_applicable' });
  });

  it('without provider feedback nothing is a number except unsubscribes counted from our own links', () => {
    const m = engagementMetrics({ ...ZERO_COUNTS, sent: 5, unsubscribed: 2 }, { feedback: false, unsubscribes: true, opens: 'tracked', clicks: 'tracked' });
    expect(m.unsubscribed).toEqual({ available: true, value: 2 });
    for (const k of ['delivered', 'deliveryRate', 'bounced', 'bounceRate', 'deferred', 'uniqueOpens', 'openRate', 'uniqueClicks', 'clickRate', 'ctor', 'unsubscribeRate', 'complained', 'complaintRate'] as const) {
      expect(m[k]).toEqual({ available: false, reason: 'tracking_not_enabled' });
    }
    const nothing = engagementMetrics(ZERO_COUNTS, { feedback: false, unsubscribes: false, opens: 'unsupported', clicks: 'unsupported' });
    expect(Object.values(nothing).every((v) => !v.available && v.reason === 'tracking_not_enabled')).toBe(true);
  });

  it('a provider that cannot report opens or clicks makes them unavailable, not zero', () => {
    const m = engagementMetrics({ ...ZERO_COUNTS, sent: 5, delivered: 5 }, { feedback: true, unsubscribes: true, opens: 'unsupported', clicks: 'tracked' });
    expect(m.uniqueOpens).toEqual({ available: false, reason: 'provider_unsupported' });
    expect(m.openRate).toEqual({ available: false, reason: 'provider_unsupported' });
    expect(m.ctor).toEqual({ available: false, reason: 'provider_unsupported' });
    expect(m.uniqueClicks).toEqual({ available: true, value: 0 });
  });

  it('tracking switched off is not tracked (not zero, not unsupported)', () => {
    const m = engagementMetrics({ ...ZERO_COUNTS, sent: 5, delivered: 5 }, { feedback: true, unsubscribes: true, opens: 'not_enabled', clicks: 'tracked' });
    expect(m.uniqueOpens).toEqual({ available: false, reason: 'tracking_not_enabled' });
    expect(m.ctor).toEqual({ available: false, reason: 'tracking_not_enabled' });
    expect(m.clickRate).toEqual({ available: true, value: 0 });
    expect(m.delivered).toEqual({ available: true, value: 5 });
  });
});
