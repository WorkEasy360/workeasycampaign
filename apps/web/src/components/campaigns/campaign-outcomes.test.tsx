import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, mockApi, renderAudience } from '@/test/audience';
import { CAMPAIGN_VIEWER, campaignView } from '@/test/campaigns';
import { CampaignOutcomes } from './campaign-outcomes';

const notTracked = { available: false, reason: 'tracking_not_enabled' };
const keys = ['delivered', 'deliveryRate', 'bounced', 'bounceRate', 'deferred', 'uniqueOpens', 'openRate', 'uniqueClicks', 'clickRate', 'ctor', 'unsubscribed', 'unsubscribeRate', 'complained', 'complaintRate'];
const pipeline = (sent: number) => ({ runs: 1, planned: sent, skipped: 1, sent, failed: 0, skippedByReason: {}, reachRate: sent / (sent + 1) });
const results = (engagement: Record<string, unknown>, runs: number) => ({
  campaignId: campaignView().id,
  deliveryMode: 'test',
  pipeline: pipeline(10),
  engagement,
  engagementBasis: null,
  lastEventAt: null,
  runs: Array.from({ length: runs }, (_, i) => ({ executionId: `0000000${i}-0000-4000-8000-000000000000`, status: 'completed', startedAt: null, completedAt: new Date().toISOString(), pipeline: pipeline(5), engagement })),
});

describe('campaign outcomes card (Phase 7.10)', () => {
  it('without tracking: pipeline numbers and a plain statement, no zeros', async () => {
    mockApi({ [`GET /campaigns/${campaignView().id}/results`]: () => json(200, results(Object.fromEntries(keys.map((k) => [k, notTracked])), 1)) });
    renderAudience(<CampaignOutcomes campaign={campaignView({ status: 'completed' })} />, [...CAMPAIGN_VIEWER, 'reports.read']);
    expect(await screen.findByText('Sent')).toBeInTheDocument();
    expect(screen.getByText(/not tracked in this workspace/)).toBeInTheDocument();
    expect(screen.queryByText('Open rate')).toBeNull();
  });

  it('several runs are listed with their own rates, reasons included', async () => {
    const e = Object.fromEntries(keys.map((k) => [k, k === 'openRate' ? { available: false, reason: 'not_applicable' } : { available: true, value: k.endsWith('Rate') || k === 'ctor' ? 0.25 : 4 }]));
    mockApi({ [`GET /campaigns/${campaignView().id}/results`]: () => json(200, results(e, 2)) });
    renderAudience(<CampaignOutcomes campaign={campaignView({ status: 'completed' })} />, [...CAMPAIGN_VIEWER, 'reports.read']);
    const table = await screen.findByRole('table', { name: 'Latest runs' });
    expect(table.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(table).toHaveTextContent('Not applicable');
    expect(table).toHaveTextContent('25%');
  });

  it('drafts and users without reports.read get nothing (and no request)', async () => {
    const calls = mockApi({});
    renderAudience(<CampaignOutcomes campaign={campaignView({ status: 'completed' })} />, CAMPAIGN_VIEWER.filter((p) => p !== 'reports.read'));
    renderAudience(<CampaignOutcomes campaign={campaignView({ status: 'draft' })} />, [...CAMPAIGN_VIEWER, 'reports.read']);
    expect(screen.queryByText('Results')).toBeNull();
    expect(calls.some((c) => c.url.includes('/results'))).toBe(false);
  });
});
