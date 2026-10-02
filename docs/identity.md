# Identity and sessions

As implemented in Phase 4, following decision D1 (option C). Campaigns ships its own login today, built behind a
provider abstraction so Workeasy-wide SSO can replace it without migrating organization or content data.

## Layers

```
IdentityProvider        local (email + password) today · Workeasy SSO (OIDC) later
      │  ExternalIdentity { provider, subject, email, emailVerified, displayName, authMethods }
      ▼
app.link_identity()     (provider, subject) → platform users.id   [user_identities]
      │
      ▼
Platform session        opaque cookie token → sessions row (provider-independent)
      │
      ▼
AuthenticatedPrincipal  { userId, email, displayName, emailVerified, sessionId, provider, authMethods }
      │
      ▼
Organization membership → Workspace membership → Role → effective permissions   (docs/tenancy.md)
```

**The boundary.** Everything below the session layer (tenancy, RBAC, audit, every future module) sees only
`AuthenticatedPrincipal`. Local-account types live in `apps/api/src/modules/identity/infrastructure/local` and in the
`identity` database schema. A dependency-cruiser rule stops anything else from importing the identity store.

## The contract

The brief's conceptual contract maps onto the code like this:

| Brief | Implementation |
|---|---|
| `authenticate()` | `AuthenticationService.authenticate(credentials)` → `IdentityProvider.authenticate` → `link_identity` → session |
| `getPrincipal()` / `verifySession()` | `AuthenticationService.verifySession(token)` → principal (and a rotated token, when due) |
| `refresh()` | Runs at token rotation: `IdentityProvider.refresh(principal)`. Local checks the account is still enabled; SSO will check its refresh token. A definitive "no" ends the session. A provider outage does not. |
| `logout()` | `AuthenticationService.logout` revokes the platform session, then `IdentityProvider.logout` (SSO may return an RP-logout URL) |

## Account linking

`app.link_identity(provider, subject, …)`:
- Returns the existing user for a known (provider, subject).
- Otherwise creates a new user.
- Never links by email alone. If the email already belongs to a user with a different identity, it raises an error. A newly added provider therefore cannot take over an existing account.

**Moving to Workeasy SSO** will be an explicit, verified linking step: an admin-initiated migration that writes `user_identities` rows. It will not happen automatically.

## Local provider

| Concern | Implementation |
|---|---|
| Password hashing | Argon2id (`argon2` library): m = 46 MiB, t = 2, p = 1, above the OWASP minimum. Hashes are upgraded at login when the parameters change. |
| Password policy | 10–256 characters; blocklist of common passwords; must not contain the email's local part; checked server-side (the client checks the same shared contract for instant feedback). |
| Login throttling | Append-only `identity.login_attempts`. After 5 failures for one email since its last success within 15 min → `account_locked` (429 + `Retry-After`). 30 failures per IP in 15 min → `rate_limited`. |
| Enumeration | Login: the same error for an unknown email and a wrong password, and one Argon2 verification runs either way (constant work). Register, forgot-password and resend always return 202. |
| Tokens (email verification, password reset) | 256-bit random, stored as SHA-256 only. Single use, enforced atomically (conditional update). Verification valid 24 h, reset 1 h. Requesting a new reset invalidates older links. Max 3 per hour. |
| Reset | Requires a valid token; sets the new password; marks the email verified (the reset proves inbox control); **revokes every session**; sends a "password changed" email. |
| Change password | Requires the current password; revokes other sessions; rotates the current token. |
| Registration rollback | The local account and the platform user are created in two databases. If linking fails, the local account is deleted (role `workeasy_identity` has DELETE on `local_accounts` only). |

## Sessions

| Property | Value |
|---|---|
| Token | 256-bit random, base64url, sent only in the cookie, stored as SHA-256 |
| Cookie (production) | `__Host-wk_session`; `HttpOnly; Secure; SameSite=Lax; Path=/`; no Domain |
| Cookie (development/test) | `wk_session` with the same attributes minus `Secure` |
| Lifetime | 7 days idle, 30 days absolute (enforced server-side) |
| Rotation | At most hourly while in use. The previous token stays valid for 60 s so parallel requests don't fail. Rotation is conditional on the current hash, so concurrent requests cannot fork the session. |
| Verification | On every request, via `app.resolve_session(hash)`. Rejects revoked, expired and deactivated users. |
| Revocation | Logout, per-device revocation, "sign out other sessions", password change (others), password reset (all), identity-provider refresh denied |
| Deactivated user | No session is created; existing sessions fail on the next request (tested) |

## CSRF

Cookie authentication requires CSRF protection on state-changing requests.

**Signed double-submit token**, bound to the session:
- token = `nonce.HMAC(SESSION_SECRET, "csrf", nonce, sessionId | "anonymous")`
- The same token must appear in the `wk_csrf` cookie and in the `X-CSRF-Token` header, and its HMAC must match the requesting session.
- Public endpoints (login, register) also accept an anonymous-bound token signed by us, so a browser holding a stale session can still sign in.

**Origin check.** A cross-origin `Origin` header is rejected outright. `SameSite=Lax` adds a further layer.

**Browser client.** It refreshes the token and retries exactly once on `csrf_failed`.

## Email verification gate

- Unverified users can sign in, but they cannot create organizations, accept invitations or use organization or workspace routes (`email_not_verified`).
- The UI routes them to `/verify-email`.

## Not built yet (contracts ready)

- **MFA:** `authMethods` is already on the principal and the session.
- **OAuth and SSO:** the `Credentials.oidc_callback` variant; `user_identities` supports many providers per user.
- **Breached-password check:** the HIBP range API (`docs/security.md`, known gaps).
