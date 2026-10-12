import { Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { FastifyRequest } from 'fastify';
import { RateLimit, TokenAuthorized } from '../../../common/access.js';
import { Errors } from '../../../common/errors.js';
import { DeliveryWebhooksService } from '../application/delivery-webhooks.service.js';

/**
 * Email provider webhooks (Phase 7.9; docs/architecture/delivery-providers.md §6). Authorized ONLY by the provider's
 * signature over the raw body (no session, no CSRF — the `token` access policy), with a per-IP limit. The body is read
 * as bytes before parsing (app.factory preParsing hook). 200 for every verified delivery, including duplicates and
 * unknown messages, so the provider does not retry what we deliberately ignore.
 */
@Controller('v1/webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: DeliveryWebhooksService) {}

  /** Meta's webhook verification (WhatsApp): echoes `hub.challenge` only when `hub.verify_token` matches WHATSAPP_VERIFY_TOKEN. */
  @Get(':provider')
  @TokenAuthorized()
  @RateLimit({ name: 'webhooks.verify', by: 'ip', limit: 60, windowSeconds: 60 })
  verify(@Param('provider') provider: string, @Query() query: Record<string, string | undefined>, @Res({ passthrough: true }) reply: FastifyReply) {
    const challenge = this.webhooks.verifySubscription(provider, query);
    reply.header('content-type', 'text/plain; charset=utf-8');
    return challenge;
  }

  @Post(':provider')
  @HttpCode(200)
  @TokenAuthorized()
  // Provider webhooks come from few IPs in bursts (500/s per IP); unsigned requests are refused before any database work.
  @RateLimit({ name: 'webhooks.delivery', by: 'ip', limit: 30000, windowSeconds: 60 })
  async receive(@Param('provider') provider: string, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(provider)) throw Errors.notFound('Webhook');
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
    const outcome = await this.webhooks.ingest(provider, (req as unknown as { rawBody?: Buffer }).rawBody, headers, req.id as string);
    if (outcome.inbound) {
      // A reply to the SMS number: Twilio reads the response as TwiML. Empty = send no reply of our own (Twilio answers
      // STOP / START / HELP itself).
      reply.header('content-type', 'text/xml; charset=utf-8');
      return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
    }
    return outcome;
  }
}
