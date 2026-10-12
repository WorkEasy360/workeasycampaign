import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, mockApi, renderAudience } from '@/test/audience';
import { CAMPAIGN_VIEWER } from '@/test/campaigns';
import { CampaignResults } from './campaign-results';

const notTracked = { available: false, reason: 'tracking_not_enabled' };
const analytics = (pipeline: Record<string, unknown>) => ({
  period: { from: '2026-09-08T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z' },
  deliveryMode: 'test',
  pipeline,
  engagement: Object.fromEntries(['delivered', 'bounceRate', 'uniqueOpens', 'openRate', 'uniqueClicks', 'clickRate', 'ctor', 'unsubscribeRate', 'complaintRate'].map((m) => [m, notTracked])),
  perCampaign: [],
});

describe('campaign results (analytics v1)', () => {
  it('shows measured numbers, the top skip reasons and test mode; engagement is "not tracked yet", never a number', async () => {
    mockApi({ 'GET /campaigns/analytics': () => json(200, analytics({ runs: 2, planned: 4, skipped: 2, sent: 4, failed: 0, skippedByReason: { CONSENT_MISSING: 2 }, reachRate: 4 / 6 })) });
    renderAudience(<CampaignResults />, [...CAMPAIGN_VIEWER, 'reports.read']);
    expect(await screen.findByText('Sends completed')).toBeInTheDocument();
    expect(screen.getByText('67%')).toBeInTheDocument();
    expect(screen.getByText(/Most common reasons for skipping/)).toBeInTheDocument();
    expect(screen.getByText(/did not leave the system/)).toBeInTheDocument();
    expect(screen.getByText(/Opens, clicks, bounces and unsubscribes are not tracked yet/)).toBeInTheDocument();
    expect(screen.queryByText(/open rate/i)).toBeNull();
  });

  it('an empty period says so (no zeros dressed up as results)', async () => {
    mockApi({ 'GET /campaigns/analytics': () => json(200, analytics({ runs: 0, planned: 0, skipped: 0, sent: 0, failed: 0, skippedByReason: {}, reachRate: null })) });
    renderAudience(<CampaignResults />, [...CAMPAIGN_VIEWER, 'reports.read']);
    expect(await screen.findByText('No campaign finished sending in the last 30 days.')).toBeInTheDocument();
  });

  it('is hidden without reports.read (and does not call the API)', async () => {
    const calls = mockApi({});
    renderAudience(<CampaignResults />, CAMPAIGN_VIEWER.filter((p) => p !== 'reports.read'));
    expect(screen.queryByText('Campaign results')).toBeNull();
    expect(calls.some((c) => c.url.includes('/analytics'))).toBe(false);
  });
});

describe('campaign results with delivery feedback (Phase 7.10)', () => {
  const v = (value: number | null) => ({ available: true, value });
  const engagement = {
    delivered: v(90), deliveryRate: v(0.9), bounced: v(3), bounceRate: v(0.03), deferred: v(0),
    uniqueOpens: v(45), openRate: v(0.5), uniqueClicks: v(0), clickRate: v(0), ctor: v(0),
    unsubscribed: v(1), unsubscribeRate: v(1 / 90), complained: { available: false, reason: 'provider_unsupported' }, complaintRate: { available: false, reason: 'not_applicable' },
  };

  it('shows measured values (a real 0 is 0 %), reasons for the rest, and the basis of opens', async () => {
    mockApi({
      'GET /campaigns/analytics': () =>
        json(200, { ...analytics({ runs: 1, planned: 100, skipped: 0, sent: 100, failed: 0, skippedByReason: {}, reachRate: 1 }), deliveryMode: 'test', engagement, engagementBasis: { source: 'provider_webhooks', provider: 'mailgun', opensIncludeAutomated: true } }),
    });
    renderAudience(<CampaignResults />, [...CAMPAIGN_VIEWER, 'reports.read']);
    const delivered = await screen.findByText('Delivered');
    expect(delivered.nextElementSibling).toHaveTextContent('90');
    expect(screen.getByText('Open rate').nextElementSibling).toHaveTextContent('50%');
    expect(screen.getByText('Click rate').nextElementSibling).toHaveTextContent('0.0%');
    expect(screen.getByText('Complaints').nextElementSibling).toHaveTextContent('Not supported');
    expect(screen.getByText('Complaint rate').nextElementSibling).toHaveTextContent('Not applicable');
    expect(screen.getByText(/include automated opens/)).toBeInTheDocument();
    expect(screen.queryByText(/are not tracked yet/)).toBeNull();
  });
});
