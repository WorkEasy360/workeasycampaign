import type { Channel, EligibilityReasonDetail, IneligibilityReason, MessagePurpose, TopicPolicy } from '@workeasy/shared';

/**
 * The ONE eligibility rule set (docs/eligibility.md). Campaigns, journeys and every later sender ask this; nobody
 * re-implements "subscribed and not suppressed and …" locally.
 *
 * Pure function over facts assembled by EligibilityEvaluator (moved unchanged from apps/api, milestone 6.2). Evaluates every check (not short-circuit) so the UI can
 * explain all blockers; reasons are ordered from most fundamental to most specific.
 */
export interface EligibilityFacts {
  contact: { id: string; deleted: boolean; erased: boolean; subscriptionType: string };
  /** Normalized addresses usable for the channel (email → email identities; sms → phone; whatsapp → whatsapp). */
  addresses: string[];
  /** Active suppressions that apply to this contact or any of its addresses, for this channel or "all". */
  suppressions: { channel: string; reason: string }[];
  /**
   * Effective channel consent (pending past its expiry is 'expired'), and whether it was recorded for the contact's
   * current primary address of this channel (false when the address changed since; true when there is no address).
   */
  consent: { state: 'none' | 'pending' | 'expired' | 'granted' | 'withdrawn'; forCurrentAddress: boolean };
  /** Present when the request names a topic. */
  topic?: { status: 'active' | 'archived' | 'missing'; preference: 'subscribed' | 'unsubscribed' | 'none' };
}

export interface EligibilityRequest {
  channel: Channel;
  purpose: MessagePurpose;
  topicId: string | null;
  /** Eligibility v1.1. Omitted ⇒ 'require_subscription' ⇒ byte-for-byte v1. */
  topicPolicy?: TopicPolicy;
}

const MESSAGES: Record<IneligibilityReason, string> = {
  CONTACT_DELETED: 'The contact is deleted',
  NOT_MARKETING: 'The contact is non-marketing',
  UNSUBSCRIBED: 'The contact is unsubscribed',
  NO_ADDRESS: 'The contact has no address for this channel',
  SUPPRESSED: 'The contact or address is on the do-not-contact list',
  CONSENT_MISSING: 'No consent recorded for this channel',
  CONSENT_PENDING: 'Consent is waiting for confirmation (double opt-in)',
  CONSENT_EXPIRED: 'The consent request expired without confirmation',
  CONSENT_WITHDRAWN: 'Consent for this channel was withdrawn',
  CONSENT_ADDRESS_CHANGED: 'Consent was given for a different address than the current one',
  TOPIC_NOT_SUBSCRIBED: 'The contact is not subscribed to this topic',
  TOPIC_INACTIVE: 'The topic is archived or does not exist',
  TOPIC_UNSUBSCRIBED: 'The contact unsubscribed from this topic',
  FREQUENCY_CAP: 'Frequency cap reached',
  QUIET_HOURS: 'Inside quiet hours',
  DUPLICATE: 'Duplicate recipient',
  UNENGAGED: 'Contact is unengaged',
  CHANNEL_UNAVAILABLE: 'Channel unavailable',
  EXCLUDED_BY_CAMPAIGN: 'Excluded by the campaign',
};

export const ADDRESS_KIND_FOR_CHANNEL: Record<Channel, 'email' | 'phone' | 'whatsapp'> = {
  email: 'email',
  sms: 'phone',
  whatsapp: 'whatsapp',
};

export function evaluateEligibility(f: EligibilityFacts, req: EligibilityRequest): { eligible: boolean; reasons: EligibilityReasonDetail[] } {
  const reasons: IneligibilityReason[] = [];
  const marketing = req.purpose === 'marketing';

  if (f.contact.deleted || f.contact.erased) reasons.push('CONTACT_DELETED');
  // Administrative status [ZOHO_PARITY]: only marketing contacts receive marketing; transactional is exempt.
  if (marketing && f.contact.subscriptionType === 'non_marketing') reasons.push('NOT_MARKETING');
  if (marketing && f.contact.subscriptionType === 'unsubscribed') reasons.push('UNSUBSCRIBED');
  if (f.addresses.length === 0) reasons.push('NO_ADDRESS');
  // Suppression applies to every purpose, transactional included (spec M7) [ZOHO_PARITY + OUR_IMPROVEMENT].
  if (f.suppressions.some((s) => s.channel === 'all' || s.channel === req.channel)) reasons.push('SUPPRESSED');
  // Channel consent is required for marketing on every channel [OUR_ORIGINAL_DESIGN — see docs/eligibility.md].
  if (marketing) {
    if (f.consent.state === 'none') reasons.push('CONSENT_MISSING');
    if (f.consent.state === 'pending') reasons.push('CONSENT_PENDING');
    if (f.consent.state === 'expired') reasons.push('CONSENT_EXPIRED');
    if (f.consent.state === 'withdrawn') reasons.push('CONSENT_WITHDRAWN');
    // Consent is bound to the address it was given for [OUR_ORIGINAL_DESIGN]; a withdrawal blocks every address.
    if (f.consent.state === 'granted' && !f.consent.forCurrentAddress) reasons.push('CONSENT_ADDRESS_CHANGED');
  }
  // Topic gate. v1 / 'require_subscription' [ZOHO_PARITY]: only subscribers of the topic. v1.1 'block_unsubscribed'
  // [OUR PRODUCT DECISION, docs/eligibility.md §v1.1]: only an explicit unsubscribe blocks; UNSET ('none') passes this
  // gate only — it is never consent, and every gate above still applies.
  if (req.topicId && f.topic) {
    if (f.topic.status !== 'active') reasons.push('TOPIC_INACTIVE');
    else if (marketing && (req.topicPolicy ?? 'require_subscription') === 'block_unsubscribed') {
      if (f.topic.preference === 'unsubscribed') reasons.push('TOPIC_UNSUBSCRIBED');
    } else if (marketing && f.topic.preference !== 'subscribed') reasons.push('TOPIC_NOT_SUBSCRIBED');
  }

  return { eligible: reasons.length === 0, reasons: reasons.map((code) => ({ code, message: MESSAGES[code] })) };
}
