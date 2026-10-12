import { SetMetadata } from '@nestjs/common';
import type { Permission } from '@workeasy/shared';

/**
 * Every route declares exactly one access policy. A route without one is refused at runtime (fail closed) and
 * flagged by test/routes.test.ts.
 *
 *   public        – no session needed (login, register, health)
 *   user          – any signed-in user; acts only on their own data
 *   organization  – route has :orgId; caller must be an active member and hold `permission`
 *   workspace     – route has :workspaceId; caller needs organization membership + workspace access + `permission`
 *   token         – the ONLY authority is a signed token in the URL (e.g. an unsubscribe link, Phase 7.8). Session
 *                   cookies are ignored, so CSRF does not apply (a forged cross-site request carries no authority the
 *                   attacker does not already hold); the handler must verify the token before doing anything.
 */
export type AccessPolicy =
  | { kind: 'public' }
  | { kind: 'user' }
  | { kind: 'organization'; permission: Permission | null }
  | { kind: 'workspace'; permission: Permission | null }
  | { kind: 'token' };

export const ACCESS_POLICY = 'workeasy:access-policy';

export const Public = () => SetMetadata(ACCESS_POLICY, { kind: 'public' } satisfies AccessPolicy);
/** Authorized by a signed token in the URL only (see `token` above). */
export const TokenAuthorized = () => SetMetadata(ACCESS_POLICY, { kind: 'token' } satisfies AccessPolicy);
export const Authenticated = () => SetMetadata(ACCESS_POLICY, { kind: 'user' } satisfies AccessPolicy);
/** `null` permission = any active member may call it (still membership-checked). */
export const OrgAccess = (permission: Permission | null) =>
  SetMetadata(ACCESS_POLICY, { kind: 'organization', permission } satisfies AccessPolicy);
export const WorkspaceAccess = (permission: Permission | null) =>
  SetMetadata(ACCESS_POLICY, { kind: 'workspace', permission } satisfies AccessPolicy);

export interface RateLimitPolicy {
  /** Bucket name, e.g. "auth.login". */
  name: string;
  /** Bucket key: client IP, or the authenticated user. */
  by: 'ip' | 'user';
  limit: number;
  windowSeconds: number;
}

export const RATE_LIMIT_POLICY = 'workeasy:rate-limit';
export const RateLimit = (policy: RateLimitPolicy) => SetMetadata(RATE_LIMIT_POLICY, policy);
