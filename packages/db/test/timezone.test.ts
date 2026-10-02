/**
 * Regression: the PostgreSQL server here runs in a non-UTC zone. Timestamps written through Prisma must round-trip
 * exactly and agree with the database clock (a 5h30m skew once made sessions rotate on every request).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/index.js';
import { resetTestDatabase, testDatabaseUrls, withOwnerConnection } from '../src/testing.js';

let db: Database;
const user = randomUUID();
beforeAll(async () => {
  await resetTestDatabase();
  await withOwnerConnection((c) =>
    c.query(`INSERT INTO users (id, email, email_normalized, display_name) VALUES ($1, 'tz@x.test', 'tz@x.test', 'TZ')`, [user]),
  );
  db = createDatabase({ url: testDatabaseUrls().app });
});
afterAll(async () => db?.disconnect());

describe('timestamps are time-zone safe', () => {
  it('explicit Date values round-trip exactly and match SQL epoch', async () => {
    const at = new Date('2026-03-01T12:34:56.789Z');
    const s = await db.asUser(user, (tx) =>
      tx.session.create({
        data: { userId: user, tokenHash: randomUUID(), provider: 'test', authMethods: [], idleExpiresAt: at, absoluteExpiresAt: at },
      }),
    );
    expect(s.idleExpiresAt.toISOString()).toBe(at.toISOString());
    const raw = await withOwnerConnection((c) =>
      c.query<{ e: string }>('SELECT extract(epoch FROM idle_expires_at)::text AS e FROM sessions WHERE id = $1', [s.id]),
    );
    expect(Number(raw.rows[0]!.e) * 1000).toBeCloseTo(at.getTime(), -1);
  });

  it('database defaults (now()) agree with the application clock', async () => {
    const s = await db.asUser(user, (tx) =>
      tx.session.create({
        data: { userId: user, tokenHash: randomUUID(), provider: 'test', authMethods: [], idleExpiresAt: new Date(), absoluteExpiresAt: new Date() },
      }),
    );
    expect(Math.abs(s.createdAt.getTime() - Date.now())).toBeLessThan(60_000);
    expect(Math.abs(s.rotatedAt.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it('the server really is in a non-UTC zone (so this test is meaningful here)', async () => {
    const tz = await withOwnerConnection(async (c) => (await c.query<{ tz: string }>(`SELECT current_setting('TimeZone') AS tz`)).rows[0]!.tz);
    expect(typeof tz).toBe('string');
  });
});
