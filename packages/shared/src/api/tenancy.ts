import { z } from 'zod';
import type { Permission, PermissionScope } from '../permissions.js';

const name = z.string().trim().min(1, { error: 'Enter a name' }).max(100);
const slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, { error: 'Use at least 3 characters' })
  .max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { error: 'Use lowercase letters, numbers and single hyphens' });

export const TIMEZONE_REGEX = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/;
const timezone = z.string().max(64).regex(TIMEZONE_REGEX);

export const createOrganizationRequest = z.object({
  name,
  slug: slug.optional(),
  workspace: z.object({ name, timezone: timezone.default('UTC') }),
});
export type CreateOrganizationRequest = z.infer<typeof createOrganizationRequest>;

export const updateOrganizationRequest = z.object({ name, version: z.number().int().positive() });
export const deleteOrganizationRequest = z.object({ confirmName: z.string() });

export const createWorkspaceRequest = z.object({ name, timezone: timezone.default('UTC') });
export const updateWorkspaceRequest = z.object({
  name: name.optional(),
  timezone: timezone.optional(),
  version: z.number().int().positive(),
});

export const switchContextRequest = z.object({
  organizationId: z.uuid(),
  workspaceId: z.uuid().nullable(),
});

const workspaceGrant = z.object({ workspaceId: z.uuid(), roleId: z.uuid() });

export const createInvitationRequest = z.object({
  email: z.string().trim().max(254).pipe(z.email({ error: 'Enter a valid email address' })),
  organizationRoleId: z.uuid(),
  workspaces: z.array(workspaceGrant).max(50).default([]),
});
export type CreateInvitationRequest = z.infer<typeof createInvitationRequest>;

export const invitationTokenRequest = z.object({ token: z.string().min(20).max(200) });

export const updateOrganizationMemberRequest = z
  .object({
    roleId: z.uuid().optional(),
    status: z.enum(['active', 'suspended']).optional(),
    version: z.number().int().positive(),
  })
  .refine((v) => v.roleId !== undefined || v.status !== undefined, { error: 'Nothing to change' });

export const putWorkspaceMemberRequest = z.object({ roleId: z.uuid() });

export const createRoleRequest = z.object({
  name,
  description: z.string().trim().max(300).default(''),
  scope: z.enum(['organization', 'workspace']),
  permissions: z.array(z.string()).min(1).max(200),
});
export const updateRoleRequest = z.object({
  name: name.optional(),
  description: z.string().trim().max(300).optional(),
  permissions: z.array(z.string()).min(1).max(200).optional(),
  version: z.number().int().positive(),
});

export const auditLogQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
  action: z.string().max(100).optional(),
  actorId: z.uuid().optional(),
  workspaceId: z.uuid().optional(),
});

// ---- Response views ----

export type MembershipStatus = 'active' | 'suspended' | 'removed';

export interface RoleView {
  id: string;
  key: string | null;
  name: string;
  description: string;
  scope: PermissionScope;
  isSystem: boolean;
  permissions: Permission[];
  version: number;
  memberCount: number;
}

export interface OrganizationView {
  id: string;
  name: string;
  slug: string;
  role: { id: string; name: string };
  version: number;
}

export interface WorkspaceView {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  timezone: string;
  status: 'active' | 'archived';
  version: number;
}

export interface CurrentContext {
  user: { id: string; email: string; displayName: string; emailVerified: boolean };
  organization: { id: string; name: string; slug: string } | null;
  workspace: { id: string; name: string; slug: string; status: 'active' | 'archived' } | null;
  /** Effective permissions in the current org + workspace. UI hint only — the API re-checks every request. */
  permissions: Permission[];
}

export interface OrganizationMemberView {
  userId: string;
  email: string;
  displayName: string;
  status: MembershipStatus;
  role: { id: string; name: string };
  workspaceCount: number;
  joinedAt: string;
  version: number;
}

export interface WorkspaceMemberView {
  userId: string;
  email: string;
  displayName: string;
  role: { id: string; name: string };
  /** 'explicit' = workspace membership; 'organization' = implied by an org role with workspaces.access_all. */
  access: 'explicit' | 'organization';
}

export interface InvitationView {
  id: string;
  email: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  organizationRole: { id: string; name: string };
  workspaces: { id: string; name: string; role: { id: string; name: string } }[];
  invitedBy: { id: string; displayName: string } | null;
  expiresAt: string;
  createdAt: string;
}

export interface InvitationPreview {
  organizationName: string;
  email: string;
  expiresAt: string;
  status: InvitationView['status'];
}

export interface AuditLogView {
  id: string;
  occurredAt: string;
  action: string;
  outcome: 'success' | 'denied' | 'failure';
  actor: { type: string; id: string | null; displayName: string | null };
  target: { type: string | null; id: string | null };
  workspaceId: string | null;
  ipAddress: string | null;
  metadata: Record<string, unknown>;
}
