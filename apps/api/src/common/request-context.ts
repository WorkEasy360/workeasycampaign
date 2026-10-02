import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Permission } from '@workeasy/shared';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedPrincipal } from '../modules/identity/domain/principal.js';

/** Facts about the HTTP request that services may record (audit, security events). */
export interface RequestMeta {
  /** Also used as the correlation id for audit logs and domain events. */
  requestId: string;
  /** Client IP as resolved through TRUST_PROXY — never a raw X-Forwarded-For value. */
  ipAddress: string | null;
  userAgent: string | null;
}

/** Resolved, authorized tenant context for organization/workspace routes. */
export interface AccessContext {
  orgId: string;
  workspaceId: string | null;
  orgRoleKey: string | null;
  permissions: ReadonlySet<Permission>;
  /** How workspace access was granted (explicit membership, or an organization-wide permission). */
  workspaceAccess: 'explicit' | 'organization' | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: AuthenticatedPrincipal;
    access?: AccessContext;
    /** Set when the session token was rotated during this request; the response must carry the new cookie. */
    rotatedSessionToken?: string;
  }
}

export function requestMeta(req: FastifyRequest): RequestMeta {
  const ua = req.headers['user-agent'];
  return {
    requestId: String(req.id),
    ipAddress: req.ip ?? null,
    userAgent: typeof ua === 'string' ? ua.slice(0, 512) : null,
  };
}

export interface UserRequestContext {
  principal: AuthenticatedPrincipal;
  meta: RequestMeta;
}

export interface TenantRequestContext extends UserRequestContext {
  access: AccessContext;
}

/** Controller parameter: the authenticated principal plus request metadata. */
export const UserCtx = createParamDecorator((_: unknown, ctx: ExecutionContext): UserRequestContext => {
  const req = ctx.switchToHttp().getRequest<FastifyRequest>();
  if (!req.principal) throw new Error('UserCtx used on a route without authentication');
  return { principal: req.principal, meta: requestMeta(req) };
});

/** Controller parameter: principal + authorized organization/workspace access, resolved by AccessGuard. */
export const TenantCtx = createParamDecorator((_: unknown, ctx: ExecutionContext): TenantRequestContext => {
  const req = ctx.switchToHttp().getRequest<FastifyRequest>();
  if (!req.principal || !req.access) throw new Error('TenantCtx used on a route without tenant access');
  return { principal: req.principal, access: req.access, meta: requestMeta(req) };
});

export const Meta = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestMeta =>
  requestMeta(ctx.switchToHttp().getRequest<FastifyRequest>()),
);
