import {
  isMergeFieldNameV2,
  type MergeDataV2,
  SMS_CONTENT_LIMITS,
  type SmsContentDraft,
  type SmsContentV1,
  smsContentV1Schema,
  WHATSAPP_LANGUAGE_PATTERN,
  WHATSAPP_TEMPLATE_NAME_PATTERN,
  type WhatsAppContentDraft,
  type WhatsAppContentV1,
  whatsappContentV1Schema,
} from '@workeasy/shared';
import { parseTemplateV2, tagValueV2 } from './merge-tags.js';

/**
 * SMS and WhatsApp content rules and rendering (messaging amendment, 2026-10-09). Pure. Same contract as the email
 * content validators: pointers are relative to the content, and a content without issues always canonicalizes to a
 * valid stored schema value.
 */
export type MessagingIssue = {
  code: 'BODY_MISSING' | 'BODY_TOO_LONG' | 'MERGE_TAG_INVALID' | 'TEMPLATE_MISSING' | 'TEMPLATE_INVALID';
  pointer: string;
  message: string;
};

/** Appended to every marketing SMS that does not already say how to opt out (carriers and law require one). */
export const SMS_OPT_OUT_INSTRUCTION = 'Reply STOP to opt out.';
const MENTIONS_STOP = /\bSTOP\b/i;

function tagIssues(value: string, pointer: string): MessagingIssue[] {
  return parseTemplateV2(value).errors.map((e) => ({ code: 'MERGE_TAG_INVALID' as const, pointer, message: e.message }));
}

export function smsIssues(c: SmsContentDraft): MessagingIssue[] {
  const text = c.text.trim();
  if (!text) return [{ code: 'BODY_MISSING', pointer: '/text', message: 'Write the message' }];
  const out: MessagingIssue[] = [];
  // The opt-out instruction is appended when missing: it must still fit.
  const withOptOut = MENTIONS_STOP.test(text) ? text : `${text}\n${SMS_OPT_OUT_INSTRUCTION}`;
  if (withOptOut.length > SMS_CONTENT_LIMITS.text) {
    out.push({ code: 'BODY_TOO_LONG', pointer: '/text', message: `Use at most ${SMS_CONTENT_LIMITS.text - SMS_OPT_OUT_INSTRUCTION.length - 1} characters (the opt-out instruction is added)` });
  }
  out.push(...tagIssues(text, '/text'));
  return out;
}

export function whatsappIssues(c: WhatsAppContentDraft): MessagingIssue[] {
  const out: MessagingIssue[] = [];
  const name = c.template.name.trim();
  const language = c.template.language.trim();
  if (!name) out.push({ code: 'TEMPLATE_MISSING', pointer: '/template/name', message: 'Enter the name of an approved WhatsApp template' });
  else if (!WHATSAPP_TEMPLATE_NAME_PATTERN.test(name)) out.push({ code: 'TEMPLATE_INVALID', pointer: '/template/name', message: 'Template names use lowercase letters, digits and underscores' });
  if (!language) out.push({ code: 'TEMPLATE_MISSING', pointer: '/template/language', message: 'Enter the template language (e.g. en or en_US)' });
  else if (!WHATSAPP_LANGUAGE_PATTERN.test(language)) out.push({ code: 'TEMPLATE_INVALID', pointer: '/template/language', message: 'Use a language code such as en, en_US or pt_BR' });
  c.template.parameters.forEach((p, i) => {
    if (!p.trim()) out.push({ code: 'TEMPLATE_INVALID', pointer: `/template/parameters/${i}`, message: `Fill in parameter {{${i + 1}}} or remove it` });
    else out.push(...tagIssues(p, `/template/parameters/${i}`));
  });
  return out;
}

export function canonicalSms(c: SmsContentDraft): SmsContentV1 | null {
  if (smsIssues(c).length) return null;
  const parsed = smsContentV1Schema.safeParse({ schema: 'sms.content.v1', text: c.text.trim() });
  return parsed.success ? parsed.data : null;
}

export function canonicalWhatsApp(c: WhatsAppContentDraft): WhatsAppContentV1 | null {
  if (whatsappIssues(c).length) return null;
  const parsed = whatsappContentV1Schema.safeParse({
    schema: 'whatsapp.content.v1',
    template: { name: c.template.name.trim(), language: c.template.language.trim(), parameters: c.template.parameters.map((p) => p.trim()) },
  });
  return parsed.success ? parsed.data : null;
}

/** v2 field names the content uses (for loading only the needed contact fields). */
export function mergeFieldsUsedMessaging(c: SmsContentDraft | WhatsAppContentDraft): string[] {
  const texts = c.schema === 'sms.content.v1' ? [c.text] : c.template.parameters;
  const out: string[] = [];
  for (const t of texts) for (const p of parseTemplateV2(t).parts) if (p.kind === 'tag' && isMergeFieldNameV2(p.name) && !out.includes(p.name)) out.push(p.name);
  return out;
}

function substituteV2(input: string, data: MergeDataV2): string {
  return parseTemplateV2(input)
    .parts.map((p) => (p.kind === 'text' ? p.value : tagValueV2(p, data)))
    .join('');
}

/** The SMS a recipient receives: personalized, with the opt-out instruction ensured. */
export function renderSms(c: SmsContentV1, data: MergeDataV2): string {
  const text = substituteV2(c.text, data).trim();
  return MENTIONS_STOP.test(text) ? text : `${text}\n${SMS_OPT_OUT_INSTRUCTION}`;
}

/** WhatsApp template variables {{1}}…{{n}}, personalized. A parameter that renders empty becomes "-" (Meta rejects empty). */
export function renderWhatsAppVariables(c: WhatsAppContentV1, data: MergeDataV2): Record<string, string> {
  return Object.fromEntries(c.template.parameters.map((p, i) => [String(i + 1), substituteV2(p, data).trim() || '-']));
}

/**
 * SMS segments for a text (what the carrier bills): GSM-7 → 160 characters (153 per part when concatenated);
 * anything outside GSM-7 (e.g. emoji, many accents) → UCS-2, 70 (67 per part). Informational for the editor.
 */
const GSM7 = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/;
export function smsSegments(text: string): { encoding: 'GSM-7' | 'UCS-2'; characters: number; segments: number } {
  const gsm = GSM7.test(text);
  // Extended GSM characters take two septets.
  const characters = gsm ? [...text].reduce((n, ch) => n + ('^{}\\[~]|€'.includes(ch) ? 2 : 1), 0) : [...text].length;
  const [single, multi] = gsm ? [160, 153] : [70, 67];
  return { encoding: gsm ? 'GSM-7' : 'UCS-2', characters, segments: characters === 0 ? 0 : characters <= single ? 1 : Math.ceil(characters / multi) };
}
