/**
 * SMS and WhatsApp message content (2026-10-09; docs/contracts/phase-7-messaging-amendment.md). Personalization uses the
 * v2 merge-tag syntax of email.content.v3 (`{{ contact.first_name | "there" }}`, `contact.custom.<key>`, workspace.name,
 * organization.name). Content is data only: rendering and limits live in @workeasy/content and the channel specs.
 *
 *  - `sms.content.v1`      — one plain-text body. A marketing SMS always ends with an opt-out instruction: the renderer
 *                            appends "Reply STOP to opt out." unless the text already mentions STOP.
 *  - `whatsapp.content.v1` — a Meta-APPROVED message template (marketing messages outside a 24 h customer window must
 *                            use one): its name, language and the body parameters {{1}}, {{2}}, … in order. The template
 *                            text itself lives at Meta; Workeasy never claims to know it.
 */
import { z } from 'zod';

export const SMS_CONTENT_LIMITS = { text: 1_600 } as const;
export const WHATSAPP_CONTENT_LIMITS = { name: 512, parameters: 10, parameter: 1_024 } as const;
/** Meta template names: lowercase letters, digits and underscores. Languages: e.g. en, en_US, pt_BR. */
export const WHATSAPP_TEMPLATE_NAME_PATTERN = /^[a-z0-9_]{1,512}$/;
export const WHATSAPP_LANGUAGE_PATTERN = /^[a-z]{2,3}(_[A-Z]{2})?$/;

export const smsContentV1Schema = z.strictObject({
  schema: z.literal('sms.content.v1'),
  text: z.string().min(1).max(SMS_CONTENT_LIMITS.text),
});
export type SmsContentV1 = z.infer<typeof smsContentV1Schema>;

/** Draft: the same shape, possibly incomplete (readiness reports what is missing). */
export const smsContentDraftSchema = z.strictObject({
  schema: z.literal('sms.content.v1'),
  text: z.string().max(SMS_CONTENT_LIMITS.text),
});
export type SmsContentDraft = z.infer<typeof smsContentDraftSchema>;

export const whatsappContentV1Schema = z.strictObject({
  schema: z.literal('whatsapp.content.v1'),
  template: z.strictObject({
    name: z.string().regex(WHATSAPP_TEMPLATE_NAME_PATTERN),
    language: z.string().regex(WHATSAPP_LANGUAGE_PATTERN),
    parameters: z.array(z.string().min(1).max(WHATSAPP_CONTENT_LIMITS.parameter)).max(WHATSAPP_CONTENT_LIMITS.parameters),
  }),
});
export type WhatsAppContentV1 = z.infer<typeof whatsappContentV1Schema>;

export const whatsappContentDraftSchema = z.strictObject({
  schema: z.literal('whatsapp.content.v1'),
  template: z.strictObject({
    name: z.string().max(WHATSAPP_CONTENT_LIMITS.name),
    language: z.string().max(12),
    parameters: z.array(z.string().max(WHATSAPP_CONTENT_LIMITS.parameter)).max(WHATSAPP_CONTENT_LIMITS.parameters),
  }),
});
export type WhatsAppContentDraft = z.infer<typeof whatsappContentDraftSchema>;

/** The content schema a channel's messages use (email has several, chosen by the editor). */
export const MESSAGING_CONTENT_SCHEMA = { sms: 'sms.content.v1', whatsapp: 'whatsapp.content.v1' } as const;
