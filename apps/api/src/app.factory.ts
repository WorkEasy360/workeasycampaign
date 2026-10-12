import 'reflect-metadata';
import { Readable } from 'node:stream';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import { Logger, type LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { v7 as uuidv7 } from 'uuid';
import { AppModule, type InfrastructureOverrides } from './app.module.js';
import { httpDuration, httpRequests, statusClass } from './common/metrics.js';
import { accessLogEntry } from './common/observability.js';
import { configureCursorKey } from './common/pagination.js';
import type { AppConfig } from './config/env.js';

/** Provider webhook bodies are small (one event each); anything larger is refused before parsing. */
const WEBHOOK_BODY_LIMIT = 256 * 1024;

const LOG_LEVELS: Record<AppConfig['logLevel'], LogLevel[]> = {
  debug: ['debug', 'log', 'warn', 'error', 'fatal'],
  info: ['log', 'warn', 'error', 'fatal'],
  warn: ['warn', 'error', 'fatal'],
  error: ['error', 'fatal'],
};

/** Builds the API. Used by main.ts and by the API test suite (so tests exercise the real guard chain). */
export async function createApp(config: AppConfig, overrides: InfrastructureOverrides = {}): Promise<NestFastifyApplication> {
  // Pagination cursors are signed with a key derived from the session secret (common/pagination.ts).
  configureCursorKey(config.sessionSecret);
  const adapter = new FastifyAdapter({
    // Explicit proxy trust from configuration — never `true` (see config/trust-proxy.ts).
    trustProxy: config.trustProxy === false ? false : config.trustProxy,
    bodyLimit: 1024 * 1024,
    // Request id is server-generated (never taken from the client) and doubles as the correlation id.
    genReqId: () => uuidv7(),
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule.forRoot(config, overrides), adapter, {
    logger: config.env === 'test' ? ['error', 'fatal'] : LOG_LEVELS[config.logLevel],
    bufferLogs: false,
  });

  await app.register(cookie);
  await app.register(helmet, {
    // JSON API: nothing should ever be rendered or framed.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    hsts: config.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });

  const fastify = app.getHttpAdapter().getInstance();
  // CSV uploads are passed to the controller as a stream (size, encoding and syntax are enforced while streaming).
  fastify.addContentTypeParser('text/csv', (_req, payload, done) => done(null, payload));
  // Provider webhooks (Phase 7.9) are verified over the exact bytes received: keep them next to the parsed body.
  fastify.addHook('preParsing', async (req, _reply, payload) => {
    if (!req.url.startsWith('/v1/webhooks/')) return payload;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of payload) {
      size += (chunk as Buffer).length;
      if (size > WEBHOOK_BODY_LIMIT) throw Object.assign(new Error('Request body is too large'), { statusCode: 413, code: 'FST_ERR_CTP_BODY_TOO_LARGE' });
      chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks);
    (req as unknown as { rawBody?: Buffer }).rawBody = raw;
    return Readable.from([raw]);
  });
  // RFC 8058 one-click unsubscribe bodies (application/x-www-form-urlencoded) use the form parser Nest registers.
  // Route inventory (populated when Nest registers routes during init) — checked against the OpenAPI registry.
  const routes: { method: string; url: string }[] = [];
  fastify.addHook('onRoute', (r) => {
    for (const m of [r.method].flat()) if (m !== 'HEAD') routes.push({ method: m, url: r.url });
  });
  fastify.decorate('workeasyRoutes', routes);
  fastify.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  });

  // One structured access entry per request (allowlisted fields only — see common/observability.ts).
  const http = new Logger('Http');
  fastify.addHook('onResponse', async (req, reply) => {
    http.log(JSON.stringify(accessLogEntry(req, reply)));
    // Route TEMPLATE only (never the URL); unmatched requests share one label.
    const route = req.routeOptions?.url ?? 'unmatched';
    httpRequests.inc({ route, method: req.method, status: statusClass(reply.statusCode) });
    httpDuration.observe({ route, method: req.method }, reply.elapsedTime / 1000);
  });

  app.enableShutdownHooks();
  new Logger('Bootstrap').log(`trust proxy: ${JSON.stringify(config.trustProxy)}`);
  return app;
}
