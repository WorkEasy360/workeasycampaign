import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ACCESS_POLICY, type AccessPolicy } from '../../../common/access.js';
import { Errors } from '../../../common/errors.js';
import { requestMeta } from '../../../common/request-context.js';
import type { AppConfig } from '../../../config/env.js';
import { APP_CONFIG } from '../../../infrastructure/providers.js';
import { AuthenticationService } from '../application/authentication.service.js';
import { clearSessionCookie, setSessionCookie } from './cookies.js';

/**
 * Global guard #1. Resolves the session cookie on EVERY request (so revocation and deactivation take effect on the
 * next request), then enforces that every route declares an access policy and that non-public routes have a
 * principal.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthenticationService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.getAllAndOverride<AccessPolicy | undefined>(ACCESS_POLICY, [
      context.getHandler(),
      context.getClass(),
    ]);
    // Fail closed: a route nobody classified is not reachable.
    if (!policy) throw Errors.forbidden('This endpoint has no access policy');

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    const token = req.cookies[this.config.cookies.sessionName];

    if (token) {
      const verified = await this.auth.verifySession(token, requestMeta(req));
      if (verified) {
        req.principal = verified.principal;
        if (verified.rotatedToken) setSessionCookie(reply, this.config, verified.rotatedToken);
      } else {
        clearSessionCookie(reply, this.config);
      }
    }

    if (policy.kind === 'public') return true;
    if (!req.principal) throw Errors.unauthenticated();
    return true;
  }
}
