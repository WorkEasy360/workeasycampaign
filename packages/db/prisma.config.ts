import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'prisma/config';

const envPath = resolve(import.meta.dirname, '../../.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

// Migrations run as the schema owner. The runtime roles (workeasy_app, workeasy_identity) never run migrations.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_OWNER_URL ?? '' },
});
