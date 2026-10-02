import { type Permission, type PermissionScope, permissionsForScope } from '@workeasy/shared';

/**
 * System roles — authoritative, server-side (moved out of packages/shared in the foundation fixes).
 * Seeded into every organization at creation; immutable (custom roles cover everything else).
 *
 * Organization scope: owner, admin, member.   Workspace scope: workspace_admin, manager, editor, analyst, viewer.
 * Provenance: Manager/Editor/Viewer mirror Zoho's documented workspace roles [ZOHO_PARITY]; Owner, Analyst and the
 * explicit org/workspace split are ours [OUR_ORIGINAL_DESIGN] (docs/spec.md §M2).
 */
export interface SystemRoleDefinition {
  key: string;
  name: string;
  description: string;
  scope: PermissionScope;
  permissions: Permission[];
}

const ORG = permissionsForScope('organization');
const WS = permissionsForScope('workspace');
const reads = (perms: Permission[]) => perms.filter((p) => p.endsWith('.read'));
const without = (perms: Permission[], drop: (p: Permission) => boolean) => perms.filter((p) => !drop(p));

const MANAGER_EXCLUDED = new Set<Permission>([
  'workspace.update',
  'workspace_members.manage',
  'campaigns.approve',
  'journeys.approve',
  'deliverability.manage',
  'integrations.manage',
  'webhooks.manage',
  'scoring.manage',
]);
const manager = without(WS, (p) => MANAGER_EXCLUDED.has(p));
const EDITOR_EXCLUDED = new Set<Permission>([
  'campaigns.send',
  'journeys.launch',
  'consent.manage',
  'contacts.delete',
  'contacts.import',
]);
const editor = without(manager, (p) => EDITOR_EXCLUDED.has(p) || p.endsWith('.export'));

export const SYSTEM_ROLES: readonly SystemRoleDefinition[] = [
  {
    key: 'owner',
    name: 'Owner',
    description: 'Full control of the organization, including billing and deletion.',
    scope: 'organization',
    permissions: ORG,
  },
  {
    key: 'admin',
    name: 'Admin',
    description: 'Manages members, roles, workspaces and security. Cannot delete the organization or change billing.',
    scope: 'organization',
    permissions: without(ORG, (p) => p === 'org.delete' || p === 'billing.manage'),
  },
  {
    key: 'member',
    name: 'Member',
    description: 'Belongs to the organization. Works only in the workspaces they are added to.',
    scope: 'organization',
    permissions: ['org.read', 'members.read', 'roles.read'],
  },
  {
    key: 'workspace_admin',
    name: 'Workspace admin',
    description: 'Everything in this workspace, including its members and settings.',
    scope: 'workspace',
    permissions: WS,
  },
  {
    key: 'manager',
    name: 'Manager',
    description: 'Creates and sends campaigns, manages audiences and journeys. Cannot approve or change settings.',
    scope: 'workspace',
    permissions: manager,
  },
  {
    key: 'editor',
    name: 'Editor',
    description: 'Creates and edits content and campaigns. Cannot send, launch, import, delete or export.',
    scope: 'workspace',
    permissions: editor,
  },
  {
    key: 'analyst',
    name: 'Analyst',
    description: 'Reads everything in the workspace and exports reports.',
    scope: 'workspace',
    permissions: [...reads(WS), 'reports.export'],
  },
  {
    key: 'viewer',
    name: 'Viewer',
    description: 'Read-only access to the workspace.',
    scope: 'workspace',
    permissions: reads(WS),
  },
];

export const systemRole = (key: string): SystemRoleDefinition => {
  const r = SYSTEM_ROLES.find((x) => x.key === key);
  if (!r) throw new Error(`Unknown system role ${key}`);
  return r;
};
