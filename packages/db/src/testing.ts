/**
 * @workeasy/db/testing — test-only helpers. Import from *.test.ts / test setup files only (dependency-cruiser rule).
 * Uses the `workeasy_test` database; refuses to touch any database whose name does not end in `_test`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = resolve(packageRoot, '../../.env');

function loadEnv(): void {
  if (existsSync(envPath) && !process.env.DATABASE_OWNER_URL) process.loadEnvFile(envPath);
}

function toTestDb(url: string | undefined, name: string): string {
  if (!url) throw new Error(`${name} is not set (run pnpm db:bootstrap)`);
  const u = new URL(url);
  u.pathname = '/workeasy_test';
  return u.toString();
}

export interface TestDatabaseUrls {
  owner: string;
  app: string;
  identity: string;
  reporting: string;
}

export function testDatabaseUrls(): TestDatabaseUrls {
  loadEnv();
  return {
    owner: toTestDb(process.env.DATABASE_OWNER_URL, 'DATABASE_OWNER_URL'),
    app: toTestDb(process.env.DATABASE_URL, 'DATABASE_URL'),
    identity: toTestDb(process.env.IDENTITY_DATABASE_URL, 'IDENTITY_DATABASE_URL'),
    reporting: toTestDb(process.env.REPORTING_DATABASE_URL, 'REPORTING_DATABASE_URL'),
  };
}

function assertTestDb(url: string): void {
  if (!new URL(url).pathname.endsWith('_test')) throw new Error(`Refusing to modify non-test database: ${url}`);
}

/** Applies pending migrations to the test database (as the schema owner). */
export function migrateTestDatabase(): void {
  const { owner } = testDatabaseUrls();
  assertTestDb(owner);
  const prismaBin = resolve(packageRoot, 'node_modules/prisma/build/index.js');
  execFileSync(process.execPath, [prismaBin, 'migrate', 'deploy'], {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_OWNER_URL: owner },
    stdio: 'pipe',
  });
}

/** Owner connection for seeding and cleanup in tests. Bypasses RLS by design — never use outside tests. */
export async function withOwnerConnection<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const { owner } = testDatabaseUrls();
  assertTestDb(owner);
  const client = new pg.Client({ connectionString: owner });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Empties every application table (identity + public) except the migration history. */
export async function resetTestDatabase(): Promise<void> {
  await withOwnerConnection(async (c) => {
    const { rows } = await c.query<{ name: string }>(`
      SELECT format('%I.%I', schemaname, tablename) AS name FROM pg_tables
      WHERE schemaname IN ('public', 'identity') AND tablename <> '_prisma_migrations'`);
    if (rows.length) await c.query(`TRUNCATE ${rows.map((r) => r.name).join(', ')} CASCADE`);
  });
}
