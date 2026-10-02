/** Campaign state machine (spec M10). */
export const CAMPAIGN_STATUSES = [
  'draft',
  'configured',
  'content_ready',
  'validated',
  'pending_approval',
  'scheduled',
  'queued',
  'sending',
  'awaiting_winner',
  'paused',
  'paused_by_system',
  'stopped',
  'completed',
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const CAMPAIGN_TRANSITIONS: Record<CampaignStatus, readonly CampaignStatus[]> = {
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
