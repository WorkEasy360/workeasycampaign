import { type DynamicModule, Global, Inject, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { MailgunEmailAdapter, MetaWhatsAppAdapter, TwilioSmsAdapter } from '@workeasy/channels';
import type { Database } from '@workeasy/db';
import type { AppConfig } from './config/env.js';
import { ErrorFilter } from './common/error.filter.js';
import { MemoryRateLimitStore, RATE_LIMIT_STORE, RateLimitGuard, type RateLimitStore, RedisRateLimitStore } from './common/rate-limit.js';
import { HealthController, ShutdownState } from './health/health.controller.js';
import { UsageModule } from './modules/usage/usage.module.js';
import { DEFAULT_RUNNER_OPTIONS, InlineJobDispatcher, JOB_DISPATCHER, type JobDispatcher, PgJobDispatcher, PgJobRunner } from './common/jobs.js';
import { FILE_STORE, type FileStore, LocalFileStore } from './infrastructure/files/file-store.js';
import { AudienceModule } from './modules/audience/audience.module.js';
import { CampaignsModule } from './modules/campaigns/campaigns.module.js';
import { MAILER, type Mailer, mailerFactory } from './infrastructure/mail/mailer.js';
import { APP_CONFIG, DATABASE, DELIVERY_ADAPTER, SMS_ADAPTER, WHATSAPP_ADAPTER, databaseFactory } from './infrastructure/providers.js';
import type { ChannelAdapter } from '@workeasy/channels';
import { AuthenticationGuard } from './modules/identity/http/authentication.guard.js';
import { CsrfGuard } from './modules/identity/http/csrf.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { AccessGuard } from './modules/tenancy/http/access.guard.js';
import { TenancyModule } from './modules/tenancy/tenancy.module.js';
import { OpenApiController } from './openapi/openapi.controller.js';
import type { DnsResolver } from './modules/campaigns/domain/deliverability.js';
import { DNS_RESOLVER, NodeDnsResolver } from './modules/campaigns/infrastructure/node-dns-resolver.js';

export interface InfrastructureOverrides {
  mailer?: Mailer;
  rateLimitStore?: RateLimitStore;
  jobDispatcher?: JobDispatcher;
  /** Sending-domain verification DNS (tests: a deterministic resolver). */
  dnsResolver?: DnsResolver;
  /** The email provider adapter for the production delivery port (tests: an adapter against a local double). */
  deliveryAdapter?: ChannelAdapter & { provider?: string };
  /** SMS / WhatsApp provider doubles (tests). */
  smsAdapter?: ChannelAdapter & { provider?: string };
  whatsappAdapter?: ChannelAdapter & { provider?: string };
  fileStore?: FileStore;
}

@Global()
@Module({})
class InfrastructureModule implements OnApplicationBootstrap, OnApplicationShutdown {
  /** The durable-queue runner of this process (null: inline queue, or no "jobs" role). Tests drive it with tick(). */
  runner: PgJobRunner | null = null;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(RATE_LIMIT_STORE) private readonly rateLimits: RateLimitStore,
    @Inject(JOB_DISPATCHER) private readonly jobs: JobDispatcher,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Every module registered its handlers in onModuleInit; a process with the "jobs" role now starts claiming. */
  onApplicationBootstrap() {
    if (!(this.jobs instanceof PgJobDispatcher)) return;
    this.runner = new PgJobRunner(this.db, this.jobs.handlers, { ...DEFAULT_RUNNER_OPTIONS, concurrency: this.config.jobConcurrency });
    if (this.config.processRoles.has('jobs') && this.config.env !== 'test') this.runner.start();
  }

  static forRoot(config: AppConfig, overrides: InfrastructureOverrides): DynamicModule {
    if (config.isProduction && !config.redisUrl) throw new Error('REDIS_URL is required in production');
    const providers = [
      { provide: APP_CONFIG, useValue: config },
      { provide: DATABASE, useFactory: () => databaseFactory(config) },
      { provide: MAILER, useValue: overrides.mailer ?? mailerFactory(config) },
      {
        provide: JOB_DISPATCHER,
        inject: [DATABASE],
        useFactory: (db: Database) => overrides.jobDispatcher ?? (config.jobQueue === 'postgres' ? new PgJobDispatcher(db) : new InlineJobDispatcher()),
      },
      { provide: FILE_STORE, useValue: overrides.fileStore ?? new LocalFileStore(config.fileStoreDir) },
      { provide: DNS_RESOLVER, useValue: overrides.dnsResolver ?? new NodeDnsResolver() },
      // The configured email provider (DELIVERY_PROVIDER + key), or none. Tests inject a double.
      {
        provide: DELIVERY_ADAPTER,
        useValue:
          overrides.deliveryAdapter ??
          (config.deliveryProvider
            ? new MailgunEmailAdapter({ apiKey: config.deliveryProvider.apiKey, baseUrl: config.deliveryProvider.baseUrl, tracking: config.deliveryTracking })
            : null),
      },
      // SMS (Twilio) and WhatsApp (Meta Cloud API) providers from configuration, or none (messaging amendment).
      {
        provide: SMS_ADAPTER,
        useValue:
          overrides.smsAdapter ??
          (config.smsProvider
            ? new TwilioSmsAdapter({
                accountSid: config.smsProvider.accountSid,
                authToken: config.smsProvider.authToken,
                ...(config.smsProvider.from ? { from: config.smsProvider.from } : { messagingServiceSid: config.smsProvider.messagingServiceSid! }),
                statusCallbackUrl: config.smsProvider.statusCallbackUrl,
              })
            : null),
      },
      {
        provide: WHATSAPP_ADAPTER,
        useValue:
          overrides.whatsappAdapter ??
          (config.whatsappProvider
            ? new MetaWhatsAppAdapter({ accessToken: config.whatsappProvider.accessToken, phoneNumberId: config.whatsappProvider.phoneNumberId, apiVersion: config.whatsappProvider.apiVersion })
            : null),
      },
      {
        provide: RATE_LIMIT_STORE,
        useValue:
          overrides.rateLimitStore ?? (config.redisUrl ? new RedisRateLimitStore(config.redisUrl) : new MemoryRateLimitStore()),
      },
    ];
    return { module: InfrastructureModule, providers, exports: providers.map((p) => p.provide) };
  }

  async onApplicationShutdown() {
    // Stop claiming and let running jobs finish their current chunk before the database goes away; an unfinished
    // durable job's lease expires and another process retries it.
    if (this.jobs instanceof InlineJobDispatcher) await this.jobs.idle();
    if (this.jobs instanceof PgJobDispatcher) {
      await this.runner?.stop();
      await this.jobs.flushed();
    }
    await Promise.allSettled([this.db.disconnect(), this.rateLimits.close()]);
  }
}

@Module({})
export class AppModule {
  static forRoot(config: AppConfig, overrides: InfrastructureOverrides = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [InfrastructureModule.forRoot(config, overrides), IdentityModule, TenancyModule, AudienceModule, CampaignsModule.forRoot(AudienceModule), UsageModule.forRoot(AudienceModule)],
      controllers: [HealthController, OpenApiController],
      providers: [
        ShutdownState,
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
