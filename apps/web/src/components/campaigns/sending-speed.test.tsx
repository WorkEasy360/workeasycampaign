import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, mockApi, renderAudience } from '@/test/audience';
import { CAMPAIGN_MANAGER, CAMPAIGN_VIEWER, execution } from '@/test/campaigns';
import { SendingSpeed } from './sending-speed';

describe('sending speed (Phase 7.11)', () => {
  it('sets a limit on a live run, validates the number, and can remove it', async () => {
    const calls = mockApi({ 'PUT /campaigns/c1/executions/e1/sending-rate': (c) => json(200, execution({ maxPerHour: (c.body as { maxPerHour: number | null }).maxPerHour })) });
    const first = renderAudience(<SendingSpeed campaignId="c1" execution={execution()} />, CAMPAIGN_MANAGER);
    expect(screen.getByText('No campaign limit')).toBeInTheDocument();
    const input = screen.getByLabelText('Messages per hour');
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set limit' }));
    expect(await screen.findByText(/Enter a whole number from 1/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    fireEvent.change(input, { target: { value: '5000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set limit' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ maxPerHour: 5000 }));
    first.unmount();
    renderAudience(<SendingSpeed campaignId="c1" execution={execution({ maxPerHour: 5000 })} />, CAMPAIGN_MANAGER);
    expect(screen.getByText('At most 5,000 per hour')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove limit' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT').at(-1)?.body).toEqual({ maxPerHour: null }));
  });

  it('read-only without campaigns.send, and nothing to change once the run has finished', () => {
    mockApi({});
    renderAudience(<SendingSpeed campaignId="c1" execution={execution({ maxPerHour: 100 })} />, CAMPAIGN_VIEWER);
    expect(screen.getByText(/at most 100 per hour/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    renderAudience(<SendingSpeed campaignId="c1" execution={execution({ status: 'completed' })} />, CAMPAIGN_MANAGER);
    expect(screen.queryByLabelText('Messages per hour')).toBeNull();
  });
});
