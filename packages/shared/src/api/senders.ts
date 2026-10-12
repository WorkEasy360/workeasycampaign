/**
 * Sending domains and sender identities (Phase 7.8b; docs/contracts/phase-7-campaign-amendment.md §S). Base path
 * /v1/workspaces/{workspaceId}. A domain is verified only from real DNS checks; an identity is usable for sending only
 * on a verified domain.
 */
import { z } from 'zod';

const uuid = z.uuid();
const utcInstant = z.iso.datetime();

export const DOMAIN_CHECK_RESULTS = ['pass', 'fail', 'missing', 'error', 'not_checked'] as const;
export const SENDING_DOMAIN_STATUSES = ['pending', 'verified', 'failed'] as const;
const check = z.enum(DOMAIN_CHECK_RESULTS);

export const createSendingDomainRequest = z.strictObject({ domain: z.string().trim().min(3).max(253) });
export type CreateSendingDomainRequest = z.infer<typeof createSendingDomainRequest>;

export const sendingDomainSchema = z.strictObject({
  id: uuid,
  domain: z.string(),
  status: z.enum(SENDING_DOMAIN_STATUSES),
  checks: z.strictObject({ ownership: check, spf: check, dkim: check, dmarc: check }).nullable(),
  checkedAt: utcInstant.nullable(),
  verifiedAt: utcInstant.nullable(),
  /** DNS records to create at the domain's DNS host. */
  records: z.array(z.strictObject({ purpose: z.enum(['ownership', 'spf', 'dkim', 'dmarc']), type: z.string(), host: z.string(), value: z.string() })),
  identityCount: z.number().int().min(0),
  version: z.number().int().positive(),
  createdAt: utcInstant,
});
export type SendingDomainView = z.infer<typeof sendingDomainSchema>;

const displayName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((v) => !/[\r\n\u0000-\u001f\u007f"<>]/.test(v), { error: 'Use letters, digits, spaces and simple punctuation' });
const replyTo = z
  .string()
  .trim()
  .toLowerCase()
  .max(320)
  .regex(/^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,63}$/i, { error: 'Enter a valid email address' })
  .nullable();

export const createSenderIdentityRequest = z.strictObject({
  domainId: uuid,
  localPart: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/, { error: 'Use the part before the @ only' }),
  displayName,
  replyTo: replyTo.optional(),
});
export type CreateSenderIdentityRequest = z.infer<typeof createSenderIdentityRequest>;

export const updateSenderIdentityRequest = z
  .strictObject({ expectedVersion: z.number().int().positive(), displayName: displayName.optional(), replyTo: replyTo.optional() })
  .refine((r) => r.displayName !== undefined || r.replyTo !== undefined, { error: 'Nothing to change' });
export type UpdateSenderIdentityRequest = z.infer<typeof updateSenderIdentityRequest>;

export const senderIdentitySchema = z.strictObject({
  id: uuid,
  domainId: uuid,
  email: z.string(),
  displayName: z.string(),
  replyTo: z.string().nullable(),
  /** Usable for sending: its domain is verified. */
  verified: z.boolean(),
  version: z.number().int().positive(),
  createdAt: utcInstant,
});
export type SenderIdentityView = z.infer<typeof senderIdentitySchema>;
