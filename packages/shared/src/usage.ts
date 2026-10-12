/**
 * Usage metering — contract only (docs/architecture/ai-billing-readiness.md §2). Billing (plans, prices, invoices,
 * payment) is NOT built; this fixes WHAT is metered and how, so a billing context can later consume it without
 * reaching into domain logic. Usage records are facts emitted by the owning context (append-only, idempotent on
 * `recordId`), aggregated per organization and period by the billing context — never computed inside Campaigns.
 */
import { z } from 'zod';

export const USAGE_METERS = [
  /** Live contacts at the end of the day (gauge; owned by Audience). */
  'contacts.active',
  /** Campaign runs started (counter; owned by Campaigns). */
  'campaign.executions',
  /** Messages accepted by a REAL delivery port (counter; Phase 8 — test mode never meters). */
  'messages.sent',
  /** Live templates (gauge; owned by Campaigns). */
  'templates.active',
  /** Stored bytes of uploads (gauge; owned by Audience imports / future assets). */
  'storage.bytes',
  /** Tokens used by AI assistance (counter; future AI context). */
  'ai.tokens',
] as const;
export type UsageMeter = (typeof USAGE_METERS)[number];

export const usageRecordSchema = z.strictObject({
  schema: z.literal('usage.record.v1'),
  /** Idempotency key, unique per source fact (e.g. `campaign.executions:<executionId>`). */
  recordId: z.string().min(8).max(200),
  meter: z.enum(USAGE_METERS),
  orgId: z.uuid(),
  workspaceId: z.uuid().nullable(),
  /** Counter increment, or the gauge value at `at`. */
  quantity: z.number().int().min(0),
  at: z.iso.datetime(),
});
export type UsageRecord = z.infer<typeof usageRecordSchema>;

/** Counter meters are summed over a period; gauge meters report the latest value in the period (per workspace). */
export const USAGE_METER_KINDS: Record<UsageMeter, 'counter' | 'gauge'> = {
  'contacts.active': 'gauge',
  'campaign.executions': 'counter',
  'messages.sent': 'counter',
  'templates.active': 'gauge',
  'storage.bytes': 'gauge',
  'ai.tokens': 'counter',
};

/** Usage of an organization over a UTC period (Phase 7.13): quantities only — no price, plan or quota. */
export const usageSummaryQuery = z
  .strictObject({ from: z.iso.datetime().optional(), to: z.iso.datetime().optional() })
  .refine((q) => !q.from || !q.to || Date.parse(q.from) < Date.parse(q.to), { path: ['from'], error: 'from must be before to' });
export type UsageSummaryQuery = z.infer<typeof usageSummaryQuery>;

export const usageSummarySchema = z.strictObject({
  period: z.strictObject({ from: z.iso.datetime(), to: z.iso.datetime() }),
  meters: z.array(
    z.strictObject({
      meter: z.enum(USAGE_METERS),
      kind: z.enum(['counter', 'gauge']),
      /** Counter: sum over the period. Gauge: sum over workspaces of each one's latest value in the period. */
      total: z.number().int().min(0),
      /** Gauge only: when the latest values were taken (null: none in the period). */
      asOf: z.iso.datetime().nullable(),
      byWorkspace: z.array(z.strictObject({ workspaceId: z.uuid(), name: z.string(), value: z.number().int().min(0) })),
    }),
  ),
});
export type UsageSummary = z.infer<typeof usageSummarySchema>;
