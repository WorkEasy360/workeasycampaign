import type { Tx } from '@workeasy/db';
import { type UsageRecord, usageRecordSchema } from '@workeasy/shared';

/**
 * Appends usage facts to the ledger (Phase 7.13; usage.record.v1) inside the caller's transaction — like an audit row:
 * exactly once with the fact it meters, never lost, never doubled (ON CONFLICT on the record id). Validated against the
 * contract first; an invalid record is a programming error and is thrown.
 */
export async function recordUsage(tx: Tx, records: readonly UsageRecord[]): Promise<void> {
  if (!records.length) return;
  const r = records.map((x) => usageRecordSchema.parse(x));
  await tx.$executeRaw`
    INSERT INTO usage_records (record_id, org_id, workspace_id, meter, quantity, at)
    SELECT * FROM unnest(${r.map((x) => x.recordId)}::text[], ${r.map((x) => x.orgId)}::uuid[], ${r.map((x) => x.workspaceId)}::uuid[],
                         ${r.map((x) => x.meter)}::text[], ${r.map((x) => x.quantity)}::bigint[], ${r.map((x) => x.at)}::timestamptz[])
    ON CONFLICT (record_id) DO NOTHING`;
}

/** UTC day of an instant, for daily gauge record ids. */
export const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Usage for one delivery batch's outcomes (pure; Phase 7.13). Only LIVE delivery is metered: test mode (the null
 * port, or the provider port against a test double) never is. One record per batch, keyed by the batch's first sent
 * recipient (a batch's outcomes are committed once).
 */
export function messagesSentUsage(
  mode: 'test' | 'live',
  tenant: { orgId: string; workspaceId: string },
  executionId: string,
  sentRecipientIds: readonly string[],
  at: Date,
): UsageRecord[] {
  if (mode !== 'live' || !sentRecipientIds.length) return [];
  const first = [...sentRecipientIds].sort()[0]!;
  return [{ schema: 'usage.record.v1', recordId: `messages.sent:${executionId}:${first}`, meter: 'messages.sent', orgId: tenant.orgId, workspaceId: tenant.workspaceId, quantity: sentRecipientIds.length, at: at.toISOString() }];
}
