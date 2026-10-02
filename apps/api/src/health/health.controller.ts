import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  /** Liveness probe. Readiness (DB/Redis checks) is added with the data layer in step 4. */
  @Get()
  check() {
    return { status: 'ok', service: 'api', time: new Date().toISOString() };
  }
}
