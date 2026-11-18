import { Controller, Get, Inject, Logger, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public, RateLimit } from '../../common/access.js';
import { requestMeta } from '../../common/request-context.js';
import type { AppConfig } from '../../config/env.js';
import { APP_CONFIG, DATABASE } from '../../infrastructure/providers.js';
import { setCsrfCookie, setSessionCookie } from '../identity/http/cookies.js';
import { issueCsrfToken, SkipCsrf } from '../identity/http/csrf.js';
import type { Database } from '@workeasy/db';
import { Workeasy360Error } from './client.js';
import { WORKEASY360_RUNTIME, type Workeasy360Runtime } from './runtime.js';
import { DENIAL_REASONS, describe, FLOW_TTL_SECONDS, providerErrorCode, SignInRefused, type SsoErrorCode, ssoErrorFor, Workeasy360SignInService } from './sign-in.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FLOW_ID = /^[A-Za-z0-9_-]{43}$/;
/** A logout token is a compact JWS of well under 2 KB; anything much larger is not one. */
const MAX_LOGOUT_TOKEN_LENGTH = 16 * 1024;
const MAX_CODE_LENGTH = 2048;

/**
 * Same-site paths someone may be sent back to after signing in ("/campaigns/…"), never "//host", "/\host" or a URL:
 * the same rule as the web app's safeNext (apps/web/src/lib/navigation.ts).
 */
export function safeReturnTo(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 512 || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return undefined;
  try {
    const u = new URL(raw, 'http://same.origin');
    if (u.origin !== 'http://same.origin' || u.pathname.startsWith('/api/')) return undefined;
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return undefined;
  }
}

/**
 * "Continue with WorkEasy360" (docs/workeasy360-sso.md). The web app proxies /api/* here, so the registered
 * redirect URI is <APP_URL>/api/v1/auth/workeasy360/callback and every cookie stays first-party.
 *
 * - GET  start                ?organization=<uuid> (the launcher's) &next=<same-site path>
 * - GET  callback             the provider's redirect; lands on <next> or /dashboard, or /login?sso_error=<code>
 * - POST backchannel-logout   OpenID Connect Back-Channel Logout 1.0 (server to server; the signature is the authority)
 */
@Controller('v1/auth/workeasy360')
export class Workeasy360Controller {
  private readonly logger = new Logger('Workeasy360');

  constructor(
    private readonly signIn: Workeasy360SignInService,
    @Inject(WORKEASY360_RUNTIME) private readonly runtime: Workeasy360Runtime | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  /** `__Host-`: only this exact host can have set it, so a sibling domain cannot plant a flow (login CSRF). */
  private get flowCookie() {
    return this.config.cookies.secure ? '__Host-wk_w360_flow' : 'wk_w360_flow';
  }

  /** To the sign-in page with a fixed error code (302 from start, 303 from the callback). Details go to the log only. */
  private fail(reply: FastifyReply, status: 302 | 303, code: SsoErrorCode, detail: string, requestId: string, reason?: string) {
    this.logger.warn(JSON.stringify({ msg: 'workeasy360 sign-in failed', code, detail, requestId }));
    const target = new URL('/login', this.config.appOrigin);
    target.searchParams.set('sso_error', code);
    if (reason && DENIAL_REASONS.has(reason)) target.searchParams.set('reason', reason);
    return reply.redirect(target.toString(), status);
  }

  @Get('start')
  @Public()
  @RateLimit({ name: 'auth.workeasy360_start', by: 'ip', limit: 30, windowSeconds: 60 })
  async start(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const q = req.query as Record<string, unknown>;
    const raw = typeof q.organization === 'string' ? q.organization : '';
    // Only a UUID is forwarded; anything else is dropped and WorkEasy360 shows its own organization chooser.
    const organizationId = UUID.test(raw) ? raw.toLowerCase() : undefined;
    try {
      const { url, flowId } = await this.signIn.start({ organizationId, returnTo: safeReturnTo(q.next) });
      reply.setCookie(this.flowCookie, flowId, { httpOnly: true, secure: this.config.cookies.secure, sameSite: 'lax', path: '/', maxAge: FLOW_TTL_SECONDS });
      return reply.redirect(url, 302);
    } catch (err) {
      return this.fail(reply, 302, ssoErrorFor(err), describe(err), String(req.id));
    }
  }

  @Get('callback')
  @Public()
  @RateLimit({ name: 'auth.workeasy360_callback', by: 'ip', limit: 60, windowSeconds: 60 })
  async callback(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const requestId = String(req.id);
    // The flow is single use: its cookie is dropped and the flow taken before anything is checked.
    reply.clearCookie(this.flowCookie, { path: '/', secure: this.config.cookies.secure, sameSite: 'lax', httpOnly: true });
    if (!this.signIn.enabled) return this.fail(reply, 303, 'not_configured', 'WORKEASY360_ISSUER is not set', requestId);
    const q = req.query as Record<string, unknown>;
    const query = new URLSearchParams();
    for (const name of ['code', 'state', 'error', 'iss']) {
      const value = q[name];
      if (typeof value === 'string') query.set(name, value.slice(0, MAX_CODE_LENGTH + 1));
    }
    const flowId = req.cookies[this.flowCookie];
    let flow;
    try {
      flow = flowId && FLOW_ID.test(flowId) ? await this.signIn.takeFlow(flowId) : null;
    } catch (err) {
      return this.fail(reply, 303, 'unavailable', describe(err), requestId);
    }
    if (!flow) {
      const providerError = query.get('error');
      if (providerError) return this.fail(reply, 303, providerErrorCode(providerError), `provider returned ${providerError.slice(0, 64)} without a pending flow`, requestId);
      return this.fail(reply, 303, 'expired', 'no pending sign-in for this browser', requestId);
    }
    if (!query.get('error') && (query.get('code') ?? '').length > MAX_CODE_LENGTH) return this.fail(reply, 303, 'refused', 'no usable code', requestId);
    try {
      const meta = requestMeta(req);
      const done = await this.signIn.complete(query, flow, meta, req.cookies[this.config.cookies.sessionName]);
      setSessionCookie(reply, this.config, done.token);
      setCsrfCookie(reply, this.config, issueCsrfToken(this.config.sessionSecret, done.principal.sessionId));
      this.logger.log(JSON.stringify({ msg: 'user signed in with WorkEasy360', userId: done.principal.userId, orgId: done.orgId, sessionId: done.principal.sessionId, organizationCreated: done.organizationCreated, requestId }));
      return reply.redirect(new URL(flow.returnTo ?? '/dashboard', this.config.appOrigin).toString(), 303);
    } catch (err) {
      return this.fail(reply, 303, ssoErrorFor(err), describe(err), requestId, err instanceof SignInRefused ? err.reason : undefined);
    }
  }

  @Post('backchannel-logout')
  @Public()
  @SkipCsrf()
  async backchannelLogout(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const requestId = String(req.id);
    reply.header('cache-control', 'no-store');
    const contentType = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    const body = req.body as Record<string, unknown> | undefined;
    const raw = contentType === 'application/x-www-form-urlencoded' ? body?.logout_token : undefined;
    if (!this.runtime) return reply.code(404).send({ error: 'not_found' });
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LOGOUT_TOKEN_LENGTH) {
      this.logger.warn(JSON.stringify({ msg: 'workeasy360 logout token rejected', detail: 'no logout_token form field', requestId }));
      return reply.code(400).send({ error: 'invalid_request' });
    }
    let token;
    try {
      token = await this.runtime.client.verifyLogoutToken(raw);
    } catch (err) {
      if (err instanceof Workeasy360Error && err.code === 'invalid_token') {
        this.logger.warn(JSON.stringify({ msg: 'workeasy360 logout token rejected', detail: err.detail, requestId }));
        return reply.code(400).send({ error: 'invalid_request' });
      }
      // The key set could not be read: not the token's fault, so the provider delivers it again.
      this.logger.error(JSON.stringify({ msg: 'workeasy360 logout token could not be verified', detail: describe(err), requestId }));
      return reply.code(503).send({ error: 'temporarily_unavailable' });
    }
    try {
      const outcome = await this.db.system.workeasy360.endSessions({
        issuer: this.runtime.client.issuer,
        jti: token.jti,
        subject: token.sub,
        sid: token.sid,
        acceptableUntil: token.acceptableUntil,
      });
      this.logger.log(JSON.stringify({ msg: 'workeasy360 back-channel logout', by: token.sid ? 'sid' : 'sub', replayed: outcome.replayed, sessionsEnded: outcome.sessionsEnded, requestId }));
      // A duplicate is a success too: delivery is at least once.
      return reply.code(200).send({ ok: true });
    } catch (err) {
      this.logger.error(JSON.stringify({ msg: 'workeasy360 back-channel logout failed', detail: describe(err), requestId }));
      return reply.code(503).send({ error: 'temporarily_unavailable' });
    }
  }
}
