import { randomBytes } from 'node:crypto';
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { ACCESS_POLICY, type AccessPolicy } from '../../../common/access.js';
import type { AppConfig } from '../../../config/env.js';
import { Errors } from '../../../common/errors.js';
import { APP_CONFIG } from '../../../infrastructure/providers.js';
import { hmac, safeEqual } from '../../../infrastructure/tokens.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_HEADER = 'x-csrf-token';

/**
 * Signed double-submit CSRF token (OWASP CSRF Prevention Cheat Sheet), bound to the session:
 *   token = nonce "." HMAC(SESSION_SECRET, nonce, sessionId | "anonymous")
 * A state-changing request must carry the same token in the cookie AND the X-CSRF-Token header, and the HMAC must
 * match the session making the request. An attacker can neither read our cookie nor forge the HMAC.
 * Defence in depth: SameSite=Lax cookies and an Origin check.
 */
export function issueCsrfToken(secret: string, sessionId: string | null): string {
  const nonce = randomBytes(18).toString('base64url');
  return `${nonce}.${hmac(secret, 'csrf', nonce, sessionId ?? 'anonymous')}`;
}

export function verifyCsrfToken(secret: string, sessionId: string | null, token: string): boolean {
  const [nonce, mac, extra] = token.split('.');
  if (!nonce || !mac || extra !== undefined) return false;
  return safeEqual(mac, hmac(secret, 'csrf', nonce, sessionId ?? 'anonymous'));
}

/** Global guard #2 (runs after authentication so the session binding is known). */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    if (SAFE_METHODS.has(req.method)) return true;

    const origin = req.headers.origin;
    if (origin && origin !== this.config.appOrigin) throw Errors.csrf();

    const header = req.headers[CSRF_HEADER];
    const cookie = req.cookies[this.config.cookies.csrfName];
    if (typeof header !== 'string' || !cookie || !safeEqual(header, cookie)) throw Errors.csrf();

    const sessionId = req.principal?.sessionId ?? null;
    if (verifyCsrfToken(this.config.sessionSecret, sessionId, header)) return true;
    // Public endpoints (login, register, reset…) also accept an anonymous-bound token, so a browser holding a
    // stale-but-valid session can still reach the sign-in form. The token must still be one we signed.
    const policy = this.reflector.getAllAndOverride<AccessPolicy | undefined>(ACCESS_POLICY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (policy?.kind === 'public' && sessionId && verifyCsrfToken(this.config.sessionSecret, null, header)) return true;
    throw Errors.csrf();
  }
}
