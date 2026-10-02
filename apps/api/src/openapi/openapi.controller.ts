import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/access.js';
import { buildOpenApiDocument } from './document.js';

@Controller('v1/openapi.json')
export class OpenApiController {
  private readonly doc = buildOpenApiDocument();

  @Get()
  @Public()
  get() {
    return this.doc;
  }
}
