import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export * from './generated/prisma/client.js';

export function createPrismaClient(connectionString = process.env.DATABASE_URL): PrismaClient {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

/**
 * Runs `fn` in a transaction with `app.org_id` set, so Postgres RLS policies scope every query to one tenant.
 * This is the only supported way for application code to touch tenant data.
 */
export async function withTenant<T>(
  prisma: PrismaClient,
  orgId: string,
  fn: (tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.org_id', ${orgId}, true)`;
    return fn(tx);
  });
}
