import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

/** Queue processors (send, events, scoring, segments, journeys, imports) are added from step 9 onward. */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env'] })],
})
export class WorkerModule {}
