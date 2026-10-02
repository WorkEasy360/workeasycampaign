import { isPermission, type Permission, type PermissionScope, PERMISSION_CATALOGUE, permissionsForScope } from '@workeasy/shared';

/**
 * Effective-permission rules. Deliberately small and explicit (docs/tenancy.md §RBAC):
 *
 *  1. Organization permissions = the org-scope permissions of the member's organization role,
 *     only while the organization membership is ACTIVE.
 *  2. Workspace permissions =
 *       a. all workspace permissions, if the org role holds `workspaces.access_all`; else
 *       b. the workspace-scope permissions of the member's explicit workspace role; else
 *       c. none (the workspace is invisible → 404).
 *  3. An ARCHIVED workspace grants read permissions only.
 *  There is no other inheritance.
 */

export function scopedPermissions(raw: readonly string[], scope: PermissionScope): Permission[] {
  return raw.filter((p): p is Permission => isPermission(p) && PERMISSION_CATALOGUE[p].scope === scope);
}

export interface MembershipFacts {
  orgMembershipStatus: string;
  orgRolePermissions: readonly string[];
  /** Null when the user has no explicit membership of the workspace. */
  workspaceRolePermissions: readonly string[] | null;
  workspaceStatus?: string;
}

export function organizationPermissions(f: Pick<MembershipFacts, 'orgMembershipStatus' | 'orgRolePermissions'>): Set<Permission> {
  if (f.orgMembershipStatus !== 'active') return new Set();
  return new Set(scopedPermissions(f.orgRolePermissions, 'organization'));
}

export function workspacePermissions(
  f: MembershipFacts,
): { permissions: Set<Permission>; access: 'organization' | 'explicit' } | null {
  const org = organizationPermissions(f);
  if (f.orgMembershipStatus !== 'active') return null;
  let granted: Permission[];
  let access: 'organization' | 'explicit';
  if (org.has('workspaces.access_all')) {
    granted = permissionsForScope('workspace');
    access = 'organization';
  } else if (f.workspaceRolePermissions) {
    granted = scopedPermissions(f.workspaceRolePermissions, 'workspace');
    access = 'explicit';
  } else {
    return null;
  }
  if (f.workspaceStatus === 'archived') granted = granted.filter((p) => p.endsWith('.read'));
  return { permissions: new Set([...org, ...granted]), access };
}

/**
 * Anti-escalation: an actor may grant (assign, invite with, or put into a custom role) only permissions they hold
 * themselves in the SAME scope — organization permissions for org roles, their effective permissions in that
 * particular workspace for workspace roles. Owners are exempt. Only owners may grant the owner role.
 */
export function canGrant(params: {
  /** Organization permissions for org-scope grants; effective permissions in the target workspace otherwise. */
  actorPermissions: ReadonlySet<Permission>;
  actorIsOwner: boolean;
  targetRoleKey: string | null;
  targetPermissions: readonly string[];
  scope: PermissionScope;
}): { ok: true } | { ok: false; reason: string } {
  if (params.targetRoleKey === 'owner' && !params.actorIsOwner) {
    return { ok: false, reason: 'Only an owner can make someone an owner' };
  }
  if (params.actorIsOwner) return { ok: true };
  const missing = scopedPermissions(params.targetPermissions, params.scope).filter((p) => !params.actorPermissions.has(p));
  return missing.length
    ? { ok: false, reason: `You cannot grant permissions you do not have: ${missing.join(', ')}` }
    : { ok: true };
}
