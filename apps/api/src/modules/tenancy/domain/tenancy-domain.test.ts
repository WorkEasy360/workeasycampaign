import { PERMISSIONS, permissionsForScope } from '@workeasy/shared';
import { describe, expect, it } from 'vitest';
import { canGrant, organizationPermissions, workspacePermissions } from './access-policy.js';
import { slugify } from './slug.js';
import { SYSTEM_ROLES, systemRole } from './system-roles.js';

const perms = (key: string) => systemRole(key).permissions;

describe('system roles', () => {
  it('every role only contains permissions of its own scope', () => {
    for (const r of SYSTEM_ROLES) {
      const allowed = new Set(permissionsForScope(r.scope));
      expect(r.permissions.every((p) => allowed.has(p)), r.key).toBe(true);
    }
  });

  it('owner holds every organization permission; admin cannot delete the org or manage billing', () => {
    expect(perms('owner')).toEqual(permissionsForScope('organization'));
    expect(perms('admin')).not.toContain('org.delete');
    expect(perms('admin')).not.toContain('billing.manage');
    expect(perms('admin')).toContain('workspaces.access_all');
  });

  it('a plain member has no administrative organization permissions', () => {
    expect(perms('member')).toEqual(['org.read', 'members.read', 'roles.read']);
  });

  it('editor creates but cannot send, launch, import, delete or export; manager can send but not approve', () => {
    expect(perms('editor')).toContain('campaigns.create');
    for (const p of ['campaigns.send', 'journeys.launch', 'contacts.import', 'contacts.delete', 'contacts.export']) {
      expect(perms('editor')).not.toContain(p);
    }
    expect(perms('manager')).toContain('campaigns.send');
    expect(perms('manager')).not.toContain('campaigns.approve');
    expect(perms('manager')).not.toContain('workspace_members.manage');
  });

  it('viewer is read-only and analyst adds only report export', () => {
    expect(perms('viewer').every((p) => p.endsWith('.read'))).toBe(true);
    expect(perms('analyst').filter((p) => !p.endsWith('.read'))).toEqual(['reports.export']);
  });

  it('the catalogue and roles stay in sync (no role references an unknown permission)', () => {
    const known = new Set(PERMISSIONS);
    for (const r of SYSTEM_ROLES) for (const p of r.permissions) expect(known.has(p)).toBe(true);
  });
});

describe('effective permissions', () => {
  it('suspended or removed members have no organization permissions', () => {
    expect(organizationPermissions({ orgMembershipStatus: 'suspended', orgRolePermissions: perms('owner') }).size).toBe(0);
    expect(organizationPermissions({ orgMembershipStatus: 'removed', orgRolePermissions: perms('owner') }).size).toBe(0);
  });

  it('ignores permissions of the wrong scope or unknown strings stored on a role', () => {
    const p = organizationPermissions({ orgMembershipStatus: 'active', orgRolePermissions: ['org.read', 'campaigns.send', 'bogus'] });
    expect([...p]).toEqual(['org.read']);
  });

  it('org admins administer every workspace; plain members need an explicit workspace role', () => {
    const admin = workspacePermissions({ orgMembershipStatus: 'active', orgRolePermissions: perms('admin'), workspaceRolePermissions: null });
    expect(admin?.access).toBe('organization');
    expect(admin?.permissions.has('workspace_members.manage')).toBe(true);

    expect(workspacePermissions({ orgMembershipStatus: 'active', orgRolePermissions: perms('member'), workspaceRolePermissions: null })).toBeNull();

    const viewer = workspacePermissions({
      orgMembershipStatus: 'active',
      orgRolePermissions: perms('member'),
      workspaceRolePermissions: perms('viewer'),
    });
    expect(viewer?.access).toBe('explicit');
    expect(viewer?.permissions.has('campaigns.read')).toBe(true);
    expect(viewer?.permissions.has('campaigns.create')).toBe(false);
  });

  it('a suspended org member loses workspace access even with a workspace role', () => {
    expect(
      workspacePermissions({ orgMembershipStatus: 'suspended', orgRolePermissions: perms('member'), workspaceRolePermissions: perms('workspace_admin') }),
    ).toBeNull();
  });

  it('archived workspaces are read-only for everyone', () => {
    const r = workspacePermissions({
      orgMembershipStatus: 'active',
      orgRolePermissions: perms('owner'),
      workspaceRolePermissions: null,
      workspaceStatus: 'archived',
    });
    expect([...r!.permissions].filter((p) => permissionsForScope('workspace').includes(p)).every((p) => p.endsWith('.read'))).toBe(true);
  });
});

describe('anti-escalation', () => {
  const adminPerms = new Set(perms('admin'));
  it('only owners can grant the owner role', () => {
    expect(canGrant({ actorPermissions: adminPerms, actorIsOwner: false, targetRoleKey: 'owner', targetPermissions: perms('owner'), scope: 'organization' }).ok).toBe(false);
    expect(canGrant({ actorPermissions: new Set(perms('owner')), actorIsOwner: true, targetRoleKey: 'owner', targetPermissions: perms('owner'), scope: 'organization' }).ok).toBe(true);
  });
  it('an admin cannot grant a custom role containing permissions the admin lacks', () => {
    const r = canGrant({ actorPermissions: adminPerms, actorIsOwner: false, targetRoleKey: null, targetPermissions: ['org.delete'], scope: 'organization' });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('org.delete') });
  });
  it('a workspace manager cannot grant workspace_admin; a workspace admin can grant any workspace role', () => {
    const managerPerms = new Set(perms('manager'));
    expect(canGrant({ actorPermissions: managerPerms, actorIsOwner: false, targetRoleKey: 'workspace_admin', targetPermissions: perms('workspace_admin'), scope: 'workspace' }).ok).toBe(false);
    expect(canGrant({ actorPermissions: managerPerms, actorIsOwner: false, targetRoleKey: 'viewer', targetPermissions: perms('viewer'), scope: 'workspace' }).ok).toBe(true);
    const wsAdmin = new Set(perms('workspace_admin'));
    expect(canGrant({ actorPermissions: wsAdmin, actorIsOwner: false, targetRoleKey: 'workspace_admin', targetPermissions: perms('workspace_admin'), scope: 'workspace' }).ok).toBe(true);
  });
});

describe('slugify', () => {
  it('produces url-safe slugs', () => {
    expect(slugify('Acme Marketing, Inc.')).toBe('acme-marketing-inc');
    expect(slugify('Café Déjà Vu')).toBe('cafe-deja-vu');
    expect(slugify('!!')).toMatch(/^org-[a-z0-9]{4}$/);
  });
});
