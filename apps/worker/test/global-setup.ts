import { migrateTestDatabase } from '@workeasy/db/testing';

export default function setup(): void {
  migrateTestDatabase();
}
