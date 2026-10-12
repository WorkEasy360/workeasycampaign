import { z } from 'zod';
import {
  auditLogQuery,
  usageSummaryQuery,
  usageSummarySchema,
  changePasswordRequest,
  createInvitationRequest,
  createOrganizationRequest,
  createRoleRequest,
  createWorkspaceRequest,
  deleteOrganizationRequest,
  forgotPasswordRequest,
  invitationTokenRequest,
  loginRequest,
  paginationQuery,
  putWorkspaceMemberRequest,
  registerRequest,
  resendVerificationRequest,
  resetPasswordRequest,
  switchContextRequest,
  updateOrganizationMemberRequest,
  updateOrganizationRequest,
  updateProfileRequest,
  updateRoleRequest,
  updateWorkspaceRequest,
  verifyEmailRequest,
} from '@workeasy/shared';
import type { RouteDoc } from './route-doc.js';

/** Response schema as JSON Schema (same helper as routes-campaigns). */
const out = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }) as Record<string, unknown>;
import { AUDIENCE_ROUTES } from './routes-audience.js';
import { CAMPAIGN_ROUTES, SENDER_ROUTES, TEMPLATE_ROUTES, UNSUBSCRIBE_ROUTES, WEBHOOK_ROUTES } from './routes-campaigns.js';

export type { RouteDoc } from './route-doc.js';

const r = (d: RouteDoc) => d;

/** Every HTTP route. test/api/routes.test.ts fails if a route exists without an entry here (or vice versa). */
export const ROUTES: RouteDoc[] = [
  r({ method: 'GET', path: '/health', tag: 'System', summary: 'Liveness probe', access: 'public', success: 200 }),
  r({ method: 'GET', path: '/health/ready', tag: 'System', summary: 'Readiness probe: PostgreSQL and (durable mode) the job queue, with latencies; 503 while a dependency is down or the process is draining', access: 'public', success: 200, errors: { 503: 'not ready' } }),
  r({ method: 'GET', path: '/metrics', tag: 'System', summary: 'Prometheus metrics (text format). Requires Authorization: Bearer METRICS_TOKEN; the route does not exist without one. Counts and latencies only — no ids, no personal data', access: 'token', success: 200, errors: { 401: 'missing or wrong token', 404: 'metrics not configured' } }),
  r({ method: 'GET', path: '/v1/openapi.json', tag: 'System', summary: 'This document', access: 'public', success: 200 }),

  r({ method: 'GET', path: '/v1/auth/csrf', tag: 'Authentication', summary: 'Issue a CSRF token (sets cookie)', access: 'public', success: 200 }),
  r({ method: 'GET', path: '/v1/auth/session', tag: 'Authentication', summary: 'Current session user, or null', access: 'public', success: 200 }),
  r({ method: 'POST', path: '/v1/auth/login', tag: 'Authentication', summary: 'Sign in with email and password', access: 'public', body: loginRequest, success: 200 }),
  r({ method: 'POST', path: '/v1/auth/logout', tag: 'Authentication', summary: 'Sign out (revokes this session)', access: 'user', success: 200 }),
  r({ method: 'POST', path: '/v1/auth/register', tag: 'Authentication', summary: 'Create an account (always 202; sends email)', access: 'public', body: registerRequest, success: 202 }),
  r({ method: 'POST', path: '/v1/auth/verify-email', tag: 'Authentication', summary: 'Confirm email with the emailed token', access: 'public', body: verifyEmailRequest, success: 200 }),
  r({ method: 'POST', path: '/v1/auth/resend-verification', tag: 'Authentication', summary: 'Resend verification email (always 202)', access: 'public', body: resendVerificationRequest, success: 202 }),
  r({ method: 'POST', path: '/v1/auth/forgot-password', tag: 'Authentication', summary: 'Request a reset link (always 202)', access: 'public', body: forgotPasswordRequest, success: 202 }),
  r({ method: 'POST', path: '/v1/auth/reset-password', tag: 'Authentication', summary: 'Set a new password; signs out every session', access: 'public', body: resetPasswordRequest, success: 200 }),

  r({ method: 'GET', path: '/v1/me', tag: 'Current user', summary: 'Signed-in user', access: 'user', success: 200 }),
  r({ method: 'PATCH', path: '/v1/me', tag: 'Current user', summary: 'Update profile', access: 'user', body: updateProfileRequest, success: 200 }),
  r({ method: 'POST', path: '/v1/me/password', tag: 'Current user', summary: 'Change password; signs out other sessions', access: 'user', body: changePasswordRequest, success: 200 }),
  r({ method: 'GET', path: '/v1/me/sessions', tag: 'Sessions', summary: 'Active sessions', access: 'user', success: 200 }),
  r({ method: 'DELETE', path: '/v1/me/sessions/{sessionId}', tag: 'Sessions', summary: 'Revoke a session', access: 'user', success: 204 }),
  r({ method: 'POST', path: '/v1/me/sessions/revoke-others', tag: 'Sessions', summary: 'Revoke all other sessions', access: 'user', success: 200 }),
  r({ method: 'GET', path: '/v1/me/security-events', tag: 'Current user', summary: 'Personal security log', access: 'user', query: paginationQuery, success: 200 }),
  r({ method: 'GET', path: '/v1/me/context', tag: 'Current context', summary: 'Current organization, workspace and effective permissions', access: 'user', success: 200 }),
  r({ method: 'PUT', path: '/v1/me/context', tag: 'Current context', summary: 'Switch organization/workspace (validated)', access: 'user', body: switchContextRequest, success: 200 }),
  r({ method: 'GET', path: '/v1/permissions', tag: 'Roles', summary: 'Permission catalogue', access: 'user', success: 200 }),

  r({ method: 'GET', path: '/v1/organizations', tag: 'Organizations', summary: 'Organizations I belong to', access: 'user', success: 200 }),
  r({ method: 'POST', path: '/v1/organizations', tag: 'Organizations', summary: 'Create organization + first workspace (requires verified email)', access: 'user', body: createOrganizationRequest, success: 201, idempotent: true }),
  r({ method: 'GET', path: '/v1/organizations/{orgId}', tag: 'Organizations', summary: 'Organization', access: 'organization:member', success: 200 }),
  r({ method: 'PATCH', path: '/v1/organizations/{orgId}', tag: 'Organizations', summary: 'Rename organization (optimistic version)', access: 'organization:org.update', body: updateOrganizationRequest, success: 200 }),
  r({ method: 'DELETE', path: '/v1/organizations/{orgId}', tag: 'Organizations', summary: 'Delete organization (type its name to confirm)', access: 'organization:org.delete', body: deleteOrganizationRequest, success: 204 }),
  r({ method: 'POST', path: '/v1/organizations/{orgId}/leave', tag: 'Organizations', summary: 'Leave organization', access: 'organization:member', success: 204 }),

  r({ method: 'GET', path: '/v1/organizations/{orgId}/workspaces', tag: 'Workspaces', summary: 'Workspaces I can enter', access: 'organization:member', success: 200 }),
  r({ method: 'POST', path: '/v1/organizations/{orgId}/workspaces', tag: 'Workspaces', summary: 'Create workspace', access: 'organization:workspaces.create', body: createWorkspaceRequest, success: 201, idempotent: true }),
  r({ method: 'POST', path: '/v1/organizations/{orgId}/workspaces/{workspaceId}/archive', tag: 'Workspaces', summary: 'Archive workspace (read-only)', access: 'organization:workspaces.manage', success: 200 }),
  r({ method: 'POST', path: '/v1/organizations/{orgId}/workspaces/{workspaceId}/restore', tag: 'Workspaces', summary: 'Restore workspace', access: 'organization:workspaces.manage', success: 200 }),
  r({ method: 'GET', path: '/v1/workspaces/{workspaceId}', tag: 'Workspaces', summary: 'Workspace and settings', access: 'workspace:workspace.read', success: 200 }),
  r({ method: 'PATCH', path: '/v1/workspaces/{workspaceId}', tag: 'Workspaces', summary: 'Update workspace (optimistic version)', access: 'workspace:workspace.update', body: updateWorkspaceRequest, success: 200 }),

  r({ method: 'GET', path: '/v1/organizations/{orgId}/members', tag: 'Members', summary: 'Organization members (cursor paginated)', access: 'organization:members.read', query: paginationQuery, success: 200 }),
  r({ method: 'PATCH', path: '/v1/organizations/{orgId}/members/{userId}', tag: 'Members', summary: 'Change role or suspend/reactivate', access: 'organization:members.manage', body: updateOrganizationMemberRequest, success: 204 }),
  r({ method: 'DELETE', path: '/v1/organizations/{orgId}/members/{userId}', tag: 'Members', summary: 'Remove member', access: 'organization:members.manage', success: 204 }),
  r({ method: 'GET', path: '/v1/workspaces/{workspaceId}/members', tag: 'Members', summary: 'Workspace members (explicit and organization-wide)', access: 'workspace:workspace_members.read', success: 200 }),
  r({ method: 'PUT', path: '/v1/workspaces/{workspaceId}/members/{userId}', tag: 'Members', summary: 'Add member to workspace or change their role', access: 'workspace:workspace_members.manage', body: putWorkspaceMemberRequest, success: 204 }),
  r({ method: 'DELETE', path: '/v1/workspaces/{workspaceId}/members/{userId}', tag: 'Members', summary: 'Remove member from workspace', access: 'workspace:workspace_members.manage', success: 204 }),

  r({ method: 'GET', path: '/v1/organizations/{orgId}/invitations', tag: 'Invitations', summary: 'Invitations', access: 'organization:members.read', success: 200 }),
  r({ method: 'POST', path: '/v1/organizations/{orgId}/invitations', tag: 'Invitations', summary: 'Invite by email', access: 'organization:members.invite', body: createInvitationRequest, success: 201, idempotent: true }),
  r({ method: 'DELETE', path: '/v1/organizations/{orgId}/invitations/{invitationId}', tag: 'Invitations', summary: 'Revoke invitation', access: 'organization:members.invite', success: 204 }),
  r({ method: 'POST', path: '/v1/organizations/{orgId}/invitations/{invitationId}/resend', tag: 'Invitations', summary: 'Resend with a new link', access: 'organization:members.invite', success: 204 }),
  r({ method: 'POST', path: '/v1/invitations/preview', tag: 'Invitations', summary: 'Describe an invitation token', access: 'public', body: invitationTokenRequest, success: 200 }),
  r({ method: 'POST', path: '/v1/invitations/accept', tag: 'Invitations', summary: 'Accept (signed in as the invited, verified email)', access: 'user', body: invitationTokenRequest, success: 200 }),

  r({ method: 'GET', path: '/v1/organizations/{orgId}/roles', tag: 'Roles', summary: 'Roles', access: 'organization:roles.read', success: 200 }),
  r({ method: 'POST', path: '/v1/organizations/{orgId}/roles', tag: 'Roles', summary: 'Create custom role', access: 'organization:roles.manage', body: createRoleRequest, success: 201 }),
  r({ method: 'PATCH', path: '/v1/organizations/{orgId}/roles/{roleId}', tag: 'Roles', summary: 'Update custom role', access: 'organization:roles.manage', body: updateRoleRequest, success: 200 }),
  r({ method: 'DELETE', path: '/v1/organizations/{orgId}/roles/{roleId}', tag: 'Roles', summary: 'Delete unused custom role', access: 'organization:roles.manage', success: 204 }),

  r({ method: 'GET', path: '/v1/organizations/{orgId}/audit-logs', tag: 'Audit', summary: 'Audit log (cursor paginated, filterable)', access: 'organization:audit.read', query: auditLogQuery, success: 200 }),
  r({ method: 'GET', path: '/v1/organizations/{orgId}/usage', tag: 'Usage', summary: 'Metered usage of the organization over a UTC period (default 30 days, max 400): counters summed, gauges at their latest daily snapshot, per workspace. Quantities only — no prices, plans or quotas', access: 'organization:billing.manage', query: usageSummaryQuery, success: 200, response: out(usageSummarySchema), errors: { 400: 'invalid period', 429: 'rate limited: 300 per user per hour' } }),
  r({ method: 'GET', path: '/v1/organizations/{orgId}/audit-logs/export', tag: 'Audit', summary: 'Export audit log as CSV (audited)', access: 'organization:audit.export', query: auditLogQuery, success: 200 }),
  ...AUDIENCE_ROUTES,
  ...CAMPAIGN_ROUTES,
  ...TEMPLATE_ROUTES,
  ...UNSUBSCRIBE_ROUTES,
  ...WEBHOOK_ROUTES,
  ...SENDER_ROUTES,
];
