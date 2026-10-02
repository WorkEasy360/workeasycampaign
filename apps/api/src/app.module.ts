import { type DynamicModule, Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import type { Database } from '@workeasy/db';
import type { AppConfig } from './config/env.js';
import { ErrorFilter } from './common/error.filter.js';
import { MemoryRateLimitStore, RATE_LIMIT_STORE, RateLimitGuard, type RateLimitStore, RedisRateLimitStore } from './common/rate-limit.js';
import { HealthController } from './health/health.controller.js';
import { MAILER, type Mailer, mailerFactory } from './infrastructure/mail/mailer.js';
import { APP_CONFIG, DATABASE, databaseFactory } from './infrastructure/providers.js';
import { AuthenticationGuard } from './modules/identity/http/authentication.guard.js';
import { CsrfGuard } from './modules/identity/http/csrf.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { AccessGuard } from './modules/tenancy/http/access.guard.js';
import { TenancyModule } from './modules/tenancy/tenancy.module.js';
import { OpenApiController } from './openapi/openapi.controller.js';

export interface InfrastructureOverrides {
  mailer?: Mailer;
  rateLimitStore?: RateLimitStore;
}

@Global()
@Module({})
class InfrastructureModule implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(RATE_LIMIT_STORE) private readonly rateLimits: RateLimitStore,
  ) {}

  static forRoot(config: AppConfig, overrides: InfrastructureOverrides): DynamicModule {
    if (config.isProduction && !config.redisUrl) throw new Error('REDIS_URL is required in production');
    const providers = [
      { provide: APP_CONFIG, useValue: config },
      { provide: DATABASE, useFactory: () => databaseFactory(config) },
      { provide: MAILER, useValue: overrides.mailer ?? mailerFactory(config) },
      {
        provide: RATE_LIMIT_STORE,
        useValue:
          overrides.rateLimitStore ?? (config.redisUrl ? new RedisRateLimitStore(config.redisUrl) : new MemoryRateLimitStore()),
      },
    ];
    return { module: InfrastructureModule, providers, exports: providers.map((p) => p.provide) };
  }

  async onApplicationShutdown() {
    await Promise.allSettled([this.db.disconnect(), this.rateLimits.close()]);
  }
}

@Module({})
export class AppModule {
  static forRoot(config: AppConfig, overrides: InfrastructureOverrides = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [InfrastructureModule.forRoot(config, overrides), IdentityModule, TenancyModule],
      controllers: [HealthController, OpenApiController],
      providers: [
        // Global guards run in registration order:
        //   1 authenticate (and enforce that every route has an access policy)
        //   2 CSRF for state-changing requests (needs the session binding from 1)
        //   3 rate limits (keyed by trusted client IP or user)
        //   4 tenant/workspace access + permission
        { provide: APP_GUARD, useClass: AuthenticationGuard },
        { provide: APP_GUARD, useClass: CsrfGuard },
        { provide: APP_GUARD, useClass: RateLimitGuard },
        { provide: APP_GUARD, useExisting: AccessGuard },
        { provide: APP_FILTER, useClass: ErrorFilter },
      ],
    };
  }
}
