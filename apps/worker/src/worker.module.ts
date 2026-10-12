import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AudienceCountMaintenanceJob } from './audience-read-side.js';

/** Queue processors (send, events, scoring, segments, journeys, imports) are added from step 9 onward. */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env'] })],
  // Audience count bitmap maintenance (Phase 6.3 G2): rebuild invalid bitmaps, reconcile valid ones at least daily.
  providers: [AudienceCountMaintenanceJob],
})
export class WorkerModule {}
