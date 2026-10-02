import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Database } from '@workeasy/db';
import { isUniqueViolation } from '@workeasy/db';
import { Errors } from '../../../common/errors.js';
import type { RequestMeta } from '../../../common/request-context.js';
import { DATABASE } from '../../../infrastructure/providers.js';
import type { AuthenticatedPrincipal } from '../domain/principal.js';
import { type Credentials, type ExternalIdentity, IDENTITY_PROVIDER, type IdentityProvider } from './identity-provider.js';
import { SessionService, type VerifiedSession } from './session.service.js';

/**
 * Provider-neutral authentication facade — the conceptual IdentityProvider contract from the product brief:
 *   authenticate()  → verify credentials with the configured provider, link the identity, open a session
 *   verifySession() / getPrincipal() → cookie token → AuthenticatedPrincipal (with rotation)
 *   refresh()       → provider re-check at rotation time
 *   logout()        → revoke the platform session and end the upstream session
 */
@Injectable()
export class AuthenticationService {
  private readonly logger = new Logger('AuthenticationService');

  constructor(
    @Inject(IDENTITY_PROVIDER) private readonly provider: IdentityProvider,
    @Inject(DATABASE) private readonly db: Database,
    private readonly sessions: SessionService,
  ) {}

  async authenticate(credentials: Credentials, meta: RequestMeta) {
    const identity = await this.provider.authenticate(credentials, meta);
    return this.openSession(identity, meta);
  }

  /** Called by any provider flow that has a verified ExternalIdentity (also used by future SSO callbacks). */
  async openSession(identity: ExternalIdentity, meta: RequestMeta) {
    let userId: string;
    try {
      userId = await this.db.system.linkIdentity({
        provider: identity.provider,
        subject: identity.subject,
        email: identity.email,
        displayName: identity.displayName ?? identity.email.split('@')[0]!,
        emailVerified: identity.emailVerified,
      });
    } catch (err) {
      // Same email already belongs to a user linked to a different identity: never auto-link (account takeover).
      if (isUniqueViolation(err)) throw Errors.invalidCredentials();
      throw err;
    }
    // A deactivated platform user gets the same generic answer as bad credentials, and no session row is created.
    const user = await this.db.asUser(userId, (tx) => tx.user.findUnique({ where: { id: userId }, select: { status: true } }));
    if (user?.status !== 'active') throw Errors.invalidCredentials();
    const { token, sessionId } = await this.sessions.create(userId, identity.provider, identity.authMethods, meta);
    await this.db.system.recordSecurityEvent({
      userId,
      type: 'auth.login_succeeded',
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      correlationId: meta.requestId,
      metadata: { provider: identity.provider, sessionId },
    });
    const verified = await this.sessions.verify(token, meta);
    if (!verified) throw Errors.unauthenticated('Your account is not active');
    return { token, principal: verified.principal };
  }

  /** Resolve the cookie token. Runs the provider refresh when the token rotates; a failed refresh ends the session. */
  async verifySession(token: string, meta: RequestMeta): Promise<VerifiedSession | null> {
    const verified = await this.sessions.verify(token, meta);
    if (!verified) return null;
    if (verified.refreshDue) {
      const stillValid = await this.provider.refresh(verified.principal).catch((err: unknown) => {
        this.logger.warn(`identity refresh failed: ${String(err)}`);
        return true; // provider outage must not log everyone out; a definitive "no" does
      });
      if (!stillValid) {
        await this.sessions.revoke(verified.principal.userId, verified.principal.sessionId, 'provider_refresh_denied');
        return null;
      }
    }
    return verified;
  }

  async getPrincipal(token: string, meta: RequestMeta): Promise<AuthenticatedPrincipal | null> {
    return (await this.verifySession(token, meta))?.principal ?? null;
  }

  async logout(principal: AuthenticatedPrincipal, meta: RequestMeta): Promise<{ redirectUrl: string | null }> {
    await this.sessions.revoke(principal.userId, principal.sessionId, 'logout');
    await this.db.system.recordSecurityEvent({
      userId: principal.userId,
      type: 'auth.logout',
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      correlationId: meta.requestId,
      metadata: { sessionId: principal.sessionId },
    });
    return this.provider.logout(principal);
  }
}
