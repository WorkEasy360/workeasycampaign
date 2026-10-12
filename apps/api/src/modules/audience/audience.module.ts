import { Inject, Logger, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { createAudienceReadSide, PrismaAudienceResolutionRecovery } from '@workeasy/audience-infra';
import type { Database } from '@workeasy/db';
import { IdempotencyService } from '../../common/idempotency.js';
import { JOB_DISPATCHER, type JobDispatcher } from '../../common/jobs.js';
import type { AppConfig } from '../../config/env.js';
import { ADDRESS_LOOKUP, APP_CONFIG, AUDIENCE_USAGE, DELIVERY_SUPPRESSIONS, AUDIENCE_PROFILES, AUDIENCE_RECOVERY, AUDIENCE_RESOLUTION, CONSENT_RECORDER, DATABASE, ELIGIBILITY_EVALUATOR } from '../../infrastructure/providers.js';
import { AudienceConsentRecorder } from './application/consent-recorder.js';
import { AudienceDeliverySuppressions } from './application/delivery-suppressions.js';
import { AudienceUsageCounts } from './application/usage-counts.js';
import { BulkService } from './application/bulk.service.js';
import { ConsentService } from './application/consent.service.js';
import { ContactsService } from './application/contacts.service.js';
import { ImportProcessor, type ImportJob } from './application/import-processor.js';
import { IMPORT_JOB, ImportsService } from './application/imports.service.js';
import { ListsService, TagsService } from './application/lists-tags.service.js';
import { EligibilityService, SuppressionService } from './application/suppression-eligibility.service.js';
import { CustomFieldsService, TopicsService } from './application/topics-fields.service.js';
import {
  ComplianceController,
  ContactsController,
  CustomFieldsController,
  ImportsController,
  ListsController,
  TagsController,
  TopicsController,
} from './http/audience.controllers.js';

/** Audience (Phase 5): contacts, identities, custom fields, lists, tags, topics, consent, suppression, eligibility, imports. */
@Module({
  controllers: [ContactsController, ListsController, TagsController, TopicsController, CustomFieldsController, ComplianceController, ImportsController],
  providers: [
    ContactsService,
    ListsService,
    TagsService,
    TopicsService,
    CustomFieldsService,
    ConsentService,
    SuppressionService,
    EligibilityService,
    // Composition root of the Audience read side: core port ← infra adapter (docs/contracts/phase-5-audience.md §9.8).
    {
      provide: ELIGIBILITY_EVALUATOR,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createAudienceReadSide({ fingerprintSecret: config.fingerprintSecret }).eligibility,
    },
    {
      provide: AUDIENCE_RESOLUTION,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createAudienceReadSide({ fingerprintSecret: config.fingerprintSecret }).resolution,
    },
    {
      provide: AUDIENCE_PROFILES,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createAudienceReadSide({ fingerprintSecret: config.fingerprintSecret }).profiles,
    },
    {
      // Audience Resolution recovery (v1.2): deduplicated, non-blocking bitmap rebuild requests (ids only in logs).
      provide: AUDIENCE_RECOVERY,
      inject: [DATABASE],
      useFactory: (db: Database) => {
        const log = new Logger('AudienceResolutionRecovery');
        return new PrismaAudienceResolutionRecovery(db, {
          info: (msg, data) => log.log(JSON.stringify({ msg, ...data })),
          error: (msg, data) => log.error(JSON.stringify({ msg, ...data })),
        });
      },
    },
    {
      // Address Lookup port (E-4; Phase 7.7): send-to values for delivery, RLS-scoped.
      provide: ADDRESS_LOOKUP,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createAudienceReadSide({ fingerprintSecret: config.fingerprintSecret }).addresses,
    },
    // ConsentRecorder port (Phase 7.8): a contact's own unsubscribe, recorded by Audience.
    { provide: CONSENT_RECORDER, useClass: AudienceConsentRecorder },
    // DeliverySuppressions port (Phase 7.9): hard bounces and complaints from provider feedback.
    { provide: DELIVERY_SUPPRESSIONS, useClass: AudienceDeliverySuppressions },
    // AudienceUsage port (Phase 7.13): usage gauges counted by the owner of the tables.
    { provide: AUDIENCE_USAGE, useClass: AudienceUsageCounts },
    BulkService,
    ImportsService,
    ImportProcessor,
    IdempotencyService,
  ],
  exports: [EligibilityService, ELIGIBILITY_EVALUATOR, AUDIENCE_RESOLUTION, AUDIENCE_RECOVERY, AUDIENCE_PROFILES, CONSENT_RECORDER, ADDRESS_LOOKUP, DELIVERY_SUPPRESSIONS, AUDIENCE_USAGE],
})
export class AudienceModule implements OnModuleInit, OnApplicationShutdown {
  constructor(
    @Inject(JOB_DISPATCHER) private readonly jobs: JobDispatcher,
    private readonly processor: ImportProcessor,
    @Inject(AUDIENCE_RECOVERY) private readonly recovery: PrismaAudienceResolutionRecovery,
  ) {}

  /** Lets a running recovery finish for a short while; an interrupted one leaves its lease to expire (6.3 semantics). */
  async onApplicationShutdown() {
    await Promise.race([this.recovery.idle(), new Promise((r) => setTimeout(r, 10_000).unref())]);
  }

  onModuleInit() {
    this.jobs.register(IMPORT_JOB, (data) => this.processor.run(data as ImportJob));
  }
}
