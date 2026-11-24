# Sign-in with WorkEasy360 Accounts

Workeasy Campaign is a WorkEasy360 product. People sign in to it through **WorkEasy360 Accounts**, the one identity provider of the WorkEasy360 product family. Campaign never sees a WorkEasy360 password. It receives an ID token that names:

- the person (`sub`);
- the WorkEasy360 organization they chose (`organization_id`);
- this product (`product_code`, default `workeasy_campaign`).

Campaign then keeps **its own** session, authorizes on organization, role and entitlement (never on `sub` alone), and ends the session when WorkEasy360 says so (back-channel logout).

It is **off** until `WORKEASY360_ISSUER` is set. Email and password sign-in keeps working unless `WORKEASY360_SSO_ONLY=true` ([Existing accounts](#existing-accounts-and-sso-only)).

This implements the platform's contract ("The contract, for every adapter", `docs/universal-sso/onboarding-a-product.md` in the platform repository) with the NestJS / Node adapter: `openid-client` 6 and `jose`.

## What happens, step by step

| Step | What Campaign does | Where |
|---|---|---|
| Start | `GET /api/v1/auth/workeasy360/start[?organization=<uuid>][&next=/campaigns]`. Generates state, nonce and a PKCE S256 verifier and stores them **in PostgreSQL** (`workeasy360_login_flows`, 10 minutes, SHA-256 of the flow id as key). The browser holds only a random flow id in an httpOnly cookie (`__Host-wk_w360_flow` over https). The launcher's organization is forwarded as the `organization` hint. | `apps/api/src/modules/workeasy360/workeasy360.controller.ts`, `sign-in.service.ts`, `client.ts` |
| Callback | `GET /api/v1/auth/workeasy360/callback`. **Takes** (deletes) the flow before anything else, so it is used once. Compares the state in constant time. | `workeasy360.controller.ts` |
| Code exchange | openid-client 6 `authorizationCodeGrant` with the PKCE verifier. Client authentication is **`private_key_jwt`**: the assertion has `iss = sub = client id`, `aud` = **the token endpoint** (not the issuer), a 60 s lifetime and a fresh `jti`, signed with `WORKEASY360_PRIVATE_KEY_FILE` (kid `WORKEASY360_KEY_ID`). No client secret exists. | `client.ts` |
| ID token | Verified **again, by Campaign itself, with jose against the provider's key set** (`jwks_uri`): key by `kid`, algorithm from an allow-list (RS256, ES256), `iss` exactly `WORKEASY360_ISSUER`, `aud` exactly the client id, `exp`/`iat` with 30 s skew, `typ` = `id_token`, `nonce`, `product_code` = `WORKEASY360_PRODUCT_CODE`, `organization_id` present (a UUID), `email_verified` = true. | `client.ts` `verifyIdToken` |
| Launcher check | If the sign-in started with `?organization=`, the token must name that organization. | `sign-in.service.ts` |
| Entitlement | Asks the entitlement endpoint from discovery (`workeasy360_entitlement_endpoint`) for the organization **and the person** (`subject`), with its own `private_key_jwt` client assertion. A denial ends the sign-in with the reason. | `entitlements.ts` |
| Person | Linked on **(issuer, sub)** (`user_identities`, provider `workeasy360`), never on email. | `app.workeasy360_link_identity` |
| Organization | The WorkEasy360 organization maps to one Campaign organization (`organizations.workeasy360_organization_id`, unique). The first sign-in from that organization creates it, with a workspace "Main", and makes the person its Owner, unless `WORKEASY360_PROVISION_ORGANIZATIONS=false`. An existing organization is linked with an operator command. | `sign-in.service.ts`, `organizations.service.ts` |
| Membership | Active: kept, with its role. **Suspended here: refused.** None, or removed: joined with `WORKEASY360_DEFAULT_ROLE` (`member`) and `WORKEASY360_DEFAULT_WORKSPACE_ROLE` (`viewer`) in the first workspace. Membership of the organization is decided in WorkEasy360; to keep someone out of Campaign while they stay in the WorkEasy360 organization, suspend them under Members. | `sign-in.service.ts` `join` |
| Session | Any session the browser already held ends. A new server-side session (`sessions`, provider `workeasy360`) records issuer, `sub`, `sid`, the WorkEasy360 organization and **the one Campaign organization it may use**. The cookie is the existing one: opaque, httpOnly, `__Host-wk_session` over https (Secure, host-only, never a `.workeasy360.com` cookie). | `session.service.ts` |

Every failure lands on `/login?sso_error=<code>` (a fixed vocabulary, `SsoErrorCode` in `sign-in.service.ts`), with `&reason=` for an entitlement denial. The sign-in page shows one message per code. Codes, tokens, state and nonce are never logged.

## Authorization: organization, role and entitlement, never `sub` alone

- **A WorkEasy360 session reaches only the organization its token named.** Any other organization or workspace answers 404, exactly as for a non-member, even when the person belongs to it (`AccessService`). `GET /v1/organizations` lists only that organization, and the current context never falls back to another one.
- A WorkEasy360 session cannot create organizations, and cannot accept an invitation to another organization (403 `workeasy360_organization_managed`). Organizations come from WorkEasy360.
- Inside the organization, roles and workspace grants decide, as before.

### Entitlement, on WorkEasy360's schedule

Every organization and workspace route of an organization **linked** to WorkEasy360 goes through the entitlement gate in `AccessGuard`. This includes password sessions of members of a linked organization: those are asked about per organization (no `subject`).

- **Cache:** `min(revalidate_after, 900)` seconds (at least 30), in PostgreSQL (`workeasy360_entitlement_answers`), shared by every API instance, plus each process's own copy. WorkEasy360 is never asked per request.
- **Denial:** re-asked after 60 s. Until then, and through any outage, it stands; a known denial is kept without expiry, so neither a restart nor an outage hands access back. The answer is 403 `workeasy360_access_ended` with `reason` (`not_entitled`, `expired`, `suspended`, `membership_inactive`, `no_seat`). The session stays valid, so the person sees why and can sign out.
- **Read-only:** while `write_allowed` is false, changes answer 403 `workeasy360_read_only`; reads, and the POSTs that change nothing (eligibility check, import dry run, campaign pre-flight), still work.
- **Outage:** a 5xx, a 429, a timeout or a network error is never a denial. The last answer stands; with none yet, access continues. WorkEasy360 is asked again after 60 s.
- **Refusal of the client:** a 400, 401 or 403 from the entitlement endpoint (a revoked credential, a suspended integration) **fails closed** for the whole client: for 60 s every question answers 403 `workeasy360_access_unverified` (and a 429 within five minutes of a refusal counts as one), then one question is asked again.

## Back-channel logout, and the session check on every request

`POST /api/v1/auth/workeasy360/backchannel-logout`, form field `logout_token`. The call is server to server: no cookie and no CSRF token are involved (the route is exempt from CSRF); the provider's signature is the authentication.

The logout token is verified with jose against the provider's key set:

- JOSE `typ` is `logout+jwt`, and a `typ` claim, if present, is `logout_token`;
- the signature is by `kid` (RS256 or ES256);
- `iss` is exactly ours and `aud` is our client id;
- `iat` is not in the future and at most 10 minutes old, and `exp` has not passed;
- the back-channel-logout event is present, and there is **no `nonce`**;
- `sub` and/or `sid` are present, and so is a `jti`.

Then, in **one PostgreSQL transaction** (`app.workeasy360_end_sessions`):

1. The `jti` is recorded once per issuer (`workeasy360_logout_tokens`).
2. With `sid`: the sessions that WorkEasy360 sign-in opened end (narrowed to `sub` when both are present). With `sub` alone: every live session of the person linked to (issuer, `sub`) ends, however it was opened.

The receiver answers:

- **200** when the token is verified. A **duplicate** delivery also gets 200 and changes nothing.
- **400** `invalid_request` when the token is invalid.
- **503** when the key set or the database is unreachable, so WorkEasy360 delivers again. Nothing was recorded.

**The per-request check:** every request resolves its cookie through `app.resolve_session` in PostgreSQL (it always did), and nothing is cached in a process. A session ended by a logout token delivered to *any* instance is refused (401) by *every* instance on its next request.

## Signing out

- **Sign out** (`POST /api/v1/auth/logout`) ends the Campaign session only.
- **Sign out of WorkEasy360 too** (`POST /api/v1/auth/logout?workeasy360=true`, offered in the app for WorkEasy360 sessions) first ends the Campaign session, then answers `redirectUrl`: WorkEasy360's `end_session_endpoint` with `id_token_hint`, `client_id` and the registered `WORKEASY360_POST_LOGOUT_REDIRECT_URI`. The web app sends the browser there; WorkEasy360 asks the person to confirm.

## Register in Super Admin

The platform catalog has **no Campaign product yet**: create it first (Products → Add product, code `workeasy_campaign`), or set `WORKEASY360_PRODUCT_CODE` to the code it gets. Then, under Product → Integration:

| Field | Value |
|---|---|
| Launch URL | `https://campaign.workeasy360.com/api/v1/auth/workeasy360/start` (the launcher appends `?organization=<uuid>`) |
| Redirect URI | `https://campaign.workeasy360.com/api/v1/auth/workeasy360/callback`, exactly |
| Back-channel logout URI | `https://campaign.workeasy360.com/api/v1/auth/workeasy360/backchannel-logout` (same origin as the redirect URI) |
| Post-logout redirect URI | `https://campaign.workeasy360.com/login`, exactly what `WORKEASY360_POST_LOGOUT_REDIRECT_URI` says |
| Login URL | `https://campaign.workeasy360.com/login` |
| Scopes | `openid email profile organization`. `email` is required (`email_verified` comes with it); `organization` names an organization created on a first sign-in. |
| Token endpoint auth method | `private_key_jwt` |
| Sign-in mode | `sso_optional` while password sign-in is on; `sso_only` once `WORKEASY360_SSO_ONLY=true`. |
| Credential | The **public** key below. Its credential id is `WORKEASY360_KEY_ID`. |

The operator equivalent is the platform's `manage.py connect_product_sso --product workeasy_campaign --redirect-uri https://campaign.workeasy360.com/api/v1/auth/workeasy360/callback --public-key-file workeasy360-campaign.pub.pem`.

Generate the key pair on the product's machine. The private key goes only into the secret manager and is mounted into the api container as a file:

```bash
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out workeasy360-campaign.pem   # private: never commit
openssl pkey -in workeasy360-campaign.pem -pubout -out workeasy360-campaign.pub.pem             # public: paste into Super Admin
```

RSA keys (RS256) work too.

### Hostname: `campaign.workeasy360.com`

Campaign is not deployed yet (`docs/operations/deployment.md`). Its hostname is **`campaign.workeasy360.com`** (free in DNS on 2026-11-18). WorkEasy360 activates an integration only once every hostname in it is proven by a DNS TXT record (`_w360-product-verify.campaign.workeasy360.com`, value shown under Integration → Domains), so:

1. publish the TXT record Super Admin shows and choose **Verify** (or the operator attests the first-party host with `connect_product_sso --attest-domains`);
2. point `campaign.workeasy360.com` at the deployment, and set `APP_URL=https://campaign.workeasy360.com`.

Until then, only loopback hosts work: they need no record.

## Environment

All names are those of the WorkEasy360 integration kit's `.env.example`. They are read by the **api** process.

| Variable | Default | Meaning |
|---|---|---|
| `WORKEASY360_ISSUER` | (empty: off) | Exactly the issuer WorkEasy360's discovery document names, **no trailing slash**. https; plain http only for a loopback issuer (`127.0.0.1`, `localhost`) outside production. |
| `WORKEASY360_CLIENT_ID` | | The client id from the registration. |
| `WORKEASY360_PRODUCT_CODE` | `workeasy_campaign` | Must equal the ID token's `product_code`. |
| `WORKEASY360_REDIRECT_URI` | `<APP_URL>/api/v1/auth/workeasy360/callback` | Must be exactly that address. |
| `WORKEASY360_POST_LOGOUT_REDIRECT_URI` | `<APP_URL>/login` | On the app's origin; registered exactly. |
| `WORKEASY360_KEY_ID` | | The credential id (`kid` of the client assertion). |
| `WORKEASY360_PRIVATE_KEY_FILE` | | PEM file, RSA or EC P-256. Never in the repository or an image. |
| `WORKEASY360_SCOPES` | `openid email profile organization` | Must include `openid` and `email`. |
| `WORKEASY360_SSO_ONLY` | `false` | `true`: WorkEasy360 is the only way in ([below](#existing-accounts-and-sso-only)). |
| `WORKEASY360_PROVISION_ORGANIZATIONS` | `true` | `false`: only organizations linked by the operator can be signed in to. |
| `WORKEASY360_DEFAULT_ROLE` | `member` | Organization role on joining (`admin` or `member`). |
| `WORKEASY360_DEFAULT_WORKSPACE_ROLE` | `viewer` | Role in the first workspace on joining (`workspace_admin`, `manager`, `editor`, `analyst`, `viewer`, or `none`). |

`ISSUER`, `CLIENT_ID`, `KEY_ID` and `PRIVATE_KEY_FILE` must all be set, or none. The API refuses to start otherwise, or with a trailing slash, a non-https issuer in production, a redirect or post-logout URI off `APP_URL`'s origin, scopes without `openid` and `email`, `WORKEASY360_SSO_ONLY=true` without an issuer, or an unreadable key file.

The **web** process reads one setting, at request time:

| Variable | Default | Meaning |
|---|---|---|
| `WORKEASY360_SIGN_IN` | `off` | `on`: the sign-in page offers **Continue with WorkEasy360** next to the password form. `only`: it offers only WorkEasy360 (set it with `WORKEASY360_SSO_ONLY=true`). |

## Existing accounts and SSO-only

**Password sign-in keeps working** while `WORKEASY360_SSO_ONLY` is false (the default). Password sessions of members of an organization an operator links to WorkEasy360 are then subject to that organization's entitlement.

**People are keyed on (issuer, sub). Nothing is ever merged by email.**

| Existing account | On the person's first WorkEasy360 sign-in |
|---|---|
| Password account with **the same email** as the WorkEasy360 person | **Refused** with `sso_error=account_exists`, and nothing is created: `users.email` is unique, and taking an account over because an email matches is exactly what the contract forbids. An operator who has confirmed it is the same person runs `link-user` (below); from then on, WorkEasy360 sign-ins reach that account with its memberships and roles. The password keeps working until SSO-only is switched on. |
| Password account with a different email | Untouched, and a separate account. |
| WorkEasy360 account under a **previous issuer name** (the platform's staged issuer move, e.g. `https://app.workeasy360.com` to `https://accounts.workeasy360.com`) | **Refused** with `sso_error=identity_conflict`, and logged, instead of creating a second account for the same `sub`. Run `move-issuer` in the same release that changes `WORKEASY360_ISSUER`. |

**With `WORKEASY360_SSO_ONLY=true`:**

- login, registration, email verification, password reset and password change answer 403 `password_sign_in_disabled`;
- every session opened another way is refused at once (401 `workeasy360_sign_in_required`), on every instance;
- set the web's `WORKEASY360_SIGN_IN=only` too, so the sign-in page offers only WorkEasy360.

Switch it on only after every customer's owners can sign in with WorkEasy360: link their organizations and accounts first.

## Operator commands

They run as the schema owner (`DATABASE_OWNER_URL`), never as a runtime role, because each one deliberately crosses a boundary the runtime may not cross. Locally: `pnpm --filter @workeasy/db build` once, then `pnpm --filter @workeasy/db workeasy360 <command>`. On a server: in the **migrate** image (it has `DATABASE_OWNER_URL`), `node dist/workeasy360-cli.js <command>`.

| Command | What it does |
|---|---|
| `link-organization <organization-id> <workeasy360-organization-id>` | Sign-ins from that WorkEasy360 organization land in this existing organization. Refused when the organization is linked to another WorkEasy360 organization, or the WorkEasy360 organization already has an organization here (unlink that one first). Audited (`organization.linked_to_workeasy360`). |
| `unlink-organization <organization-id>` | Removes the link. Its WorkEasy360 sessions end at once. Audited. |
| `link-user <user-id or email> <workeasy360-sub> [--issuer <issuer>]` | You vouch that an existing account is this WorkEasy360 person. Refused when that WorkEasy360 person already has an account here, or the account already has a WorkEasy360 identity. Recorded in the person's security log. `--issuer` defaults to `WORKEASY360_ISSUER`. |
| `move-issuer --from <old> --to <new> [--apply]` | The identity move of an issuer change: every WorkEasy360 identity and live session under `<old>` moves to `<new>`. Without `--apply` it only reports. Subjects are unique, so two accounts are never merged by a move. |
| `identities` | WorkEasy360 identities and live sessions per issuer, and the number of linked organizations. |

## Run it locally against a WorkEasy360 platform on `http://127.0.0.1:8031`

1. Run a WorkEasy360 platform locally with issuer `http://127.0.0.1:8031` (the platform repository's local stack).
2. In its Super Admin, create the product `workeasy_campaign` and register the integration with:
   - redirect URI `http://localhost:3000/api/v1/auth/workeasy360/callback`;
   - back-channel logout URI `http://localhost:3000/api/v1/auth/workeasy360/backchannel-logout`;
   - post-logout URI `http://localhost:3000/login`;
   - scopes `openid email profile organization`, `private_key_jwt`.
3. Add the public key, activate, and grant the product to a test organization. Loopback hosts need no DNS proof; http redirect URIs are accepted outside production.
4. Add to the repository `.env`:

   ```dotenv
   WORKEASY360_ISSUER=http://127.0.0.1:8031
   WORKEASY360_CLIENT_ID=<client id>
   WORKEASY360_KEY_ID=<credential id>
   WORKEASY360_PRIVATE_KEY_FILE=<absolute path to workeasy360-campaign.pem, outside the repository>
   WORKEASY360_SIGN_IN=on
   ```

5. Start Campaign as the README says: `pnpm build`, then `NODE_ENV=development pnpm --filter @workeasy/api start` (API on :4000) and `pnpm --filter @workeasy/web dev` (web on :3000, proxying `/api/*` to the API).
6. Open `http://localhost:3000/login` and choose **Continue with WorkEasy360**, or open `http://localhost:3000/api/v1/auth/workeasy360/start?organization=<organization uuid>` as the launcher would.

The platform must reach `http://localhost:3000/api/v1/auth/workeasy360/backchannel-logout` from where it runs.

### Proving 200 vs 401 from a script

The protected endpoint is **`GET /api/v1/me`** on the app origin. The credential is the **session cookie** the callback sets: `wk_session` over http, `__Host-wk_session` over https.

```bash
# after signing in in a browser, copy the cookie value from the browser's developer tools
curl -s -o /dev/null -w '%{http_code}\n' -H 'Cookie: wk_session=<value>' http://localhost:3000/api/v1/me   # 200
# sign out everywhere in WorkEasy360 (it delivers a logout token), then the same call:
curl -s -o /dev/null -w '%{http_code}\n' -H 'Cookie: wk_session=<value>' http://localhost:3000/api/v1/me   # 401
```

Over https: `Cookie: __Host-wk_session=<value>` against `https://campaign.workeasy360.com/api/v1/me`. Against the API directly (port 4000), the path is `/v1/me`.

`GET /api/v1/organizations/<organization id>` answers 200 while the organization is entitled, and 403 `workeasy360_access_ended` once it is not.

## Tests

`apps/api/test/workeasy360.test.ts` runs the real API (two instances sharing the test database) against a fake WorkEasy360 provider (`apps/api/test/workeasy360-fake-provider.ts`) whose keys are generated when it starts. It serves discovery, the key set, authorize, token (checking `private_key_jwt` with `aud` = token endpoint, and PKCE, as the platform does), entitlement and end-session. The tests cover:

- the happy path (authorization request, client assertion, entitlement question, the organization created, the bound session), a second member joining, a returning person, session replacement, and safe return paths;
- a wrong issuer, audience, signature (another key under the same `kid`), nonce or `typ`;
- PKCE: the challenge is S256 of the stored verifier, a code exchanged with another verifier is refused, and the provider refuses an authorization request without PKCE;
- a replayed callback, a callback without this browser's flow, and a wrong state;
- a wrong product, a missing organization, an unverified email, another organization than the launcher asked for, and the person cancelling;
- not entitled at sign-in; the client refused at sign-in; re-checks on `revalidate_after` with denial, read-only, outage and client refusal; a person removed in WorkEasy360;
- cross-organization access refused (other organization, other workspace, listing, context switch, creating organizations); suspended, removed and organization-suspended cases;
- logout tokens: valid (by `sid` and by `sub`), forged (another key, another issuer, another audience, wrong `typ`, missing event, nonce present, too old), neither `sub` nor `sid`, an ID token, a missing token, JSON; a duplicate; a replayed `jti`;
- sessions refused at once on **two app instances** sharing the database;
- both sign-outs;
- no merge by email, the operator links, refusals to re-point or merge, unlinking, and the issuer move;
- password members of a linked organization under its entitlement, and SSO-only;
- the integration off.

`apps/api/src/modules/workeasy360/settings.test.ts` covers the configuration rules.

## Not covered yet

- **Automatic start** for SSO-only products (integration guide §6b): someone who opens Campaign with no session sees the sign-in page with "Continue with WorkEasy360" rather than being sent to WorkEasy360 by itself.
- `prompt=login` ("confirm it's you") before sensitive actions is not used.
- Self-service linking of a password account to a WorkEasy360 identity (today: the operator's `link-user`).
- Campaign's own plan limits (`docs/spec.md`) are not fed from WorkEasy360 plans; the entitlement API deliberately says only allow/deny/read-only.
- No run against a real WorkEasy360 platform yet (only the fake provider): do it before activation (`VERIFY.md` of the integration kit, and the platform's `Accounts/e2e/run_global_logout.py` extended with Campaign).
