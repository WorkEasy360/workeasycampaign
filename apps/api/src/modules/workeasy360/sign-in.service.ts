import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Database, isUniqueViolation } from '@workeasy/db';
import type { RequestMeta, TenantRequestContext } from '../../common/request-context.js';
import { DATABASE } from '../../infrastructure/providers.js';
import { SessionService } from '../identity/application/session.service.js';
import type { AuthenticatedPrincipal } from '../identity/domain/principal.js';
import { OrganizationsService } from '../tenancy/application/organizations.service.js';
import { inTenant } from '../tenancy/application/tenant-tx.js';
import { Workeasy360Error, type Workeasy360Identity } from './client.js';
import { WORKEASY360_RUNTIME, type Workeasy360Runtime } from './runtime.js';

/** How long a sign-in may take between the redirect to WorkEasy360 and the callback. */
export const FLOW_TTL_SECONDS = 600;
/** A provider-defined label for an organization created on a first sign-in; never used as a key. */
const ORGANIZATION_NAME_FALLBACK = 'My organization';

/**
 * Why a WorkEasy360 sign-in did not complete, as the sign-in page shows it (`/login?sso_error=<code>`). A fixed
 * vocabulary: never a token, a code, a state or the provider's description.
 */
export type SsoErrorCode =
  | 'not_configured'
  | 'expired'
  | 'unavailable'
  | 'rate_limited'
  | 'cancelled'
  | 'refused'
  | 'invalid_token'
  | 'wrong_product'
  | 'no_organization'
  | 'email_unverified'
  | 'wrong_organization'
  | 'not_entitled'
  | 'membership_inactive'
  | 'organization_inactive'
  | 'integration_suspended'
  | 'access_policy_denied'
  | 'access_unverified'
  | 'account_exists'
  | 'identity_conflict'
  | 'account_disabled'
  | 'organization_unavailable'
  | 'organization_not_linked'
  | 'membership_suspended';

/** The provider's OAuth error codes (OIDC contract §7) that have their own message here. */
const PROVIDER_ERRORS: Record<string, SsoErrorCode> = {
  access_denied: 'cancelled',
  invalid_grant: 'expired',
  product_not_entitled: 'not_entitled',
  membership_inactive: 'membership_inactive',
  organization_inactive: 'organization_inactive',
  integration_suspended: 'integration_suspended',
  access_policy_denied: 'access_policy_denied',
  temporarily_unavailable: 'unavailable',
  server_error: 'unavailable',
};

/** Entitlement reasons (entitlement API §4) the sign-in page has a message for. */
export const DENIAL_REASONS = new Set(['not_entitled', 'expired', 'suspended', 'read_only', 'membership_inactive', 'no_seat']);

export class SignInRefused extends Error {
  constructor(
    readonly code: SsoErrorCode,
    readonly detail: string,
    readonly reason?: string,
  ) {
    super(detail);
  }
}

export function ssoErrorFor(err: unknown): SsoErrorCode {
  if (err instanceof SignInRefused) return err.code;
  if (err instanceof Workeasy360Error) {
    switch (err.code) {
      case 'state_mismatch':
        return 'expired';
      case 'sign_in_refused':
        return PROVIDER_ERRORS[err.detail] ?? 'refused';
      case 'wrong_product':
      case 'no_organization':
      case 'email_unverified':
      case 'invalid_token':
      case 'rate_limited':
        return err.code;
      case 'provider_refused':
        return 'access_unverified';
      default:
        return 'unavailable';
    }
  }
  return 'unavailable';
}

export function providerErrorCode(error: string): SsoErrorCode {
  return PROVIDER_ERRORS[error] ?? 'refused';
}

/** Safe to log: our own words, never a token or code. */
export function describe(err: unknown): string {
  if (err instanceof SignInRefused || err instanceof Workeasy360Error) return err.detail || (err instanceof Workeasy360Error ? err.code : '');
  return err instanceof Error ? err.name : 'unknown';
}

export const hashFlowId = (flowId: string) => createHash('sha256').update(flowId, 'utf8').digest('hex');

export interface CompletedSignIn {
  token: string;
  principal: AuthenticatedPrincipal;
  orgId: string;
  organizationCreated: boolean;
}

/**
 * The WorkEasy360 sign-in flow (docs/workeasy360-sso.md §What happens): start keeps state, nonce and the PKCE
 * verifier server-side; the callback verifies everything, maps the WorkEasy360 organization to its organization
 * here, and opens a session bound to that one organization.
 */
@Injectable()
export class Workeasy360SignInService {
  private readonly logger = new Logger('Workeasy360');

  constructor(
    @Inject(WORKEASY360_RUNTIME) private readonly runtime: Workeasy360Runtime | null,
    @Inject(DATABASE) private readonly db: Database,
    private readonly sessions: SessionService,
    private readonly organizations: OrganizationsService,
  ) {}

  get enabled(): boolean {
    return this.runtime !== null;
  }

  /** Builds the authorization request and saves the flow; returns the provider URL and the browser's flow id. */
  async start(options: { organizationId?: string | undefined; returnTo?: string | undefined }): Promise<{ url: string; flowId: string }> {
    const runtime = this.require();
    const request = await runtime.client.beginLogin({ organizationId: options.organizationId });
    const flowId = randomBytes(32).toString('base64url');
    await this.db.system.workeasy360.saveLoginFlow(
      hashFlowId(flowId),
      {
        state: request.state,
        nonce: request.nonce,
        codeVerifier: request.codeVerifier,
        organizationHint: options.organizationId ?? null,
        returnTo: options.returnTo ?? null,
      },
      FLOW_TTL_SECONDS,
    );
    return { url: request.url.toString(), flowId };
  }

  /** Takes (deletes) the browser's pending flow: whatever happens next, it cannot be used again. */
  takeFlow(flowId: string) {
    return this.db.system.workeasy360.takeLoginFlow(hashFlowId(flowId));
  }

  /**
   * The callback: state (constant time), code exchange with private_key_jwt + PKCE, ID token verification, the
   * launcher's organization, entitlement, (issuer, sub) linking, organization mapping, membership, then a new session
   * bound to that organization. `previousToken` (the browser's current session, if any) ends first.
   */
  async complete(
    query: URLSearchParams,
    flow: { state: string; nonce: string; codeVerifier: string; organizationHint: string | null },
    meta: RequestMeta,
    previousToken: string | undefined,
  ): Promise<CompletedSignIn> {
    const runtime = this.require();
    const identity = await runtime.client.completeLogin(query, flow);
    if (flow.organizationHint && identity.organizationId !== flow.organizationHint) {
      // The launcher asked for one organization and the token is for another: land nowhere.
      throw new SignInRefused('wrong_organization', 'organization_id differs from the launcher\'s');
    }

    // Entitlement when the person arrives (integration guide §7): asked afresh, for the organization and the person.
    const access = await runtime.entitlements.check(identity.organizationId, { subject: identity.subject, fresh: true });
    if (access.status === 'refused') throw new SignInRefused('access_unverified', 'the provider refused this product\'s client');
    if (!access.allowed) throw new SignInRefused('not_entitled', `entitlement denied (${access.reason})`, access.reason);

    const link = await this.db.system.workeasy360.linkIdentity({
      issuer: identity.issuer,
      subject: identity.subject,
      email: identity.email,
      displayName: (identity.name ?? identity.email.split('@')[0] ?? identity.email).slice(0, 100),
    });
    if (link.userId === null) {
      if (link.outcome === 'issuer_conflict') throw new SignInRefused('identity_conflict', 'this subject is linked under another issuer: run move-issuer');
      // Never merged by email: an operator links the two accounts explicitly (docs/workeasy360-sso.md).
      throw new SignInRefused('account_exists', 'the email belongs to an account not linked to this WorkEasy360 identity');
    }
    const userId = link.userId;
    const user = await this.db.asUser(userId, (tx) => tx.user.findUnique({ where: { id: userId }, select: { status: true, email: true, displayName: true } }));
    if (user?.status !== 'active') throw new SignInRefused('account_disabled', 'the account here is deactivated');

    const principal: AuthenticatedPrincipal = {
      userId,
      email: user.email,
      displayName: user.displayName,
      emailVerified: true,
      sessionId: 'workeasy360-sign-in',
      provider: 'workeasy360',
      authMethods: ['workeasy360'],
      workeasy360: null,
    };
    const { orgId, created } = await this.organizationFor(identity, principal, meta, runtime);

    // Account switching and session fixation: whatever session this browser holds ends here.
    if (previousToken) {
      const previous = await this.sessions.verify(previousToken, meta).catch(() => null);
      if (previous) await this.sessions.revoke(previous.principal.userId, previous.principal.sessionId, 'replaced_by_workeasy360_sign_in');
    }

    const { token, sessionId } = await this.sessions.create(userId, 'workeasy360', ['workeasy360'], meta, {
      issuer: identity.issuer,
      subject: identity.subject,
      sid: identity.sid ?? null,
      organizationId: identity.organizationId,
      boundOrgId: orgId,
      idToken: identity.idToken,
    });
    await this.db.system.recordSecurityEvent({
      userId,
      type: 'auth.login_succeeded',
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      correlationId: meta.requestId,
      metadata: { provider: 'workeasy360', sessionId, organizationId: orgId, organizationCreated: created, sid: Boolean(identity.sid) },
    });
    const verified = await this.sessions.verify(token, meta);
    if (!verified) throw new SignInRefused('account_disabled', 'the new session did not verify');
    return { token, principal: verified.principal, orgId, organizationCreated: created };
  }

  /**
   * The organization here for the token's WorkEasy360 organization: the linked one, or (first sign-in, provisioning
   * on) a new one. Never another: an organization is reached only through its own link.
   */
  private async organizationFor(identity: Workeasy360Identity, principal: AuthenticatedPrincipal, meta: RequestMeta, runtime: Workeasy360Runtime): Promise<{ orgId: string; created: boolean }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const tenant = await this.db.system.workeasy360.tenantOf(identity.organizationId);
      if (tenant) {
        if (tenant.status !== 'active') throw new SignInRefused('organization_unavailable', `organization is ${tenant.status}`);
        await this.join(tenant.orgId, principal, meta, runtime);
        return { orgId: tenant.orgId, created: false };
      }
      if (!runtime.settings.provisionOrganizations) throw new SignInRefused('organization_not_linked', 'no organization is linked to this WorkEasy360 organization');
      try {
        const created = await this.organizations.create(
          { principal, meta },
          { name: (identity.organizationName ?? ORGANIZATION_NAME_FALLBACK).slice(0, 100), workspace: { name: 'Main', timezone: 'UTC' } },
          { workeasy360OrganizationId: identity.organizationId },
        );
        this.logger.log(JSON.stringify({ msg: 'organization created by a first WorkEasy360 sign-in', orgId: created.organization.id, requestId: meta.requestId }));
        return { orgId: created.organization.id, created: true };
      } catch (err) {
        // A concurrent first sign-in from the same organization created it first: join that one.
        if (attempt === 0 && (isUniqueViolation(err) || (err as { code?: string }).code === 'conflict')) continue;
        throw err;
      }
    }
    throw new SignInRefused('organization_unavailable', 'the organization could not be resolved');
  }

  /**
   * Membership in a linked organization. Active: kept, with its role. Suspended here: refused (an owner reactivates it
   * under Members). None, or removed: joined with WORKEASY360_DEFAULT_ROLE and, unless "none", a role in the first
   * workspace - membership of the organization is decided in WorkEasy360.
   */
  private async join(orgId: string, principal: AuthenticatedPrincipal, meta: RequestMeta, runtime: Workeasy360Runtime): Promise<void> {
    const ctx: TenantRequestContext = { principal, meta, access: { orgId, workspaceId: null, orgRoleKey: null, permissions: new Set(), workspaceAccess: null } };
    try {
      await inTenant(this.db, ctx, async ({ tx, audit, event }) => {
        const existing = await tx.organizationMembership.findUnique({ where: { orgId_userId: { orgId, userId: principal.userId } } });
        if (existing?.status === 'active') return;
        if (existing?.status === 'suspended') throw new SignInRefused('membership_suspended', 'membership is suspended here');
        const role = await tx.role.findFirst({ where: { orgId, scope: 'organization', key: runtime.settings.defaultRole, deletedAt: null } });
        if (!role) throw new SignInRefused('organization_unavailable', `the organization has no ${runtime.settings.defaultRole} role`);
        const membershipId = existing
          ? (await tx.organizationMembership.update({
              where: { id: existing.id },
              data: { status: 'active', roleId: role.id, removedAt: null, suspendedAt: null, joinedAt: new Date(), updatedAt: new Date(), version: { increment: 1 } },
            })).id
          : (await tx.organizationMembership.create({ data: { orgId, userId: principal.userId, roleId: role.id } })).id;
        await audit({ action: 'member.joined_via_workeasy360', targetType: 'user', targetId: principal.userId, metadata: { email: principal.email, role: role.key, rejoined: Boolean(existing) } });
        await event('membership.added', membershipId, { userId: principal.userId, roleId: role.id, via: 'workeasy360' });

        const wsRoleKey = runtime.settings.defaultWorkspaceRole;
        if (!wsRoleKey) return;
        const workspace = await tx.workspace.findFirst({ where: { status: 'active' }, orderBy: { createdAt: 'asc' }, select: { id: true } });
        const wsRole = workspace ? await tx.role.findFirst({ where: { orgId, scope: 'workspace', key: wsRoleKey, deletedAt: null } }) : null;
        if (!workspace || !wsRole) return;
        const already = await tx.workspaceMembership.findUnique({ where: { workspaceId_userId: { workspaceId: workspace.id, userId: principal.userId } } });
        if (already) return;
        const created = await tx.workspaceMembership.create({ data: { orgId, workspaceId: workspace.id, userId: principal.userId, roleId: wsRole.id } });
        await event('workspace_membership.added', created.id, { userId: principal.userId, roleId: wsRole.id }, { workspaceId: workspace.id });
      });
    } catch (err) {
      // Two sign-ins of the same person at once: the other one created the membership.
      if (isUniqueViolation(err)) return;
      throw err;
    }
  }

  private require(): Workeasy360Runtime {
    if (!this.runtime) throw new SignInRefused('not_configured', 'WORKEASY360_ISSUER is not set');
    return this.runtime;
  }
}
