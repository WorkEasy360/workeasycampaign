import { type DynamicModule, Inject, Module, type OnApplicationBootstrap, type OnApplicationShutdown, type OnModuleInit, type Type } from '@nestjs/common';
import type { AddressLookup, AudienceProfiles } from '@workeasy/audience-core';
import type { ChannelAdapter } from '@workeasy/channels';
import type { Database, Tx } from '@workeasy/db';
import { ProviderDeliveryPort } from './infrastructure/provider-delivery-port.js';
import { ChannelDeliveryRouter, MessagingDeliveryPort } from './infrastructure/messaging-delivery-port.js';
import { IdempotencyService } from '../../common/idempotency.js';
import type { AppConfig } from '../../config/env.js';
import { ADDRESS_LOOKUP, APP_CONFIG, AUDIENCE_PROFILES, DATABASE, DELIVERY_ADAPTER, SMS_ADAPTER, WHATSAPP_ADAPTER } from '../../infrastructure/providers.js';
import { AnalyticsService } from './application/analytics.service.js';
import { CampaignsService } from './application/campaigns.service.js';
import { CAMPAIGN_DELIVERY_PORT, type CampaignDeliveryPort } from './application/delivery.js';
import { CONTENT_ASSISTANT, DisabledContentAssistant, DisabledUsageRecorder, USAGE_RECORDER } from './application/readiness-ports.js';
import { DisabledMessageEventIngest, MESSAGE_EVENT_INGEST } from './application/tracking.js';
import { ExecutionService } from './application/execution.service.js';
import { LifecycleService } from './application/lifecycle.service.js';
import { PreflightService } from './application/preflight.service.js';
import { PreviewService } from './application/preview.service.js';
import { RecipientsService } from './application/recipients.service.js';
import { TemplatesService } from './application/templates.service.js';
import { SnippetsService } from './application/snippets.service.js';
import { TestSendService } from './application/test-send.service.js';
import { UnsubscribeService } from './application/unsubscribe.service.js';
import { UnsubscribeController } from './http/unsubscribe.controller.js';
import { SendersService } from './application/senders.service.js';
import { SendersController } from './http/senders.controller.js';
import { DeliveryWebhooksService } from './application/delivery-webhooks.service.js';
import { WebhooksController } from './http/webhooks.controller.js';
import { isDeliveryAvailable } from './domain/delivery-mode.js';
import { CampaignsController } from './http/campaigns.controller.js';
import { TemplatesController } from './http/templates.controller.js';
import { SnippetsController } from './http/snippets.controller.js';
import { NullDeliveryPort } from './infrastructure/null-delivery-port.js';

/** Recovery sweep cadence (contract §6.4: every 15 min and at process start). Off under NODE_ENV=test: tests call sweep(). */
const SWEEP_INTERVAL_MS = 15 * 60_000;

/**
 * Campaigns (Phase 6.5–6.9): drafts, versions, lifecycle commands, and execution (6.9, Gate G3 — test mode only).
 * Audience data is reached only through audience-core ports bound by the Audience composition root, which `forRoot`
 * receives from the application module — this module never imports Audience code.
 *
 * Delivery (contract §9.3): the delivery port is wired ONLY when CAMPAIGN_DELIVERY_MODE=test (which config accepts only
 * with NODE_ENV=test), and NullDeliveryPort itself refuses construction outside NODE_ENV=test. In every other
 * configuration the port is null: executions cannot start (DELIVERY_NOT_AVAILABLE) and nothing can be handed off.
 */
@Module({})
export class CampaignsModule implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    private readonly executions: ExecutionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  static forRoot(audiencePorts: Type): DynamicModule {
    return {
      module: CampaignsModule,
      imports: [audiencePorts],
      controllers: [CampaignsController, TemplatesController, SnippetsController, UnsubscribeController, SendersController, WebhooksController],
      providers: [
        CampaignsService,
        PreflightService,
        PreviewService,
        AnalyticsService,
        RecipientsService,
        TemplatesService,
        SnippetsService,
        TestSendService,
        UnsubscribeService,
        SendersService,
        DeliveryWebhooksService,
        LifecycleService,
        ExecutionService,
        IdempotencyService,
        // Tracking (analytics-tracking.md §3): contracts only — the sole binding accepts nothing until Phase 8/9.
        { provide: MESSAGE_EVENT_INGEST, useClass: DisabledMessageEventIngest },
        // AI and billing readiness (ai-billing-readiness.md): contracts only — disabled bindings.
        { provide: CONTENT_ASSISTANT, useClass: DisabledContentAssistant },
        { provide: USAGE_RECORDER, useClass: DisabledUsageRecorder },
        {
          provide: CAMPAIGN_DELIVERY_PORT,
          inject: [APP_CONFIG, DATABASE, AUDIENCE_PROFILES, ADDRESS_LOOKUP, DELIVERY_ADAPTER, SMS_ADAPTER, WHATSAPP_ADAPTER],
          // disabled → none. live → the production port with the configured provider (boot guarantees one). test → the
          // production port against a provider double when one is injected, else the test-only null port.
          // SMS / WhatsApp (messaging amendment): when either provider is configured, a router sends each hand-off to its
          // channel's port; without them the email port is wired directly, exactly as before.
          useFactory: (
            config: AppConfig,
            db: Database,
            profiles: AudienceProfiles<Tx>,
            addresses: AddressLookup<Tx>,
            adapter: (ChannelAdapter & { provider?: string }) | null,
            sms: (ChannelAdapter & { provider?: string }) | null,
            whatsapp: (ChannelAdapter & { provider?: string }) | null,
          ) => {
            const mode = config.campaignDeliveryMode;
            if (!isDeliveryAvailable(mode)) return null;
            const opts = { appUrl: config.appUrl, unsubscribeSecret: config.unsubscribeKeys.current };
            let email: CampaignDeliveryPort;
            if (mode === 'live') {
              if (!adapter) throw new Error('CAMPAIGN_DELIVERY_MODE=live needs a configured delivery provider');
              email = new ProviderDeliveryPort(db, adapter, profiles, addresses, { ...opts, mode: 'live' });
            } else email = adapter ? new ProviderDeliveryPort(db, adapter, profiles, addresses, { ...opts, mode: 'test' }) : new NullDeliveryPort();
            if (!sms && !whatsapp) return email;
            return new ChannelDeliveryRouter(
              {
                email,
                ...(sms ? { sms: new MessagingDeliveryPort(db, sms, profiles, addresses, { mode }) } : {}),
                ...(whatsapp ? { whatsapp: new MessagingDeliveryPort(db, whatsapp, profiles, addresses, { mode }) } : {}),
              },
              { mode },
            );
          },
        },
      ],
    };
  }

  onModuleInit() {
    this.executions.registerHandlers();
  }

  onApplicationBootstrap() {
    // Recovery sweep and scheduler run in processes with the "scheduler" role (both are safe to run in several).
    if (this.config.env !== 'test' && this.config.processRoles.has('scheduler')) {
      this.executions.startSweeps(SWEEP_INTERVAL_MS);
      this.executions.startScheduler(this.config.campaignSchedulerIntervalMs);
    }
  }

  onApplicationShutdown() {
    this.executions.stopTimers();
  }
}
