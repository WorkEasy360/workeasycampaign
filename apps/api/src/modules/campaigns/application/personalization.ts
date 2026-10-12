import type { AudienceProfiles } from '@workeasy/audience-core';
import { mergeFieldsUsedMessaging, mergeFieldsUsedV3 } from '@workeasy/content';
import type { Tx } from '@workeasy/db';
import { customFieldKeyOf, EXAMPLE_MERGE_DATA, EXAMPLE_MERGE_DATA_V2, type EmailContentV3Draft, type MergeDataV2, type MessageDraft } from '@workeasy/shared';

/**
 * Personalization data for rendering (docs/contracts/phase-7-content-amendment.md §C, C13–C14). Contact values come
 * ONLY through the Audience Profiles port (Campaigns never reads Audience tables); `workspace.name` and
 * `organization.name` are the tenant's own names (tenancy tables, RLS-scoped to the current organization). Values are
 * used to render immediately and are never stored, logged or emitted by callers.
 */
export interface PersonalizationScope {
  tx: Tx;
  orgId: string;
  workspaceId: string;
}

type V2Content = Extract<MessageDraft['content'], { schema: 'email.content.v3' | 'sms.content.v1' | 'whatsapp.content.v1' }>;
/** Content personalized with merge_tags_v2: email v3, SMS and WhatsApp. */
const usesV2 = (content: MessageDraft['content']): content is V2Content =>
  content.schema === 'email.content.v3' || content.schema === 'sms.content.v1' || content.schema === 'whatsapp.content.v1';

/** Custom-field keys a v2-personalized content references (v3: all branches, conditions and HTML text included). */
export const customKeysOf = (content: V2Content | EmailContentV3Draft): string[] =>
  (content.schema === 'email.content.v3' ? mergeFieldsUsedV3(content) : mergeFieldsUsedMessaging(content)).flatMap((n) => customFieldKeyOf(n) ?? []);

async function tenantNames(scope: PersonalizationScope): Promise<Record<string, string | null>> {
  const [ws, org] = await Promise.all([
    scope.tx.workspace.findUnique({ where: { id: scope.workspaceId }, select: { name: true } }),
    scope.tx.organization.findUnique({ where: { id: scope.orgId }, select: { name: true } }),
  ]);
  return { 'workspace.name': ws?.name ?? null, 'organization.name': org?.name ?? null };
}

/** The example profile for previews without a contact: fixed values, real tenant names, "<label> (example)" fields. */
export async function examplePersonalization(profiles: AudienceProfiles<Tx>, scope: PersonalizationScope, content: MessageDraft['content']): Promise<MergeDataV2> {
  if (!usesV2(content)) return EXAMPLE_MERGE_DATA;
  const keys = customKeysOf(content);
  const fields = keys.length ? await profiles.personalizationFields(scope) : [];
  const labels = new Map(fields.map((f) => [f.key, f.label]));
  const data: Record<string, string | null> = { ...EXAMPLE_MERGE_DATA_V2, ...(await tenantNames(scope)) };
  for (const k of keys) data[`contact.custom.${k}`] = labels.has(k) ? `${labels.get(k)} (example)` : null;
  return data;
}

/**
 * One contact's personalization data, or null when the contact is not visible (another workspace, deleted, erased).
 * v1/v2 content gets the v1 fields only, exactly as before.
 */
export async function contactPersonalization(profiles: AudienceProfiles<Tx>, scope: PersonalizationScope, contactId: string, content: MessageDraft['content']): Promise<MergeDataV2 | null> {
  const id = contactId.toLowerCase();
  if (!usesV2(content)) return (await profiles.mergeData(scope, [id])).get(id) ?? null;
  const found = (await profiles.mergeDataV2(scope, [id], customKeysOf(content))).get(id);
  return found ? { ...found, ...(await tenantNames(scope)) } : null;
}
