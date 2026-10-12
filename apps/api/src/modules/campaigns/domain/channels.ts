import { contentIssues, contentIssuesV3, smsIssues, whatsappIssues } from '@workeasy/content';
import { type Channel, emailContentV2DraftSchema, emailContentV3DraftSchema, type ReadinessFinding, smsContentDraftSchema, whatsappContentDraftSchema } from '@workeasy/shared';

/**
 * Channel strategies (contract §9). Campaign code never branches on the channel; it asks the channel's spec.
 * Provider delivery is not here — that is `ChannelAdapter` in packages/channels (Phase 8).
 */
export interface ChannelSpec {
  channel: Channel;
  enabled: boolean;
  /** Identity kind messages on this channel are sent to (matches Eligibility's address kind). */
  addressKind: 'email' | 'phone' | 'whatsapp';
  /** Content schema id stored in versions. */
  contentSchema: string;
  /** Email only: a verified sender identity is chosen per campaign. SMS / WhatsApp send from the deployment's provider number. */
  usesSenderIdentity: boolean;
  /** Readiness findings for one message's content; `pointer` is the JSON pointer of that content in the draft. */
  validateContent(content: unknown, pointer: string): ReadinessFinding[];
}

export const EMAIL_LIMITS = { subject: 200, preheader: 200, body: 100_000 } as const;

const emailSpec: ChannelSpec = {
  channel: 'email',
  enabled: true,
  addressKind: 'email',
  contentSchema: 'email.content.v1',
  usesSenderIdentity: true,
  validateContent(content, pointer) {
    // email.content.v2 (content amendment §2): the pure content rules, as findings under this message's pointer.
    // email.content.v3 (Phase 7 amendment §C): the same, with v3's rules (HTML, conditions, merge_tags_v2 syntax).
    if ((content as { schema?: unknown } | null)?.schema === 'email.content.v3') {
      const parsed = emailContentV3DraftSchema.safeParse(content);
      if (!parsed.success) return [finding('BODY_MISSING', 'message', `${pointer}/body`, 'The message could not be read')];
      return contentIssuesV3(parsed.data).map((i) => finding(i.code, 'message', `${pointer}${i.pointer}`, i.message));
    }
    if ((content as { schema?: unknown } | null)?.schema === 'email.content.v2') {
      const parsed = emailContentV2DraftSchema.safeParse(content);
      if (!parsed.success) return [finding('BODY_MISSING', 'message', `${pointer}/body`, 'The message could not be read')];
      return contentIssues(parsed.data).map((i) => finding(i.code, 'message', `${pointer}${i.pointer}`, i.message));
    }
    const c = (content ?? {}) as { subject?: unknown; body?: { text?: unknown } };
    const findings: ReadinessFinding[] = [];
    const subject = typeof c.subject === 'string' ? c.subject.trim() : '';
    const text = typeof c.body?.text === 'string' ? c.body.text.trim() : '';
    if (!subject) findings.push(finding('SUBJECT_MISSING', 'message', `${pointer}/subject`, 'Add a subject'));
    else if (subject.length > EMAIL_LIMITS.subject) {
      findings.push(finding('SUBJECT_TOO_LONG', 'message', `${pointer}/subject`, `Use at most ${EMAIL_LIMITS.subject} characters`));
    }
    if (!text) findings.push(finding('BODY_MISSING', 'message', `${pointer}/body/text`, 'Write the message'));
    else if (text.length > EMAIL_LIMITS.body) {
      findings.push(finding('BODY_TOO_LONG', 'message', `${pointer}/body/text`, `Use at most ${EMAIL_LIMITS.body.toLocaleString('en')} characters`));
    }
    return findings;
  },
};

/**
 * SMS (messaging amendment, 2026-10-09): one text, personalized with merge_tags_v2; the STOP instruction is ensured by
 * the renderer. Implemented; AVAILABLE only where an SMS provider is configured (isChannelAvailable).
 */
const smsSpec: ChannelSpec = {
  channel: 'sms',
  enabled: true,
  addressKind: 'phone',
  contentSchema: 'sms.content.v1',
  usesSenderIdentity: false,
  validateContent(content, pointer) {
    const parsed = smsContentDraftSchema.safeParse(content);
    if (!parsed.success) return [finding('BODY_MISSING', 'message', `${pointer}/text`, 'Write the SMS')];
    return smsIssues(parsed.data).map((i) => finding(i.code, 'message', `${pointer}${i.pointer}`, i.message));
  },
};

/** WhatsApp (messaging amendment): a Meta-approved template and its parameters. Available where Meta is configured. */
const whatsappSpec: ChannelSpec = {
  channel: 'whatsapp',
  enabled: true,
  addressKind: 'whatsapp',
  contentSchema: 'whatsapp.content.v1',
  usesSenderIdentity: false,
  validateContent(content, pointer) {
    const parsed = whatsappContentDraftSchema.safeParse(content);
    if (!parsed.success) return [finding('TEMPLATE_MISSING', 'message', `${pointer}/template/name`, 'Choose the approved WhatsApp template to send')];
    return whatsappIssues(parsed.data).map((i) => finding(i.code, 'message', `${pointer}${i.pointer}`, i.message));
  },
};

const SPECS: Record<Channel, ChannelSpec> = {
  email: emailSpec,
  sms: smsSpec,
  whatsapp: whatsappSpec,
};

/**
 * Whether campaigns can use a channel in THIS deployment: implemented, and its provider configured (email is always
 * draftable; sending is a separate capability). Test delivery mode runs every channel against test doubles.
 */
export function isChannelAvailable(channel: Channel, deployment: { mode: string; smsConfigured: boolean; whatsappConfigured: boolean }): boolean {
  if (!SPECS[channel].enabled) return false;
  if (channel === 'email' || deployment.mode === 'test') return true;
  return channel === 'sms' ? deployment.smsConfigured : deployment.whatsappConfigured;
}

export const channelSpec = (channel: Channel): ChannelSpec => SPECS[channel];

function finding(code: ReadinessFinding['code'], section: ReadinessFinding['section'], field: string, message: string): ReadinessFinding {
  return { code, severity: 'error', section, field, message };
}
