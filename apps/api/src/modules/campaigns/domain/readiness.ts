import {
  type AudienceSelector,
  type CampaignReadiness,
  FINDING_SECTIONS,
  type FindingSection,
  type ReadinessFinding,
  type ReadinessFindingCode,
} from '@workeasy/shared';
import { channelSpec } from './channels.js';
import { AUDIENCE_LIMITS, type CampaignDraft, selectorKey } from './draft.js';

/**
 * Readiness and pre-flight (contract §3). Pure: everything time-dependent takes `now`; everything that needs data
 * (topic status, audience size, eligibility estimate) arrives as facts loaded by the application layer through the
 * Audience contracts. Readiness is a computed result, never a lifecycle state, and is never stored.
 */

export const SCHEDULE_LIMITS = { pastToleranceMs: 60_000, maxAheadMs: 365 * 86_400_000 } as const;
export const LOW_ELIGIBLE_SHARE = 0.5;
const EMAIL_RE = /^[^\s@"(),:;<>[\]\\]+@[^\s@"(),:;<>[\]\\]+\.[a-z]{2,63}$/i;

export interface ReadinessContext {
  now: Date;
  deliveryAvailable: boolean;
  /**
   * Real recipients would receive it (live delivery; Phase 7.8b). Sender problems are errors then, warnings in test
   * mode (where nothing reaches a real mailbox).
   */
  liveDelivery?: boolean;
  /** The draft's channel is usable in this deployment (provider configured); false → CHANNEL_NOT_AVAILABLE. */
  channelAvailable?: boolean;
}

/** Facts for the expensive checks, loaded by the application layer (Audience Resolution + Eligibility). */
export interface PreflightFacts {
  topic: 'ok' | 'unavailable' | null;
  sources: { role: 'include' | 'exclude'; selector: AudienceSelector; status: 'ok' | 'archived' | 'not_found' }[];
  audience: { size: number; capped: boolean } | null;
  eligibility: { estimate: number; sampleSize: number } | null;
  /** The audience could not be resolved within the interactive budget (degraded mode, contract §3.3). */
  audienceUnavailable?: { retryAfterSeconds: number };
  /**
   * Phase 7 §C (C13): custom fields the v3 message references, with their Audience status — loaded only for v3 content
   * that uses `contact.custom.*` (absent otherwise).
   */
  personalization?: { key: string; status: 'ok' | 'archived' | 'unknown' }[];
  /** Phase 7.8b: the chosen sender identity — missing (unknown or deleted) or on a domain not verified by DNS. */
  sender?: 'ok' | 'unverified' | 'missing';
}

/** Cheap structural checks — included in every campaign view. */
export function readinessFindings(draft: CampaignDraft, ctx: ReadinessContext): ReadinessFinding[] {
  const f: ReadinessFinding[] = [];
  const spec = channelSpec(draft.channel);

  if (!draft.name.trim()) f.push(err('NAME_MISSING', 'details', '/name', 'Give the campaign a name'));
  if (!spec.enabled || ctx.channelAvailable === false) f.push(err('CHANNEL_NOT_AVAILABLE', 'channel', '/channel', 'This channel is not configured for this workspace yet'));
  if (!draft.topicId) f.push(err('TOPIC_MISSING', 'topic', '/topicId', 'Choose a topic'));

  const { include, exclude } = draft.audience;
  if (include.length === 0) f.push(err('AUDIENCE_EMPTY_DEFINITION', 'audience', '/audience/include', 'Choose at least one list or tag'));
  if (include.length > AUDIENCE_LIMITS.include || exclude.length > AUDIENCE_LIMITS.exclude) {
    f.push(err('AUDIENCE_TOO_MANY_SOURCES', 'audience', '/audience', `Use at most ${AUDIENCE_LIMITS.include} included and ${AUDIENCE_LIMITS.exclude} excluded lists or tags`));
  }
  const included = new Set(include.map(selectorKey));
  if (exclude.some((s) => included.has(selectorKey(s)))) {
    f.push(err('AUDIENCE_SOURCE_CONFLICT', 'audience', '/audience/exclude', 'A list or tag cannot be both included and excluded'));
  }

  // Sender identities are email's (SMS / WhatsApp send from the deployment's provider number).
  if (spec.usesSenderIdentity && !draft.sender.senderIdentityId) {
    // Phase 7.8b: an error once real recipients would receive it; a warning in test mode.
    f.push({ code: 'SENDER_NOT_CONFIGURED', severity: ctx.liveDelivery ? 'error' : 'warning', section: 'sender', field: '/sender/senderIdentityId', message: 'Choose a sender address on a verified domain' });
  }
  if (spec.usesSenderIdentity && draft.sender.replyTo !== null && !EMAIL_RE.test(draft.sender.replyTo.trim())) {
    f.push(err('REPLY_TO_INVALID', 'sender', '/sender/replyTo', 'Enter a valid reply-to email address'));
  }

  if (spec.enabled) {
    const message = draft.messages.find((m) => m.variantKey === 'default');
    f.push(...spec.validateContent(message?.content, `/messages/${Math.max(0, draft.messages.indexOf(message!))}/content`));
  }

  f.push(...scheduleFindings(draft.schedule, ctx.now));
  if (!ctx.deliveryAvailable) f.push(err('DELIVERY_NOT_AVAILABLE', 'delivery', undefined, 'Sending is not available yet'));
  return f;
}

/** Full pre-flight: readiness plus checks that need Audience/Eligibility facts. */
export function preflightFindings(draft: CampaignDraft, facts: PreflightFacts, ctx: ReadinessContext): ReadinessFinding[] {
  const f = readinessFindings(draft, ctx);
  if (draft.topicId && facts.topic === 'unavailable') f.push(err('TOPIC_UNAVAILABLE', 'topic', '/topicId', 'The topic was deleted or archived'));
  for (const s of facts.sources) {
    if (s.status === 'not_found') {
      f.push({ ...err('AUDIENCE_SOURCE_NOT_FOUND', 'audience', `/audience/${s.role}`, 'A selected list or tag no longer exists'), details: { selector: selectorKey(s.selector) } });
    } else if (s.status === 'archived' && s.role === 'include') {
      f.push({ code: 'AUDIENCE_SOURCE_ARCHIVED', severity: 'warning', section: 'audience', field: '/audience/include', message: 'An archived list is included; its members are frozen', details: { selector: selectorKey(s.selector) } });
    }
  }
  if (draft.sender.senderIdentityId && facts.sender && facts.sender !== 'ok') {
    f.push({
      code: 'SENDER_NOT_VERIFIED',
      severity: ctx.liveDelivery ? 'error' : 'warning',
      section: 'sender',
      field: '/sender/senderIdentityId',
      message: facts.sender === 'missing' ? 'The chosen sender address no longer exists' : 'The sender address is on a domain that is not verified yet',
    });
  }
  const message = draft.messages.findIndex((m) => m.variantKey === 'default');
  for (const p of facts.personalization ?? []) {
    const field = `/messages/${Math.max(0, message)}/content`;
    if (p.status === 'unknown') {
      f.push({ ...err('PERSONALIZATION_FIELD_UNKNOWN', 'message', field, `The message uses a contact field that does not exist (contact.custom.${p.key})`), details: { field: p.key } });
    } else if (p.status === 'archived') {
      f.push({ code: 'PERSONALIZATION_FIELD_ARCHIVED', severity: 'warning', section: 'message', field, message: `The message uses an archived contact field (contact.custom.${p.key}); its stored values are still used`, details: { field: p.key } });
    }
  }
  if (facts.audienceUnavailable) {
    f.push({
      ...err('ELIGIBILITY_ESTIMATE_UNAVAILABLE', 'audience', '/audience', 'The audience size and eligibility estimate are being prepared. Try again shortly.'),
      details: { retryAfterSeconds: facts.audienceUnavailable.retryAfterSeconds },
    });
  }
  if (facts.audience) {
    if (facts.audience.capped) {
      f.push(err('AUDIENCE_TOO_LARGE', 'audience', '/audience', `The audience is larger than ${AUDIENCE_LIMITS.captureMax.toLocaleString('en')} contacts`));
    } else if (facts.audience.size === 0) {
      f.push(err('AUDIENCE_EMPTY', 'audience', '/audience', 'The selected lists and tags contain no contacts'));
    } else if (facts.eligibility) {
      const { estimate } = facts.eligibility;
      if (estimate === 0) f.push(err('NO_ELIGIBLE_RECIPIENTS', 'audience', '/audience', 'No contact in this audience can currently receive this campaign'));
      else if (estimate / facts.audience.size < LOW_ELIGIBLE_SHARE) {
        f.push({ code: 'LOW_ELIGIBLE_SHARE', severity: 'warning', section: 'audience', field: '/audience', message: 'Fewer than half of these contacts can currently receive this campaign', details: { estimate, audienceSize: facts.audience.size } });
      }
    }
  }
  return f;
}

/**
 * Start/resume checks (contract §3.2 "Start" column). Returns the configuration failure code, or null.
 * Audience-source problems are reported by the capture itself (Audience contract §9), not here.
 */
export function startFailure(facts: { channelEnabled: boolean; topic: 'ok' | 'unavailable'; deliveryAvailable: boolean }): ReadinessFindingCode | null {
  if (!facts.channelEnabled) return 'CHANNEL_NOT_AVAILABLE';
  if (facts.topic !== 'ok') return 'TOPIC_UNAVAILABLE';
  if (!facts.deliveryAvailable) return 'DELIVERY_NOT_AVAILABLE';
  return null;
}

export function summarize(findings: ReadinessFinding[]): CampaignReadiness & { sections: Record<FindingSection, 'pass' | 'warning' | 'error'> } {
  const sections = Object.fromEntries(FINDING_SECTIONS.map((s) => [s, 'pass'])) as Record<FindingSection, 'pass' | 'warning' | 'error'>;
  for (const x of findings) {
    if (x.severity === 'error') sections[x.section] = 'error';
    else if (x.severity === 'warning' && sections[x.section] === 'pass') sections[x.section] = 'warning';
  }
  return { readiness: findings.some((x) => x.severity === 'error') ? 'not_ready' : 'ready', readinessFindings: findings, sections };
}

export const errorCount = (findings: ReadinessFinding[]) => findings.filter((x) => x.severity === 'error').length;

function scheduleFindings(schedule: CampaignDraft['schedule'], now: Date): ReadinessFinding[] {
  const f: ReadinessFinding[] = [];
  if (!isValidTimeZone(schedule.timezone)) f.push(err('TIMEZONE_INVALID', 'schedule', '/schedule/timezone', 'Choose a valid time zone'));
  if (schedule.mode === 'at') {
    const at = schedule.sendAt ? Date.parse(schedule.sendAt) : Number.NaN;
    if (Number.isNaN(at) || at < now.getTime() - SCHEDULE_LIMITS.pastToleranceMs) {
      f.push(err('SCHEDULE_IN_PAST', 'schedule', '/schedule/sendAt', 'Choose a send time in the future'));
    } else if (at > now.getTime() + SCHEDULE_LIMITS.maxAheadMs) {
      f.push(err('SCHEDULE_TOO_FAR', 'schedule', '/schedule/sendAt', 'Choose a send time within the next year'));
    }
  }
  return f;
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz.length > 0;
  } catch {
    return false;
  }
}

function err(code: ReadinessFindingCode, section: FindingSection, field: string | undefined, message: string): ReadinessFinding {
  return { code, severity: 'error', section, ...(field ? { field } : {}), message };
}
