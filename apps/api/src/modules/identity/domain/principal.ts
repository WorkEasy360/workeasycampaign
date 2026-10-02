/**
 * The authenticated principal — the ONLY identity type the rest of the platform sees.
 *
 * It is produced by AuthenticationService from a platform session, regardless of which identity provider
 * authenticated the person (local passwords today, Workeasy SSO later). Domain code must depend on this type,
 * never on local-account or provider-specific types.
 */
export interface AuthenticatedPrincipal {
  /** Platform user id (users.id) — stable across identity providers. */
  userId: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
  /** Platform session that authenticated this request. */
  sessionId: string;
  /** Identity provider that established the session, e.g. "local" or "workeasy-sso". */
  provider: string;
  /** How the person authenticated, e.g. ["pwd"] or ["pwd", "otp"]. Enables step-up checks once MFA exists. */
  authMethods: string[];
}
