import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module.js';

async function bootstrap() {
  // Standalone context: no HTTP server. Queue processors are registered as providers per module.
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  console.log('Worker started');
}

void bootstrap();
