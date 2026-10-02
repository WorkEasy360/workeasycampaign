import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { type Database, isUniqueViolation } from '@workeasy/db';
import { DATABASE } from '../infrastructure/providers.js';
import { AppError, Errors } from './errors.js';

const TTL_HOURS = 24;
const PENDING = 0;

/**
 * Idempotency-Key support for unsafe creates (organizations, workspaces, invitations).
 * The key is CLAIMED before the work runs (insert of a pending record), so concurrent retries cannot both execute;
 * the response is stored on success and replayed for 24 h. A failed attempt releases its claim. Keys are per user.
 */
@Injectable()
export class IdempotencyService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async run<T>(
    userId: string,
    key: string | undefined,
    scope: string,
    request: unknown,
    work: () => Promise<{ status: number; body: T }>,
  ): Promise<{ status: number; body: T; replayed: boolean }> {
    if (key === undefined) return { ...(await work()), replayed: false };
    if (!/^[A-Za-z0-9_\-:.]{8,128}$/.test(key)) {
      throw Errors.validation({ 'Idempotency-Key': ['Use 8–128 letters, digits, "-", "_", ":" or "."'] });
    }
    const requestHash = createHash('sha256').update(`${scope}\u0000${JSON.stringify(request ?? null)}`).digest('hex');

    const claimed = await this.db.asUser(userId, async (tx) => {
      const existing = await tx.idempotencyRecord.findUnique({ where: { userId_key: { userId, key } } });
      if (existing && existing.expiresAt.getTime() > Date.now()) return existing;
      if (existing) await tx.idempotencyRecord.delete({ where: { userId_key: { userId, key } } });
      return null;
    });
    if (claimed) return this.replay(claimed, scope, requestHash);

    try {
      await this.db.asUser(userId, (tx) =>
        tx.idempotencyRecord.create({
          data: {
            userId,
            key,
            scope,
            requestHash,
            responseStatus: PENDING,
            responseBody: {},
            expiresAt: new Date(Date.now() + TTL_HOURS * 3600_000),
          },
        }),
      );
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const raced = await this.db.asUser(userId, (tx) => tx.idempotencyRecord.findUnique({ where: { userId_key: { userId, key } } }));
      if (raced) return this.replay(raced, scope, requestHash);
      throw err;
    }

    try {
      const result = await work();
      await this.db.asUser(userId, (tx) =>
        tx.idempotencyRecord.update({
          where: { userId_key: { userId, key } },
          data: { responseStatus: result.status, responseBody: result.body as object },
        }),
      );
      return { ...result, replayed: false };
    } catch (err) {
      await this.db.asUser(userId, (tx) => tx.idempotencyRecord.deleteMany({ where: { userId, key } }));
      throw err;
    }
  }

  private replay<T>(
    record: { scope: string; requestHash: string; responseStatus: number; responseBody: unknown },
    scope: string,
    requestHash: string,
  ): { status: number; body: T; replayed: boolean } {
    if (record.scope !== scope || record.requestHash !== requestHash) throw Errors.idempotencyConflict();
    if (record.responseStatus === PENDING) {
      throw new AppError('conflict', 409, 'A request with this Idempotency-Key is still being processed');
    }
    return { status: record.responseStatus, body: record.responseBody as T, replayed: true };
  }
}
