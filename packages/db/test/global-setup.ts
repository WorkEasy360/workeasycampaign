import { migrateTestDatabase } from '../src/testing.js';

export default function setup(): void {
  migrateTestDatabase();
}
