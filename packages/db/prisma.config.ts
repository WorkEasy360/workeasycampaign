import { defineConfig } from 'prisma/config';

// Migrations run as the owner role; the application connects as `workeasy_app`, which is subject to RLS.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'tsx src/seed.ts' },
  datasource: {
    url: process.env.DATABASE_MIGRATION_URL ?? 'postgresql://workeasy:workeasy@localhost:5432/workeasy',
  },
});
