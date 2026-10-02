import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@workeasy/db';
import type { SessionSummary } from '@workeasy/shared';
import type { RequestMeta } from '../../../common/request-context.js';
import { DATABASE } from '../../../infrastructure/providers.js';
import { hashToken, newToken } from '../../../infrastructure/tokens.js';
import type { AuthenticatedPrincipal } from '../domain/principal.js';

/** Session lifetime policy (docs/identity.md §Sessions). */
export const SESSION_POLICY = {
  idleSeconds: 7 * 24 * 3600,
  absoluteSeconds: 30 * 24 * 3600,
  /** Token is replaced at most this often while the session is in use. */
  rotateAfterSeconds: 3600,
  /** The replaced token keeps working this long so in-flight parallel requests do not fail. */
  rotationGraceSeconds: 60,
  /** last_seen_at / idle expiry are refreshed at most this often (avoids a write per request). */
  touchAfterSeconds: 60,
} as const;

export interface VerifiedSession {
  principal: AuthenticatedPrincipal;
  /** Present when the token was rotated; the caller must send it back as the new cookie. */
  rotatedToken: string | null;
  /** True when this request is the first to cross the rotation interval (provider refresh is due). */
  refreshDue: boolean;
}

/**
 * Platform sessions: opaque random tokens, stored only as SHA-256, independent of the identity provider.
 * Any provider (local, SSO) ends in `create`; every request goes through `verify`.
 */
@Injectable()
export class SessionService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async create(
    userId: string,
    provider: string,
    authMethods: string[],
    meta: RequestMeta,
  ): Promise<{ token: string; sessionId: string }> {
    const token = newToken();
    const now = Date.now();
    const session = await this.db.asUser(userId, async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { lastLoginAt: new Date(now), updatedAt: new Date(now) } });
      return tx.session.create({
        data: {
          userId,
          tokenHash: hashToken(token),
          provider,
          authMethods,
          idleExpiresAt: new Date(now + SESSION_POLICY.idleSeconds * 1000),
          absoluteExpiresAt: new Date(now + SESSION_POLICY.absoluteSeconds * 1000),
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        },
      });
    });
    return { token, sessionId: session.id };
  }

  /** Resolve a cookie token to a principal. Returns null for unknown, revoked, expired or deactivated. */
  async verify(token: string, meta: RequestMeta): Promise<VerifiedSession | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const tokenHash = hashToken(token);
    const s = await this.db.system.resolveSession(tokenHash);
    const now = Date.now();
    if (
      !s ||
      s.revokedAt ||
      s.userStatus !== 'active' ||
      s.idleExpiresAt.getTime() <= now ||
      s.absoluteExpiresAt.getTime() <= now
    ) {
      return null;
    }

    const principal: AuthenticatedPrincipal = {
      userId: s.userId,
      email: s.userEmail,
      displayName: s.userDisplayName,
      emailVerified: s.userEmailVerified,
      sessionId: s.sessionId,
      provider: s.provider,
      authMethods: s.authMethods,
    };

    let rotatedToken: string | null = null;
    let refreshDue = false;
    const rotationDue = !s.isPreviousToken && now - s.rotatedAt.getTime() > SESSION_POLICY.rotateAfterSeconds * 1000;
    const idleTarget = Math.min(now + SESSION_POLICY.idleSeconds * 1000, s.absoluteExpiresAt.getTime());
    const touchDue = idleTarget - s.idleExpiresAt.getTime() > SESSION_POLICY.touchAfterSeconds * 1000;

    if (rotationDue || touchDue) {
      const next = rotationDue ? newToken() : null;
      const updated = await this.db.asUser(s.userId, (tx) =>
        tx.session.updateMany({
          // Conditional on the current hash: if a parallel request rotated first, this one does nothing.
          where: { id: s.sessionId, tokenHash, revokedAt: null },
          data: {
            lastSeenAt: new Date(now),
            idleExpiresAt: new Date(idleTarget),
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
            ...(next
              ? {
                  tokenHash: hashToken(next),
                  previousTokenHash: tokenHash,
                  previousTokenValidUntil: new Date(now + SESSION_POLICY.rotationGraceSeconds * 1000),
                  rotatedAt: new Date(now),
                }
              : {}),
          },
        }),
      );
      if (next && updated.count === 1) {
        rotatedToken = next;
        refreshDue = true;
      }
    }
    return { principal, rotatedToken, refreshDue };
  }

  async revoke(userId: string, sessionId: string, reason: string): Promise<boolean> {
    const r = await this.db.asUser(userId, (tx) =>
      tx.session.updateMany({
        where: { id: sessionId, userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
      }),
    );
    return r.count === 1;
  }

  async revokeAll(userId: string, reason: string, exceptSessionId?: string): Promise<number> {
    const r = await this.db.asUser(userId, (tx) =>
      tx.session.updateMany({
        where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
        data: { revokedAt: new Date(), revokedReason: reason },
      }),
    );
    return r.count;
  }

  /** Issue a fresh token for the same session (after a privilege change such as a password change). */
  async rotateNow(userId: string, sessionId: string): Promise<string> {
    const token = newToken();
    await this.db.asUser(userId, (tx) =>
      tx.session.update({
        where: { id: sessionId },
        data: { tokenHash: hashToken(token), previousTokenHash: null, previousTokenValidUntil: null, rotatedAt: new Date() },
      }),
    );
    return token;
  }

  async list(userId: string, currentSessionId: string): Promise<SessionSummary[]> {
    const rows = await this.db.asUser(userId, (tx) =>
      tx.session.findMany({
        where: { userId, revokedAt: null, absoluteExpiresAt: { gt: new Date() }, idleExpiresAt: { gt: new Date() } },
        orderBy: { lastSeenAt: 'desc' },
        take: 50,
      }),
    );
    return rows.map((s) => ({
      id: s.id,
      current: s.id === currentSessionId,
      createdAt: s.createdAt.toISOString(),
      lastSeenAt: s.lastSeenAt.toISOString(),
      ipAddress: s.ipAddress,
      userAgent: s.userAgent,
    }));
  }

  async rememberContext(userId: string, sessionId: string, orgId: string | null, workspaceId: string | null) {
    await this.db.asUser(userId, (tx) =>
      tx.session.update({ where: { id: sessionId }, data: { lastOrganizationId: orgId, lastWorkspaceId: workspaceId } }),
    );
  }

  async lastContext(userId: string, sessionId: string) {
    const s = await this.db.asUser(userId, (tx) =>
      tx.session.findUnique({ where: { id: sessionId }, select: { lastOrganizationId: true, lastWorkspaceId: true } }),
    );
    return { organizationId: s?.lastOrganizationId ?? null, workspaceId: s?.lastWorkspaceId ?? null };
  }
}
