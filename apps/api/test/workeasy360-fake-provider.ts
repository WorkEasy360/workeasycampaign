import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  importJWK,
  jwtVerify,
  SignJWT,
  type CryptoKey,
  type JWK,
  type JWTPayload,
} from 'jose';
import { BACKCHANNEL_LOGOUT_EVENT } from '../src/modules/workeasy360/client.js';

/**
 * A WorkEasy360 Accounts stand-in for the integration tests: discovery, key
 * set, authorization, token (private_key_jwt + PKCE checked as the platform
 * checks them), entitlement and end-session endpoints, on 127.0.0.1 with
 * keys generated when it starts. Test support only (apps/api/test): never part of the production build.
 */

export interface FakePerson {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
  organizationId: string | undefined;
  organizationName?: string;
  sid?: string | undefined;
}

/** Ways to make the next ID token wrong, one check at a time. */
export interface IdTokenTampering {
  issuer?: string;
  audience?: string;
  nonce?: string;
  productCode?: string;
  /** Sign with a key that is not in the key set. */
  foreignKey?: boolean;
  typ?: string;
  /** Extra or replaced claims. */
  claims?: Record<string, unknown>;
}

export interface EntitlementReply {
  status: number;
  body: Record<string, unknown>;
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  nonce: string;
  person: FakePerson;
  tampering: IdTokenTampering;
  issuedAt: number;
}

interface Signer {
  key: CryptoKey;
  kid: string;
  alg: 'ES256' | 'RS256';
}

export interface ClientKeys {
  /** PKCS#8 PEM, as WORKEASY360_PRIVATE_KEY_FILE would hold it. */
  privateKeyPem: string;
  keyId: string;
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export class FakeWorkeasy360 {
  issuer = '';
  productCode = 'workeasy_campaign';
  /** The person the next authorization signs in. */
  person: FakePerson = { sub: randomUUID(), email: 'asha@example.test', emailVerified: true, name: 'Asha', organizationId: randomUUID() };
  /** Applied to the next ID token only. */
  tampering: IdTokenTampering = {};
  /** The authorization endpoint answers with this error instead of a code, once. */
  authorizeError: string | undefined;
  /** How the entitlement endpoint answers, per organization (and subject). */
  entitlement: (organizationId: string, subject: string | undefined) => EntitlementReply = (organizationId) => ({
    status: 200,
    body: { decision: 'allow', reason: 'entitled', product_code: this.productCode, organization_id: organizationId, write_allowed: true, revalidate_after: 900 },
  });
  /** What the endpoints were asked, for assertions. */
  readonly seen = {
    authorize: [] as URLSearchParams[],
    token: [] as { form: URLSearchParams; assertion: JWTPayload }[],
    entitlement: [] as { form: URLSearchParams; assertion: JWTPayload }[],
    endSession: [] as URLSearchParams[],
  };

  private server: Server | undefined;
  private signer!: Signer;
  private foreign!: Signer;
  private publicJwk!: JWK;
  private readonly clients = new Map<string, { publicJwk: JWK; alg: string; redirectUris: Set<string> }>();
  private readonly codes = new Map<string, PendingCode>();
  private readonly assertionIds = new Set<string>();

  static async start(): Promise<FakeWorkeasy360> {
    const fake = new FakeWorkeasy360();
    await fake.listen();
    return fake;
  }

  private async listen(): Promise<void> {
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    this.signer = { key: privateKey, kid: `w360-${randomBytes(4).toString('hex')}`, alg: 'ES256' };
    this.publicJwk = { ...(await exportJWK(publicKey)), kid: this.signer.kid, alg: 'ES256', use: 'sig' };
    const foreign = await generateKeyPair('ES256');
    // Same kid as the real key: only the signature tells them apart.
    this.foreign = { key: foreign.privateKey, kid: this.signer.kid, alg: 'ES256' };
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => json(res, 500, { error: 'server_error', detail: String(err) }));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  get tokenEndpoint(): string {
    return `${this.issuer}/api/v1/integrations/oauth/token`;
  }

  /** Registers a confidential client with a private_key_jwt credential, as Super Admin would; returns its private key. */
  async registerClient(clientId: string, redirectUris: string[]): Promise<ClientKeys> {
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    const keyId = `cred-${randomBytes(4).toString('hex')}`;
    this.clients.set(clientId, { publicJwk: { ...(await exportJWK(publicKey)), kid: keyId }, alg: 'ES256', redirectUris: new Set(redirectUris) });
    return { privateKeyPem: await exportPKCS8(privateKey), keyId };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.issuer);
    switch (`${req.method} ${url.pathname}`) {
      case 'GET /.well-known/openid-configuration':
        return json(res, 200, {
          issuer: this.issuer,
          authorization_endpoint: `${this.issuer}/api/v1/integrations/oauth/authorize`,
          token_endpoint: this.tokenEndpoint,
          jwks_uri: `${this.issuer}/.well-known/jwks.json`,
          end_session_endpoint: `${this.issuer}/api/v1/integrations/oauth/logout`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code'],
          code_challenge_methods_supported: ['S256'],
          id_token_signing_alg_values_supported: ['RS256', 'ES256'],
          token_endpoint_auth_methods_supported: ['private_key_jwt'],
          subject_types_supported: ['public'],
          scopes_supported: ['openid', 'profile', 'email', 'organization'],
          backchannel_logout_supported: true,
          workeasy360_entitlement_endpoint: `${this.issuer}/api/v1/integrations/entitlements/verify`,
          workeasy360_entitlement_revalidate_after: 900,
        });
      case 'GET /.well-known/jwks.json':
        return json(res, 200, { keys: [this.publicJwk] });
      case 'GET /api/v1/integrations/oauth/authorize':
        return this.authorize(url, res);
      case 'POST /api/v1/integrations/oauth/token':
        return this.token(await readForm(req), res);
      case 'POST /api/v1/integrations/entitlements/verify':
        return this.verifyEntitlement(await readForm(req), res);
      case 'GET /api/v1/integrations/oauth/logout':
        this.seen.endSession.push(url.searchParams);
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('Sign out of WorkEasy360?');
        return;
      default:
        return json(res, 404, { error: 'not_found' });
    }
  }

  private authorize(url: URL, res: ServerResponse): void {
    const q = url.searchParams;
    this.seen.authorize.push(q);
    const client = this.clients.get(q.get('client_id') ?? '');
    const redirectUri = q.get('redirect_uri') ?? '';
    if (!client || !client.redirectUris.has(redirectUri)) return json(res, 400, { error: 'invalid_request' });
    const back = new URL(redirectUri);
    if (q.get('state')) back.searchParams.set('state', q.get('state')!);
    const refuse = (error: string) => {
      back.searchParams.set('error', error);
      res.writeHead(302, { location: back.toString() });
      res.end();
    };
    if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return refuse('invalid_request');
    if (!(q.get('scope') ?? '').split(' ').includes('openid')) return refuse('invalid_scope');
    if (this.authorizeError) {
      const error = this.authorizeError;
      this.authorizeError = undefined;
      return refuse(error);
    }
    const code = randomBytes(32).toString('base64url');
    this.codes.set(code, {
      clientId: q.get('client_id')!,
      redirectUri,
      codeChallenge: q.get('code_challenge')!,
      nonce: q.get('nonce') ?? '',
      person: { ...this.person, organizationId: q.get('organization') ?? this.person.organizationId },
      tampering: this.tampering,
      issuedAt: Date.now(),
    });
    this.tampering = {};
    back.searchParams.set('code', code);
    res.writeHead(302, { location: back.toString() });
    res.end();
  }

  /** private_key_jwt as the platform checks it: the client's key, iss = sub = client id, aud = the token endpoint, ≤ 60 s, jti once. */
  private async authenticateClient(form: URLSearchParams): Promise<{ clientId: string; assertion: JWTPayload } | undefined> {
    if (form.get('client_assertion_type') !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer') return undefined;
    const assertion = form.get('client_assertion') ?? '';
    const unverified = JSON.parse(Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString('utf8') || '{}') as JWTPayload;
    const client = this.clients.get(String(unverified.iss ?? ''));
    if (!client) return undefined;
    try {
      const { payload } = await jwtVerify(assertion, await importJWK(client.publicJwk, client.alg), {
        issuer: String(unverified.iss),
        subject: String(unverified.iss),
        audience: this.tokenEndpoint,
        algorithms: [client.alg],
        maxTokenAge: 60,
      });
      if (!payload.jti || this.assertionIds.has(payload.jti) || (payload.exp ?? 0) - (payload.iat ?? 0) > 60) return undefined;
      this.assertionIds.add(payload.jti);
      return { clientId: String(unverified.iss), assertion: payload };
    } catch {
      return undefined;
    }
  }

  private async token(form: URLSearchParams, res: ServerResponse): Promise<void> {
    const client = await this.authenticateClient(form);
    if (!client) return json(res, 401, { error: 'invalid_client' });
    this.seen.token.push({ form, assertion: client.assertion });
    if (form.get('grant_type') !== 'authorization_code') return json(res, 400, { error: 'unsupported_grant_type' });
    const code = form.get('code') ?? '';
    const pending = this.codes.get(code);
    this.codes.delete(code);
    if (!pending || pending.clientId !== client.clientId || pending.redirectUri !== form.get('redirect_uri') || Date.now() - pending.issuedAt > 60_000) {
      return json(res, 400, { error: 'invalid_grant' });
    }
    const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
    if (challenge !== pending.codeChallenge) return json(res, 400, { error: 'invalid_grant' });
    return json(res, 200, {
      access_token: randomBytes(16).toString('base64url'),
      token_type: 'Bearer',
      expires_in: 900,
      scope: 'openid email profile organization',
      id_token: await this.idToken(pending),
    });
  }

  private async idToken(pending: PendingCode): Promise<string> {
    const { person, tampering } = pending;
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      typ: tampering.typ ?? 'id_token',
      nonce: tampering.nonce ?? pending.nonce,
      product_code: tampering.productCode ?? this.productCode,
      email: person.email,
      email_verified: person.emailVerified,
      name: person.name,
      aal: 1,
      auth_time: now,
      ...(person.organizationId ? { organization_id: person.organizationId } : {}),
      ...(person.organizationName ? { organization_name: person.organizationName } : {}),
      ...(person.sid ? { sid: person.sid } : {}),
      ...tampering.claims,
    };
    const signer = tampering.foreignKey ? this.foreign : this.signer;
    return new SignJWT(claims)
      .setProtectedHeader({ alg: signer.alg, kid: signer.kid, typ: 'JWT' })
      .setIssuer(tampering.issuer ?? this.issuer)
      .setSubject(person.sub)
      .setAudience(tampering.audience ?? pending.clientId)
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + 300)
      .setJti(randomUUID())
      .sign(signer.key);
  }

  private async verifyEntitlement(form: URLSearchParams, res: ServerResponse): Promise<void> {
    const client = await this.authenticateClient(form);
    if (!client) return json(res, 401, { error: 'invalid_client' });
    this.seen.entitlement.push({ form, assertion: client.assertion });
    const reply = this.entitlement(form.get('organization_id') ?? '', form.get('subject') ?? undefined);
    return json(res, reply.status, reply.body);
  }

  /** An ID token with exactly these claims (plus iss, aud, iat, exp, jti), for checking the verifier directly. */
  async signIdToken(clientId: string, claims: Record<string, unknown>, options: { foreignKey?: boolean } = {}): Promise<string> {
    const signer = options.foreignKey ? this.foreign : this.signer;
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: signer.alg, kid: signer.kid })
      .setIssuer(this.issuer)
      .setAudience(clientId)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .setJti(randomUUID())
      .sign(signer.key);
  }

  /** A back-channel logout token as the platform sends it, or wrong in exactly one way. */
  async logoutToken(
    clientId: string,
    options: {
      sub?: string | undefined;
      sid?: string | undefined;
      issuer?: string;
      audience?: string;
      typ?: string;
      withoutEvent?: boolean;
      nonce?: string;
      foreignKey?: boolean;
      jti?: string;
      issuedAt?: number;
    } = {},
  ): Promise<string> {
    const now = options.issuedAt ?? Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      typ: 'logout_token',
      ...(options.withoutEvent ? {} : { events: { [BACKCHANNEL_LOGOUT_EVENT]: {} } }),
      ...(options.sid ? { sid: options.sid } : {}),
      ...(options.nonce ? { nonce: options.nonce } : {}),
    };
    const signer = options.foreignKey ? this.foreign : this.signer;
    let jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: signer.alg, kid: signer.kid, typ: options.typ ?? 'logout+jwt' })
      .setIssuer(options.issuer ?? this.issuer)
      .setAudience(options.audience ?? clientId)
      .setIssuedAt(now)
      .setExpirationTime(now + 120)
      .setJti(options.jti ?? randomUUID());
    if (options.sub) jwt = jwt.setSubject(options.sub);
    return jwt.sign(signer.key);
  }
}
