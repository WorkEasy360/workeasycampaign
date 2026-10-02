/**
 * Campaign status values (contract). The transition rules are server-side policy:
 * apps/api/src/modules/campaigns/domain/campaign-state.ts. The API returns `allowedActions` per campaign.
 */
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
