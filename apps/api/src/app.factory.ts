import 'reflect-metadata';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import { Logger, type LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { v7 as uuidv7 } from 'uuid';
import { AppModule, type InfrastructureOverrides } from './app.module.js';
import type { AppConfig } from './config/env.js';

const LOG_LEVELS: Record<AppConfig['logLevel'], LogLevel[]> = {
  debug: ['debug', 'log', 'warn', 'error', 'fatal'],
  info: ['log', 'warn', 'error', 'fatal'],
  warn: ['warn', 'error', 'fatal'],
  error: ['error', 'fatal'],
};

/** Builds the API. Used by main.ts and by the API test suite (so tests exercise the real guard chain). */
export async function createApp(config: AppConfig, overrides: InfrastructureOverrides = {}): Promise<NestFastifyApplication> {
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

  app.enableShutdownHooks();
  new Logger('Bootstrap').log(`trust proxy: ${JSON.stringify(config.trustProxy)}`);
  return app;
}
