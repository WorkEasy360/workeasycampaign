import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildOpenApiDocument } from '../src/openapi/document.js';

const out = resolve(import.meta.dirname, '../../../docs/api/openapi.json');
mkdirSync(resolve(out, '..'), { recursive: true });
writeFileSync(out, JSON.stringify(buildOpenApiDocument(), null, 2) + '\n');
console.log(`wrote ${out}`);
