import { createHash, createPrivateKey, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  errors as joseErrors,
  importPKCS8,
  jwtVerify,
  SignJWT,
  type CryptoKey as JoseCryptoKey,
  type JWTPayload,
} from 'jose';
import * as oidc from 'openid-client';

/**
 * The WorkEasy360 Accounts relying party (docs/workeasy360-sso.md), built on
 * maintained libraries: openid-client 6 for discovery, the authorization
 * request and the code exchange (PKCE S256, state, nonce, private_key_jwt), and
 * jose for every signature this product checks itself.
 *
 * Only the issuer is configured; every endpoint comes from its discovery
 * document, whose `issuer` must equal the configured one exactly.
 */

/** ID tokens and logout tokens are signed with one of these; anything else (HS256, none) is refused. */
export const SIGNING_ALGORITHMS = ['RS256', 'ES256'];
/** Clock skew tolerated on exp / nbf / iat (the integration guide's ±30 s). */
export const LEEWAY_SECONDS = 30;
/** A client assertion is single use and lives 60 s (the contract's step 2). */
export const ASSERTION_LIFETIME_SECONDS = 60;
/** A logout token older than this is refused even if its exp would still allow it: the provider mints a fresh one per delivery. */
export const MAX_LOGOUT_TOKEN_AGE_SECONDS = 600;
/** Longest sub, sid or jti accepted (what the database stores). */
export const MAX_IDENTIFIER_LENGTH = 255;
/** OpenID Connect Back-Channel Logout 1.0 §2.4. */
export const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How long a server-to-server call to the provider may take. */
const REQUEST_TIMEOUT_SECONDS = 10;

export type Workeasy360ErrorCode =
  /** Discovery, the key set or an endpoint could not be reached, or answered 5xx. Never a denial. */
  | 'provider_unavailable'
  /** The discovery document, a key or this product's own configuration is unusable. */
  | 'provider_misconfigured'
  /** The callback's state is not this browser's flow. */
  | 'state_mismatch'
  /** The provider answered the callback or the code exchange with an OAuth error. `detail` holds the error code. */
  | 'sign_in_refused'
  /** A token did not verify. */
  | 'invalid_token'
  /** The ID token is for another product. */
  | 'wrong_product'
  /** The ID token names no organization. */
  | 'no_organization'
  /** The provider has not verified the person's email address. */
  | 'email_unverified'
  /** The provider refused this product's own client (400/401/403 from the entitlement endpoint). */
  | 'provider_refused'
  /** 429 from the provider. */
  | 'rate_limited';

export class Workeasy360Error extends Error {
  override name = 'Workeasy360Error';
  constructor(
    readonly code: Workeasy360ErrorCode,
    /** Ours only: never a token, code, state or nonce. Safe to log. */
    readonly detail = '',
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export interface Workeasy360ClientOptions {
  /** Exactly as registered; no trailing slash. */
  issuer: string;
  clientId: string;
  productCode: string;
  redirectUri: string;
  keyId: string;
  /** PEM, RSA or EC P-256 (PKCS#8, PKCS#1 or SEC1). */
  privateKeyPem: string;
  scopes: readonly string[];
  /** Plain-http provider endpoints; only for a loopback provider outside production. */
  allowInsecureRequests: boolean;
  /** Milliseconds since the epoch; replaced in tests. */
  now?: () => number;
}

export interface AuthorizationRequest {
  url: URL;
  state: string;
  nonce: string;
  codeVerifier: string;
}

/** What a verified ID token says, after every check of the contract. */
export interface Workeasy360Identity {
  issuer: string;
  subject: string;
  organizationId: string;
  productCode: string;
  email: string;
  name?: string | undefined;
  organizationName?: string | undefined;
  /** The provider's sign-in, present once a back-channel logout URI is registered. */
  sid?: string | undefined;
  aal?: number | undefined;
  /** The raw ID token, kept only as id_token_hint for "sign out of WorkEasy360 too". */
  idToken: string;
}

export interface VerifiedLogoutToken {
  jti: string;
  sub?: string | undefined;
  sid?: string | undefined;
  /** Past this instant the token is refused anyway, so its jti need not be remembered longer. */
  acceptableUntil: Date;
}

export interface EntitlementAnswer {
  decision: 'allow' | 'deny';
  reason: string;
  writeAllowed: boolean;
  /** Seconds the answer may be trusted, as the provider advertises (default 900). */
  revalidateAfter: number;
}

interface Discovered {
  config: oidc.Configuration;
  tokenEndpoint: string;
  entitlementEndpoint: string | undefined;
  jwks: ReturnType<typeof createRemoteJWKSet>;
}

/** Constant-time comparison that does not leak the length either. */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right) && a.length === b.length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalIdentifier(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) {
    throw new Workeasy360Error('invalid_token', `${name} is not a usable identifier`);
  }
  return value;
}

function joseFailure(err: unknown): Workeasy360Error {
  if (err instanceof Workeasy360Error) return err;
  // The key set could not be fetched: the provider's problem, not the token's.
  if (err instanceof joseErrors.JWKSTimeout || (err instanceof Error && /fetch|ECONNREFUSED|ENOTFOUND|network/i.test(err.message) && !(err instanceof joseErrors.JOSEError))) {
    return new Workeasy360Error('provider_unavailable', 'the key set could not be read');
  }
  const code = err instanceof joseErrors.JOSEError ? err.code : err instanceof Error ? err.name : 'unknown';
  return new Workeasy360Error('invalid_token', `verification failed (${code})`);
}

function isHttpUrl(value: unknown, allowHttp: boolean): value is string {
  if (typeof value !== 'string') return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'https:' || (allowHttp && protocol === 'http:');
  } catch {
    return false;
  }
}

export class Workeasy360Client {
  readonly issuer: string;
  readonly clientId: string;
  readonly productCode: string;
  readonly redirectUri: string;
  private readonly options: Workeasy360ClientOptions;
  private readonly now: () => number;
  private discovered: Promise<Discovered> | undefined;
  private signingKey: Promise<{ key: JoseCryptoKey; alg: 'RS256' | 'ES256' }> | undefined;
  private lastFailure = 0;

  constructor(options: Workeasy360ClientOptions) {
    this.options = options;
    this.issuer = options.issuer;
    this.clientId = options.clientId;
    this.productCode = options.productCode;
    this.redirectUri = options.redirectUri;
    this.now = options.now ?? Date.now;
  }

  // --- keys and discovery --------------------------------------------------------

  /** RS256 for an RSA key, ES256 for a P-256 key: derived from the key, so the two cannot disagree. */
  private key(): Promise<{ key: JoseCryptoKey; alg: 'RS256' | 'ES256' }> {
    this.signingKey ??= (async () => {
      let keyObject;
      try {
        keyObject = createPrivateKey(this.options.privateKeyPem);
      } catch {
        throw new Workeasy360Error('provider_misconfigured', 'the client private key is unreadable');
      }
      let alg: 'RS256' | 'ES256';
      if (keyObject.asymmetricKeyType === 'rsa') alg = 'RS256';
      else if (keyObject.asymmetricKeyType === 'ec' && keyObject.asymmetricKeyDetails?.namedCurve === 'prime256v1') alg = 'ES256';
      else throw new Workeasy360Error('provider_misconfigured', 'the client key must be RSA or EC P-256');
      const pkcs8 = keyObject.export({ type: 'pkcs8', format: 'pem' }).toString();
      return { key: await importPKCS8(pkcs8, alg), alg };
    })();
    this.signingKey.catch(() => {
      this.signingKey = undefined;
    });
    return this.signingKey;
  }

  private discover(): Promise<Discovered> {
    this.discovered ??= this.runDiscovery().catch((err: unknown) => {
      // Retry on the next call instead of caching the failure.
      this.discovered = undefined;
      this.lastFailure = this.now();
      throw err;
    });
    return this.discovered;
  }

  private async runDiscovery(): Promise<Discovered> {
    const { key, alg } = await this.key();
    let tokenEndpoint = '';
    const execute: Array<(config: oidc.Configuration) => void> = [oidc.enableNonRepudiationChecks];
    if (this.options.allowInsecureRequests) execute.unshift(oidc.allowInsecureRequests);
    let config: oidc.Configuration;
    try {
      config = await oidc.discovery(
        new URL(this.issuer),
        this.clientId,
        { redirect_uris: [this.redirectUri], response_types: ['code'] },
        oidc.PrivateKeyJwt(
          { key, kid: this.options.keyId },
          {
            // The contract: aud is the token endpoint (RFC 7523 §3); openid-client would name the issuer.
            [oidc.modifyAssertion]: (header, payload) => {
              header.alg = alg;
              payload.aud = tokenEndpoint;
            },
          },
        ),
        { execute, timeout: REQUEST_TIMEOUT_SECONDS },
      );
    } catch (err) {
      if (err instanceof Workeasy360Error) throw err;
      throw new Workeasy360Error('provider_unavailable', `discovery failed (${err instanceof Error ? err.name : 'unknown'})`);
    }
    const metadata = config.serverMetadata();
    // openid-client compares the issuer after URL normalisation; the contract wants exact string equality.
    if (metadata.issuer !== this.issuer) throw new Workeasy360Error('provider_misconfigured', 'discovery names a different issuer');
    const allowHttp = this.options.allowInsecureRequests;
    for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
      if (!isHttpUrl(metadata[field], allowHttp)) throw new Workeasy360Error('provider_misconfigured', `discovery has no usable ${field}`);
    }
    const methods = metadata.code_challenge_methods_supported;
    if (Array.isArray(methods) && !methods.includes('S256')) throw new Workeasy360Error('provider_misconfigured', 'the provider does not support PKCE S256');
    const entitlement = metadata['workeasy360_entitlement_endpoint'];
    if (entitlement !== undefined && !isHttpUrl(entitlement, allowHttp)) {
      throw new Workeasy360Error('provider_misconfigured', 'discovery has an unusable workeasy360_entitlement_endpoint');
    }
    if (metadata.end_session_endpoint !== undefined && !isHttpUrl(metadata.end_session_endpoint, allowHttp)) {
      throw new Workeasy360Error('provider_misconfigured', 'discovery has an unusable end_session_endpoint');
    }
    tokenEndpoint = metadata.token_endpoint!;
    return {
      config,
      tokenEndpoint,
      entitlementEndpoint: typeof entitlement === 'string' ? entitlement : undefined,
      // jose selects the key by kid and refreshes the set once for an unknown kid, with a cooldown
      // so garbage tokens cannot turn into requests against the provider.
      jwks: createRemoteJWKSet(new URL(metadata.jwks_uri!), {
        timeoutDuration: REQUEST_TIMEOUT_SECONDS * 1000,
        cooldownDuration: 10_000,
        cacheMaxAge: 60 * 60 * 1000,
      }),
    };
  }

  /** Whether sign-in can start now; after a failure, the provider is asked again at most once a minute. */
  async isAvailable(): Promise<boolean> {
    if (this.discovered === undefined && this.now() - this.lastFailure < 60_000) return false;
    try {
      await this.discover();
      return true;
    } catch {
      return false;
    }
  }

  // --- the flow -------------------------------------------------------------------

  async beginLogin(options: { organizationId?: string | undefined } = {}): Promise<AuthorizationRequest> {
    const { config } = await this.discover();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const parameters: Record<string, string> = {
      redirect_uri: this.redirectUri,
      scope: this.options.scopes.join(' '),
      code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    };
    // The launcher names the organization the person chose; without it the provider shows its own chooser.
    if (options.organizationId) parameters.organization = options.organizationId;
    return { url: oidc.buildAuthorizationUrl(config, parameters), state, nonce, codeVerifier };
  }

  /**
   * The callback: compares the state (constant time), exchanges the code with
   * private_key_jwt and the PKCE verifier, and verifies the ID token.
   * `query` is the callback's query string.
   */
  async completeLogin(query: URLSearchParams, flow: { state: string; nonce: string; codeVerifier: string }): Promise<Workeasy360Identity> {
    const returnedState = query.get('state') ?? '';
    if (!flow.state || !safeEqual(returnedState, flow.state)) throw new Workeasy360Error('state_mismatch');
    const providerError = query.get('error');
    if (providerError) throw new Workeasy360Error('sign_in_refused', providerError.slice(0, 64));
    const { config } = await this.discover();
    // The redirect_uri sent with the code is the registered one exactly, whatever host the proxy saw.
    const current = new URL(this.redirectUri);
    current.search = query.toString();
    let tokens;
    try {
      tokens = await oidc.authorizationCodeGrant(config, current, {
        pkceCodeVerifier: flow.codeVerifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
        idTokenExpected: true,
      });
    } catch (err) {
      throw this.exchangeFailure(err);
    }
    const idToken = tokens.id_token;
    if (typeof idToken !== 'string' || idToken === '') throw new Workeasy360Error('invalid_token', 'token response has no id_token');
    return this.verifyIdToken(idToken, flow.nonce);
  }

  private exchangeFailure(err: unknown): Workeasy360Error {
    if (err instanceof Workeasy360Error) return err;
    if (err instanceof oidc.ResponseBodyError) {
      if (err.status === 429) return new Workeasy360Error('rate_limited', 'token endpoint 429');
      if (err.status >= 500 || err.error === 'temporarily_unavailable') return new Workeasy360Error('provider_unavailable', `token endpoint ${err.status}`);
      // invalid_grant is routine (an expired code, a membership changed since the redirect): start again.
      return new Workeasy360Error('sign_in_refused', err.error.slice(0, 64));
    }
    if (err instanceof oidc.AuthorizationResponseError) return new Workeasy360Error('sign_in_refused', err.error.slice(0, 64));
    if (err instanceof oidc.ClientError) {
      // openid-client's own checks of the response or the ID token (iss, aud, nonce, signature...).
      return new Workeasy360Error('invalid_token', `the code exchange failed a check (${String((err as { code?: string }).code ?? 'client_error')})`);
    }
    if (err instanceof TypeError || (err instanceof Error && err.name === 'AbortError')) {
      return new Workeasy360Error('provider_unavailable', 'token endpoint unreachable');
    }
    return new Workeasy360Error('invalid_token', `the code exchange failed (${err instanceof Error ? err.name : 'unknown'})`);
  }

  /**
   * The ID token, verified here with jose against the provider's key set,
   * whatever the code exchange already checked (a signature is never taken on
   * trust from TLS):
   *
   * 1. key by kid from jwks_uri, algorithm from an allow-list (RS256/ES256);
   * 2. iss is exactly the configured issuer; aud is exactly this client;
   * 3. exp / nbf / iat with ±30 s; typ is id_token (not an access token);
   * 4. nonce is this browser's flow (constant time);
   * 5. product_code is this product, organization_id is a UUID, email_verified is true.
   */
  async verifyIdToken(idToken: string, expectedNonce: string): Promise<Workeasy360Identity> {
    const { jwks } = await this.discover();
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(idToken, jwks, {
        algorithms: SIGNING_ALGORITHMS,
        issuer: this.issuer,
        audience: this.clientId,
        clockTolerance: LEEWAY_SECONDS,
        currentDate: new Date(this.now()),
        requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat'],
      }));
    } catch (err) {
      throw joseFailure(err);
    }
    const nowSeconds = Math.floor(this.now() / 1000);
    if (typeof payload.iat !== 'number' || payload.iat > nowSeconds + LEEWAY_SECONDS) throw new Workeasy360Error('invalid_token', 'iat is in the future');
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (audiences.length !== 1 || audiences[0] !== this.clientId) throw new Workeasy360Error('invalid_token', 'aud is not exactly this client');
    if (payload.azp !== undefined && payload.azp !== this.clientId) throw new Workeasy360Error('invalid_token', 'azp is another client');
    // An access token is signed with the same key for the same audience: only typ tells them apart.
    if (payload.typ !== 'id_token') throw new Workeasy360Error('invalid_token', 'typ is not id_token');
    const nonce = typeof payload.nonce === 'string' ? payload.nonce : '';
    if (!expectedNonce || !safeEqual(nonce, expectedNonce)) throw new Workeasy360Error('invalid_token', 'nonce mismatch');
    const subject = optionalIdentifier(payload.sub, 'sub');
    if (!subject) throw new Workeasy360Error('invalid_token', 'no sub');
    if (payload.product_code !== this.productCode) {
      throw new Workeasy360Error('wrong_product', `token is for ${typeof payload.product_code === 'string' ? payload.product_code.slice(0, 64) : 'no product'}`);
    }
    const organizationId = payload.organization_id;
    if (typeof organizationId !== 'string' || !UUID_PATTERN.test(organizationId)) throw new Workeasy360Error('no_organization');
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase().slice(0, 254) : '';
    if (!email || payload.email_verified !== true) throw new Workeasy360Error('email_unverified');
    const sid = typeof payload.sid === 'string' && payload.sid.length > 0 && payload.sid.length <= MAX_IDENTIFIER_LENGTH ? payload.sid : undefined;
    const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim().slice(0, 200) : undefined;
    const organizationName =
      typeof payload.organization_name === 'string' && payload.organization_name.trim() ? payload.organization_name.trim().slice(0, 200) : undefined;
    return {
      issuer: this.issuer,
      subject,
      organizationId: organizationId.toLowerCase(),
      productCode: this.productCode,
      email,
      name,
      organizationName,
      sid,
      aal: typeof payload.aal === 'number' ? payload.aal : undefined,
      idToken,
    };
  }

  // --- back-channel logout ----------------------------------------------------------

  /**
   * A logout token, verified as OpenID Connect Back-Channel Logout 1.0 §2.6
   * asks and as WorkEasy360 issues it (signed like an ID token):
   * JOSE typ logout+jwt; signature by kid from the key set (RS256/ES256 only);
   * iss exactly ours; aud this client; iat not in the future and at most ten
   * minutes old; exp not passed; the back-channel-logout event; no nonce;
   * sub and/or sid; a jti. Replay (a jti seen before) is the receiver's to
   * check, in the shared database.
   *
   * Throws `invalid_token` for a token that must not be trusted (answer 400),
   * and `provider_unavailable` when the key set cannot be read (answer 503 so
   * the provider retries).
   */
  async verifyLogoutToken(logoutToken: string): Promise<VerifiedLogoutToken> {
    let header;
    try {
      header = decodeProtectedHeader(logoutToken);
    } catch {
      throw new Workeasy360Error('invalid_token', 'not a JWS');
    }
    const typ = typeof header.typ === 'string' ? header.typ.toLowerCase() : '';
    if (typ !== 'logout+jwt' && typ !== 'application/logout+jwt') throw new Workeasy360Error('invalid_token', 'the typ header is not logout+jwt');
    const { jwks } = await this.discover();
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(logoutToken, jwks, {
        algorithms: SIGNING_ALGORITHMS,
        issuer: this.issuer,
        audience: this.clientId,
        typ: 'logout+jwt',
        clockTolerance: LEEWAY_SECONDS,
        currentDate: new Date(this.now()),
        requiredClaims: ['iss', 'aud', 'iat', 'exp', 'jti', 'events'],
      }));
    } catch (err) {
      throw joseFailure(err);
    }
    const nowSeconds = Math.floor(this.now() / 1000);
    const issuedAt = payload.iat!;
    const expiresAt = payload.exp!;
    if (issuedAt > nowSeconds + LEEWAY_SECONDS) throw new Workeasy360Error('invalid_token', 'iat is in the future');
    if (nowSeconds - issuedAt > MAX_LOGOUT_TOKEN_AGE_SECONDS + LEEWAY_SECONDS) throw new Workeasy360Error('invalid_token', 'the token is too old');
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (audiences.length > 1 && payload.azp !== this.clientId) throw new Workeasy360Error('invalid_token', 'several audiences and azp is not this client');
    if (payload.azp !== undefined && payload.azp !== this.clientId) throw new Workeasy360Error('invalid_token', 'azp is another client');
    if ('typ' in payload && payload.typ !== 'logout_token') throw new Workeasy360Error('invalid_token', 'typ is not logout_token');
    const events = payload.events;
    const event = isPlainObject(events) ? events[BACKCHANNEL_LOGOUT_EVENT] : undefined;
    if (!isPlainObject(event)) throw new Workeasy360Error('invalid_token', 'events does not hold the back-channel logout event');
    // What keeps an ID token (same key, same audience) from being replayed as a logout instruction.
    if ('nonce' in payload) throw new Workeasy360Error('invalid_token', 'a logout token must not carry a nonce');
    const sub = optionalIdentifier(payload.sub, 'sub');
    const sid = optionalIdentifier(payload.sid, 'sid');
    if (sub === undefined && sid === undefined) throw new Workeasy360Error('invalid_token', 'neither sub nor sid');
    const jti = optionalIdentifier(payload.jti, 'jti');
    if (jti === undefined) throw new Workeasy360Error('invalid_token', 'no jti');
    const until = Math.min(expiresAt, issuedAt + MAX_LOGOUT_TOKEN_AGE_SECONDS) + LEEWAY_SECONDS + 1;
    return { jti, sub, sid, acceptableUntil: new Date(until * 1000) };
  }

  // --- sign-out -----------------------------------------------------------------------

  /**
   * RP-initiated logout: the provider's end_session_endpoint with id_token_hint,
   * client_id and a registered post-logout URI. Undefined when the provider
   * advertises none. The provider asks the person to confirm.
   */
  async endSessionUrl(options: { idTokenHint?: string | undefined; postLogoutRedirectUri: string }): Promise<URL | undefined> {
    const { config } = await this.discover();
    if (!config.serverMetadata().end_session_endpoint) return undefined;
    const parameters: Record<string, string> = { post_logout_redirect_uri: options.postLogoutRedirectUri };
    if (options.idTokenHint) parameters.id_token_hint = options.idTokenHint;
    return oidc.buildEndSessionUrl(config, parameters);
  }

  // --- the entitlement API --------------------------------------------------------------

  /** RFC 7523 §3: iss = sub = client id, aud = the token endpoint, 60 s, a fresh jti. */
  private async clientAssertion(tokenEndpoint: string): Promise<string> {
    const { key, alg } = await this.key();
    const issuedAt = Math.floor(this.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg, kid: this.options.keyId })
      .setIssuer(this.clientId)
      .setSubject(this.clientId)
      .setAudience(tokenEndpoint)
      .setIssuedAt(issuedAt)
      .setNotBefore(issuedAt)
      .setExpirationTime(issuedAt + ASSERTION_LIFETIME_SECONDS)
      .setJti(randomUUID())
      .sign(key);
  }

  /**
   * Asks whether `organizationId` (and, with `subject`, that person) may use
   * this product. There is no product parameter: the product is whoever the
   * client assertion proves this is. Anything that is not an answer throws:
   * `provider_unavailable` / `rate_limited` for an outage (never a denial) and
   * `provider_refused` when the provider refused this client (400/401/403).
   */
  async verifyEntitlement(organizationId: string, options: { subject?: string | undefined; write?: boolean } = {}): Promise<EntitlementAnswer> {
    const { tokenEndpoint, entitlementEndpoint } = await this.discover();
    if (!entitlementEndpoint) throw new Workeasy360Error('provider_misconfigured', 'discovery has no workeasy360_entitlement_endpoint');
    const form = new URLSearchParams({
      organization_id: organizationId,
      write: options.write ? 'true' : 'false',
      client_assertion_type: ASSERTION_TYPE,
      client_assertion: await this.clientAssertion(tokenEndpoint),
    });
    if (options.subject) form.set('subject', options.subject);
    let response: Response;
    try {
      response = await fetch(entitlementEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: form,
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_SECONDS * 1000),
      });
    } catch {
      throw new Workeasy360Error('provider_unavailable', 'entitlement endpoint unreachable');
    }
    const status = response.status;
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = await response.json();
      if (isPlainObject(parsed)) body = parsed;
    } catch {
      // Not JSON: decided by the status below.
    }
    const decision = body.decision;
    if (status === 200 && (decision === 'allow' || decision === 'deny')) {
      const advertised = Number(body.revalidate_after);
      return {
        decision,
        reason: typeof body.reason === 'string' ? body.reason.slice(0, 64) : '',
        writeAllowed: decision === 'allow' && body.write_allowed === true,
        revalidateAfter: Number.isFinite(advertised) && advertised > 0 ? advertised : 900,
      };
    }
    const detail = `entitlement endpoint ${status}`;
    if (status === 400 || status === 401 || status === 403) throw new Workeasy360Error('provider_refused', detail);
    if (status === 429) throw new Workeasy360Error('rate_limited', detail);
    throw new Workeasy360Error('provider_unavailable', detail);
  }
}
