import type { CampaignStatus } from '@workeasy/shared';

/**
 * Campaign state machine (spec M10) — server-side policy. The browser receives `allowedActions` from the API and
 * never computes transitions itself. Provenance: statuses are OUR_IMPROVEMENT over Zoho's documented set
 * (drafts, scheduled, inprogress, sent, stopped, canceled, tobereviewed, reviewed, paused, intesting).
 */
export const CAMPAIGN_TRANSITIONS: Readonly<Record<CampaignStatus, readonly CampaignStatus[]>> = {
  draft: ['configured'],
  configured: ['draft', 'content_ready'],
  content_ready: ['draft', 'configured', 'validated'],
  validated: ['draft', 'content_ready', 'pending_approval', 'scheduled', 'queued'],
  pending_approval: ['draft', 'validated'],
  scheduled: ['draft', 'queued'],
  queued: ['sending', 'stopped'],
  sending: ['paused', 'paused_by_system', 'awaiting_winner', 'stopped', 'completed'],
  awaiting_winner: ['sending', 'stopped'],
  paused: ['sending', 'stopped'],
  paused_by_system: ['sending', 'stopped'],
  stopped: [],
  completed: [],
};

export function canTransition(from: CampaignStatus, to: CampaignStatus): boolean {
  return CAMPAIGN_TRANSITIONS[from].includes(to);
}
