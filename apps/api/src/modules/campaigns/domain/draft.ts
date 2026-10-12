import type { AudienceDefinitionV1, AudienceSelector, Channel } from '@workeasy/shared';

/**
 * The editable draft held on the campaign row (contract §4.1: "the draft uses the same value types but every field may
 * be partial/null"). Request validation (shape, lengths, duplicate selectors) happens at the API boundary; the domain
 * reasons about completeness and rules.
 */
export interface CampaignDraft {
  name: string;
  channel: Channel;
  topicId: string | null;
  audience: AudienceDefinitionV1;
  sender: { senderIdentityId: string | null; fromName: string | null; replyTo: string | null };
  /** Channel-specific content, validated by the channel's spec. Phase 6: one `default` variant. */
  messages: { variantKey: string; content: unknown }[];
  schedule: { mode: 'now' | 'at'; sendAt: string | null; timezone: string };
}

export const AUDIENCE_LIMITS = { include: 25, exclude: 25, captureMax: 5_000_000 } as const;

export const selectorKey = (s: AudienceSelector) => (s.type === 'list' ? `list:${s.listId}` : `tag:${s.tagId}`);

/** Draft fields whose change requires an extra read permission (contract §8 composite rule). */
export function draftChangePermissions(before: Pick<CampaignDraft, 'topicId' | 'audience'>, after: Pick<CampaignDraft, 'topicId' | 'audience'>) {
  const needed = new Set<'lists.read' | 'tags.read' | 'topics.read'>();
  if (after.topicId && after.topicId !== before.topicId) needed.add('topics.read');
  const had = new Set([...before.audience.include, ...before.audience.exclude].map(selectorKey));
  for (const s of [...after.audience.include, ...after.audience.exclude]) {
    if (had.has(selectorKey(s))) continue;
    needed.add(s.type === 'list' ? 'lists.read' : 'tags.read');
  }
  return needed;
}
