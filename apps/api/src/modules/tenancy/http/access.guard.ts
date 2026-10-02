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
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.getAllAndOverride<AccessPolicy | undefined>(ACCESS_POLICY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!policy || policy.kind === 'public' || policy.kind === 'user') return true;

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
}
