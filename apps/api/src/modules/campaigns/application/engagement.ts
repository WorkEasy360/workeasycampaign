import type { Tx } from '@workeasy/db';

/** Stored engagement event types (message_events.type). */
export type StoredType = 'delivered' | 'deferred' | 'bounced' | 'complained' | 'unsubscribed' | 'opened' | 'clicked';

/**
 * Records one engagement fact (Phase 7.9/7.10) inside the caller's tenant transaction: the event once (UNIQUE provider +
 * provider event id), and — only when it is new — the recipient's firsts and the execution's counters. Returns false
 * for a duplicate (nothing changed). Ids only.
 */
export async function recordEngagementEvent(
  tx: Tx,
  tenant: { orgId: string; workspaceId: string },
  e: { executionId: string; recipientId: string; type: StoredType; detail: Record<string, string>; provider: string; providerEventId: string; occurredAt: Date },
): Promise<boolean> {
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO message_events (org_id, workspace_id, execution_id, recipient_id, type, detail, provider, provider_event_id, occurred_at)
    VALUES (${tenant.orgId}::uuid, ${tenant.workspaceId}::uuid, ${e.executionId}::uuid, ${e.recipientId}::uuid, ${e.type}, ${JSON.stringify(e.detail)}::jsonb,
            ${e.provider}, ${e.providerEventId}, ${e.occurredAt})
    ON CONFLICT (provider, provider_event_id) DO NOTHING
    RETURNING id`;
  if (!inserted.length) return false;
  await applyEngagement(tx, tenant, e.executionId, e.recipientId, e.type, e.occurredAt);
  return true;
}

type Delta = Partial<Record<'delivered' | 'bounced_hard' | 'bounced_soft' | 'complained' | 'unsubscribed' | 'opened_unique' | 'clicked_unique', number>>;

/**
 * Recipient firsts and execution counters for one NEW event. Each counter moves only when the recipient's state
 * changes (unique per recipient); times keep the earliest occurrence whatever the arrival order.
 */
export async function applyEngagement(tx: Tx, tenant: { orgId: string; workspaceId: string }, executionId: string, recipientId: string, type: StoredType, at: Date): Promise<Delta> {
  await tx.$executeRaw`
    INSERT INTO recipient_engagement (recipient_id, org_id, workspace_id, execution_id)
    VALUES (${recipientId}::uuid, ${tenant.orgId}::uuid, ${tenant.workspaceId}::uuid, ${executionId}::uuid)
    ON CONFLICT (recipient_id) DO NOTHING`;
  const [before] = await tx.$queryRaw<{ delivered_at: Date | null; first_opened_at: Date | null; first_clicked_at: Date | null; bounced: string | null; complained_at: Date | null; unsubscribed_at: Date | null }[]>`
    SELECT delivered_at, first_opened_at, first_clicked_at, bounced, complained_at, unsubscribed_at
      FROM recipient_engagement WHERE recipient_id = ${recipientId}::uuid FOR UPDATE`;
  const b = before!;
  const d: Delta = {};
  const earliest = (x: Date | null) => (x && x <= at ? x : at);
  let set: { delivered_at?: Date; first_opened_at?: Date; first_clicked_at?: Date; bounced?: string; complained_at?: Date; unsubscribed_at?: Date } = {};
  switch (type) {
    case 'delivered':
      if (!b.delivered_at) d.delivered = 1;
      set = { delivered_at: earliest(b.delivered_at) };
      break;
    case 'deferred':
      if (!b.bounced) {
        d.bounced_soft = 1;
        set = { bounced: 'soft' };
      }
      break;
    case 'bounced':
      if (b.bounced !== 'hard') {
        d.bounced_hard = 1;
        if (b.bounced === 'soft') d.bounced_soft = -1;
        set = { bounced: 'hard' };
      }
      break;
    case 'complained':
      if (!b.complained_at) d.complained = 1;
      set = { complained_at: earliest(b.complained_at) };
      break;
    case 'unsubscribed':
      if (!b.unsubscribed_at) d.unsubscribed = 1;
      set = { unsubscribed_at: earliest(b.unsubscribed_at) };
      break;
    case 'opened':
      if (!b.first_opened_at) d.opened_unique = 1;
      set = { first_opened_at: earliest(b.first_opened_at) };
      break;
    case 'clicked':
      // A click proves the message was opened (the open pixel is often blocked).
      if (!b.first_clicked_at) d.clicked_unique = 1;
      if (!b.first_opened_at) d.opened_unique = 1;
      set = { first_clicked_at: earliest(b.first_clicked_at), first_opened_at: earliest(b.first_opened_at) };
      break;
  }
  if (Object.keys(set).length) {
    await tx.$executeRaw`
      UPDATE recipient_engagement SET
        delivered_at     = coalesce(${set.delivered_at ?? null}::timestamptz, delivered_at),
        first_opened_at  = coalesce(${set.first_opened_at ?? null}::timestamptz, first_opened_at),
        first_clicked_at = coalesce(${set.first_clicked_at ?? null}::timestamptz, first_clicked_at),
        bounced          = coalesce(${set.bounced ?? null}::text, bounced),
        complained_at    = coalesce(${set.complained_at ?? null}::timestamptz, complained_at),
        unsubscribed_at  = coalesce(${set.unsubscribed_at ?? null}::timestamptz, unsubscribed_at)
      WHERE recipient_id = ${recipientId}::uuid`;
  }
  await tx.$executeRaw`
    INSERT INTO execution_engagement (execution_id, org_id, workspace_id, delivered, bounced_hard, bounced_soft, complained, unsubscribed, opened_unique, clicked_unique, last_event_at)
    VALUES (${executionId}::uuid, ${tenant.orgId}::uuid, ${tenant.workspaceId}::uuid, ${d.delivered ?? 0}, ${d.bounced_hard ?? 0}, ${Math.max(d.bounced_soft ?? 0, 0)},
            ${d.complained ?? 0}, ${d.unsubscribed ?? 0}, ${d.opened_unique ?? 0}, ${d.clicked_unique ?? 0}, ${at})
    ON CONFLICT (execution_id) DO UPDATE SET
      delivered      = execution_engagement.delivered + EXCLUDED.delivered,
      bounced_hard   = execution_engagement.bounced_hard + EXCLUDED.bounced_hard,
      bounced_soft   = execution_engagement.bounced_soft + ${d.bounced_soft ?? 0},
      complained     = execution_engagement.complained + EXCLUDED.complained,
      unsubscribed   = execution_engagement.unsubscribed + EXCLUDED.unsubscribed,
      opened_unique  = execution_engagement.opened_unique + EXCLUDED.opened_unique,
      clicked_unique = execution_engagement.clicked_unique + EXCLUDED.clicked_unique,
      last_event_at  = greatest(execution_engagement.last_event_at, EXCLUDED.last_event_at)`;
  return d;
}

