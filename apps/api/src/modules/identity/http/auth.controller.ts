import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import {
  forgotPasswordRequest,
  loginRequest,
  registerRequest,
  resendVerificationRequest,
  resetPasswordRequest,
  type SessionUser,
  verifyEmailRequest,
} from '@workeasy/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Authenticated, Public, RateLimit } from '../../../common/access.js';
import { type RequestMeta, Meta, UserCtx, type UserRequestContext } from '../../../common/request-context.js';
import { parse } from '../../../common/validation.js';
import type { AppConfig } from '../../../config/env.js';
import { APP_CONFIG } from '../../../infrastructure/providers.js';
import { AuthenticationService } from '../application/authentication.service.js';
import { SessionService } from '../application/session.service.js';
import type { AuthenticatedPrincipal } from '../domain/principal.js';
import { LocalIdentityProvider } from '../infrastructure/local/local-identity.provider.js';
import { clearSessionCookie, setCsrfCookie, setSessionCookie } from './cookies.js';
import { issueCsrfToken } from './csrf.js';

const ACCEPTED = { status: 'accepted' } as const;

export const toSessionUser = (p: AuthenticatedPrincipal): SessionUser => ({
  id: p.userId,
  email: p.email,
  displayName: p.displayName,
  emailVerified: p.emailVerified,
});

@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthenticationService,
    private readonly local: LocalIdentityProvider,
    private readonly sessions: SessionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Issues a CSRF token bound to the current session (or to "anonymous" before sign-in). */
  @Get('csrf')
  @Public()
  csrf(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const token = issueCsrfToken(this.config.sessionSecret, req.principal?.sessionId ?? null);
    setCsrfCookie(reply, this.config, token);
    reply.header('cache-control', 'no-store');
    return { csrfToken: token };
  }

  @Get('session')
  @Public()
  session(@Req() req: FastifyRequest) {
    return { user: req.principal ? toSessionUser(req.principal) : null };
  }

  @Post('login')
  @HttpCode(200)
  @Public()
  @RateLimit({ name: 'auth.login', by: 'ip', limit: 20, windowSeconds: 60 })
  async login(@Body() body: unknown, @Meta() meta: RequestMeta, @Res({ passthrough: true }) reply: FastifyReply) {
    const input = parse(loginRequest, body);
    const { token, principal } = await this.auth.authenticate({ kind: 'password', ...input }, meta);
    setSessionCookie(reply, this.config, token);
    const csrfToken = issueCsrfToken(this.config.sessionSecret, principal.sessionId);
    setCsrfCookie(reply, this.config, csrfToken);
    return { user: toSessionUser(principal), csrfToken };
  }

  @Post('logout')
  @HttpCode(200)
  @Authenticated()
  async logout(@UserCtx() ctx: UserRequestContext, @Res({ passthrough: true }) reply: FastifyReply) {
    const { redirectUrl } = await this.auth.logout(ctx.principal, ctx.meta);
    clearSessionCookie(reply, this.config);
    const csrfToken = issueCsrfToken(this.config.sessionSecret, null);
    setCsrfCookie(reply, this.config, csrfToken);
    return { redirectUrl, csrfToken };
  }

  @Post('register')
  @HttpCode(202)
  @Public()
  @RateLimit({ name: 'auth.register', by: 'ip', limit: 10, windowSeconds: 3600 })
  async register(@Body() body: unknown, @Meta() meta: RequestMeta) {
    await this.local.register(parse(registerRequest, body), meta);
    return ACCEPTED;
  }

  @Post('verify-email')
  @HttpCode(200)
  @Public()
  @RateLimit({ name: 'auth.verify', by: 'ip', limit: 30, windowSeconds: 3600 })
  async verifyEmail(@Body() body: unknown, @Meta() meta: RequestMeta) {
    await this.local.verifyEmail(parse(verifyEmailRequest, body).token, meta);
    return { status: 'verified' };
  }

  @Post('resend-verification')
  @HttpCode(202)
  @Public()
  @RateLimit({ name: 'auth.resend', by: 'ip', limit: 10, windowSeconds: 3600 })
  async resend(@Body() body: unknown, @Meta() meta: RequestMeta) {
    await this.local.resendVerification(parse(resendVerificationRequest, body).email, meta);
    return ACCEPTED;
  }

  @Post('forgot-password')
  @HttpCode(202)
  @Public()
  @RateLimit({ name: 'auth.forgot', by: 'ip', limit: 10, windowSeconds: 3600 })
  async forgot(@Body() body: unknown, @Meta() meta: RequestMeta) {
    await this.local.requestPasswordReset(parse(forgotPasswordRequest, body).email, meta);
    return ACCEPTED;
  }

  @Post('reset-password')
  @HttpCode(200)
  @Public()
  @RateLimit({ name: 'auth.reset', by: 'ip', limit: 20, windowSeconds: 3600 })
  async reset(@Body() body: unknown, @Meta() meta: RequestMeta, @Res({ passthrough: true }) reply: FastifyReply) {
    const input = parse(resetPasswordRequest, body);
    const userId = await this.local.resetPassword(input.token, input.password, meta);
    // A reset means the old password may be compromised: end every session, including this browser's.
    await this.sessions.revokeAll(userId, 'password_reset');
    clearSessionCookie(reply, this.config);
    return { status: 'password_reset' };
  }
}
