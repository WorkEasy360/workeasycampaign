import type { Channel } from './channels.js';

/**
 * Eligibility contract v1 (docs/eligibility.md, frozen at the end of Phase 5). Stable, machine-readable reasons a
 * contact cannot receive a message. `EVALUATED_ELIGIBILITY_REASONS` are checked today; the rest are reserved for
 * later phases so their codes are fixed now. Codes are never renamed or reused; new codes may be added.
 */
export const ELIGIBILITY_REASONS = [
  // Evaluated since Phase 5
  'CONTACT_DELETED',
  'NOT_MARKETING',
  'UNSUBSCRIBED',
  'NO_ADDRESS',
  'SUPPRESSED',
  'CONSENT_MISSING',
  'CONSENT_PENDING',
  'CONSENT_EXPIRED',
  'CONSENT_WITHDRAWN',
  'CONSENT_ADDRESS_CHANGED',
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

export const EVALUATED_ELIGIBILITY_REASONS: readonly IneligibilityReason[] = ELIGIBILITY_REASONS.slice(0, 12);

export type MessagePurpose = 'marketing' | 'transactional';

export interface EligibilityReasonDetail {
  code: IneligibilityReason;
  /** Human-readable explanation, safe to show to users. Never contains addresses or other personal data. */
  message: string;
}

/** What a caller asks (API body `POST /v1/workspaces/{ws}/eligibility/check`, or `EligibilityService.evaluate`). */
export interface EligibilityRequest {
  /** 1–100 contacts of the current workspace. Ids from elsewhere are reported in `notFound`, never evaluated. */
  contactIds: string[];
  channel: Channel;
  /** Default `marketing`. `transactional` skips subscription, consent and topic checks — never suppression. */
  purpose?: MessagePurpose;
  /** A topic of the current workspace; an unknown topic is a 422 validation error for the whole request. */
  topicId?: string;
}

export interface EligibilityResult {
  contactId: string;
  channel: Channel;
  purpose: MessagePurpose;
  topicId: string | null;
  eligible: boolean;
  /** All failing checks, most fundamental first. Empty when eligible. */
  reasons: EligibilityReasonDetail[];
  /**
   * The contact identity a message on this channel would be sent to (the primary identity of the channel's kind),
   * or null when there is none. An id, never the address: senders load the address themselves at send time.
   */
  addressIdentityId: string | null;
}

export interface EligibilityResponse {
  results: EligibilityResult[];
  /** Requested ids that are not contacts of this workspace (other workspaces' ids look exactly like unknown ids). */
  notFound: string[];
}
