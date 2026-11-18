import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Database } from '@workeasy/db';
import type { FastifyRequest } from 'fastify';
import { ACCESS_POLICY, type AccessPolicy } from '../../../common/access.js';
import { Errors } from '../../../common/errors.js';
import { requestMeta } from '../../../common/request-context.js';
import { routeId } from '../../../common/validation.js';
import { DATABASE } from '../../../infrastructure/providers.js';
import { recordAudit } from '../../audit/audit.js';
import { AccessService } from '../application/access.service.js';
import { WORKEASY360_RUNTIME, type Workeasy360Runtime } from '../../workeasy360/runtime.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** POSTs that change nothing (a read-only organization may still use them). Matched on the route template. */
const READ_ONLY_POSTS = [/\/eligibility\/check$/, /\/imports\/:importId\/dry-run$/, /\/campaigns\/:campaignId\/preflight$/];

/**
 * Global guard #4 (after authentication, CSRF and rate limiting).
 * organization/workspace routes: authenticated user + active org membership + (workspace access) + permission.
 *   - not a member / unknown id      → 404 (never confirms another tenant's resource exists)
 *   - member without the permission  → 403, recorded in the organization's audit log as access.denied
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: AccessService,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(WORKEASY360_RUNTIME) private readonly workeasy360: Workeasy360Runtime | null,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.getAllAndOverride<AccessPolicy | undefined>(ACCESS_POLICY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!policy || policy.kind === 'public' || policy.kind === 'user' || policy.kind === 'token') return true;

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const principal = req.principal;
    if (!principal) throw Errors.unauthenticated();
    if (!principal.emailVerified) throw Errors.emailNotVerified();
    const params = req.params as Record<string, string | undefined>;

    const resolved =
      policy.kind === 'organization'
        ? await this.access.organization(principal, routeId(params.orgId, 'Organization'))
        : await this.access.workspace(principal, routeId(params.workspaceId, 'Workspace'));
    if (!resolved) throw Errors.notFound(policy.kind === 'organization' ? 'Organization' : 'Workspace');
    if (resolved.workeasy360OrganizationId && this.workeasy360) await this.checkEntitlement(req, resolved.workeasy360OrganizationId);

    if (policy.permission && !resolved.permissions.has(policy.permission)) {
      await this.db.withTenant({ orgId: resolved.orgId, workspaceId: null, userId: principal.userId }, (tx) =>
        recordAudit(
          tx,
          { orgId: resolved.orgId, principal, meta: requestMeta(req) },
          {
            action: 'access.denied',
            outcome: 'denied',
            workspaceId: resolved.workspaceId,
            metadata: { permission: policy.permission, method: req.method, route: req.routeOptions.url },
          },
        ),
      );
      throw Errors.forbidden();
    }
    req.access = resolved;
    return true;
  }

  /**
   * An organization linked to WorkEasy360 is used only while WorkEasy360 says it (and, for a WorkEasy360 session, the
   * person) is entitled: asked on WorkEasy360's cadence, never per request (docs/workeasy360-sso.md §Entitlement).
   * The session itself stays valid, so the person sees why and can sign out.
   */
  private async checkEntitlement(req: FastifyRequest, organizationId: string): Promise<void> {
    const binding = req.principal?.workeasy360;
    const subject = binding && binding.organizationId === organizationId ? binding.subject : undefined;
    const access = await this.workeasy360!.entitlements.check(organizationId, { subject });
    if (access.status === 'refused') throw Errors.workeasy360AccessUnverified();
    if (!access.allowed) throw Errors.workeasy360AccessEnded(access.reason);
    const route = req.routeOptions.url ?? '';
    const write = !SAFE_METHODS.has(req.method) && !(req.method === 'POST' && READ_ONLY_POSTS.some((p) => p.test(route)));
    if (write && !access.writeAllowed) throw Errors.workeasy360ReadOnly();
  }
}
