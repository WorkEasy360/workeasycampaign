import { CAMPAIGN_EVENT_TYPES, type CampaignCounts, type CampaignEventPayloads, type CampaignEventType } from '@workeasy/shared';

/**
 * Campaign event contract v1 (docs/events.md §"Campaign event contract v1"). Aggregate `campaign`.
 * Ids, states, counts, timestamps and changed field NAMES only: never names, subjects, bodies, audience members,
 * addresses or contact ids. The payload schemas and types are the shared contract (milestone 6.4,
 * `CAMPAIGN_EVENT_PAYLOAD_SCHEMAS` in @workeasy/shared); registration in the API event catalogue happens with 6.10.
 */
export { CAMPAIGN_EVENT_TYPES };
export type { CampaignCounts, CampaignEventPayloads, CampaignEventType };

export interface CampaignDomainEvent<T extends CampaignEventType = CampaignEventType> {
  type: T;
  payload: CampaignEventPayloads[T];
}

export const campaignEvent = <T extends CampaignEventType>(type: T, payload: CampaignEventPayloads[T]): CampaignDomainEvent<T> => ({ type, payload });
