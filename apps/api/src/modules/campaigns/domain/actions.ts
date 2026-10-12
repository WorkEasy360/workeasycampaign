import { CAMPAIGN_ACTIONS, type CampaignAction, type Permission } from '@workeasy/shared';
import { type CampaignLifecycleState, COMMAND_PERMISSION, DELIVERY_COMMANDS, decideCommand } from './lifecycle.js';

export type BlockedReason = 'PERMISSION_DENIED' | 'DELIVERY_NOT_AVAILABLE' | 'READINESS_ERRORS';

export interface CampaignActions {
  /** The UI renders exactly these as enabled. */
  allowedActions: CampaignAction[];
  /** Lifecycle-legal actions that are blocked, with the reason to show (contract §2.5). */
  blockedActions: { action: CampaignAction; reason: BlockedReason }[];
}

/**
 * Derives the actions a viewer may take, from the SAME decision function the commands use — so the API and the UI can
 * never disagree with the lifecycle. An action is offered only when it would change something (no-ops are hidden).
 */
export function campaignActions(
  state: CampaignLifecycleState,
  input: { permissions: ReadonlySet<Permission | string>; deliveryAvailable: boolean; readinessErrors: number },
): CampaignActions {
  const allowedActions: CampaignAction[] = [];
  const blockedActions: CampaignActions['blockedActions'] = [];
  // Evaluate the lifecycle alone: everything that is not about state is reported as a blocked reason instead.
  const lifecycleOnly = { type: 'user' as const, permissions: new Set<string>(Object.values(COMMAND_PERMISSION)) };
  for (const action of CAMPAIGN_ACTIONS) {
    const decision = decideCommand(state, action, {
      actor: lifecycleOnly,
      expectedVersion: state.version,
      deliveryAvailable: true,
      preflightErrors: 0,
    });
    if (decision.outcome !== 'apply') continue;
    if (!input.permissions.has(COMMAND_PERMISSION[action])) blockedActions.push({ action, reason: 'PERMISSION_DENIED' });
    else if (DELIVERY_COMMANDS.includes(action) && !input.deliveryAvailable) blockedActions.push({ action, reason: 'DELIVERY_NOT_AVAILABLE' });
    else if ((action === 'schedule' || action === 'send_now') && input.readinessErrors > 0) blockedActions.push({ action, reason: 'READINESS_ERRORS' });
    else allowedActions.push(action);
  }
  return { allowedActions, blockedActions };
}
