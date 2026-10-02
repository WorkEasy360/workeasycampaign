/**
 * @workeasy/db/identity — data access for the LOCAL identity provider only.
 *
 * Connects as workeasy_identity, which has privileges on the `identity` schema and nothing else. Importing this
 * entry point is restricted to apps/api/src/modules/identity/infrastructure/local (enforced by dependency-cruiser).
 * When Workeasy SSO replaces local auth, this entry point and the schema are removed; no tenant data lives here.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export type { LocalAccountModel as LocalAccount, LocalAccountTokenModel as LocalAccountToken } from './generated/prisma/models.js';

export interface IdentityStore {
  readonly accounts: PrismaClient['localAccount'];
  readonly tokens: PrismaClient['localAccountToken'];
  readonly loginAttempts: PrismaClient['loginAttempt'];
  transaction<T>(fn: (store: Omit<IdentityStore, 'transaction' | 'disconnect'>) => Promise<T>): Promise<T>;
  disconnect(): Promise<void>;
}

export function createIdentityStore(url: string, maxConnections = 5): IdentityStore {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url, max: maxConnections, application_name: 'workeasy-identity' }),
  });
  return {
    accounts: prisma.localAccount,
    tokens: prisma.localAccountToken,
    loginAttempts: prisma.loginAttempt,
    transaction: (fn) =>
      prisma.$transaction((tx) =>
        fn({ accounts: tx.localAccount, tokens: tx.localAccountToken, loginAttempts: tx.loginAttempt }),
      ),
    disconnect: () => prisma.$disconnect(),
  };
}
