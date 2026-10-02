import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true, bodyLimit: 10 * 1024 * 1024 }),
  );
  await app.register(helmet);
  await app.register(cookie, { secret: process.env.SESSION_SECRET });
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port, '0.0.0.0');
  console.log(`API listening on :${port}`);
}

void bootstrap();
