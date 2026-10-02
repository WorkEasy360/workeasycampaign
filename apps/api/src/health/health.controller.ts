import { Controller, Get, Inject } from '@nestjs/common';
import type { Database } from '@workeasy/db';
import { Public } from '../common/access.js';
import { AppError } from '../common/errors.js';
import { DATABASE } from '../infrastructure/providers.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Liveness: the process is up. */
  @Get()
  @Public()
  live() {
    return { status: 'ok' };
  }

  /** Readiness: dependencies reachable. */
  @Get('ready')
  @Public()
  async ready() {
    try {
      await this.db.ping();
    } catch {
      throw new AppError('internal_error', 503, 'Database unavailable');
    }
    return { status: 'ready' };
  }
}
