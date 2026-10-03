import type { Channel } from './channels.js';

/**
 * Stable, machine-readable reasons a contact cannot receive a message (docs/eligibility.md).
 * `evaluated` lists the reasons the Phase 5 engine checks; the rest are reserved for later phases so their codes are
 * fixed now and never renamed.
 */
export const ELIGIBILITY_REASONS = [
  // Evaluated in Phase 5
  'CONTACT_DELETED',
  'NOT_MARKETING',
  'UNSUBSCRIBED',
  'NO_ADDRESS',
  'SUPPRESSED',
  'CONSENT_MISSING',
  'CONSENT_PENDING',
  'CONSENT_WITHDRAWN',
  'TOPIC_NOT_SUBSCRIBED',
  'TOPIC_INACTIVE',
  // Reserved for later phases
  'FREQUENCY_CAP',
  'QUIET_HOURS',
  'DUPLICATE',
  'UNENGAGED',
  'CHANNEL_UNAVAILABLE',
  'EXCLUDED_BY_CAMPAIGN',
] as const;
export type IneligibilityReason = (typeof ELIGIBILITY_REASONS)[number];

export const EVALUATED_ELIGIBILITY_REASONS: readonly IneligibilityReason[] = ELIGIBILITY_REASONS.slice(0, 10);

export type MessagePurpose = 'marketing' | 'transactional';

export interface EligibilityReasonDetail {
  code: IneligibilityReason;
  /** Human-readable explanation, safe to show to users. */
  message: string;
}

export interface EligibilityResult {
  contactId: string;
  channel: Channel;
  purpose: MessagePurpose;
  topicId: string | null;
  eligible: boolean;
  /** All failing checks, most fundamental first. Empty when eligible. */
  reasons: EligibilityReasonDetail[];
}
