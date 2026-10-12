/**
 * Message events v1 — normalized delivery and engagement facts (docs/architecture/analytics-tracking.md §3). The
 * CONTRACT the delivery adapters (Phase 8) and the tracking endpoints (Phase 9) will produce; nothing produces them
 * yet. Strict and PII-free by construction: ids, codes, timestamps and classifications only — never an address, a
 * subject, a body, a URL (clicks carry the link's index in the message, not the URL), a user agent or an IP.
 *
 * Idempotency: `eventId` is unique per source (provider event id, or a signed tracking token's event id); consumers
 * deduplicate on it, so at-least-once delivery from providers never double-counts.
 */
import { z } from 'zod';
import { CHANNELS } from './channels.js';

const uuid = z.uuid();
const utcInstant = z.iso.datetime();
const code = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);

export const MESSAGE_EVENT_TYPES = ['sent', 'delivery_accepted', 'delivery_failed', 'bounced', 'complained', 'opened', 'clicked', 'unsubscribed'] as const;
export type MessageEventType = (typeof MESSAGE_EVENT_TYPES)[number];

const base = {
  schema: z.literal('message.event.v1'),
  /** Unique per source; the deduplication key. */
  eventId: z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  occurredAt: utcInstant,
  /** Tenant comes from the routing table (M12), never from the payload; carried here after resolution. */
  orgId: uuid,
  workspaceId: uuid,
  campaignId: uuid,
  executionId: uuid,
  /** The campaign recipient row (pseudonymous; attribution never needs a contact lookup). */
  recipientId: uuid,
  channel: z.enum(CHANNELS),
};

export const messageEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...base, type: z.literal('sent') }),
  z.strictObject({ ...base, type: z.literal('delivery_accepted') }),
  z.strictObject({ ...base, type: z.literal('delivery_failed'), reason: code, permanent: z.boolean() }),
  z.strictObject({ ...base, type: z.literal('bounced'), bounce: z.enum(['hard', 'soft']), reason: code }),
  z.strictObject({ ...base, type: z.literal('complained') }),
  /** `machine`: Apple Mail Privacy Protection, security scanners and prefetchers (reported separately, M12/M14). */
  z.strictObject({ ...base, type: z.literal('opened'), classification: z.enum(['human', 'machine']) }),
  z.strictObject({ ...base, type: z.literal('clicked'), classification: z.enum(['human', 'machine']), linkIndex: z.number().int().min(0).max(999) }),
  z.strictObject({ ...base, type: z.literal('unsubscribed') }),
]);
export type MessageEvent = z.infer<typeof messageEventSchema>;
