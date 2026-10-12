import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RateLimit, TokenAuthorized } from '../../../common/access.js';
import { parse } from '../../../common/validation.js';
import { UnsubscribeService } from '../application/unsubscribe.service.js';

/**
 * Public unsubscribe endpoints (Phase 7.8; campaign amendment §U). Authorized ONLY by the signed token in the path
 * (no session, no CSRF — see the `token` access policy). Limited per IP.
 *  - GET  /v1/unsubscribe/{token} — what the link is for (changes nothing).
 *  - POST /v1/unsubscribe/{token} — unsubscribe. JSON `{ scope }` from the confirmation page, or the RFC 8058
 *    one-click form body `List-Unsubscribe=One-Click` sent by mail clients (topic scope).
 */
const body = z.union([
  z.strictObject({ scope: z.enum(['topic', 'all']).default('topic') }),
  z.strictObject({ 'List-Unsubscribe': z.literal('One-Click') }),
]);

@Controller('v1/unsubscribe')
export class UnsubscribeController {
  constructor(private readonly unsubscribes: UnsubscribeService) {}

  @Get(':token')
  @TokenAuthorized()
  @RateLimit({ name: 'unsubscribe.view', by: 'ip', limit: 300, windowSeconds: 3600 })
  info(@Param('token') token: string) {
    return this.unsubscribes.info(token);
  }

  @Post(':token')
  @HttpCode(200)
  @TokenAuthorized()
  @RateLimit({ name: 'unsubscribe.submit', by: 'ip', limit: 120, windowSeconds: 3600 })
  unsubscribe(@Param('token') token: string, @Body() raw: unknown, @Req() req: FastifyRequest) {
    const b = parse(body, raw ?? {});
    const oneClick = 'List-Unsubscribe' in b;
    const ua = req.headers['user-agent'];
    return this.unsubscribes.unsubscribe(token, oneClick ? 'topic' : b.scope, {
      source: oneClick ? 'list_unsubscribe' : 'unsubscribe_link',
      correlationId: req.id as string,
      ipAddress: req.ip ?? null,
      userAgent: typeof ua === 'string' ? ua.slice(0, 300) : null,
    });
  }
}
