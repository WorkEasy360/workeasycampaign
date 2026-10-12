import { type DynamicModule, Inject, Module, type OnApplicationBootstrap, type OnApplicationShutdown, type Type } from '@nestjs/common';
import type { AppConfig } from '../../config/env.js';
import { APP_CONFIG } from '../../infrastructure/providers.js';
import { UsageController } from './usage.controller.js';
import { UsageService } from './usage.service.js';

/** Usage metering (Phase 7.13). Gauges are snapshotted by processes with the "scheduler" role (not under NODE_ENV=test). */
@Module({})
export class UsageModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    private readonly usage: UsageService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  static forRoot(audiencePorts: Type): DynamicModule {
    return { module: UsageModule, imports: [audiencePorts], controllers: [UsageController], providers: [UsageService], exports: [UsageService] };
  }

  onApplicationBootstrap() {
    if (this.config.env !== 'test' && this.config.processRoles.has('scheduler')) this.usage.start();
  }

  onApplicationShutdown() {
    this.usage.stop();
  }
}
