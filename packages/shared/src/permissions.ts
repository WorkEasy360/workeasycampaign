/**
 * Permission catalogue — a CONTRACT, not a policy.
 *
 * The browser uses this for labels and for hiding controls the API already told it the user cannot use.
 * Which roles hold which permissions, and every authorization decision, live in the API
 * (apps/api/src/modules/tenancy/domain). Nothing here grants anything.
 */
export type PermissionScope = 'organization' | 'workspace';

interface PermissionMeta {
  scope: PermissionScope;
  group: string;
  label: string;
}

const org = (group: string, label: string): PermissionMeta => ({ scope: 'organization', group, label });
const ws = (group: string, label: string): PermissionMeta => ({ scope: 'workspace', group, label });

export const PERMISSION_CATALOGUE = {
  // Organization scope
  'org.read': org('Organization', 'View organization'),
  'org.update': org('Organization', 'Edit organization settings'),
  'org.delete': org('Organization', 'Delete organization'),
  'billing.manage': org('Organization', 'Manage plan and billing'),
  'security.manage': org('Organization', 'Manage security settings'),
  'workspaces.create': org('Workspaces', 'Create workspaces'),
  'workspaces.manage': org('Workspaces', 'Rename, archive and restore workspaces'),
  'workspaces.access_all': org('Workspaces', 'Administer every workspace'),
  'members.read': org('Members', 'View organization members'),
  'members.invite': org('Members', 'Invite people'),
  'members.manage': org('Members', 'Change member roles, suspend and remove members'),
  'roles.read': org('Roles', 'View roles'),
  'roles.manage': org('Roles', 'Create and edit custom roles'),
  'audit.read': org('Audit', 'View audit log'),
  'audit.export': org('Audit', 'Export audit log'),
  'api_keys.manage': org('Developers', 'Manage API keys'),

  // Workspace scope
  'workspace.read': ws('Workspace', 'Open workspace'),
  'workspace.update': ws('Workspace', 'Edit workspace settings'),
  'workspace_members.read': ws('Workspace', 'View workspace members'),
  'workspace_members.manage': ws('Workspace', 'Add, remove and change workspace members'),
  'contacts.read': ws('Contacts', 'View contacts'),
  'contacts.create': ws('Contacts', 'Create contacts'),
  'contacts.update': ws('Contacts', 'Edit contacts'),
  'contacts.delete': ws('Contacts', 'Delete contacts'),
  'contacts.import': ws('Contacts', 'Import contacts'),
  'contacts.export': ws('Contacts', 'Export contacts'),
  'lists.read': ws('Audience', 'View lists'),
  'lists.manage': ws('Audience', 'Manage lists'),
  'segments.read': ws('Audience', 'View segments'),
  'segments.manage': ws('Audience', 'Manage segments'),
  'topics.read': ws('Audience', 'View topics'),
  'topics.manage': ws('Audience', 'Manage topics'),
  'consent.read': ws('Audience', 'View consent records'),
  'consent.manage': ws('Audience', 'Record and withdraw consent'),
  'scoring.read': ws('Audience', 'View scoring rules'),
  'scoring.manage': ws('Audience', 'Manage scoring rules'),
  'campaigns.read': ws('Campaigns', 'View campaigns'),
  'campaigns.create': ws('Campaigns', 'Create campaigns'),
  'campaigns.update': ws('Campaigns', 'Edit campaigns'),
  'campaigns.delete': ws('Campaigns', 'Delete campaigns'),
  'campaigns.send': ws('Campaigns', 'Send and schedule campaigns'),
  'campaigns.approve': ws('Campaigns', 'Approve campaigns'),
  'journeys.read': ws('Journeys', 'View journeys'),
  'journeys.create': ws('Journeys', 'Create journeys'),
  'journeys.update': ws('Journeys', 'Edit journeys'),
  'journeys.delete': ws('Journeys', 'Delete journeys'),
  'journeys.launch': ws('Journeys', 'Launch and pause journeys'),
  'journeys.approve': ws('Journeys', 'Approve journeys'),
  'templates.read': ws('Content', 'View templates'),
  'templates.manage': ws('Content', 'Manage templates'),
  'assets.read': ws('Content', 'View assets'),
  'assets.manage': ws('Content', 'Upload and delete assets'),
  'forms.read': ws('Content', 'View forms'),
  'forms.manage': ws('Content', 'Manage forms'),
  'reports.read': ws('Reports', 'View reports'),
  'reports.export': ws('Reports', 'Export reports'),
  'deliverability.read': ws('Settings', 'View deliverability'),
  'deliverability.manage': ws('Settings', 'Manage sender domains'),
  'integrations.read': ws('Settings', 'View integrations'),
  'integrations.manage': ws('Settings', 'Manage integrations and credentials'),
  'webhooks.read': ws('Settings', 'View webhooks'),
  'webhooks.manage': ws('Settings', 'Manage webhooks'),
} as const satisfies Record<string, PermissionMeta>;

export type Permission = keyof typeof PERMISSION_CATALOGUE;

export const PERMISSIONS = Object.keys(PERMISSION_CATALOGUE) as Permission[];

export function permissionsForScope(scope: PermissionScope): Permission[] {
  return PERMISSIONS.filter((p) => PERMISSION_CATALOGUE[p].scope === scope);
}

export function isPermission(value: string): value is Permission {
  return Object.hasOwn(PERMISSION_CATALOGUE, value);
}
