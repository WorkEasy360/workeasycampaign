import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { IdempotencyService } from '../../common/idempotency.js';
import { InlineJobDispatcher, JOB_DISPATCHER, type JobDispatcher } from '../../common/jobs.js';
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
    BulkService,
    ImportsService,
    ImportProcessor,
    IdempotencyService,
  ],
  exports: [EligibilityService],
})
export class AudienceModule implements OnModuleInit {
  constructor(
    @Inject(JOB_DISPATCHER) private readonly jobs: JobDispatcher,
    private readonly processor: ImportProcessor,
  ) {}

  onModuleInit() {
    if (this.jobs instanceof InlineJobDispatcher) {
      this.jobs.register(IMPORT_JOB, (data) => this.processor.run(data as ImportJob));
    }
  }
}
