import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { migrateTestDatabase, resetTestDatabase } from '@workeasy/db/testing';

export default async function globalSetup() {
  migrateTestDatabase();
  await resetTestDatabase();
  rmSync(resolve(import.meta.dirname, '.mail'), { recursive: true, force: true });
}
