import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { json, mockApi, renderAudience } from '@/test/audience';
import { CAMPAIGN_MANAGER } from '@/test/campaigns';
import UsagePage from './page';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/settings/usage', useParams: () => ({}) }));

const WS2 = '99999999-9999-4999-8999-999999999999';
const summary = {
  period: { from: '2026-09-09T00:00:00.000Z', to: '2026-10-09T00:00:00.000Z' },
  meters: [
    { meter: 'contacts.active', kind: 'gauge', total: 1500, asOf: '2026-10-09T00:00:00.000Z', byWorkspace: [{ workspaceId: WS2, name: 'Main', value: 1500 }] },
    { meter: 'campaign.executions', kind: 'counter', total: 4, asOf: null, byWorkspace: [{ workspaceId: WS2, name: 'Main', value: 4 }] },
    { meter: 'messages.sent', kind: 'counter', total: 0, asOf: null, byWorkspace: [] },
    { meter: 'templates.active', kind: 'gauge', total: 2, asOf: '2026-10-09T00:00:00.000Z', byWorkspace: [{ workspaceId: WS2, name: 'Main', value: 2 }] },
    { meter: 'storage.bytes', kind: 'gauge', total: 3_250_000, asOf: '2026-10-09T00:00:00.000Z', byWorkspace: [{ workspaceId: WS2, name: 'Main', value: 3_250_000 }] },
    { meter: 'ai.tokens', kind: 'counter', total: 0, asOf: null, byWorkspace: [] },
  ],
};

describe('usage page (Phase 7.13)', () => {
  it('shows each meter with its meaning, bytes humanized, and a per-workspace table — no prices', async () => {
    mockApi({ 'GET /api/v1/organizations/o1/usage': () => json(200, summary) });
    renderAudience(<UsagePage />, [...CAMPAIGN_MANAGER, 'billing.manage']);
    expect(await screen.findByText('Active contacts', { selector: 'dt' })).toBeInTheDocument();
    expect(screen.getByText('1,500', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText('3.1 MB', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText(/test sends are never counted/)).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Usage by workspace' });
    expect(within(table).getByText('Main')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/[$€£]/); // quantities only: no amounts
  });

  it('needs billing.manage (and asks nothing of the API without it)', () => {
    const calls = mockApi({});
    renderAudience(<UsagePage />, CAMPAIGN_MANAGER);
    expect(screen.getByText(/Only people who manage billing/)).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('/usage'))).toBe(false);
  });
});
