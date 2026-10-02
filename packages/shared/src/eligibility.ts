/** Ordered checks applied by the Eligibility Engine (spec M8). The first failing check is the recorded reason. */
export const ELIGIBILITY_REASONS = [
  'NOT_MARKETING',
  'UNSUBSCRIBED',
  'NO_ADDRESS',
  'INVALID_ADDRESS',
  'SUPPRESSED',
  'NO_CHANNEL_CONSENT',
  'NO_TOPIC_SUBSCRIPTION',
  'FREQUENCY_CAP',
  'QUIET_HOURS',
  'DUPLICATE',
  'UNENGAGED',
] as const;
export type IneligibilityReason = (typeof ELIGIBILITY_REASONS)[number];

export type EligibilityDecision =
  | { eligible: true; deferUntil?: Date }
  | { eligible: false; reason: IneligibilityReason; detail?: string };
