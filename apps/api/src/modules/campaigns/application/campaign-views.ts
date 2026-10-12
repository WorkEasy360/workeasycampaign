import type { CampaignExecutionModel, CampaignModel, Tx } from '@workeasy/db';
import {
  audienceDefinitionDraftSchema,
  type CampaignListItem,
  type CampaignView,
  type Channel,
  type ExecutionSummary,
  messageDraftSchema,
  type Permission,
  scheduleDraftSchema,
  senderDraftSchema,
} from '@workeasy/shared';
import { z } from 'zod';
import { campaignActions } from '../domain/actions.js';
import type { CampaignDraft } from '../domain/draft.js';
import type { CampaignLifecycleState } from '../domain/lifecycle.js';
import { errorCount, readinessFindings, summarize } from '../domain/readiness.js';

/**
 * Read side of the campaigns module: stored rows → contract views (docs/contracts/phase-6-campaign.md §15). Readiness and
 * actions are computed here from the SAME domain functions the commands use; nothing is stored or trusted from a client.
 */

/** A campaign row with the two pointers the views show. */
export type CampaignRow = CampaignModel & {
  currentVersion: { id: string; number: number; createdAt: Date } | null;
  currentExecution: CampaignExecutionModel | null;
};

export const CAMPAIGN_INCLUDE = {
  currentVersion: { select: { id: true, number: true, createdAt: true } },
  currentExecution: true,
} as const;

/** What the viewer may do: permissions from the authorized tenant context, delivery capability from server config. */
export interface ViewerContext {
  permissions: ReadonlySet<Permission | string>;
  deliveryAvailable: boolean;
  /** Live delivery: sender problems are errors. */
  liveDelivery?: boolean;
  /** Whether a channel is usable in this deployment (provider configured). */
  channelAvailable?: (channel: Channel) => boolean;
  now: Date;
}

const storedDraft = z.object({
  audience: audienceDefinitionDraftSchema,
  sender: senderDraftSchema,
  messages: z.array(messageDraftSchema),
  schedule: scheduleDraftSchema,
});

/** The draft as stored (written only through validated requests); a row that does not parse is a server error. */
export function draftOf(row: Pick<CampaignModel, 'name' | 'channel' | 'topicId' | 'audience' | 'sender' | 'messages' | 'schedule'>): CampaignDraft {
  const d = storedDraft.parse({ audience: row.audience, sender: row.sender, messages: row.messages, schedule: row.schedule });
  return { name: row.name, channel: row.channel as Channel, topicId: row.topicId, ...d };
}

export const lifecycleState = (row: Pick<CampaignModel, 'status' | 'version' | 'deletedAt'>): CampaignLifecycleState => ({
  status: row.status as CampaignLifecycleState['status'],
  version: row.version,
  deleted: row.deletedAt !== null,
});

export function executionSummary(e: CampaignExecutionModel): ExecutionSummary {
  return {
    id: e.id,
    runNumber: e.runNumber,
    status: e.status as ExecutionSummary['status'],
    health: e.health as ExecutionSummary['health'],
    sendAt: e.sendAt.toISOString(),
    startedAt: e.startedAt?.toISOString() ?? null,
    materializedAt: e.materializedAt?.toISOString() ?? null,
    completedAt: e.completedAt?.toISOString() ?? null,
    lastProgressAt: e.lastProgressAt?.toISOString() ?? null,
    counts: { planned: e.planned, skipped: e.skipped, sent: e.sent, failed: e.failed, cancelled: e.cancelled, unknown: e.unknown },
    skippedByReason: e.skippedByReason as Record<string, number>,
    failure: e.failureClass && e.failureCode ? { class: 'configuration', code: e.failureCode } : null,
    maxPerHour: e.maxPerHour ?? null,
  };
}

function readinessAndActions(row: CampaignRow, viewer: ViewerContext) {
  const draft = draftOf(row);
  const findings = readinessFindings(draft, { now: viewer.now, deliveryAvailable: viewer.deliveryAvailable, liveDelivery: viewer.liveDelivery ?? false, channelAvailable: viewer.channelAvailable?.(draft.channel) });
  const actions = campaignActions(lifecycleState(row), {
    permissions: viewer.permissions,
    deliveryAvailable: viewer.deliveryAvailable,
    readinessErrors: errorCount(findings),
  });
  return { draft, findings, summary: summarize(findings), actions };
}

export function campaignView(row: CampaignRow, viewer: ViewerContext, createdBy: CampaignView['createdBy']): CampaignView {
  const { draft, summary, actions } = readinessAndActions(row, viewer);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    channel: row.channel as Channel,
    purpose: 'marketing',
    status: row.status as CampaignView['status'],
    version: row.version,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    draft: {
      topicId: draft.topicId,
      audience: draft.audience,
      sender: draft.sender,
      messages: draft.messages as CampaignView['draft']['messages'],
      schedule: draft.schedule,
    },
    currentVersion: row.currentVersion ? { id: row.currentVersion.id, number: row.currentVersion.number, createdAt: row.currentVersion.createdAt.toISOString() } : null,
    currentExecution: row.currentExecution ? executionSummary(row.currentExecution) : null,
    allowedActions: actions.allowedActions,
    blockedActions: actions.blockedActions,
    readiness: summary.readiness,
    readinessFindings: summary.readinessFindings,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    createdBy,
  };
}

export function campaignListItem(row: CampaignRow, viewer: ViewerContext): CampaignListItem {
  const { summary, actions } = readinessAndActions(row, viewer);
  return {
    id: row.id,
    name: row.name,
    channel: row.channel as Channel,
    status: row.status as CampaignListItem['status'],
    version: row.version,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    topicId: row.topicId,
    currentExecution: row.currentExecution ? executionSummary(row.currentExecution) : null,
    readiness: summary.readiness,
    allowedActions: actions.allowedActions,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Display names of users visible in the current organization (users RLS); one query for any number of ids. */
export async function actorsById(tx: Tx, userIds: (string | null)[]): Promise<Map<string, { id: string; displayName: string }>> {
  const ids = [...new Set(userIds.filter((x): x is string => !!x))];
  if (!ids.length) return new Map();
  const users = await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } });
  return new Map(users.map((u) => [u.id, u]));
}
