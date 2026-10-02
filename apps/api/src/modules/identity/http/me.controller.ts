import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Database } from '@workeasy/db';
import { changePasswordRequest, paginationQuery, type SecurityEventView, updateProfileRequest } from '@workeasy/shared';
import type { FastifyReply } from 'fastify';
import { Authenticated, RateLimit } from '../../../common/access.js';
import { Errors } from '../../../common/errors.js';
import { decodeCursor, pageOf } from '../../../common/pagination.js';
import { UserCtx, type UserRequestContext } from '../../../common/request-context.js';
import { parse, routeId } from '../../../common/validation.js';
import type { AppConfig } from '../../../config/env.js';
import { APP_CONFIG, DATABASE } from '../../../infrastructure/providers.js';
import { SessionService } from '../application/session.service.js';
import { LocalIdentityProvider } from '../infrastructure/local/local-identity.provider.js';
import { toSessionUser } from './auth.controller.js';
import { setSessionCookie } from './cookies.js';

/** The signed-in user's own account. Every query is scoped to the principal by RLS (asUser). */
@Controller('v1/me')
export class MeController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly sessions: SessionService,
    private readonly local: LocalIdentityProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  @Authenticated()
  me(@UserCtx() ctx: UserRequestContext) {
    return { user: toSessionUser(ctx.principal) };
  }

  @Patch()
  @Authenticated()
  async update(@UserCtx() ctx: UserRequestContext, @Body() body: unknown) {
    const { displayName } = parse(updateProfileRequest, body);
    const user = await this.db.asUser(ctx.principal.userId, (tx) =>
      tx.user.update({
        where: { id: ctx.principal.userId },
        data: { displayName, updatedAt: new Date(), version: { increment: 1 } },
      }),
    );
    return { user: { ...toSessionUser(ctx.principal), displayName: user.displayName } };
  }

  @Post('password')
  @HttpCode(200)
  @Authenticated()
  @RateLimit({ name: 'me.password', by: 'user', limit: 10, windowSeconds: 3600 })
  async changePassword(
    @UserCtx() ctx: UserRequestContext,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parse(changePasswordRequest, body);
    await this.local.changePassword(ctx.principal, input.currentPassword, input.newPassword, ctx.meta);
    const revoked = await this.sessions.revokeAll(ctx.principal.userId, 'password_changed', ctx.principal.sessionId);
    // Privilege change: replace this browser's token too, keeping the session (and its CSRF binding).
    setSessionCookie(reply, this.config, await this.sessions.rotateNow(ctx.principal.userId, ctx.principal.sessionId));
    return { status: 'password_changed', otherSessionsSignedOut: revoked };
  }

  @Get('sessions')
  @Authenticated()
  async listSessions(@UserCtx() ctx: UserRequestContext) {
    return { data: await this.sessions.list(ctx.principal.userId, ctx.principal.sessionId) };
  }

  @Delete('sessions/:sessionId')
  @HttpCode(204)
  @Authenticated()
  async revokeSession(@UserCtx() ctx: UserRequestContext, @Param('sessionId') sessionId: string) {
    const id = routeId(sessionId, 'Session');
    if (!(await this.sessions.revoke(ctx.principal.userId, id, 'revoked_by_user'))) throw Errors.notFound('Session');
    await this.securityEvent(ctx, 'auth.session_revoked', { sessionId: id });
  }

  @Post('sessions/revoke-others')
  @HttpCode(200)
  @Authenticated()
  async revokeOthers(@UserCtx() ctx: UserRequestContext) {
    const count = await this.sessions.revokeAll(ctx.principal.userId, 'revoked_by_user', ctx.principal.sessionId);
    await this.securityEvent(ctx, 'auth.sessions_revoked', { count });
    return { revoked: count };
  }

  @Get('security-events')
  @Authenticated()
  async securityEvents(@UserCtx() ctx: UserRequestContext, @Query() query: unknown) {
    const { limit, cursor } = parse(paginationQuery, query);
    const c = decodeCursor(cursor);
    const rows = await this.db.asUser(ctx.principal.userId, (tx) =>
      tx.securityEvent.findMany({
        where: {
          userId: ctx.principal.userId,
          ...(c ? { OR: [{ occurredAt: { lt: new Date(c.t) } }, { occurredAt: new Date(c.t), id: { lt: c.id } }] } : {}),
        },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
    );
    const page = pageOf(rows, limit, (r) => ({ t: r.occurredAt.toISOString(), id: r.id }));
    return {
      data: page.data.map(
        (e): SecurityEventView => ({
          id: e.id,
          type: e.type,
          occurredAt: e.occurredAt.toISOString(),
          ipAddress: e.ipAddress,
          userAgent: e.userAgent,
        }),
      ),
      nextCursor: page.nextCursor,
    };
  }

  private securityEvent(ctx: UserRequestContext, type: string, metadata: Record<string, unknown>) {
    return this.db.system.recordSecurityEvent({
      userId: ctx.principal.userId,
      type,
      ipAddress: ctx.meta.ipAddress,
      userAgent: ctx.meta.userAgent,
      correlationId: ctx.meta.requestId,
      metadata,
    });
  }
}
