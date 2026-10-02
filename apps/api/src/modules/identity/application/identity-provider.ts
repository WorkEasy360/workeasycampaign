import type { RequestMeta } from '../../../common/request-context.js';
import type { AuthenticatedPrincipal } from '../domain/principal.js';

/**
 * What an identity provider asserts about a person after verifying them. Provider-neutral: the local provider
 * produces it from email + password; a Workeasy SSO (OIDC) provider will produce it from a verified ID token.
 */
export interface ExternalIdentity {
  provider: string;
  /** Provider-scoped stable subject (local: local account id; OIDC: `sub`). Never an email. */
  subject: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  authMethods: string[];
}

export type Credentials =
  | { kind: 'password'; email: string; password: string }
  /** Reserved for SSO: an authorization-code callback (code + state) from the Workeasy identity provider. */
  | { kind: 'oidc_callback'; code: string; state: string };

/**
 * Contract every identity provider implements. Platform sessions, tenancy and RBAC sit ABOVE this interface, so
 * swapping local auth for Workeasy SSO replaces the provider binding — not organization or content data.
 */
export interface IdentityProvider {
  readonly id: string;
  /** Verify credentials and return the asserted identity. Throws AppError (invalid_credentials, account_locked…). */
  authenticate(credentials: Credentials, meta: RequestMeta): Promise<ExternalIdentity>;
  /**
   * Re-check upstream state when a session is refreshed (rotated). Return false to end the session —
   * e.g. the local account was disabled, or the SSO refresh token was revoked.
   */
  refresh(principal: AuthenticatedPrincipal): Promise<boolean>;
  /** End any upstream session. SSO providers may return an RP-initiated logout URL. */
  logout(principal: AuthenticatedPrincipal): Promise<{ redirectUrl: string | null }>;
}

export const IDENTITY_PROVIDER = Symbol('IDENTITY_PROVIDER');
