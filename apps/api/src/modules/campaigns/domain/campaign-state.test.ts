import { CAMPAIGN_STATUSES } from '@workeasy/shared';
import { describe, expect, it } from 'vitest';
import { CAMPAIGN_TRANSITIONS, canTransition } from './campaign-state.js';

describe('campaign state machine', () => {
  it('allows pausing a sending campaign but not completing a draft', () => {
    expect(canTransition('sending', 'paused')).toBe(true);
    expect(canTransition('draft', 'completed')).toBe(false);
  });

  it('treats stopped and completed as terminal', () => {
    expect(canTransition('completed', 'sending')).toBe(false);
    expect(canTransition('stopped', 'sending')).toBe(false);
  });

  it('defines transitions for every status in the shared contract', () => {
    expect(Object.keys(CAMPAIGN_TRANSITIONS).sort()).toEqual([...CAMPAIGN_STATUSES].sort());
  });
});
